import { describe, expect, it } from "vitest";
import { businessDay, payDates } from "../src/biz";
import { add, addBusinessDays, DAY_MS, diff, fmtDate, parseWorkdays, weekdaysBetween, type Workweek } from "../src/date";
import worker from "../src/index";

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} };
const post = (path: string, body: unknown) =>
  worker.fetch(new Request("https://date-math.example" + path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }), {} as any, ctx);

describe("custom workweeks", () => {
  it("diff counts Sun–Thu business days", () => {
    // 2026-11-01 is a Sunday; [Sun 1, Sun 8) holds Sun–Thu = 5 days with workdays [0..4], and 5 Mon–Fri days by default.
    expect(diff({ from: "2026-11-01", to: "2026-11-08", workdays: [0, 1, 2, 3, 4] }).business_days).toBe(5);
    expect(diff({ from: "2026-11-06", to: "2026-11-08", workdays: [0, 1, 2, 3, 4] }).business_days).toBe(0); // Fri, Sat
    expect(diff({ from: "2026-11-06", to: "2026-11-08" }).business_days).toBe(1); // Fri only
  });

  it("add skips Fri–Sat weekends and counts Saturdays for a Mon–Sat week", () => {
    expect(add({ date: "2026-11-05", business_days: 1, workdays: [0, 1, 2, 3, 4] }).result).toBe("2026-11-08"); // Thu -> Sun
    expect(add({ date: "2026-11-06", business_days: 1, workdays: [1, 2, 3, 4, 5, 6] }).result).toBe("2026-11-07"); // Fri -> Sat
    expect(add({ date: "2026-11-06", business_days: 1 }).result).toBe("2026-11-09"); // default Mon–Fri
  });

  it("rejects bad workdays with a helpful message", () => {
    for (const w of [[], [7], ["1"], [1.5], "1,2,3"]) expect(() => parseWorkdays(w), JSON.stringify(w)).toThrow(/workdays must be/);
  });

  it("matches a day-by-day walk for random workweeks and holidays", () => {
    let seed = 42;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    for (let trial = 0; trial < 300; trial++) {
      const ww: boolean[] = Array.from({ length: 7 }, () => rnd(3) > 0);
      if (!ww.some(Boolean)) ww[rnd(7)] = true;
      const start = Date.UTC(2026, 0, 1) + rnd(700) * DAY_MS;
      const hol = new Set<string>();
      for (let i = 0; i < rnd(12); i++) hol.add(fmtDate(new Date(start + (rnd(120) - 60) * DAY_MS)));
      const isBiz = (ms: number) => ww[new Date(ms).getUTCDay()] && !hol.has(fmtDate(new Date(ms)));

      // addBusinessDays vs brute force
      const n = rnd(60) - 30;
      let ms = start, left = Math.abs(n);
      while (left > 0) {
        ms += Math.sign(n) * DAY_MS;
        if (isBiz(ms)) left--;
      }
      expect(fmtDate(new Date(addBusinessDays(start, n, hol, ww as Workweek))), `trial ${trial}`).toBe(fmtDate(new Date(ms)));

      // weekdaysBetween (rest days only) vs brute force
      const end = start + rnd(40) * DAY_MS;
      let count = 0;
      for (let t = start; t < end; t += DAY_MS) if (ww[new Date(t).getUTCDay()]) count++;
      expect(weekdaysBetween(start, end, ww), `trial ${trial}`).toBe(count);
    }
  });
});

describe("business_day", () => {
  it("explains a holiday and finds the neighbours", () => {
    expect(businessDay({ date: "2026-12-25", country: "PH" })).toMatchObject({
      weekday: "Friday",
      is_business_day: false,
      reason: "holiday",
      holiday: "Christmas Day",
      next_business_day: "2026-12-28",
      previous_business_day: "2026-12-24",
      month: { business_day_number: null, first_business_day: "2026-12-01" },
    });
  });

  it("numbers business days in the month", () => {
    const r = businessDay({ date: "2026-11-04" }); // Wed; Nov 2026 starts on a Sunday
    expect(r).toMatchObject({ is_business_day: true, reason: null, holiday: null, month: { business_days: 21, first_business_day: "2026-11-02", last_business_day: "2026-11-30", business_day_number: 3 } });
  });

  it("supports Fri–Sat weekends and named custom holidays", () => {
    const fri = businessDay({ date: "2026-11-06", workdays: [0, 1, 2, 3, 4] });
    expect(fri).toMatchObject({ is_business_day: false, reason: "weekend", next_business_day: "2026-11-08" });
    const custom = businessDay({ date: "2026-11-09", holidays: ["2026-11-09"] });
    expect(custom).toMatchObject({ is_business_day: false, reason: "holiday", holiday: "Custom holiday", next_business_day: "2026-11-10" });
  });

  it("steps across a year boundary using next year's holidays", () => {
    // 2026-12-31 Thu; 2027-01-01 Fri is New Year's Day in the US -> next business day Mon 2027-01-04.
    expect(businessDay({ date: "2026-12-31", country: "US" }).next_business_day).toBe("2027-01-04");
  });
});

describe("pay_dates", () => {
  it("semi-monthly 15th and last day, moved back off weekends", () => {
    const r = payDates({ schedule: "semi_monthly", from: "2026-12-01", count: 4, country: "PH" });
    expect(r.pay_dates.map((p) => [p.scheduled, p.pay_date])).toEqual([
      ["2026-12-15", "2026-12-15"],
      ["2026-12-31", "2026-12-31"],
      ["2027-01-15", "2027-01-15"],
      ["2027-01-31", "2027-01-29"], // Sunday -> Friday
    ]);
    expect(r.pay_dates[3]).toMatchObject({ adjusted: true, reason: "weekend", weekday: "Friday" });
  });

  it("moves a holiday pay date and names the holiday", () => {
    const r = payDates({ schedule: "monthly", days: [25], from: "2026-12-01", count: 1, country: "PH" });
    expect(r.pay_dates[0]).toMatchObject({ scheduled: "2026-12-25", pay_date: "2026-12-24", adjusted: true, reason: "holiday: Christmas Day" });
    const next = payDates({ schedule: "monthly", days: [25], from: "2026-12-01", count: 1, country: "PH", adjust: "next" });
    expect(next.pay_dates[0].pay_date).toBe("2026-12-28");
  });

  it("clamps day 31 to month end and keeps 'none' unadjusted", () => {
    const r = payDates({ schedule: "monthly", days: [31], from: "2027-02-01", count: 2, adjust: "none" });
    expect(r.pay_dates.map((p) => p.scheduled)).toEqual(["2027-02-28", "2027-03-31"]);
    expect(r.pay_dates[0]).toMatchObject({ pay_date: "2027-02-28", adjusted: false, is_business_day: false });
  });

  it("nearest prefers the earlier day on a tie", () => {
    // Saturday 2026-11-14: Friday is 1 day back, Monday 2 days ahead -> Friday.
    const r = payDates({ schedule: "monthly", days: [14], from: "2026-11-01", count: 1, adjust: "nearest" });
    expect(r.pay_dates[0].pay_date).toBe("2026-11-13");
    // Sunday 2026-11-15 with a Monday holiday-free week: Friday is 2 back, Monday 1 ahead -> Monday.
    expect(payDates({ schedule: "monthly", days: [15], from: "2026-11-01", count: 1, adjust: "nearest" }).pay_dates[0].pay_date).toBe("2026-11-16");
  });

  it("biweekly and weekly follow the anchor", () => {
    const bi = payDates({ schedule: "biweekly", anchor: "2026-11-06", from: "2026-11-10", count: 3 });
    expect(bi.pay_dates.map((p) => p.scheduled)).toEqual(["2026-11-20", "2026-12-04", "2026-12-18"]);
    const wk = payDates({ schedule: "weekly", anchor: "2026-11-06", from: "2026-10-01", count: 2 });
    expect(wk.pay_dates.map((p) => p.scheduled)).toEqual(["2026-10-02", "2026-10-09"]);
  });

  it("validates input", () => {
    expect(() => payDates({ schedule: "daily", from: "2026-11-01" })).toThrow(/schedule must be/);
    expect(() => payDates({ schedule: "weekly", from: "2026-11-01" })).toThrow(/anchor/);
    expect(() => payDates({ schedule: "semi_monthly", from: "2026-11-01", days: [15] })).toThrow(/2 day-of-month/);
    expect(() => payDates({ schedule: "monthly", from: "2026-11-01", count: 25 })).toThrow(/count/);
    expect(() => payDates({ schedule: "monthly", from: "2026-11-01", adjust: "later" })).toThrow(/adjust must be/);
  });
});

describe("error hints", () => {
  it("HTTP 400 includes a valid example body for the tool", async () => {
    const res = await post("/v1/pay_dates", { schedule: "daily" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("invalid_schedule");
    expect(body.error.example).toEqual({ schedule: "semi_monthly", from: "2026-12-01", count: 4, country: "PH" });
  });

  it("the example in each error is itself a valid request", async () => {
    for (const path of ["/v1/business_day", "/v1/pay_dates", "/v1/diff", "/v1/add"]) {
      const bad = (await (await post(path, {})).json()) as any;
      expect(bad.error.example, path).toBeTruthy();
      expect((await post(path, bad.error.example)).status, path).toBe(200);
    }
  });
});
