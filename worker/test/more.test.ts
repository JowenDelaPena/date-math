import { describe, expect, it } from "vitest";
import app from "../src/app";
import { TOOLS } from "../src/tools";

const post = async (path: string, body: unknown) => {
  const res = await app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  const text = await res.text();
  expect(text.startsWith("{")).toBe(true);
  return { status: res.status, body: JSON.parse(text) };
};

describe("holidays", () => {
  it("US 2026 federal holidays incl. observed substitute", async () => {
    const { body } = await post("/v1/holidays", { country: "us", year: 2026 });
    const dates = body.holidays.map((h: any) => h.date);
    expect(body.country).toBe("US");
    for (const d of ["2026-01-19", "2026-05-25", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"]) expect(dates).toContain(d);
  });
  it("rejects unknown country and bad types", async () => {
    expect((await post("/v1/holidays", { country: "ZZ" })).body.error.code).toBe("unsupported_country");
    expect((await post("/v1/holidays", { country: "USA" })).body.error.code).toBe("invalid_country");
    expect((await post("/v1/holidays", { country: "US", year: 1999 })).body.error.code).toBe("year_out_of_range");
  });
});

describe("country-aware business days", () => {
  it("diff skips US Presidents' Day", async () => {
    expect((await post("/v1/diff", { from: "2026-01-31", to: "2026-03-15" })).body.business_days).toBe(30);
    expect((await post("/v1/diff", { from: "2026-01-31", to: "2026-03-15", country: "US" })).body.business_days).toBe(29);
  });
  it("add skips PH Christmas and Rizal Day", async () => {
    expect((await post("/v1/add", { date: "2026-12-22", business_days: 5 })).body.result).toBe("2026-12-29");
    expect((await post("/v1/add", { date: "2026-12-22", business_days: 5, country: "PH" })).body.result).toBe("2026-12-31");
  });
  it("caps the holiday year range", async () => {
    expect((await post("/v1/diff", { from: "1900-01-01", to: "2100-01-01", country: "US" })).body.error.code).toBe("range_too_large");
    expect((await post("/v1/diff", { from: "1990-01-01", to: "2001-01-01", country: "US" })).body.error.code).toBe("year_out_of_range");
  });
});

describe("overlap", () => {
  it("Manila + London 09-18 overlap 09:00-10:00Z", async () => {
    const { body } = await post("/v1/overlap", { timezones: ["Asia/Manila", "Europe/London"], date: "2026-11-10", work_start: "09:00", work_end: "18:00" });
    expect(body.total_overlap_minutes).toBe(60);
    expect(body.windows[0]).toMatchObject({ start_utc: "2026-11-10T09:00:00Z", end_utc: "2026-11-10T10:00:00Z" });
  });
  it("no overlap for Manila + London + New York 08-18", async () => {
    const { body } = await post("/v1/overlap", { timezones: ["Asia/Manila", "Europe/London", "America/New_York"], date: "2026-11-10", work_start: "08:00", work_end: "18:00" });
    expect(body.total_overlap_minutes).toBe(0);
  });
  it("per-participant hours and weekend skipping", async () => {
    const { body } = await post("/v1/overlap", {
      participants: [{ timezone: "America/New_York", work_start: "07:00", work_end: "11:00" }, { timezone: "Europe/Berlin" }],
      date: "2026-11-14", days: 3,
    });
    // Nov 14-15 are a weekend; Monday Nov 16: NY 07-11 = 12:00-16:00Z, Berlin 09-17 = 08:00-16:00Z
    expect(body.windows).toHaveLength(1);
    expect(body.windows[0]).toMatchObject({ start_utc: "2026-11-16T12:00:00Z", end_utc: "2026-11-16T16:00:00Z" });
  });
  it("validates input", async () => {
    expect((await post("/v1/overlap", { timezones: ["UTC"] })).body.error.code).toBe("invalid_participants");
    expect((await post("/v1/overlap", { timezones: ["UTC", "Asia/Tokyo"], work_start: "9am" })).body.error.code).toBe("invalid_time");
  });
});

describe("cron", () => {
  it("weekday 9am Manila", async () => {
    const { body } = await post("/v1/cron", { expression: "0 9 * * 1-5", timezone: "Asia/Manila", count: 3, from: "2026-11-07T00:00:00Z" });
    expect(body.description).toBe("At 09:00, Monday through Friday");
    expect(body.next_runs.map((r: any) => r.utc)).toEqual(["2026-11-09T01:00:00Z", "2026-11-10T01:00:00Z", "2026-11-11T01:00:00Z"]);
  });
  it("DST-aware in New York", async () => {
    const { body } = await post("/v1/cron", { expression: "30 8 * * *", timezone: "America/New_York", count: 2, from: "2026-10-31T00:00:00Z" });
    // Nov 1 2026 DST ends: 08:30 EDT (12:30Z) on Oct 31, 08:30 EST (13:30Z) on Nov 1
    expect(body.next_runs.map((r: any) => r.utc)).toEqual(["2026-10-31T12:30:00Z", "2026-11-01T13:30:00Z"]);
  });
  it("rejects garbage", async () => {
    expect((await post("/v1/cron", { expression: "every day" })).body.error.code).toBe("invalid_cron");
    expect((await post("/v1/cron", { expression: "99 * * * *" })).body.error.code).toBe("invalid_cron");
  });
});

describe("parse", () => {
  it("next friday at 3pm relative to a Saturday in Manila", async () => {
    const { body } = await post("/v1/parse", { text: "next friday at 3pm", timezone: "Asia/Manila", reference: "2026-11-07T14:00:00+08:00" });
    expect(body.results[0].start).toMatchObject({ local: "2026-11-13T15:00:00+08:00", weekday: "Friday" });
  });
  it("ranges and relative durations", async () => {
    const { body } = await post("/v1/parse", { text: "Dec 24 to Dec 26", timezone: "UTC", reference: "2026-11-07T00:00:00Z" });
    expect(body.results[0].start.date).toBe("2026-12-24");
    expect(body.results[0].end.date).toBe("2026-12-26");
    const r2 = await post("/v1/parse", { text: "in 2 weeks", timezone: "UTC", reference: "2026-11-07T10:00:00Z" });
    expect(r2.body.results[0].start.date).toBe("2026-11-21");
  });
  it("no match returns empty results", async () => {
    expect((await post("/v1/parse", { text: "hello world" })).body.count).toBe(0);
  });
});

describe("registry examples", () => {
  it.each(TOOLS.map((t) => [t.name, t] as const))("%s example runs and is routed", async (_n, t) => {
    const { status } = await post(t.path, t.example);
    expect(status).toBe(200);
  });
});

describe("overlap across mismatched DST", () => {
  it("New York + London: 3h overlap normally, 4h in the March gap when only the US has switched", async () => {
    const tz = ["America/New_York", "Europe/London"];
    expect((await post("/v1/overlap", { timezones: tz, date: "2026-03-03" })).body.total_overlap_minutes).toBe(180);
    const gap = await post("/v1/overlap", { timezones: tz, date: "2026-03-10" });
    expect(gap.body.total_overlap_minutes).toBe(240);
    expect(gap.body.windows[0]).toMatchObject({ start_utc: "2026-03-10T13:00:00Z", end_utc: "2026-03-10T17:00:00Z" });
  });
});
