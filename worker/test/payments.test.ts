import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import server from "../../server.json";
import worker from "../src/index";

const PAY_TO = "0x000000000000000000000000000000000000dEaD";
const env = { PAY_TO, PRICE: "$0.001", X402_NETWORK: "eip155:84532", FACILITATOR_URL: "https://facilitator.test", POCKET_PREFIX: "pk-secret-123" };
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} };
const realFetch = globalThis.fetch;

beforeEach(() => {
  // Fake facilitator: advertises exact on Base Sepolia, rejects everything else.
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/supported")) {
      return new Response(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }], extensions: [], signers: {} }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ isValid: false, invalidReason: "test" }), { status: 400 });
  });
});
afterEach(() => vi.stubGlobal("fetch", realFetch));

const call = (path: string, init?: RequestInit, e: Record<string, string> = env) =>
  worker.fetch(new Request("https://date-math.example" + path, init), e, ctx);
const post = (path: string, body: unknown, e?: Record<string, string>) =>
  call(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", Accept: "application/json" } }, e);

describe("x402 paywall", () => {
  it("returns 402 with x402 v2 terms for unpaid compute calls", async () => {
    const res = await post("/v1/info", { date: "2026-11-07" });
    expect(res.status).toBe(402);
    const header = res.headers.get("PAYMENT-REQUIRED");
    expect(header).toBeTruthy();
    const terms = JSON.parse(atob(header!));
    expect(terms.x402Version).toBe(2);
    expect(terms.accepts[0]).toMatchObject({ scheme: "exact", network: "eip155:84532", payTo: PAY_TO });
    expect(terms.accepts[0].amount).toBe("1000"); // $0.001 in USDC (6 decimals)
    const text = await res.text();
    expect(text.startsWith("{")).toBe(true);
    expect(JSON.parse(text).error.code).toBe("payment_required");
  });

  it("keeps probes, overview and spec free", async () => {
    for (const p of ["/", "/v1/version", "/v1/health", "/openapi.json", "/v1/openapi.json"]) {
      expect((await call(p)).status, p).toBe(200);
    }
  });

  it("rejects a bogus payment", async () => {
    const res = await call("/v1/info", {
      method: "POST",
      body: JSON.stringify({ date: "2026-11-07" }),
      headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": btoa("{}") },
    });
    expect(res.status).toBe(402);
  });
});

describe("Pocket supplier path", () => {
  it("is free under the secret prefix", async () => {
    const res = await post("/pk-secret-123/v1/info", { date: "2024-02-29" });
    expect(res.status).toBe(200);
    expect((await res.json()).weekday).toBe("Thursday");
    expect((await call("/pk-secret-123/v1/version")).status).toBe(200);
  });
  it("a wrong prefix is not free", async () => {
    expect((await post("/pk-wrong/v1/info", { date: "2024-02-29" })).status).toBe(404);
  });
});

describe("no PAY_TO = payments off", () => {
  it("serves compute calls free", async () => {
    const res = await post("/v1/info", { date: "2024-02-29" }, {});
    expect(res.status).toBe(200);
  });
});

describe("discovery", () => {
  it("serves /.well-known/x402, /llms.txt and an OpenAPI with x-payment-info", async () => {
    const wk = await (await call("/.well-known/x402")).json();
    expect(wk.version).toBe(1);
    expect(wk.resources).toHaveLength(16);
    expect((await call("/llms.txt")).status).toBe(200);
    const spec = await (await call("/openapi.json")).json();
    expect(spec.info["x-guidance"]).toContain("POST /v1/diff");
    expect(spec["x-discovery"]).toBeUndefined();
    for (const p of ["/v1/diff", "/v1/add", "/v1/convert", "/v1/info", "/v1/holidays", "/v1/overlap", "/v1/cron", "/v1/parse", "/v1/city", "/v1/recurrence", "/v1/business_hours", "/v1/business_day", "/v1/pay_dates", "/v1/stay", "/v1/timestamp", "/v1/dst"]) {
      expect(spec.paths[p].post["x-payment-info"]).toEqual({ price: { mode: "fixed", currency: "USD", amount: "0.001" }, protocols: [{ x402: {} }] });
      expect(spec.paths[p].post.responses["200"].content["application/json"].schema.properties).toBeTruthy();
      expect(spec.paths[p].post.responses["402"]).toEqual({ description: "Payment Required" });
    }
  });

  it("serves an MCP Server Card (SEP-2127) and an AI Catalog that points to it, matching server.json", async () => {

    for (const path of ["/mcp/server-card", "/.well-known/mcp/server-card.json"]) {
      const res = await call(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/mcp-server-card+json");
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      const card = await res.json();
      expect(card.$schema).toBe("https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json");
      expect(card).toMatchObject({ name: server.name, version: server.version, description: server.description, title: server.title });
      expect(card.description.length).toBeLessThanOrEqual(100);
      expect(card.remotes[0]).toMatchObject({ type: "streamable-http", url: server.remotes[0].url });
      expect(card.remotes[0].supportedProtocolVersions).toContain("2025-06-18");
    }
    const cat = await call("/.well-known/ai-catalog.json");
    expect(cat.headers.get("content-type")).toBe("application/ai-catalog+json");
    const { entries } = await cat.json();
    expect(entries).toEqual([expect.objectContaining({ type: "application/mcp-server-card+json", url: "https://date-math.datemath.workers.dev/mcp/server-card" })]);
  });

  it("402 challenge carries a Bazaar input schema (x402scan requirement)", async () => {
    const res = await post("/v1/diff", { from: "2026-01-01", to: "2026-02-01" });
    const terms = JSON.parse(atob(res.headers.get("PAYMENT-REQUIRED")!));
    const bazaar = terms.extensions.bazaar;
    expect(bazaar.info.input.body).toBeTruthy();
    expect(JSON.stringify(bazaar.schema)).toContain("from");
  });
});
