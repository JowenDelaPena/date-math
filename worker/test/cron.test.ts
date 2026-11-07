// Our cron engine vs cron-parser (dev-only oracle) on randomized expressions, plus DST edge cases.
import { describe, expect, it } from "vitest";
import { CronExpressionParser } from "cron-parser";
import { nextRuns, parseCron } from "../src/cron";

let seed = 7;
const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
const pick = <T,>(a: T[]) => a[rnd(a.length)];

function randField(min: number, max: number): string {
  switch (rnd(6)) {
    case 0: return "*";
    case 1: return String(min + rnd(max - min + 1));
    case 2: { const a = min + rnd(max - min + 1), b = a + rnd(max - a + 1); return `${a}-${b}`; }
    case 3: return `*/${1 + rnd(Math.min(15, max))}`;
    case 4: return [...new Set([0, 1, 2].map(() => min + rnd(max - min + 1)))].sort((a, b) => a - b).join(",");
    default: { const a = min + rnd(max - min + 1); return `${a}-${Math.min(max, a + 5)}/${1 + rnd(3)}`; }
  }
}

describe("cron engine matches cron-parser", () => {
  const zones = ["UTC", "Asia/Manila", "Asia/Kolkata", "Asia/Tokyo"]; // no-DST zones: semantics are unambiguous
  it("400 random expressions × 10 runs", () => {
    for (let i = 0; i < 400; i++) {
      const expr = [randField(0, 59), randField(0, 23), rnd(3) ? "*" : randField(1, 28), rnd(4) ? "*" : randField(1, 12), rnd(2) ? "*" : randField(0, 6)].join(" ");
      const tz = pick(zones);
      const from = new Date(Date.UTC(2026, rnd(12), 1 + rnd(28), rnd(24), rnd(60)));
      const expected = CronExpressionParser.parse(expr, { currentDate: from, tz }).take(10).map((d) => d.toDate().toISOString());
      const actual = nextRuns(parseCron(expr), tz, from, 10).map((d) => d.toISOString());
      expect(actual, `${expr} @ ${tz} from ${from.toISOString()}`).toEqual(expected);
    }
  });
});

describe("cron semantics", () => {
  const runs = (e: string, tz: string, from: string, n = 3) => nextRuns(parseCron(e), tz, new Date(from), n).map((d) => d.toISOString());
  it("DST fall-back in New York", () => {
    expect(runs("30 8 * * *", "America/New_York", "2026-10-31T00:00:00Z", 2)).toEqual(["2026-10-31T12:30:00.000Z", "2026-11-01T13:30:00.000Z"]);
  });
  it("skips a nonexistent local time on spring-forward day", () => {
    // 2026-03-08 02:30 does not exist in New York
    expect(runs("30 2 * * *", "America/New_York", "2026-03-07T00:00:00Z", 2)).toEqual(["2026-03-07T07:30:00.000Z", "2026-03-09T06:30:00.000Z"]);
  });
  it("names, macros, 6 fields, DOM-or-DOW", () => {
    expect(runs("0 9 * JAN MON", "UTC", "2026-01-01T00:00:00Z", 2)).toEqual(["2026-01-05T09:00:00.000Z", "2026-01-12T09:00:00.000Z"]);
    expect(runs("@monthly", "UTC", "2026-01-15T00:00:00Z", 1)).toEqual(["2026-02-01T00:00:00.000Z"]);
    expect(runs("*/15 * * * * *", "UTC", "2026-01-01T00:00:00Z", 3)).toEqual(["2026-01-01T00:00:15.000Z", "2026-01-01T00:00:30.000Z", "2026-01-01T00:00:45.000Z"]);
    // 13th OR Friday
    expect(runs("0 0 13 * 5", "UTC", "2026-11-07T00:00:00Z", 3)).toEqual(["2026-11-13T00:00:00.000Z", "2026-11-20T00:00:00.000Z", "2026-11-27T00:00:00.000Z"]);
  });
  it("Feb 29 and never-matching schedules", () => {
    expect(runs("0 0 29 2 *", "UTC", "2026-01-01T00:00:00Z", 1)).toEqual(["2028-02-29T00:00:00.000Z"]);
    expect(runs("0 0 30 2 *", "UTC", "2026-01-01T00:00:00Z", 1)).toEqual([]);
  });
  it("rejects invalid input", () => {
    for (const e of ["every day", "60 * * * *", "* * 32 * *", "0 0 L * *", "5-1 * * * *", "*/0 * * * *", "* * * *"]) {
      expect(() => parseCron(e), e).toThrow();
    }
  });
});

describe("cron speed", () => {
  it("100 runs well under 5ms", () => {
    const s = parseCron("*/5 * * * *");
    nextRuns(s, "Europe/Berlin", new Date(), 100);
    const t = performance.now();
    for (let i = 0; i < 20; i++) nextRuns(s, "Europe/Berlin", new Date(), 100);
    expect((performance.now() - t) / 20).toBeLessThan(5);
  });
});
