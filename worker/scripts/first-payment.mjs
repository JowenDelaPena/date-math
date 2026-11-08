// Makes real paid calls to your own API so facilitator catalogs (x402 Bazaar) index it.
// Discovery catalogs list a service only after a real settled payment, made by a client that
// forwards the Bazaar extension (the official @x402/fetch client does).
//
// Uses a THROWAWAY buyer wallet stored in worker/.buyer-key (gitignored). Fund it with ~$0.05 USDC
// on Base. The facilitator pays gas, so no ETH is needed. Each call costs $0.001,
// and the money goes to your PAY_TO wallet, so you pay yourself.
//
// Usage (from worker/):  node scripts/first-payment.mjs
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createx402MCPClient } from "@x402/mcp";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const API = process.env.API_URL ?? "https://date-math.datemath.workers.dev";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC on Base
const RPC = "https://mainnet.base.org";
const KEY_FILE = new URL("../.buyer-key", import.meta.url);

if (!existsSync(KEY_FILE)) {
  writeFileSync(KEY_FILE, generatePrivateKey() + "\n");
  try { chmodSync(KEY_FILE, 0o600); } catch {}
  console.log("Created a new throwaway buyer wallet (key saved in worker/.buyer-key, never share it).");
}
const account = privateKeyToAccount(readFileSync(KEY_FILE, "utf8").trim());
console.log(`Buyer wallet: ${account.address}`);

async function usdcBalance(addr) {
  const data = "0x70a08231" + addr.slice(2).toLowerCase().padStart(64, "0"); // balanceOf(address)
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDC, data }, "latest"] }),
  });
  return Number(BigInt((await r.json()).result)) / 1e6;
}

const bal = await usdcBalance(account.address);
console.log(`Buyer USDC on Base: $${bal.toFixed(6)}`);
if (bal < 0.005) {
  console.log(`\nFund it first: send about 0.05 USDC on the **Base** network to\n  ${account.address}\nthen run this script again. No ETH needed.`);
  process.exit(0);
}

const pay = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(account) }] });
// `node scripts/first-payment.mjs`                     pays every paid tool once ($0.001 each) + one MCP call
// `node scripts/first-payment.mjs stay sla market`     pays only the named tools (path without /v1/)
// Tools and example bodies come from the live service's index (GET /), so new tools are included automatically.
// The MCP call uses the free daily tier when it has calls left, so it usually settles nothing.
const args = process.argv.slice(2);
const named = args.length ? new Set(args.map((a) => "/v1/" + a.replace(/^\/?(v1\/)?/, ""))) : null;
const index = await (await fetch(API + "/")).json();
const all = Object.entries(index.endpoints).map(([route, e]) => [route.replace(/^POST /, ""), e.example]);
const calls = all.filter(([path]) => !named || named.has(path));
if (named && calls.length !== named.size) console.log(`Unknown tool name(s). Known: ${all.map(([p]) => p.slice(4)).join(", ")}`);

for (const [path, body] of calls) {
  const res = await pay(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  const header = res.headers.get("PAYMENT-RESPONSE");
  const settle = header ? decodePaymentResponseHeader(header) : null;
  console.log(`\n${path} -> HTTP ${res.status}`);
  console.log(`  result: ${text.slice(0, 160)}`);
  if (settle) console.log(`  settled: ${settle.success} tx ${settle.transaction ?? "?"} (https://basescan.org/tx/${settle.transaction})`);
}

// One paid MCP tool call (x402 over MCP; payment rides in the tool call's _meta).
const mcp = createx402MCPClient({
  name: "date-math-first-payment",
  version: "1.0.0",
  schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(account) }],
  autoPayment: true,
  onPaymentRequested: async ({ paymentRequired }) => paymentRequired.accepts[0].amount === "1000", // only ever pay $0.001
});
await mcp.connect(new StreamableHTTPClientTransport(new URL(API + "/mcp")));
const r = await mcp.callTool("working_hours_overlap", { timezones: ["Asia/Manila", "America/New_York"], date: "2026-11-10", work_start: "07:00", work_end: "21:00" });
console.log(`\nMCP working_hours_overlap -> ${r.isError ? "ERROR" : "ok"}`);
console.log(`  result: ${(r.content?.[0]?.text ?? "").slice(0, 160)}`);
if (r.paymentMade && r.paymentResponse) console.log(`  settled: ${r.paymentResponse.success} tx ${r.paymentResponse.transaction} (https://basescan.org/tx/${r.paymentResponse.transaction})`);
await mcp.close();

console.log(`\nBuyer USDC now: $${(await usdcBalance(account.address)).toFixed(6)}`);
console.log("Catalog check (may take a few minutes): https://facilitator.payai.network/discovery/resources");
