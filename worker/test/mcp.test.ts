import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} };
const PAID_ENV = { PAY_TO: "0x000000000000000000000000000000000000dEaD", X402_NETWORK: "eip155:84532", FACILITATOR_URL: "https://facilitator.test" };
const realFetch = globalThis.fetch;

let id = 0;
async function rpc(method: string, params: unknown, env: Record<string, string> = {}) {
  const res = await worker.fetch(
    new Request("https://date-math.example/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    }),
    env,
    ctx,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

describe("MCP (payments off)", () => {
  it("initializes and lists 11 tools with schemas", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.result.serverInfo.name).toBe("date-math");
    const list = await rpc("tools/list", {});
    expect(list.result.tools.map((t: any) => t.name)).toEqual([
      "date_diff", "date_add", "timezone_convert", "date_info", "public_holidays", "working_hours_overlap", "cron_schedule", "parse_date_text", "city_time", "recurring_dates", "business_hours_deadline",
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
