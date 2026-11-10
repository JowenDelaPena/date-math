import { describe, expect, it } from "vitest";
import { businessDaySchedule, dateRange, timeBuckets } from "../src/more5";
import { listHolidays } from "../src/holidays";

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const utc = (s: string) => Date.parse(s + "T00:00:00Z");

describe("date_range", () => {
  it("resolves relative periods in a time zone", () => {
    const r = dateRange({ period: "last_month", timezone: "Asia/Manila", as_of: "2026-11-10" });
    expect(r).toMatchObject({
      label: "October 2026", start_date: "2026-10-01", end_date: "2026-10-31", days: 31,
      start: "2026-10-01T00:00:00+08:00", end_exclusive: "2026-11-01T00:00:00+08:00",
      start_utc: "2026-09-30T16:00:00Z", end_exclusive_utc: "2026-10-31T16:00:00Z",
    });
  });

  it("accepts spaces, aliases and explicit periods", () => {
    const at = { as_of: "2026-11-10" };
    expect(dateRange({ period: "Last 7 Days", ...at })).toMatchObject({ start_date: "2026-11-03", end_date: "2026-11-09", days: 7 });
    expect(dateRange({ period: "last_7_days", include_today: true, ...at })).toMatchObject({ start_date: "2026-11-04", end_date: "2026-11-10" });
    expect(dateRange({ period: "YTD", ...at })).toMatchObject({ start_date: "2026-01-01", end_date: "2026-11-10" });
    expect(dateRange({ period: "mtd", include_today: false, ...at })).toMatchObject({ start_date: "2026-11-01", end_date: "2026-11-09" });
    expect(dateRange({ period: "previous quarter", ...at })).toMatchObject({ label: "Q3 2026", start_date: "2026-07-01", end_date: "2026-09-30" });
    expect(dateRange({ period: "next_2_weeks", ...at })).toMatchObject({ start_date: "2026-11-16", end_date: "2026-11-29" });
    expect(dateRange({ period: "last_3_months", ...at })).toMatchObject({ start_date: "2026-08-01", end_date: "2026-10-31" });
    expect(dateRange({ period: "last_3_months", include_today: true, ...at })).toMatchObject({ start_date: "2026-09-01", end_date: "2026-11-10" });
    expect(dateRange({ period: "this_half", ...at })).toMatchObject({ label: "H2 2026", start_date: "2026-07-01", end_date: "2026-12-31" });
    expect(dateRange({ period: "Q3 2026" })).toMatchObject({ label: "Q3 2026", start_date: "2026-07-01", end_date: "2026-09-30", days: 92 });
    expect(dateRange({ period: "2026-q1" })).toMatchObject({ start_date: "2026-01-01", end_date: "2026-03-31" });
    expect(dateRange({ period: "2024-02" })).toMatchObject({ label: "February 2024", days: 29 });
    expect(dateRange({ period: "2026" })).toMatchObject({ label: "2026", days: 365 });
    expect(dateRange({ period: "2026-W53" })).toMatchObject({ label: "2026-W53", start_date: "2026-12-28", end_date: "2027-01-03" });
    expect(dateRange({ period: "2026-03-15" })).toMatchObject({ days: 1, end_date: "2026-03-15" });
  });

  it("uses the week start and fiscal year", () => {
    const at = { as_of: "2026-11-10" }; // Tuesday
    expect(dateRange({ period: "this_week", ...at })).toMatchObject({ label: "2026-W46", start_date: "2026-11-09", end_date: "2026-11-15" });
    expect(dateRange({ period: "this_week", week_start: "sunday", ...at })).toMatchObject({ label: "Week of 2026-11-08", start_date: "2026-11-08", week_start: "sunday" });
    expect(dateRange({ period: "this_quarter", fiscal_year_start: 7, ...at })).toMatchObject({ label: "Q2 FY2027", start_date: "2026-10-01", fiscal_year_start: "July" });
    expect(dateRange({ period: "this_year", fiscal_year_start: 4, ...at })).toMatchObject({ label: "FY2027", start_date: "2026-04-01", end_date: "2027-03-31" });
    expect(dateRange({ period: "ytd", fiscal_year_start: 10, ...at })).toMatchObject({ start_date: "2026-10-01", end_date: "2026-11-10" });
  });

  it("builds comparison periods", () => {
    const mtd = dateRange({ period: "mtd", as_of: "2026-03-31", compare: "previous_period" });
    expect(mtd.comparison).toMatchObject({ start_date: "2026-02-01", end_date: "2026-02-28" }); // clamped to February
    const m10 = dateRange({ period: "mtd", as_of: "2026-11-10", compare: "previous_period" });
    expect(m10.comparison).toMatchObject({ start_date: "2026-10-01", end_date: "2026-10-10" });
    const lm = dateRange({ period: "last_month", as_of: "2026-11-10", compare: "previous_year" });
    expect(lm.comparison).toMatchObject({ label: "October 2025", start_date: "2025-10-01", end_date: "2025-10-31" });
    const wk = dateRange({ period: "last_week", as_of: "2026-11-10", compare: "previous_year" });
    expect(wk.comparison).toMatchObject({ start_date: "2025-11-03", end_date: "2025-11-09", method: "52 weeks earlier (same weekdays)" });
    const l7 = dateRange({ period: "last_7_days", as_of: "2026-11-10", compare: "previous_period" });
    expect(l7.comparison).toMatchObject({ start_date: "2026-10-27", end_date: "2026-11-02" });
    const q = dateRange({ period: "2026-Q1", compare: "previous_period" });
    expect(q.comparison).toMatchObject({ label: "Q4 2025", start_date: "2025-10-01", end_date: "2025-12-31" });
  });

  it("is DST-aware: start and end are local midnights", () => {
    const r = dateRange({ period: "this_month", timezone: "America/New_York", as_of: "2026-03-10" });
    expect(r).toMatchObject({ start: "2026-03-01T00:00:00-05:00", end_exclusive: "2026-04-01T00:00:00-04:00" });
  });

  it("brute force: every relative period contains or touches today correctly, 2024-2027", () => {
    for (let t = utc("2024-01-01"); t <= utc("2027-12-31"); t += 3 * DAY) {
      const as_of = iso(t);
      for (const fy of [1, 4, 7, 10]) {
        for (const unit of ["week", "month", "quarter", "year"]) {
          const cur = dateRange({ period: `this_${unit}`, as_of, fiscal_year_start: fy });
          const last = dateRange({ period: `last_${unit}`, as_of, fiscal_year_start: fy });
          const next = dateRange({ period: `next_${unit}`, as_of, fiscal_year_start: fy });
          const todate = dateRange({ period: `${unit}_to_date`, as_of, fiscal_year_start: fy });
          expect((cur.start_date as string) <= as_of && as_of <= (cur.end_date as string), `${unit} ${as_of}`).toBe(true);
          expect(utc(last.end_date as string) + DAY).toBe(utc(cur.start_date as string));
          expect(utc(cur.end_date as string) + DAY).toBe(utc(next.start_date as string));
          expect([todate.start_date, todate.end_date]).toEqual([cur.start_date, as_of]);
          if (unit !== "week") expect((cur.start_date as string).slice(8)).toBe("01");
          if (unit === "year") expect(Number((cur.start_date as string).slice(5, 7))).toBe(fy);
          if (unit === "quarter") expect((Number((cur.start_date as string).slice(5, 7)) - fy + 12) % 3).toBe(0);
        }
      }
    }
  });

  it("validates input", () => {
    expect(() => dateRange({ period: "fortnight" })).toThrow(/period must be like/);
    expect(() => dateRange({ period: "2026-W53x" })).toThrow(/period/);
    expect(() => dateRange({ period: "2027-W53" })).toThrow(/no ISO week 53/);
    expect(() => dateRange({ period: "2026-13" })).toThrow(/01–12/);
    expect(() => dateRange({ period: "last_9999_days" })).toThrow(/between 1 and 3660/);
    expect(() => dateRange({ period: "mtd", as_of: "2026-11-01", include_today: false })).toThrow(/empty/);
    expect(() => dateRange({ period: "today", timezone: "Mars/Base" })).toThrow(/time zone/);
    expect(() => dateRange({ period: "today", week_start: "friday" })).toThrow(/week_start/);
    expect(() => dateRange({ period: "today", compare: "yoy" })).toThrow(/compare/);
  });
});

describe("time_buckets", () => {
  it("day buckets are 23 or 25 hours on clock-change days", () => {
    const r = timeBuckets({ from: "2026-10-31", to: "2026-11-03", bucket: "day", timezone: "America/New_York" });
    expect(r.buckets.map((b) => [b.label, b.hours])).toEqual([["2026-10-31", 24], ["2026-11-01", 25], ["2026-11-02", 24]]);
    const spring = timeBuckets({ from: "2026-03-29", to: "2026-03-30", bucket: "day", timezone: "Europe/London" });
    expect(spring.buckets[0].hours).toBe(23);
  });

  it("hour buckets follow real time: the repeated hour appears twice, the skipped hour never", () => {
    const fall = timeBuckets({ from: "2026-11-01T00:00", to: "2026-11-01T03:00", bucket: "hour", timezone: "America/New_York" });
    expect(fall.buckets.map((b) => b.label)).toEqual(["2026-11-01T00:00-04:00", "2026-11-01T01:00-04:00", "2026-11-01T01:00-05:00", "2026-11-01T02:00-05:00"]);
    const spring = timeBuckets({ from: "2026-03-08T00:00", to: "2026-03-08T04:00", bucket: "hour", timezone: "America/New_York" });
    expect(spring.buckets.map((b) => b.label)).toEqual(["2026-03-08T00:00-05:00", "2026-03-08T01:00-05:00", "2026-03-08T03:00-04:00"]);
  });

  it("labels weeks, months, quarters and years; flags or clips partial buckets", () => {
    const w = timeBuckets({ from: "2026-11-10", to: "2026-12-01", bucket: "week" });
    expect(w.buckets.map((b) => [b.label, b.partial ?? false])).toEqual([["2026-W46", true], ["2026-W47", false], ["2026-W48", false], ["2026-W49", true]]);
    expect(w.buckets[0].start).toBe("2026-11-09T00:00:00+00:00");
    const clipped = timeBuckets({ from: "2026-11-10", to: "2026-12-01", bucket: "week", clip: true });
    expect([clipped.buckets[0].start, clipped.buckets[3].end]).toEqual(["2026-11-10T00:00:00+00:00", "2026-12-01T00:00:00+00:00"]);
    const sun = timeBuckets({ from: "2026-11-10", to: "2026-11-20", bucket: "week", week_start: "sunday" });
    expect(sun.buckets.map((b) => b.label)).toEqual(["2026-11-08", "2026-11-15"]);
    const m = timeBuckets({ from: "2026-01-15", to: "2026-04-01", bucket: "month" });
    expect(m.buckets.map((b) => b.label)).toEqual(["2026-01", "2026-02", "2026-03"]);
    const q = timeBuckets({ from: "2026-01-01", to: "2027-01-01", bucket: "quarter", fiscal_year_start: 7 });
    expect(q.buckets.map((b) => b.label)).toEqual(["FY2026-Q3", "FY2026-Q4", "FY2027-Q1", "FY2027-Q2"]);
    const y = timeBuckets({ from: "2024-06-01", to: "2026-06-01", bucket: "year" });
    expect(y.buckets.map((b) => b.label)).toEqual(["2024", "2025", "2026"]);
  });

  it("15-minute buckets in a half-hour-offset zone line up with the local clock", () => {
    const r = timeBuckets({ from: "2026-11-10T09:07:00+05:30", to: "2026-11-10T10:00:00+05:30", bucket: "minute", size: 15, timezone: "Asia/Kolkata" });
    expect(r.buckets.map((b) => b.label)).toEqual(["2026-11-10T09:00+05:30", "2026-11-10T09:15+05:30", "2026-11-10T09:30+05:30", "2026-11-10T09:45+05:30"]);
    expect(r.buckets[0].partial).toBe(true);
  });

  it("brute force: buckets are contiguous and cover the range in many zones", () => {
    for (const timezone of ["America/New_York", "Europe/London", "Australia/Lord_Howe", "Asia/Kathmandu", "America/Santiago", "UTC"]) {
      for (const bucket of ["hour", "day", "week", "month"]) {
        const r = timeBuckets({ from: "2026-01-01", to: bucket === "hour" ? "2026-01-30" : "2026-12-31", bucket, size: bucket === "hour" ? 1 : undefined, timezone });
        const fromMs = Date.parse(r.buckets[0].start_utc), toMs = Date.parse(r.buckets[r.count - 1].end_utc);
        for (let i = 1; i < r.count; i++) expect(r.buckets[i].start_utc, `${timezone} ${bucket} ${i}`).toBe(r.buckets[i - 1].end_utc);
        const hours = r.buckets.reduce((s, b) => s + b.hours, 0);
        expect(Math.abs(hours - (toMs - fromMs) / 3_600_000)).toBeLessThan(1e-3);
        expect(r.buckets.every((b) => b.hours > 0)).toBe(true);
      }
    }
  });

  it("validates input", () => {
    expect(() => timeBuckets({ from: "2026-01-01", to: "2026-01-01", bucket: "day" })).toThrow(/after from/);
    expect(() => timeBuckets({ from: "2026-01-01", to: "2030-01-01", bucket: "day" })).toThrow(/more than 1000/);
    expect(() => timeBuckets({ from: "2026-01-01", to: "2026-01-02", bucket: "minute", size: 7 })).toThrow(/size/);
    expect(() => timeBuckets({ from: "2026-01-01", to: "2026-02-01", bucket: "day", size: 2 })).toThrow(/size/);
    expect(() => timeBuckets({ from: "2026-02-30", to: "2026-03-02", bucket: "day" })).toThrow(/real calendar date/);
    expect(() => timeBuckets({ from: "2026-01-01T25:00", to: "2026-01-02", bucket: "day" })).toThrow(/real date and time/);
    expect(() => timeBuckets({ to: "2026-01-02", bucket: "day" })).toThrow(/required/);
  });
});

describe("business_day_schedule", () => {
  it("nth business day skips holidays", () => {
    const r = businessDaySchedule({ rule: "nth_business_day", n: 3, time: "09:00", timezone: "Europe/London", country: "GB", from: "2026-11-10", count: 3 });
    expect(r.runs.map((x) => x.datetime)).toEqual(["2026-12-03T09:00:00+00:00", "2027-01-06T09:00:00+00:00", "2027-02-03T09:00:00+00:00"]);
    expect(r.description).toBe("3rd business day of every month at 09:00 (Europe/London); holidays: GB public holidays");
    const last = businessDaySchedule({ rule: "nth_business_day", n: -1, from: "2026-12-01", count: 2, country: "US", months: [12, 6] });
    expect(last.runs.map((x) => x.date)).toEqual(["2026-12-31", "2027-06-30"]);
  });

  it("weekly with a holiday moves to the next business day and answers 'run today?'", () => {
    const r = businessDaySchedule({ rule: "weekly", weekdays: [1], country: "GB", timezone: "Europe/London", from: "2026-12-20", count: 3, check_date: "2026-12-28" });
    expect(r.runs.map((x) => [x.date, x.scheduled_date, x.adjusted])).toEqual([["2026-12-21", "2026-12-21", false], ["2026-12-29", "2026-12-28", true], ["2027-01-04", "2027-01-04", false]]);
    expect(r.runs[1].reason).toBe("holiday: Boxing Day (substitute day)");
    expect(r.check).toMatchObject({ runs: false, scheduled_run_moved_to: "2026-12-29", reason: "holiday: Boxing Day (substitute day)" });
    const tue = businessDaySchedule({ rule: "weekly", weekdays: [1], country: "GB", timezone: "Europe/London", from: "2026-12-20", check_date: "2026-12-29" });
    expect(tue.check).toMatchObject({ runs: true, run_times: [{ datetime: "2026-12-29T09:00:00+00:00", scheduled_date: "2026-12-28" }] });
  });

  it("cron with modified_following and skip", () => {
    const r = businessDaySchedule({ rule: "cron", expression: "0 9 25 * *", adjust: "modified_following", country: "US", timezone: "America/New_York", from: "2026-12-01", count: 2 });
    expect(r.runs.map((x) => x.datetime)).toEqual(["2026-12-28T09:00:00-05:00", "2027-01-25T09:00:00-05:00"]);
    // Jan 31 2027 is a Sunday: modified_following cannot move into February, so it goes back to Friday Jan 29.
    const eom = businessDaySchedule({ rule: "day_of_month", day: 31, adjust: "modified_following", from: "2027-01-01", count: 1 });
    expect(eom.runs[0]).toMatchObject({ date: "2027-01-29", scheduled_date: "2027-01-31", reason: "weekend" });
    const skip = businessDaySchedule({ rule: "cron", expression: "30 8 * * *", adjust: "skip", country: "US", timezone: "America/New_York", from: "2026-12-24", count: 3 });
    expect(skip.runs.map((x) => x.date)).toEqual(["2026-12-24", "2026-12-28", "2026-12-29"]);
  });

  it("brute force: nth business day matches a plain day-by-day count, 2026-2030, five countries", () => {
    for (const country of ["US", "GB", "DE", "JP", "PH"]) {
      const hol = new Set<string>();
      for (let y = 2026; y <= 2030; y++) for (const h of listHolidays(country, y).holidays) hol.add(h.date);
      const biz = (t: number) => ![0, 6].includes(new Date(t).getUTCDay()) && !hol.has(iso(t));
      for (const n of [1, 2, 5, -1, -3]) {
        const r = businessDaySchedule({ rule: "nth_business_day", n, country, from: "2026-01-01", count: 50 });
        const want: string[] = [];
        for (let m = 0; want.length < 50; m++) {
          const days: number[] = [];
          for (let t = Date.UTC(2026, m, 1); t < Date.UTC(2026, m + 1, 1); t += DAY) if (biz(t)) days.push(t);
          want.push(iso(n > 0 ? days[n - 1] : days[days.length + n]));
        }
        expect(r.runs.map((x) => x.date), `${country} n=${n}`).toEqual(want);
      }
    }
  });

  it("brute force: every adjust rule lands on a business day in the right direction", () => {
    const hol = new Set(["2026-12-25", "2026-12-28", "2027-01-01", "2027-04-02", "2027-04-05", "2027-05-31"].concat(listHolidays("GB", 2027).holidays.map((h) => h.date)));
    const biz = (d: string) => ![0, 6].includes(new Date(d).getUTCDay()) && !hol.has(d);
    for (const adjust of ["next", "previous", "modified_following", "modified_preceding", "nearest"]) {
      for (const dom of [1, 15, 28, 30, 31]) {
        const r = businessDaySchedule({ rule: "day_of_month", day: dom, adjust, country: "GB", holidays: ["2026-12-25", "2026-12-28"], from: "2026-12-01", count: 13 });
        for (const run of r.runs) {
          expect(biz(run.date), `${adjust} ${dom} ${run.date}`).toBe(true);
          if (!run.adjusted) expect(run.date).toBe(run.scheduled_date);
          if (adjust === "next") expect(run.date >= run.scheduled_date).toBe(true);
          if (adjust === "previous") expect(run.date <= run.scheduled_date).toBe(true);
          if (adjust.startsWith("modified")) expect(run.date.slice(0, 7)).toBe(run.scheduled_date.slice(0, 7));
          // No business day lies strictly between the scheduled day and the run day (we took the closest one).
          if (adjust === "next" || adjust === "previous") {
            const [a, b] = [run.scheduled_date, run.date].sort();
            for (let t = utc(a) + DAY; t < utc(b); t += DAY) expect(biz(iso(t)), `${adjust} ${iso(t)}`).toBe(false);
          }
        }
      }
    }
  });

  it("is DST-aware and keeps the local time", () => {
    const r = businessDaySchedule({ rule: "weekly", weekdays: [1, 2, 3, 4, 5], time: "09:30", timezone: "America/New_York", from: "2026-03-06", count: 2 });
    expect(r.runs.map((x) => x.utc)).toEqual(["2026-03-06T14:30:00Z", "2026-03-09T13:30:00Z"]);
  });

  it("validates input", () => {
    expect(() => businessDaySchedule({})).toThrow(/rule is required/);
    expect(() => businessDaySchedule({ rule: "nth_business_day", n: 0 })).toThrow(/n: 1–23/);
    expect(() => businessDaySchedule({ rule: "weekly" })).toThrow(/weekdays/);
    expect(() => businessDaySchedule({ rule: "day_of_month", day: 32 })).toThrow(/day/);
    expect(() => businessDaySchedule({ rule: "cron", expression: "* * * * *" })).toThrow(/at most 96/);
    expect(() => businessDaySchedule({ rule: "weekly", weekdays: [1], adjust: "later" })).toThrow(/adjust must be/);
    expect(() => businessDaySchedule({ rule: "weekly", weekdays: [1], time: "9am" })).toThrow(/HH:MM/);
    expect(() => businessDaySchedule({ rule: "weekly", weekdays: [1], country: "XX" })).toThrow(/no holiday data/);
    expect(() => businessDaySchedule({ rule: "weekly", weekdays: [1], country: "US", from: "2051-01-01" })).toThrow(/2000–2050/);
    expect(() => businessDaySchedule({ rule: "weekly", weekdays: [1], months: [13] })).toThrow(/months/);
  });
});
