import { describe, expect, it } from "vitest";
import { DAY_MS, fmtDate, zonedParts } from "../src/date";
import { dst, offsetMinutes, stay, timestamp } from "../src/more3";
import worker from "../src/index";

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} };
const post = (path: string, body: unknown) =>
  worker.fetch(new Request("https://date-math.example" + path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }), {} as any, ctx);
const d = (s: string) => Date.parse(s + "T00:00:00Z") / DAY_MS;
const iso = (n: number) => fmtDate(new Date(n * DAY_MS));

describe("stay_calculator", () => {
  it("counts a full 90-day stay and blocks re-entry", () => {
    const r = stay({ trips: [{ entry: "2026-01-01", exit: "2026-03-31" }], date: "2026-03-31", entry: "2026-04-01" });
    expect(r.days_used).toBe(90);
    expect(r.days_remaining).toBe(0);
    expect(r.in_compliance).toBe(true);
    expect(r.first_overstay).toBeNull();
    expect(r.max_stay).toEqual({ entry: "2026-04-01", days_allowed: 0, latest_exit: null });
    expect(r.rule.window_start).toBe("2025-10-03");
  });

  it("flags an overstay on day 91", () => {
    const r = stay({ trips: [{ entry: "2026-01-01", exit: "2026-04-02" }], date: "2026-04-02" });
    expect(r.days_used).toBe(92);
    expect(r.overstay_days).toBe(2);
    expect(r.in_compliance).toBe(false);
    expect(r.first_overstay).toBe("2026-04-01");
  });

  it("matches a brute-force day-by-day count on random trips", () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    for (let trial = 0; trial < 60; trial++) {
      const days = new Set<number>();
      const trips: { entry: string; exit: string }[] = [];
      let t = d("2026-01-01") + rnd(30);
      for (let i = 0; i < 1 + rnd(5); i++) {
        const len = 1 + rnd(40);
        trips.push({ entry: iso(t), exit: iso(t + len - 1) });
        for (let k = 0; k < len; k++) days.add(t + k);
        t += len + rnd(60);
      }
      const date = t - rnd(40), entry = t + rnd(30);
      const used = (x: number) => { let c = 0; for (let k = x - 179; k <= x; k++) if (days.has(k)) c++; return c; };
      const allowed = (s: number) => {
        const all = new Set(days);
        let k = 0;
        while (k < 90) { all.add(s + k); let c = 0; for (let j = s + k - 179; j <= s + k; j++) if (all.has(j)) c++; if (c > 90) break; k++; }
        return k;
      };
      let full: number | null = null;
      for (let x = date + 1; x <= date + 270 && full === null; x++) if (allowed(x) >= 90) full = x;

      const r = stay({ trips, date: iso(date), entry: iso(entry) });
      expect(r.days_used, JSON.stringify(trips)).toBe(used(date));
      expect(r.max_stay!.days_allowed).toBe(allowed(entry));
      expect(r.next_full_stay_date).toBe(full === null ? null : iso(full));
    }
  });

  it("supports custom rules and validates input", () => {
    expect(stay({ trips: [{ entry: "2026-01-01", exit: "2026-01-10" }], date: "2026-01-10", max_days: 30, window_days: 60 }).days_remaining).toBe(20);
    expect(() => stay({ trips: [{ entry: "2026-02-01", exit: "2026-01-01" }] })).toThrow(/before its entry/);
    expect(() => stay({ trips: "x" })).toThrow(/trips must be/);
    expect(() => stay({ trips: [], max_days: 200, window_days: 100 })).toThrow(/must not exceed/);
    expect(() => stay({ trips: [{ entry: "2000-01-01", exit: "2000-01-02" }], date: "2026-01-01" })).toThrow(/10 years/);
  });
});

describe("timestamp_normalize", () => {
  const one = (v: unknown, extra: Record<string, unknown> = {}) => timestamp({ values: [v], ...extra }).results[0] as any;

  it("detects Unix units by magnitude without losing precision", () => {
    expect(one(1762500000)).toMatchObject({ format: "unix_seconds", utc: "2025-11-07T07:20:00Z", ambiguous: false });
    expect(one("1762500000123").utc).toBe("2025-11-07T07:20:00.123Z");
    expect(one("1762500000123456").format).toBe("unix_us");
    expect(one("1762500000123456789")).toMatchObject({ format: "unix_ns", utc: "2025-11-07T07:20:00.123Z" });
  });

  it("reads Excel serials (flagging the Unix reading) and FILETIME on request", () => {
    expect(one(45000)).toMatchObject({ format: "excel", utc: "2023-03-15T00:00:00Z", ambiguous: true, alternatives: [{ format: "unix_seconds", utc: "1970-01-01T12:30:00Z" }] });
    expect(one(45000.5, { timezone: "Asia/Manila" })).toMatchObject({ utc: "2023-03-15T04:00:00Z", local: "2023-03-15T12:00:00+08:00", ambiguous: false });
    expect(one("133000000000000000", { numeric_format: "filetime" }).utc).toBe(new Date(133000000000000000 / 10_000 - 11_644_473_600_000).toISOString().replace(".000Z", "Z"));
  });

  it("flags ambiguous slash dates and honours date_order", () => {
    expect(one("03/04/2026")).toMatchObject({ format: "mdy", utc: "2026-03-04T00:00:00Z", ambiguous: true, alternatives: [{ format: "dmy", utc: "2026-04-03T00:00:00Z" }] });
    expect(one("03/04/2026", { date_order: "DMY" }).utc).toBe("2026-04-03T00:00:00Z");
    expect(one("13/04/2026")).toMatchObject({ format: "dmy", ambiguous: false });
    expect(one("04/04/2026").ambiguous).toBe(false);
  });

  it("reads ISO, RFC 2822 and month-name dates; naive times use the time zone (DST-aware)", () => {
    expect(one("Tue, 10 Nov 2026 14:30:00 GMT").utc).toBe("2026-11-10T14:30:00Z");
    expect(one("10 Nov 2026 14:30:00 +0800").utc).toBe("2026-11-10T06:30:00Z");
    expect(one("2026-11-07T09:00:00.5-05:00").utc).toBe("2026-11-07T14:00:00.500Z");
    expect(one("2026-11-07 09:00", { timezone: "Asia/Manila" })).toMatchObject({ utc: "2026-11-07T01:00:00Z", assumed_timezone: "Asia/Manila" });
    expect(one("Nov 7, 2026 3:15 PM", { timezone: "America/New_York" }).utc).toBe("2026-11-07T20:15:00Z");
    expect(one("July 4 2026 12:00", { timezone: "America/New_York" }).utc).toBe("2026-07-04T16:00:00Z");
    expect(one("2026/1/5").utc).toBe("2026-01-05T00:00:00Z");
    const at = (v: string, tz: string) => one(v, { timezone: tz }).utc;
    expect(at("2026-11-01 01:30", "America/New_York")).toBe("2026-11-01T05:30:00Z"); // repeated: first occurrence
    expect(at("2026-03-08 02:30", "America/New_York")).toBe("2026-03-08T07:30:00Z"); // gap: shifts to 03:30 EDT
    expect(at("2026-04-05 02:30", "Australia/Sydney")).toBe("2026-04-04T15:30:00Z");
    expect(at("2026-10-04 02:30", "Australia/Sydney")).toBe("2026-10-03T16:30:00Z");
    expect(at("2026-07-01 12:00", "Asia/Kolkata")).toBe("2026-07-01T06:30:00Z");
  });

  it("reports bad values per item instead of failing the call", () => {
    const r = timestamp({ values: ["next friday", "2026-02-30", "13/13/2026", { a: 1 }, "1762500000"] });
    expect(r.ok).toBe(1);
    expect(r.results.slice(0, 4).every((x) => !x.ok)).toBe(true);
    expect(() => timestamp({ values: [] })).toThrow(/values must be/);
    expect(() => timestamp({ values: [1], numeric_format: "x" })).toThrow(/numeric_format/);
    expect(() => timestamp({ values: [1], date_order: "YMD" })).toThrow(/date_order/);
    expect(() => timestamp({ values: [1], timezone: "Mars/Base" })).toThrow(/time zone/);
  });
});

describe("offsetMinutes (fast path)", () => {
  it("matches zonedParts for random instants across many zones, 1850–2100", () => {
    const zones = ["UTC", "America/New_York", "Australia/Lord_Howe", "Asia/Kolkata", "Asia/Kathmandu", "Europe/Dublin", "Africa/Casablanca", "Pacific/Chatham", "America/St_Johns", "Europe/Amsterdam", "Asia/Manila", "America/Sao_Paulo"];
    let seed = 99;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed / 2 ** 31);
    for (let i = 0; i < 3000; i++) {
      const tz = zones[i % zones.length];
      const ms = Date.UTC(1850, 0, 1) + Math.floor(rnd() * 250 * 365.25 * DAY_MS / 60_000) * 60_000;
      expect(offsetMinutes(ms, tz), `${tz} ${new Date(ms).toISOString()}`).toBe(zonedParts(new Date(ms), tz).offsetMin);
    }
  });
});

describe("dst_check", () => {
  it("lists New York's 2026 transitions and classifies wall times", () => {
    const r = dst({ timezone: "America/New_York", datetime: "2026-03-08T02:30" });
    expect(r).toMatchObject({ year: 2026, observes_dst: true, standard_offset: "-05:00", dst_offset: "-04:00" });
    expect(r.transitions).toEqual([
      { at_utc: "2026-03-08T07:00:00Z", local_before: "2026-03-08T02:00:00-05:00", local_after: "2026-03-08T03:00:00-04:00", offset_before: "-05:00", offset_after: "-04:00", change_minutes: 60, type: "clocks_forward" },
      { at_utc: "2026-11-01T06:00:00Z", local_before: "2026-11-01T02:00:00-04:00", local_after: "2026-11-01T01:00:00-05:00", offset_before: "-04:00", offset_after: "-05:00", change_minutes: -60, type: "clocks_back" },
    ]);
    expect(r.check).toMatchObject({ status: "skipped", instants: [], resolved: "2026-03-08T03:30:00-04:00" });

    const back = dst({ timezone: "America/New_York", datetime: "2026-11-01T01:30" });
    expect(back.check).toMatchObject({ status: "repeated", instants: ["2026-11-01T01:30:00-04:00", "2026-11-01T01:30:00-05:00"] });
    expect(dst({ timezone: "America/New_York", datetime: "2026-07-01T12:00" }).check).toMatchObject({ status: "valid", instants: ["2026-07-01T12:00:00-04:00"] });
  });

  it("handles zones without DST and the southern hemisphere", () => {
    expect(dst({ timezone: "Asia/Manila", year: 2026 })).toMatchObject({ observes_dst: false, standard_offset: "+08:00", dst_offset: null, transitions: [], check: null });
    const syd = dst({ timezone: "Australia/Sydney", year: 2026 });
    expect(syd).toMatchObject({ standard_offset: "+10:00", dst_offset: "+11:00" });
    expect(syd.transitions.map((t) => [t.at_utc, t.type])).toEqual([["2026-04-04T16:00:00Z", "clocks_back"], ["2026-10-03T16:00:00Z", "clocks_forward"]]);
    expect(dst({ timezone: "Australia/Lord_Howe", year: 2026 }).transitions.map((t) => t.change_minutes)).toEqual([-30, 30]);
  });

  it("validates input", () => {
    expect(() => dst({ timezone: "Nope/Zone" })).toThrow(/time zone/);
    expect(() => dst({ timezone: "UTC", datetime: "2026-03-08T02:30Z" })).toThrow(/wall-clock/);
    expect(() => dst({ timezone: "UTC", datetime: "2026-02-30T02:30" })).toThrow(/wall-clock/);
    expect(() => dst({ timezone: "UTC", year: 3000 })).toThrow(/year/);
  });
});

describe("HTTP routes (payments off)", () => {
  it("serves the three new tools and returns examples on bad input", async () => {
    for (const [p, b] of [["/v1/stay", { trips: [] }], ["/v1/timestamp", { values: [0] }], ["/v1/dst", { timezone: "UTC", year: 2026 }]] as const) {
      expect((await post(p, b)).status, p).toBe(200);
    }
    const bad = await post("/v1/dst", {});
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.example).toBeTruthy();
  });
});
