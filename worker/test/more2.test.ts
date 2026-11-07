import { describe, expect, it } from "vitest";
import app from "../src/app";

const post = async (path: string, body: unknown) => {
  const res = await app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  const text = await res.text();
  expect(text.startsWith("{")).toBe(true);
  return { status: res.status, body: JSON.parse(text) };
};

describe("city_time", () => {
  it("resolves common and accented names", async () => {
    const { body } = await post("/v1/city", { cities: ["Cebu", "Tokyo", "São Paulo", "sao paulo", "London"], at: "2026-11-07T06:30:00Z" });
    const tz = body.results.map((r: any) => r.best?.timezone);
    expect(tz).toEqual(["Asia/Manila", "Asia/Tokyo", "America/Sao_Paulo", "America/Sao_Paulo", "Europe/London"]);
    expect(body.results[0].best.local_time).toBe("2026-11-07T14:30:00+08:00");
  });
  it("country filter disambiguates", async () => {
    const au = await post("/v1/city", { city: "Perth", country: "AU" });
    expect(au.body.results[0].best.timezone).toBe("Australia/Perth");
    const gb = await post("/v1/city", { city: "Perth", country: "GB" });
    expect(gb.body.results[0].best?.timezone ?? "none").toMatch(/Europe\/London|none/);
  });
  it("falls back to IANA zone names and reports misses", async () => {
    expect((await post("/v1/city", { city: "Ho Chi Minh" })).body.results[0].best.timezone).toBe("Asia/Ho_Chi_Minh");
    expect((await post("/v1/city", { city: "Qwertyville" })).body.results[0].found).toBe(false);
    expect((await post("/v1/city", {})).body.error.code).toBe("invalid_city");
  });
});

describe("recurring_dates", () => {
  it("2nd Tuesday monthly in Manila", async () => {
    const { body } = await post("/v1/recurrence", { rrule: "FREQ=MONTHLY;BYDAY=2TU", start: "2026-01-01T10:00", timezone: "Asia/Manila", count: 3 });
    expect(body.occurrences.map((o: any) => o.local)).toEqual(["2026-01-13T10:00:00+08:00", "2026-02-10T10:00:00+08:00", "2026-03-10T10:00:00+08:00"]);
    expect(body.description).toMatch(/2nd Tuesday/);
  });
  it("keeps local wall time across DST (New York)", async () => {
    const { body } = await post("/v1/recurrence", { rrule: "RRULE:FREQ=WEEKLY;BYDAY=MO", start: "2026-03-02T09:00", timezone: "America/New_York", count: 2 });
    expect(body.occurrences.map((o: any) => o.utc)).toEqual(["2026-03-02T14:00:00Z", "2026-03-09T13:00:00Z"]);
    expect(body.occurrences.every((o: any) => o.local.slice(11, 16) === "09:00")).toBe(true);
  });
  it("COUNT/UNTIL inside the rule and excluded dates", async () => {
    const { body } = await post("/v1/recurrence", { rrule: "FREQ=DAILY;COUNT=5", start: "2026-12-23", exclude: ["2026-12-25"], count: 10 });
    expect(body.occurrences.map((o: any) => o.date)).toEqual(["2026-12-23", "2026-12-24", "2026-12-26", "2026-12-27"]);
  });
  it("rejects bad input", async () => {
    expect((await post("/v1/recurrence", { rrule: "FREQ=SOMETIMES", start: "2026-01-01" })).body.error.code).toBe("invalid_rrule");
    expect((await post("/v1/recurrence", { rrule: "DTSTART:20260101T000000Z\nRRULE:FREQ=DAILY", start: "2026-01-01" })).body.error.code).toBe("invalid_rrule");
    expect((await post("/v1/recurrence", { rrule: "FREQ=DAILY", start: "tomorrow" })).body.error.code).toBe("invalid_start");
  });
});

describe("business_hours_deadline", () => {
  it("2 business hours from Friday 16:00 lands Monday 10:00", async () => {
    const { body } = await post("/v1/business_hours", { start: "2026-11-06T16:00", hours: 2, timezone: "Asia/Manila" });
    expect(body).toMatchObject({ mode: "deadline", deadline: "2026-11-09T10:00:00+08:00", weekday: "Monday", business_minutes: 120 });
  });
  it("skips PH Bonifacio Day (Mon Nov 30)", async () => {
    const { body } = await post("/v1/business_hours", { start: "2026-11-27T16:00", hours: 2, timezone: "Asia/Manila", country: "PH" });
    expect(body.deadline).toBe("2026-12-01T10:00:00+08:00");
  });
  it("starting outside hours begins at next opening; custom hours/workdays", async () => {
    const r1 = await post("/v1/business_hours", { start: "2026-11-07T08:00", hours: 1, timezone: "Asia/Manila" }); // Saturday
    expect(r1.body.deadline).toBe("2026-11-09T10:00:00+08:00");
    const r2 = await post("/v1/business_hours", { start: "2026-11-07T08:00", hours: 1, timezone: "Asia/Manila", workdays: [6], work_start: "10:00", work_end: "14:00" });
    expect(r2.body.deadline).toBe("2026-11-07T11:00:00+08:00");
  });
  it("elapsed business time between two datetimes", async () => {
    const { body } = await post("/v1/business_hours", { start: "2026-11-06T16:00", end: "2026-11-09T10:00", timezone: "Asia/Manila" });
    expect(body).toMatchObject({ mode: "elapsed", business_minutes: 120, business_hours: 2 });
  });
  it("DST day in New York keeps local hours", async () => {
    // Sunday Mar 8 2026 is DST start; Friday 16:00 + 2h => Monday Mar 9 10:00 EDT
    const { body } = await post("/v1/business_hours", { start: "2026-03-06T16:00", hours: 2, timezone: "America/New_York" });
    expect(body).toMatchObject({ deadline: "2026-03-09T10:00:00-04:00", deadline_utc: "2026-03-09T14:00:00Z" });
  });
  it("validates", async () => {
    expect((await post("/v1/business_hours", { timezone: "Asia/Manila" })).body.error.code).toBe("invalid_request");
    expect((await post("/v1/business_hours", { timezone: "Asia/Manila", hours: 5000 })).body.error.code).toBe("invalid_hours");
    expect((await post("/v1/business_hours", { timezone: "Mars/Base", hours: 1 })).body.error.code).toBe("invalid_timezone");
  });
});

import { offsetCursor, zonedParts } from "../src/date";
describe("offsetCursor matches direct Intl lookups", () => {
  it.each(["America/New_York", "Europe/London", "Africa/Casablanca", "Australia/Lord_Howe", "Pacific/Chatham", "America/Santiago", "Asia/Manila"])(
    "%s, hourly samples across 2025-2028",
    (tz) => {
      const off = offsetCursor(tz);
      for (let t = Date.UTC(2025, 0, 1); t < Date.UTC(2029, 0, 1); t += 3_600_000 * 7) {
        expect(off(t), `${tz} @ ${new Date(t).toISOString()}`).toBe(zonedParts(new Date(t), tz).offsetMin);
      }
    },
  );
});
