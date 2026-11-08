import { describe, expect, it } from "vitest";
import app from "../src/app";
import spec from "../src/openapi.json";

const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "Content-Type": "application/json" } });

async function json(res: Response) {
  const text = await res.text();
  expect(text.startsWith("{")).toBe(true); // Pocket rule: every body starts with {
  return JSON.parse(text);
}

describe("probes", () => {
  it("identity", async () => {
    const res = await app.request("/v1/version");
    expect(await json(res)).toEqual({ service: "date-math", version: "1.6.0" });
    expect(res.headers.get("cache-control")).toContain("no-transform");
  });
  it("health", async () => expect(await json(await app.request("/v1/health"))).toEqual({ status: "ok" }));
  it("openapi", async () => expect((await json(await app.request("/openapi.json"))).openapi).toBe("3.1.0"));
});

describe("info", () => {
  it("matches the spec example", async () => {
    const ex = (spec.paths["/v1/info"].post.responses["200"].content as any)["application/json"].example;
    expect(await json(await post("/v1/info", { date: "2026-11-07" }))).toEqual(ex);
  });
  it("leap year + ISO week edge", async () => {
    const r = await json(await post("/v1/info", { date: "2024-12-30" }));
    expect(r).toMatchObject({ is_leap_year: true, iso_year: 2025, iso_week: 1, weekday: "Monday", day_of_year: 365 });
  });
});

describe("diff", () => {
  it("matches the spec example", async () => {
    const ex = (spec.paths["/v1/diff"].post.responses["200"].content as any)["application/json"].example;
    expect(await json(await post("/v1/diff", { from: "2026-01-31", to: "2026-03-15" }))).toEqual(ex);
  });
  it("backward + holidays", async () => {
    const r = await json(await post("/v1/diff", { from: "2026-12-31", to: "2026-12-21", holidays: ["2026-12-25"] }));
    expect(r).toMatchObject({ direction: "backward", total_days: -10, business_days: -7 });
  });
  it("datetimes", async () => {
    const r = await json(await post("/v1/diff", { from: "2026-11-07T08:00:00+08:00", to: "2026-11-08T03:30:15Z" }));
    expect(r).toMatchObject({ total_hours: 27, total_seconds: 27 * 3600 + 30 * 60 + 15, iso_duration: "P1DT3H30M15S" });
  });
  it("same day", async () => expect((await json(await post("/v1/diff", { from: "2026-01-01", to: "2026-01-01" }))).iso_duration).toBe("P0D"));
});

describe("add", () => {
  it("business days over weekend", async () => {
    const ex = (spec.paths["/v1/add"].post.responses["200"].content as any)["application/json"].example;
    expect(await json(await post("/v1/add", { date: "2026-11-06", business_days: 10 }))).toEqual(ex);
  });
  it("month-end clamp", async () => {
    expect((await json(await post("/v1/add", { date: "2024-01-31", months: 1 }))).result).toBe("2024-02-29");
    expect((await json(await post("/v1/add", { date: "2026-03-31", months: -1 }))).result).toBe("2026-02-28");
  });
  it("time units", async () => {
    expect((await json(await post("/v1/add", { date: "2026-11-07T23:00:00Z", hours: 2, minutes: 30 }))).result).toBe("2026-11-08T01:30:00Z");
  });
  it("rejects time on date", async () => expect((await post("/v1/add", { date: "2026-11-07", hours: 1 })).status).toBe(400));
});

describe("convert", () => {
  it("matches the spec example (local time)", async () => {
    const ex = (spec.paths["/v1/convert"].post.responses["200"].content as any)["application/json"].example;
    expect(await json(await post("/v1/convert", { datetime: "2026-11-07T14:30:00", from_timezone: "Asia/Manila", to_timezone: "America/New_York" }))).toEqual(ex);
  });
  it("DST summer offset", async () => {
    const r = await json(await post("/v1/convert", { datetime: "2026-07-01T12:00:00Z", to_timezone: "Europe/London" }));
    expect(r.to).toMatchObject({ time: "13:00:00", utc_offset: "+01:00" });
    expect(r.from.timezone).toBe("UTC");
  });
  it("local time in New York DST", async () => {
    const r = await json(await post("/v1/convert", { datetime: "2026-07-04T09:00", from_timezone: "America/New_York", to_timezone: "UTC" }));
    expect(r.utc).toBe("2026-07-04T13:00:00Z");
  });
  it("now", async () => expect((await json(await post("/v1/convert", { to_timezone: "Asia/Tokyo" }))).to.utc_offset).toBe("+09:00"));
});

describe("errors are JSON objects", () => {
  it.each([
    ["/v1/info", { date: "2026-02-30" }, 400, "invalid_date"],
    ["/v1/info", "not json", 400, "invalid_json"],
    ["/v1/info", [1, 2], 400, "invalid_json"],
    ["/v1/convert", { to_timezone: "Mars/Base" }, 400, "invalid_timezone"],
    ["/v1/convert", { datetime: "2026-11-07T10:00", to_timezone: "UTC" }, 400, "invalid_timezone"],
    ["/v1/diff", { from: "2026-01-01", to: "2026-01-02T00:00:00Z" }, 400, "mixed_formats"],
    ["/v1/add", { date: "2026-01-01", days: 1.5 }, 400, "invalid_number"],
    ["/v1/nope", {}, 404, "not_found"],
  ])("%s %j", async (path, body, status, code) => {
    const res = await post(path, body);
    expect(res.status).toBe(status);
    expect((await json(res)).error.code).toBe(code);
  });
});
