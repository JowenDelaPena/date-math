// Live payment monitor: checks that the deployed service can actually take money, the way real agents pay.
// Exits 1 on any problem (GitHub Actions then emails the repo owner). Spends nothing unless BUYER_KEY is set.
//
//   cd worker; node scripts/payment-monitor.mjs                 # free checks
//   $env:BUYER_KEY = "0x..."; node scripts/payment-monitor.mjs  # also one real $0.001 MCP payment to yourself
//
// Checks:
//  1. Every paid HTTP route answers an unpaid call with 402 and the right terms (wallet, price, USDC on Base).
//  2. The facilitator is up and supports x402 v2 exact payments on Base.
//  3. Over MCP, a standard SDK client that listed tools first (as real agents do) and attaches a signed payment
//     gets a readable answer, not a protocol error. This is the path the 1.4.0 bug broke. The payment comes from
//     a fresh, empty wallet, so the facilitator rejects it and nothing is spent.
//  4. Optional (BUYER_KEY): one real paid MCP call settles on-chain and returns the result.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const API = (process.env.API_URL || "https://date-math.datemath.workers.dev").replace(/\/$/, "");

// Mark our own requests so Cloudflare logs show them as src = "internal", not as real users.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  let sameOrigin = false;
  try {
    sameOrigin = new URL(url).origin === new URL(API).origin; // exact origin match, not a string prefix
  } catch {}
  if (!sameOrigin) return realFetch(input, init);
  const req = new Request(input, init);
  req.headers.set("X-Date-Math-Internal", "1");
  return realFetch(req);
};

const EXPECT = {
  payTo: (process.env.EXPECTED_PAY_TO || "0x7eC21Ee3AA308D2cbB8c65ef0E89af2a30101656").toLowerCase(),
  amount: "1000", // $0.001 in USDC units (6 decimals)
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".toLowerCase(), // USDC on Base
};
const FACILITATOR = process.env.FACILITATOR_URL || "https://facilitator.payai.network";
const MCP_SAMPLE = ["date_info", "business_day", "timezone_convert"]; // one per code module; keeps facilitator load low

const failures = [];
const ok = (msg) => console.log(`  ok    ${msg}`);
const fail = (msg) => (failures.push(msg), console.log(`  FAIL  ${msg}`));
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

function checkTerms(accepts, where) {
  const a = (accepts ?? []).find((x) => x.network === EXPECT.network);
  if (!a) return fail(`${where}: no payment option on ${EXPECT.network}`);
  const bad = [];
  if (a.scheme !== "exact") bad.push(`scheme ${a.scheme}`);
  if (String(a.payTo).toLowerCase() !== EXPECT.payTo) bad.push(`payTo ${a.payTo} (expected ${EXPECT.payTo})`);
  if (a.amount !== EXPECT.amount) bad.push(`amount ${a.amount} (expected ${EXPECT.amount})`);
  if (String(a.asset).toLowerCase() !== EXPECT.asset) bad.push(`asset ${a.asset}`);
  check(bad.length === 0, `${where}: terms ${bad.length ? bad.join(", ") : "correct"}`);
  return a;
}

async function timed(label, fn) {
  try {
    return await fn();
  } catch (e) {
    fail(`${label}: ${e?.message ?? e}`);
    return undefined;
  }
}

console.log(`Payment monitor for ${API}\n`);

// ---- 1. HTTP 402 terms on every paid route ----
console.log("HTTP");
const overview = await timed("GET /", async () => (await fetch(API + "/")).json());
const routes = Object.entries(overview?.endpoints ?? {}).map(([k, v]) => ({ path: k.replace(/^POST /, ""), tool: v.mcp_tool, example: v.example }));
check(routes.length >= 13, `${routes.length} paid routes listed`);
const httpTerms = new Map();
for (const r of routes) {
  await timed(r.path, async () => {
    const res = await fetch(API + r.path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(r.example) });
    if (res.status !== 402) return fail(`${r.path}: unpaid call returned ${res.status}, expected 402 (is it giving results away?)`);
    const header = res.headers.get("PAYMENT-REQUIRED");
    if (!header) return fail(`${r.path}: 402 without PAYMENT-REQUIRED header`);
    const required = decodePaymentRequiredHeader(header);
    httpTerms.set(r.tool, required);
    checkTerms(required.accepts, r.path);
  });
}

// ---- 2. Facilitator health ----
console.log("\nFacilitator");
await timed("facilitator /supported", async () => {
  const res = await fetch(FACILITATOR.replace(/\/$/, "") + "/supported");
  const body = await res.json();
  const kinds = body.kinds ?? [];
  check(kinds.some((k) => k.x402Version === 2 && k.scheme === "exact" && k.network === EXPECT.network), `${FACILITATOR} supports x402 v2 exact on ${EXPECT.network}`);
});

// The worker's facilitators must actually verify payments: an unfunded HTTP payment has to be refused for lack of
// funds (anything else, like an auth or network error, would also block real buyers).
await timed("facilitator verify via the worker", async () => {
  const r = routes.find((x) => x.tool === "date_info") ?? routes[0];
  const payer = new x402Client().register("eip155:*", new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())));
  const sig = encodePaymentSignatureHeader(await payer.createPaymentPayload(httpTerms.get(r.tool)));
  const res = await fetch(API + r.path, { method: "POST", headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": sig }, body: JSON.stringify(r.example) });
  const reason = res.headers.get("PAYMENT-REQUIRED") ? String(decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")).error ?? "") : "";
  if (res.status !== 402) return fail(`unfunded HTTP payment returned ${res.status}, expected 402`);
  check(/insufficient/i.test(reason), `worker's facilitator refuses an unfunded payment for lack of funds (${reason.slice(0, 60) || "no reason"})`);
});

// ---- 3. MCP: standard client, tools listed first, signed payment attached ----
async function mcpPaidCall(account, toolName) {
  const required = httpTerms.get(toolName);
  if (!required) throw new Error(`no HTTP terms for ${toolName} to sign against`);
  const payer = new x402Client().register("eip155:*", new ExactEvmScheme(account));
  const payment = await payer.createPaymentPayload(required);
  const client = new Client({ name: "date-math-monitor", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(API + "/mcp")));
  try {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === toolName);
    if (!t) throw new Error(`tool ${toolName} missing from tools/list`);
    const example = routes.find((r) => r.tool === toolName)?.example ?? {};
    // First call: a payment signed against the HTTP terms. MCP terms carry different discovery metadata, so the
    // server rejects it and answers with its own MCP terms (this also proves a listed-tools SDK client can read them).
    const first = await client.callTool({ name: toolName, arguments: example, _meta: { "x402/payment": payment } });
    let mcpTerms;
    try {
      mcpTerms = JSON.parse(String(first.content?.[0]?.text ?? ""));
    } catch {}
    if (!first.isError || !mcpTerms?.accepts) return { first };
    // Second call: signed against the MCP terms, exactly as an x402 MCP client would.
    const second = await client.callTool({ name: toolName, arguments: example, _meta: { "x402/payment": await payer.createPaymentPayload(mcpTerms) } });
    return { first, second, mcpTerms };
  } finally {
    await client.close();
  }
}

console.log("\nMCP");
const empty = privateKeyToAccount(generatePrivateKey());
for (const name of MCP_SAMPLE) {
  await timed(`MCP ${name}`, async () => {
    const { first, second, mcpTerms } = await mcpPaidCall(empty, name);
    if (!mcpTerms) return fail(`MCP ${name}: no readable payment terms (${String(first.content?.[0]?.text ?? "").slice(0, 100)})`);
    checkTerms(mcpTerms.accepts, `MCP ${name}`);
    // An empty wallet can't pay: the facilitator must reject it, and no result may come back.
    const text = String(second.content?.[0]?.text ?? "");
    if (!second.isError) return fail(`MCP ${name}: an unfunded payment returned a result (giving results away?)`);
    let reason;
    try {
      reason = JSON.parse(text).error;
    } catch {}
    check(reason !== "extension_echo_mismatch", `MCP ${name}: unfunded payment refused, no result given (${(reason ?? text).slice(0, 70)})`);
  });
}

// ---- 4. Optional real payment ----
if (process.env.BUYER_KEY) {
  console.log("\nReal payment ($0.001 to your own wallet)");
  await timed("real MCP payment", async () => {
    const buyer = privateKeyToAccount(process.env.BUYER_KEY.trim());
    const { second: r = {} } = await mcpPaidCall(buyer, "date_info");
    const settle = r._meta?.["x402/payment-response"];
    if (r.isError || !settle?.success) return fail(`real MCP payment did not settle: ${String(r.content?.[0]?.text ?? "").slice(0, 160)}`);
    ok(`settled: https://basescan.org/tx/${settle.transaction}`);
  });
}

console.log(failures.length ? `\n${failures.length} problem(s). Payments may be broken: check the FAIL lines above.` : "\nAll payment checks passed.");
process.exit(failures.length ? 1 : 0);
