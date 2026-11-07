import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { handleMcp } from "../src/mcp";
import { clientKey, FreeQuota, freeLimit } from "../src/quota";

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} };
const PAID_ENV = { PAY_TO: "0x000000000000000000000000000000000000dEaD", X402_NETWORK: "eip155:84532", FACILITATOR_URL: "https://facilitator.test" };
const realFetch = globalThis.fetch;

let id = 0;
async function rpc(method: string, params: unknown, env: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const res = await worker.fetch(
    new Request("https://date-math.example/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    }),
    env as any,
    ctx,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

describe("MCP (payments off)", () => {
  it("initializes and lists every tool with schemas", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.result.serverInfo.name).toBe("date-math");
    const list = await rpc("tools/list", {});
    expect(list.result.tools.map((t: any) => t.name)).toEqual([
      "date_diff", "date_add", "timezone_convert", "date_info", "public_holidays", "working_hours_overlap", "cron_schedule", "parse_date_text", "city_time", "recurring_dates", "business_hours_deadline", "business_day", "pay_dates",
    ]);
    for (const t of list.result.tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.outputSchema.type).toBe("object");
      expect(t.annotations.readOnlyHint).toBe(true);
    }
  });
  it("calls a tool and returns structured content", async () => {
    const r = await rpc("tools/call", { name: "date_info", arguments: { date: "2024-02-29" } });
    expect(r.result.structuredContent.weekday).toBe("Thursday");
    expect(JSON.parse(r.result.content[0].text).weekday).toBe("Thursday");
  });
  it("returns tool errors as isError", async () => {
    const r = await rpc("tools/call", { name: "date_info", arguments: { date: "2026-02-30" } });
    expect(r.result.isError).toBe(true);
    expect(JSON.parse(r.result.content[0].text).error.code).toBe("invalid_date");
  });
  it("rejects GET", async () => {
    const res = await worker.fetch(new Request("https://date-math.example/mcp"), {}, ctx);
    expect(res.status).toBe(405);
  });
});

describe("MCP (payments on)", () => {
  beforeEach(() => {
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

  it("unpaid tool call returns x402 payment requirements, not the result", async () => {
    const r = await rpc("tools/call", { name: "date_info", arguments: { date: "2024-02-29" } }, PAID_ENV);
    expect(r.result.isError).toBe(true);
    const blob = JSON.stringify(r.result);
    expect(blob).toContain("eip155:84532");
    expect(blob).toContain(PAID_ENV.PAY_TO);
    expect(blob).toContain('"1000"');
    expect(blob).not.toContain("Thursday");
  });
  it("tools/list stays free and mentions the price", async () => {
    const list = await rpc("tools/list", {}, PAID_ENV);
    expect(list.result.tools[0].description).toContain("$0.001");
  });
});

/** In-memory stand-in for the FREE_QUOTA Durable Object namespace: one real FreeQuota per name. */
function fakeQuotaNs() {
  const objects = new Map<string, FreeQuota>();
  return {
    names: () => [...objects.keys()],
    idFromName: (name: string) => name,
    get(id: unknown) {
      const name = String(id);
      if (!objects.has(name)) {
        const store = new Map<string, unknown>();
        objects.set(name, new FreeQuota({ storage: { get: async (k: string) => store.get(k) as any, put: async (k: string, v: unknown) => void store.set(k, v) } }));
      }
      const obj = objects.get(name)!;
      return { fetch: (input: string, init?: RequestInit) => obj.fetch(new Request(input, init)) };
    },
  };
}

describe("MCP free tier", () => {
  beforeEach(() => {
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

  const call = (env: Record<string, unknown>, ip = "203.0.113.7", meta?: Record<string, unknown>) =>
    rpc("tools/call", { name: "date_info", arguments: { date: "2024-02-29" }, ...(meta ? { _meta: meta } : {}) }, env, { "CF-Connecting-IP": ip });

  it("gives each IP N free calls per day, then asks for payment", async () => {
    const env = { ...PAID_ENV, FREE_QUOTA: fakeQuotaNs(), FREE_CALLS_PER_DAY: "2" };
    const first = await call(env);
    expect(first.result.isError).toBeUndefined();
    expect(first.result.structuredContent.weekday).toBe("Thursday");
    expect(first.result._meta["date-math/free_calls_remaining"]).toBe(1);
    const second = await call(env);
    expect(second.result._meta["date-math/free_calls_remaining"]).toBe(0);
    const third = await call(env);
    expect(third.result.isError).toBe(true);
    expect(JSON.stringify(third.result)).toContain(PAID_ENV.PAY_TO);
    expect(JSON.stringify(third.result)).not.toContain("Thursday");
    // A different IP has its own allowance.
    const other = await call(env, "198.51.100.9");
    expect(other.result.structuredContent.weekday).toBe("Thursday");
  });

  it("counts an IPv6 /64 as one client", async () => {
    const ns = fakeQuotaNs();
    const env = { ...PAID_ENV, FREE_QUOTA: ns, FREE_CALLS_PER_DAY: "1" };
    expect((await call(env, "2001:db8:1:2::a")).result.isError).toBeUndefined();
    expect((await call(env, "2001:db8:1:2:ffff::b")).result.isError).toBe(true);
    expect(ns.names()).toEqual(["2001:db8:1:2::/64"]);
  });

  it("does not spend free calls when the client attaches a payment", async () => {
    const ns = fakeQuotaNs();
    const env = { ...PAID_ENV, FREE_QUOTA: ns, FREE_CALLS_PER_DAY: "5" };
    const r = await call(env, "203.0.113.7", { "x402/payment": { x402Version: 2, payload: {} } });
    expect(r.result.isError).toBe(true); // bogus payment rejected by the fake facilitator
    expect(ns.names()).toEqual([]);
  });

  it("is off without the binding, with FREE_CALLS_PER_DAY=0, or without a client IP", async () => {
    expect((await call(PAID_ENV)).result.isError).toBe(true);
    expect((await call({ ...PAID_ENV, FREE_QUOTA: fakeQuotaNs(), FREE_CALLS_PER_DAY: "0" })).result.isError).toBe(true);
    const noIp = await rpc("tools/call", { name: "date_info", arguments: { date: "2024-02-29" } }, { ...PAID_ENV, FREE_QUOTA: fakeQuotaNs() });
    expect(noIp.result.isError).toBe(true);
  });

  it("falls back to payment if the quota store fails", async () => {
    const broken = { idFromName: (n: string) => n, get: () => ({ fetch: async () => { throw new Error("down"); } }) };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await call({ ...PAID_ENV, FREE_QUOTA: broken });
    err.mockRestore();
    expect(r.result.isError).toBe(true);
    expect(JSON.stringify(r.result)).toContain(PAID_ENV.PAY_TO);
  });

  it("advertises the free tier in tools/list", async () => {
    const list = await rpc("tools/list", {}, { ...PAID_ENV, FREE_QUOTA: fakeQuotaNs() }, { "CF-Connecting-IP": "203.0.113.7" });
    expect(list.result.tools[0].description).toContain("First 25 calls per day are free, then $0.001 per call");
  });

  it("leaves plain HTTP routes paid (x402 discovery expects 402)", async () => {
    const res = await worker.fetch(
      new Request("https://date-math.example/v1/info", { method: "POST", body: '{"date":"2026-11-07"}', headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" } }),
      { ...PAID_ENV, FREE_QUOTA: fakeQuotaNs() } as any,
      ctx,
    );
    expect(res.status).toBe(402);
  });
});

describe("quota helpers", () => {
  it("keys IPv4 as is and IPv6 by /64", () => {
    expect(clientKey("203.0.113.7")).toBe("203.0.113.7");
    expect(clientKey("2001:0db8:0001:0002:0000:0000:0000:000a")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(clientKey("::1")).toBe("0:0:0:0::/64");
    expect(clientKey(null)).toBeNull();
  });
  it("parses the daily limit", () => {
    expect(freeLimit(undefined)).toBe(25);
    expect(freeLimit("10")).toBe(10);
    expect(freeLimit("0")).toBe(0);
    expect(freeLimit("abc")).toBe(0);
  });
});

describe("MCP fast path matches the SDK", () => {
  const H = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" };
  const both = async (msg: unknown, env: Record<string, unknown>) => {
    const make = () => new Request("https://x/mcp", { method: "POST", headers: H, body: JSON.stringify(msg) });
    const [fast, sdk] = [await handleMcp(make(), env as any), await handleMcp(make(), env as any, { sdkOnly: true })];
    const read = async (r: Response) => ({ status: r.status, type: r.headers.get("content-type"), body: r.status === 202 ? null : await r.json() });
    return [await read(fast), await read(sdk)];
  };
  const PAID_ENV_ = { PAY_TO: "0x000000000000000000000000000000000000dEaD", X402_NETWORK: "eip155:84532", FACILITATOR_URL: "https://facilitator.test" };
  const cases: [string, unknown][] = [
    ["initialize", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }],
    ["initialize, unknown version", { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "t", version: "1" } } }],
    ["ping", { jsonrpc: "2.0", id: "p", method: "ping" }],
    ["notification", { jsonrpc: "2.0", method: "notifications/initialized" }],
    ["tools/list", { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }],
    ["tools/call", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "business_day", arguments: { date: "2026-12-25", country: "PH" } } }],
    ["tools/call error", { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "pay_dates", arguments: { schedule: "daily" } } }],
    ["unknown tool", { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope", arguments: {} } }],
  ];
  for (const [label, msg] of cases) {
    it(`${label} (payments off)`, async () => {
      const [fast, sdk] = await both(msg, {});
      expect(fast).toEqual(sdk);
    });
  }
  it("initialize and tools/list (payments on, free tier)", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }], extensions: [], signers: {} }), { headers: { "Content-Type": "application/json" } }));
    try {
      for (const [, msg] of cases.slice(0, 5)) {
        const [fast, sdk] = await both(msg, { ...PAID_ENV_, FREE_QUOTA: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ remaining: 1 }) }) } });
        expect(fast).toEqual(sdk);
      }
    } finally {
      vi.stubGlobal("fetch", realFetch);
    }
  });
});
