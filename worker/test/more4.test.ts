import { describe, expect, it } from "vitest";
import { currentTime, freeSlots, marketCalendar, slaCountdown, subscriptionDates } from "../src/more4";
import worker from "../src/index";

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} };
const PAID_ENV = { PAY_TO: "0x000000000000000000000000000000000000dEaD", X402_NETWORK: "eip155:84532", FACILITATOR_URL: "https://facilitator.test" };

describe("sla_countdown", () => {
  const base = { start: "2026-11-06T16:00", sla_hours: 4, timezone: "Asia/Manila", country: "PH" }; // Friday 16:00, 9–17 workdays

  it("counts business minutes across a weekend and a manual pause", () => {
    const r = slaCountdown({ ...base, now: "2026-11-09T10:30", pauses: [{ start: "2026-11-09T01:00:00Z", end: "2026-11-09T01:30:00Z" }] });
    // Fri 16:00–17:00 (60) + Mon 09:30–10:30 (60; 09:00–09:30 paused)
    expect(r).toMatchObject({ elapsed_business_minutes: 120, remaining_business_minutes: 120, breached: false, status: "running", deadline: "2026-11-09T12:30:00+08:00", deadline_utc: "2026-11-09T04:30:00Z", percent_used: 50 });
  });

  it("reports a breach and by how much", () => {
    const r = slaCountdown({ ...base, now: "2026-11-09T13:00" });
    expect(r).toMatchObject({ elapsed_business_minutes: 300, breached: true, breached_by_business_minutes: 60, status: "breached", remaining_business_minutes: 0, deadline: "2026-11-09T12:00:00+08:00" });
  });

  it("pauses on weekends, holidays and open manual pauses", () => {
    expect(slaCountdown({ ...base, now: "2026-11-07T10:00" })).toMatchObject({ elapsed_business_minutes: 60, status: "paused_weekend", resumes_at: "2026-11-09T09:00:00+08:00" });
    expect(slaCountdown({ ...base, now: "2026-11-06T18:00" })).toMatchObject({ status: "paused_outside_hours", resumes_at: "2026-11-09T09:00:00+08:00" });
    expect(slaCountdown({ ...base, holidays: ["2026-11-09"], now: "2026-11-09T10:00" })).toMatchObject({ status: "paused_holiday", resumes_at: "2026-11-10T09:00:00+08:00" });
    const open = slaCountdown({ ...base, now: "2026-11-09T10:30", pauses: [{ start: "2026-11-09T01:00:00Z" }] });
    expect(open).toMatchObject({ elapsed_business_minutes: 60, status: "paused_manual", resumes_at: null, deadline: "2026-11-09T13:30:00+08:00" });
  });

  it("is DST-aware", () => {
    // Fri 2026-03-06 16:00 EST, 2 h SLA: 1 h on Friday, then Mon 09:00–10:00 EDT (clocks moved on Mar 8).
    const r = slaCountdown({ start: "2026-03-06T16:00", now: "2026-03-06T16:30", sla_hours: 2, timezone: "America/New_York" });
    expect(r.deadline).toBe("2026-03-09T10:00:00-04:00");
    expect(r.deadline_utc).toBe("2026-03-09T14:00:00Z");
  });

  it("validates input", () => {
    expect(() => slaCountdown({ ...base, now: "2026-11-09T10:00", sla_hours: undefined })).toThrow(/sla_hours/);
    expect(() => slaCountdown({ ...base, now: "2026-11-01T10:00" })).toThrow(/before start/);
    expect(() => slaCountdown({ ...base, now: "2026-11-09T10:00", pauses: [{ start: "x" }] })).toThrow(/ISO 8601/);
    expect(() => slaCountdown({ ...base, now: "2026-11-09T10:00", sla_hours: 5000 })).toThrow(/2000 hours/);
  });
});

describe("find_free_slots", () => {
  const people = [
    { timezone: "Asia/Manila", busy: [{ start: "2026-11-10T01:00:00Z", end: "2026-11-10T02:00:00Z" }] }, // 09–17 = 01:00–09:00Z
    { timezone: "Europe/London", work_start: "08:00", work_end: "16:00" }, // 08:00–16:00Z in November
  ];

  it("intersects working hours across zones", () => {
    const r = freeSlots({ participants: people, from: "2026-11-10", days: 2, duration_minutes: 30, max_slots: 3 });
    expect(r.free_windows.map((w) => [w.start_utc, w.end_utc])).toEqual([["2026-11-10T08:00:00Z", "2026-11-10T09:00:00Z"], ["2026-11-11T08:00:00Z", "2026-11-11T09:00:00Z"]]);
    expect(r.slots.map((s) => s.start_utc)).toEqual(["2026-11-10T08:00:00Z", "2026-11-10T08:30:00Z", "2026-11-11T08:00:00Z"]);
    expect(r.slots[0].local).toEqual([
      { timezone: "Asia/Manila", start: "2026-11-10T16:00:00+08:00", end: "2026-11-10T16:30:00+08:00" },
      { timezone: "Europe/London", start: "2026-11-10T08:00:00+00:00", end: "2026-11-10T08:30:00+00:00" },
    ]);
  });

  it("removes busy blocks (with buffer) and aligns slot starts", () => {
    const busy = [{ timezone: "Asia/Manila", busy: [{ start: "2026-11-10T08:00:00Z", end: "2026-11-10T08:20:00Z" }] }, people[1]];
    const r = freeSlots({ participants: busy, from: "2026-11-10", days: 1, duration_minutes: 30, step_minutes: 15 });
    expect(r.slots.map((s) => s.start_utc)).toEqual(["2026-11-10T08:30:00Z"]); // window 08:20–09:00, aligned to :30
    const buffered = freeSlots({ participants: busy, from: "2026-11-10", days: 1, duration_minutes: 30, step_minutes: 15, buffer_minutes: 15 });
    expect(buffered.count).toBe(0); // 08:35–09:00 is too short
  });

  it("skips weekends and country holidays, and works for one person", () => {
    const r = freeSlots({ participants: [{ timezone: "Asia/Manila", country: "PH" }], from: "2026-12-25", days: 3, duration_minutes: 480 });
    // Dec 25 is a PH holiday, Dec 26–27 a weekend
    expect(r.count).toBe(0);
    const one = freeSlots({ participants: [{ timezone: "Asia/Manila" }], from: "2026-11-10", days: 1, duration_minutes: 480 });
    expect(one.slots.map((s) => s.start_utc)).toEqual(["2026-11-10T01:00:00Z"]);
  });

  it("validates input", () => {
    expect(() => freeSlots({ participants: [], duration_minutes: 30 })).toThrow(/participants/);
    expect(() => freeSlots({ participants: people })).toThrow(/duration_minutes/);
    expect(() => freeSlots({ participants: [{ timezone: "Nope/Zone" }], duration_minutes: 30 })).toThrow(/time zone/);
    expect(() => freeSlots({ participants: people, duration_minutes: 30, days: 30 })).toThrow(/days/);
  });
});

describe("subscription_dates", () => {
  it("keeps month-end anchors and prorates by day", () => {
    const r = subscriptionDates({ start: "2026-01-31", interval: "month", as_of: "2026-03-10", notice_days: 7, amount: 30 });
    expect(r).toMatchObject({
      status: "active",
      current_period: { number: 2, start: "2026-02-28", end: "2026-03-30", days: 31, days_elapsed: 10, days_remaining: 21 },
      next_renewal: "2026-03-31",
      cancel_by: "2026-03-24",
      cancel_by_passed: false,
      upcoming_renewals: ["2026-03-31", "2026-04-30", "2026-05-31"],
      proration: { amount: 30, used: 9.68, unused: 20.32 },
    });
  });

  it("handles trials, leap-day yearly plans, weeks and future starts", () => {
    expect(subscriptionDates({ start: "2026-11-01", trial_days: 14, as_of: "2026-11-05" })).toMatchObject({ status: "trial", billing_start: "2026-11-15", next_renewal: "2026-11-15", current_period: null });
    expect(subscriptionDates({ start: "2024-02-29", interval: "year", as_of: "2026-06-01", count: 3 }).upcoming_renewals).toEqual(["2027-02-28", "2028-02-29", "2029-02-28"]);
    expect(subscriptionDates({ start: "2026-11-02", interval: "week", interval_count: 2, as_of: "2026-11-20" })).toMatchObject({ next_renewal: "2026-11-30", current_period: { start: "2026-11-16", days: 14 } });
    expect(subscriptionDates({ start: "2026-12-01", as_of: "2026-11-01" }).status).toBe("not_started");
    expect(subscriptionDates({ start: "2026-01-15", interval: "month", interval_count: 3, as_of: "2026-04-15" }).current_period).toMatchObject({ number: 2, start: "2026-04-15", days_elapsed: 0 });
  });

  it("validates input", () => {
    expect(() => subscriptionDates({ start: "2026-01-01", interval: "fortnight" })).toThrow(/interval/);
    expect(() => subscriptionDates({ start: "2026-01-01", amount: -1 })).toThrow(/amount/);
  });
});

describe("market_calendar", () => {
  it("knows NYSE early closes, settlement and the open/closed status", () => {
    const r = marketCalendar({ exchange: "NYSE", date: "2026-11-27", at: "2026-11-27T17:00:00Z" });
    expect(r).toMatchObject({
      exchange: "XNYS", is_trading_day: true, early_close: "Day after Thanksgiving",
      session: { open: "2026-11-27T09:30:00-05:00", close: "2026-11-27T13:00:00-05:00", close_utc: "2026-11-27T18:00:00Z", break: null },
      previous_trading_day: "2026-11-25", next_trading_day: "2026-11-30",
      settlement: { cycle: "T+1", settlement_date: "2026-11-30" },
      status: { is_open: true, phase: "open", next_close: "2026-11-27T18:00:00Z", next_open: "2026-11-30T14:30:00Z" },
    });
  });

  it("lists the 2026 NYSE calendar", () => {
    const cal = marketCalendar({ exchange: "XNYS", date: "2026-01-02", at: "2026-01-02T15:00:00Z", list_year: 2026 }).calendar!;
    expect(cal.filter((d) => d.type === "closed").map((d) => d.date)).toEqual([
      "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
    ]);
    expect(cal.filter((d) => d.type === "early_close").map((d) => [d.date, d.close])).toEqual([["2026-11-27", "13:00"], ["2026-12-24", "13:00"]]);
  });

  it("applies NYSE observance rules and special closures", () => {
    const y2027 = marketCalendar({ exchange: "NYSE", date: "2027-12-31", at: "2027-12-31T15:00:00Z", list_year: 2027 });
    expect(y2027.is_trading_day).toBe(true); // New Year 2028 falls on a Saturday: not observed on Friday
    expect(y2027.calendar!.filter((d) => d.type === "closed").map((d) => d.date)).toContain("2027-07-05");
    expect(y2027.calendar!.map((d) => d.date)).toContain("2027-06-18");
    expect(marketCalendar({ exchange: "NYSE", date: "2025-01-09", at: "2025-01-09T15:00:00Z" }).holiday).toBe("National Day of Mourning (Carter)");
    expect(marketCalendar({ exchange: "NYSE", date: "2025-07-03", at: "2025-07-03T15:00:00Z" }).early_close).toBe("Day before Independence Day");
    // US settlement skips Columbus Day and Veterans Day (markets open, banks closed)
    expect(marketCalendar({ exchange: "NYSE", date: "2026-10-09", at: "2026-10-09T15:00:00Z" }).settlement!.settlement_date).toBe("2026-10-13");
    expect(marketCalendar({ exchange: "NYSE", date: "2026-11-11", at: "2026-11-11T15:00:00Z" })).toMatchObject({ is_trading_day: true, settlement: { settlement_date: "2026-11-12" } });
    expect(marketCalendar({ exchange: "NYSE", date: "2026-11-10", at: "2026-11-10T15:00:00Z" }).settlement!.settlement_date).toBe("2026-11-12");
    expect(marketCalendar({ exchange: "NYSE", date: "2023-06-01", at: "2023-06-01T15:00:00Z" }).settlement!.cycle).toBe("T+2");
  });

  it("knows London bank holidays and half days", () => {
    const cal = marketCalendar({ exchange: "LSE", date: "2026-12-24", at: "2026-12-24T10:00:00Z", list_year: 2026 });
    expect(cal.calendar!.filter((d) => d.type === "closed").map((d) => d.date)).toEqual(["2026-01-01", "2026-04-03", "2026-04-06", "2026-05-04", "2026-05-25", "2026-08-31", "2026-12-25", "2026-12-28"]);
    expect(cal).toMatchObject({ early_close: "Christmas Eve", session: { close: "2026-12-24T12:30:00+00:00" }, settlement: { cycle: "T+2", settlement_date: "2026-12-30" } }); // skips Dec 25 and the Dec 28 substitute holiday
    const y2022 = marketCalendar({ exchange: "XLON", date: "2022-06-01", at: "2022-06-01T10:00:00Z", list_year: 2022 }).calendar!.map((d) => d.date);
    expect(y2022).toEqual(expect.arrayContaining(["2022-06-02", "2022-06-03", "2022-09-19"]));
    expect(marketCalendar({ exchange: "LSE", date: "2020-05-08", at: "2020-05-08T10:00:00Z" }).holiday).toBe("Early May Bank Holiday");
  });

  it("knows Tokyo's lunch break, New Year closure and substitute holidays", () => {
    const r = marketCalendar({ exchange: "TSE", date: "2026-11-10", at: "2026-11-10T03:00:00Z" }); // 12:00 JST
    expect(r).toMatchObject({ session: { open: "2026-11-10T09:00:00+09:00", close: "2026-11-10T15:30:00+09:00", break: { start: "2026-11-10T11:30:00+09:00", end: "2026-11-10T12:30:00+09:00" } }, status: { is_open: false, phase: "break", next_open: "2026-11-10T03:30:00Z", next_close: "2026-11-10T06:30:00Z" }, settlement: { cycle: "T+2", settlement_date: "2026-11-12" } });
    expect(marketCalendar({ exchange: "JPX", date: "2026-01-02", at: "2026-01-02T01:00:00Z" })).toMatchObject({ is_trading_day: false, holiday: "New Year holiday" });
    expect(marketCalendar({ exchange: "XTKS", date: "2026-05-06", at: "2026-05-06T01:00:00Z" }).is_trading_day).toBe(false);
    expect(marketCalendar({ exchange: "XTKS", date: "2024-10-01", at: "2024-10-01T01:00:00Z" }).session!.close).toBe("2024-10-01T15:00:00+09:00");
  });

  it("reports weekends and phases, and validates input", () => {
    expect(marketCalendar({ exchange: "NYSE", date: "2026-11-28", at: "2026-11-28T15:00:00Z" })).toMatchObject({ is_trading_day: false, reason: "weekend", session: null, settlement: null, status: { phase: "closed_today", next_open: "2026-11-30T14:30:00Z" } });
    expect(marketCalendar({ exchange: "NYSE", at: "2026-11-10T13:00:00Z" }).status.phase).toBe("pre_open");
    expect(marketCalendar({ exchange: "NYSE", at: "2026-11-10T22:00:00Z" }).status).toMatchObject({ phase: "after_close", next_open: "2026-11-11T14:30:00Z" });
    expect(() => marketCalendar({ exchange: "MOON" })).toThrow(/exchange must be/);
    expect(() => marketCalendar({ exchange: "NYSE", date: "2060-01-02" })).toThrow(/2000–2050/);
  });
});

describe("current_time (free)", () => {
  it("returns now in each zone", () => {
    const before = Date.now();
    const r = currentTime({ timezones: ["Asia/Manila", "America/New_York"] });
    expect(r.unix_ms).toBeGreaterThanOrEqual(before);
    expect(r.times.map((t) => t.timezone)).toEqual(["Asia/Manila", "America/New_York"]);
    expect(r.times[0].utc_offset).toBe("+08:00");
    expect(currentTime({}).times[0].timezone).toBe("UTC");
    expect(currentTime({ timezones: "Asia/Manila, Europe/London" }).times).toHaveLength(2);
    expect(() => currentTime({ timezone: "Nope/Zone" })).toThrow(/time zone/);
  });

  it("is free over HTTP GET even with payments on, and POST is not a route", async () => {
    const res = await worker.fetch(new Request("https://date-math.example/v1/now?timezones=Asia/Manila"), PAID_ENV as any, ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).times[0].timezone).toBe("Asia/Manila");
    const bad = await worker.fetch(new Request("https://date-math.example/v1/now?timezone=Nope/Zone"), PAID_ENV as any, ctx);
    expect(bad.status).toBe(400);
  });
});

describe("landing page", () => {
  const get = (accept: string) => worker.fetch(new Request("https://date-math.example/", { headers: { Accept: accept } }), PAID_ENV as any, ctx);

  it("serves HTML to browsers with a strict CSP, listing every tool", async () => {
    const res = await get("text/html,application/xhtml+xml,*/*;q=0.8");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await res.text();
    const { TOOLS } = await import("../src/tools");
    for (const t of TOOLS) expect(html, t.name).toContain(`<code>${t.name}</code>`);
    expect(html).toContain("current_time");
    expect(html).not.toMatch(/gradient/i);
  });

  it("keeps the JSON index for agents and scripts", async () => {
    for (const accept of ["application/json", "*/*", ""]) {
      const res = await get(accept);
      expect(res.headers.get("content-type"), accept).toContain("application/json");
      expect((await res.json()).service).toBe("date-math");
    }
  });
});

describe("form-style arguments (blank optional fields)", () => {
  it("current_time accepts timezone with an empty timezones list, or both together", () => {
    expect(currentTime({ timezone: "Asia/Manila", timezones: [] }).times.map((t) => t.timezone)).toEqual(["Asia/Manila"]);
    expect(currentTime({ timezone: "Asia/Manila", timezones: ["Europe/London"] }).times.map((t) => t.timezone)).toEqual(["Asia/Manila", "Europe/London"]);
  });

  it("every tool still works when untouched optional fields arrive as [] or \"\"", async () => {
    const { FREE_TOOLS, TOOLS } = await import("../src/tools");
    const { inputSchemaFor } = await import("../src/payments");
    const tools = [...TOOLS.map((t) => ({ t, schema: inputSchemaFor(t.path) as any })), ...FREE_TOOLS.map((t) => ({ t, schema: t.inputSchema as any }))];
    for (const { t, schema } of tools) {
      const body: Record<string, unknown> = { ...t.example };
      for (const [k, prop] of Object.entries<any>(schema.properties ?? {})) {
        if (k in body) continue;
        const types = [prop.type].flat();
        body[k] = types.includes("array") ? [] : types.includes("string") || prop.pattern || prop.$ref ? "" : null;
      }
      expect(() => t.run(body), `${t.name} ${JSON.stringify(body)}`).not.toThrow();
    }
  });
});
