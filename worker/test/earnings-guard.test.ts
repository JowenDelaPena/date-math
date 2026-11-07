// Guards for the production payment config and the usage logs. If one of these fails, money could be going to the
// wrong place, at the wrong price, or not at all; fix the cause, don't loosen the test.
import { describe, expect, it } from "vitest";
import toml from "../wrangler.toml?raw";
import { mcpOutcome, outcome } from "../src/outcome";

// The owner's wallet. Changing it here and in wrangler.toml must be a deliberate, reviewed change.
const EXPECTED_PAY_TO = "0x7eC21Ee3AA308D2cbB8c65ef0E89af2a30101656";
const value = (key: string) => new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m").exec(toml)?.[1];

describe("production payment config (wrangler.toml)", () => {
  it("pays the owner's wallet", () => expect(value("PAY_TO")).toBe(EXPECTED_PAY_TO));
  it("charges $0.001 on Base mainnet", () => {
    expect(value("PRICE")).toBe("$0.001");
    expect(value("X402_NETWORK")).toBe("eip155:8453");
  });
  it("uses a known facilitator over HTTPS", () => expect(value("FACILITATOR_URL")).toBe("https://facilitator.payai.network"));
  it("keeps the free tier small", () => expect(Number(value("FREE_CALLS_PER_DAY"))).toBeLessThanOrEqual(25));
});

describe("usage-log outcomes", () => {
  const res = (status: number, headers: Record<string, string> = {}) => new Response("{}", { status, headers });
  const req = (headers: Record<string, string> = {}) => new Request("https://x/v1/info", { method: "POST", headers });

  it("HTTP: paid only with a settlement header", () => {
    expect(outcome(res(200, { "PAYMENT-RESPONSE": "e30=" }), true, req({ "PAYMENT-SIGNATURE": "x" }))).toBe("paid");
    expect(outcome(res(200), true, req())).toBe("unverified"); // a 200 without settlement must never count as paid
    expect(outcome(res(402), true, req())).toBe("unpaid");
    expect(outcome(res(402), true, req({ "PAYMENT-SIGNATURE": "x" }))).toBe("payment_failed");
    expect(outcome(res(200), false, req())).toBe("free");
  });

  it("MCP: paid only with a successful settlement in the result", () => {
    const rpc = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, result });
    expect(mcpOutcome(rpc({ content: [], _meta: { "x402/payment-response": { success: true, transaction: "0xabc" } } }), true)).toEqual({ outcome: "paid", tx: "0xabc" });
    expect(mcpOutcome(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "schema" } }), true).outcome).toBe("rpc_error");
    expect(mcpOutcome(rpc({ content: [{ type: "text", text: '{"error":"Payment required to access this tool"}' }], isError: true }), false).outcome).toBe("unpaid");
    expect(mcpOutcome(rpc({ content: [{ type: "text", text: "settle failed" }], isError: true }), true).outcome).toBe("payment_failed");
    expect(mcpOutcome(rpc({ content: [], _meta: { "date-math/free_calls_remaining": 3 } }), false).outcome).toBe("free_tier");
    expect(mcpOutcome(rpc({ content: [] }), true).outcome).toBe("payment_failed");
    expect(mcpOutcome("not json", false).outcome).toBe("unparsable");
  });
});
