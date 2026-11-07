// End-to-end payment tests with the real x402 client libraries (the ones agents use), against the worker in-process
// and a fake facilitator. These guard earnings: a paying client must be able to pay, the money must go to PAY_TO at
// the advertised price, and no result may be handed out unless settlement succeeded.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { createx402MCPClient } from "@x402/mcp";
import { x402Client } from "@x402/core/client";
import { privateKeyToAccount } from "viem/accounts";
import worker from "../src/index";
import { TOOLS } from "../src/tools";

const PAY_TO = "0x7eC21Ee3AA308D2cbB8c65ef0E89af2a30101656";
const NETWORK = "eip155:84532";
const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const env = { PAY_TO, PRICE: "$0.001", X402_NETWORK: NETWORK, FACILITATOR_URL: "https://facilitator.test", PUBLIC_URL: "https://date-math.example" };
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} };
// Fixed test key (never funded, never used outside tests).
const buyer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const TX = "0x" + "ab".repeat(32);
const realFetch = globalThis.fetch;

type Call = { path: string; body: any };
let calls: Call[];
let settleOk: boolean;
let verifyStatus: number;

beforeEach(() => {
  calls = [];
  settleOk = true;
  verifyStatus = 200;
  // Fake facilitator: supports exact on Base Sepolia, verifies anything, settles unless told to fail.
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const path = new URL(req.url).pathname;
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (path.endsWith("/supported")) return json({ kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [], signers: {} });
    const body = await req.json();
    calls.push({ path, body });
    if (path.endsWith("/verify")) return verifyStatus === 200 ? json({ isValid: true, payer: buyer.address }) : json({ errorType: "insufficient_funds", errorMessage: "contract call failed" }, verifyStatus);
    if (path.endsWith("/settle")) {
      return settleOk
        ? json({ success: true, payer: buyer.address, transaction: TX, network: NETWORK })
        : json({ success: false, errorReason: "insufficient_funds", payer: buyer.address, transaction: "", network: NETWORK });
    }
    return json({}, 404);
  });
});
afterEach(() => vi.stubGlobal("fetch", realFetch));

/** fetch that sends requests to the worker instead of the network. */
const toWorker = ((input: RequestInfo | URL, init?: RequestInit) => worker.fetch(new Request(input, init), env as any, ctx)) as typeof fetch;
const schemes = [{ network: NETWORK as `${string}:${string}`, client: new ExactEvmScheme(buyer) }];

/** Every settlement must pay PAY_TO exactly the advertised price, in USDC on the configured network. */
function expectSettledCorrectly() {
  const settles = calls.filter((c) => c.path.endsWith("/settle"));
  expect(settles).toHaveLength(1);
  const { paymentPayload, paymentRequirements } = settles[0].body;
  expect(paymentRequirements).toMatchObject({ scheme: "exact", network: NETWORK, amount: "1000", payTo: PAY_TO, asset: USDC_BASE_SEPOLIA });
  const auth = paymentPayload.payload.authorization;
  expect(auth.to.toLowerCase()).toBe(PAY_TO.toLowerCase());
  expect(auth.value).toBe("1000");
  expect(auth.from.toLowerCase()).toBe(buyer.address.toLowerCase());
}

describe("paid HTTP calls (@x402/fetch)", () => {
  const pay = wrapFetchWithPaymentFromConfig(toWorker, { schemes });
  const call = (t: (typeof TOOLS)[number]) =>
    pay(`https://date-math.example${t.path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(t.example) });

  it.each(TOOLS.map((t) => [t.path, t]))("%s: pays PAY_TO $0.001 and returns the result", async (_, t) => {
    const res = await call(t);
    expect(res.status).toBe(200);
    expect((await res.json()).error).toBeUndefined();
    const settle = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!);
    expect(settle).toMatchObject({ success: true, transaction: TX });
    expectSettledCorrectly();
  });

  it("logs a paid call as paid, with the transaction", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((s: unknown) => void lines.push(String(s)));
    await call(TOOLS[0]);
    spy.mockRestore();
    expect(lines.map((l) => JSON.parse(l))).toContainEqual(expect.objectContaining({ evt: "call", via: "http", outcome: "paid", tx: TX }));
  });

  it("gives nothing away when settlement fails", async () => {
    settleOk = false;
    const res = await call(TOOLS.find((t) => t.name === "date_info")!);
    expect(res.status).toBe(402);
    expect(await res.text()).not.toContain("weekday");
  });
});

describe("paid MCP calls (@x402/mcp)", () => {
  async function client() {
    const c = createx402MCPClient({ name: "paid-test", version: "1", schemes, autoPayment: true, onPaymentRequested: () => true });
    await c.connect(new StreamableHTTPClientTransport(new URL("https://date-math.example/mcp"), { fetch: toWorker }));
    return c;
  }

  it.each(TOOLS.map((t) => [t.name, t]))("%s: pays after tools/list (the way real agents call)", async (_, t) => {
    const c = await client();
    await c.listTools(); // caches output schemas; this is what broke payments before 1.5.0
    const r = (await c.callTool(t.name, t.example)) as any;
    expect(r.isError).toBeFalsy();
    expect(r.paymentMade).toBe(true);
    expect(r.paymentResponse).toMatchObject({ success: true, transaction: TX });
    expect(JSON.parse(r.content[0].text).error).toBeUndefined();
    expectSettledCorrectly();
    await c.close();
  });

  it("logs a paid MCP call as paid, with the transaction", async () => {
    const c = await client();
    await c.listTools();
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((s: unknown) => void lines.push(String(s)));
    await c.callTool("date_info", { date: "2024-02-29" });
    spy.mockRestore();
    const events = lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
    expect(events).toContainEqual(expect.objectContaining({ evt: "call", via: "mcp", path: "date_info", outcome: "unpaid" })); // first try, no payment
    expect(events).toContainEqual(expect.objectContaining({ evt: "call", via: "mcp", path: "date_info", outcome: "paid", tx: TX }));
    await c.close();
  });

  it("gives nothing away when settlement fails", async () => {
    settleOk = false;
    const c = await client();
    await c.listTools();
    const r = (await c.callTool("date_info", { date: "2024-02-29" }).catch((e: Error) => ({ thrown: e.message }))) as any;
    expect(JSON.stringify(r)).not.toContain("Thursday");
    await c.close();
  });

  it("a facilitator error during verify gives the agent a reason and fresh terms, not 'Internal Server Error'", async () => {
    verifyStatus = 400; // how Coinbase's facilitator answers e.g. insufficient funds
    const c = new Client({ name: "plain", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL("https://date-math.example/mcp"), { fetch: toWorker }));
    await c.listTools();
    const payer = new x402Client().register("eip155:*", new ExactEvmScheme(buyer));
    const unpaid = (await c.callTool({ name: "date_info", arguments: { date: "2024-02-29" } })) as any;
    const payment = await payer.createPaymentPayload(JSON.parse(unpaid.content[0].text));
    const r = (await c.callTool({ name: "date_info", arguments: { date: "2024-02-29" }, _meta: { "x402/payment": payment } })) as any;
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.error).toContain("payment_verification_failed");
    expect(body.accepts[0]).toMatchObject({ payTo: PAY_TO, amount: "1000" });
    expect(JSON.stringify(r)).not.toContain("Thursday");
    expect(calls.filter((x) => x.path.endsWith("/settle"))).toHaveLength(0);
    await c.close();
  });

  it("a plain MCP client (no x402) gets readable payment terms, not a protocol error", async () => {
    const c = new Client({ name: "plain", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL("https://date-math.example/mcp"), { fetch: toWorker }));
    await c.listTools();
    const r = (await c.callTool({ name: "date_info", arguments: { date: "2024-02-29" } })) as any;
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).accepts[0]).toMatchObject({ payTo: PAY_TO, amount: "1000", network: NETWORK });
    expect(calls.filter((x) => x.path.endsWith("/settle"))).toHaveLength(0);
    await c.close();
  });
});
