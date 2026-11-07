import { describe, expect, it } from "vitest";
import { addBusinessDays, weekdaysBetween } from "../src/date";

const DAY = 86_400_000;
const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const isBiz = (ms: number, hol: Set<string>) => {
  const wd = new Date(ms).getUTCDay();
  return wd !== 0 && wd !== 6 && !hol.has(fmt(ms));
};

// Brute-force references (the old per-day loops).
function bruteCount(lo: number, hi: number, hol: Set<string>) {
  let c = 0;
  for (let t = lo; t < hi; t += DAY) if (isBiz(t, hol)) c++;
  return c;
}
function bruteAdd(ms: number, n: number, hol: Set<string>) {
  const step = n > 0 ? 1 : -1;
  for (let left = Math.abs(n); left > 0; ) {
    ms += step * DAY;
    if (isBiz(ms, hol)) left--;
  }
  return ms;
}

// Deterministic PRNG so failures are reproducible.
let seed = 42;
const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
const base = Date.UTC(2026, 0, 1);

describe("business-day math matches brute force", () => {
  it("weekdaysBetween + holidays, 2,000 random ranges", () => {
    for (let i = 0; i < 2000; i++) {
      const lo = base + (rnd(800) - 400) * DAY;
      const hi = lo + rnd(400) * DAY;
      const hol = new Set(Array.from({ length: rnd(8) }, () => fmt(lo + rnd(400) * DAY)));
      const holCount = [...hol].filter((h) => {
        const t = Date.parse(h + "T00:00:00Z");
        const wd = new Date(t).getUTCDay();
        return t >= lo && t < hi && wd !== 0 && wd !== 6;
      }).length;
      expect(weekdaysBetween(lo, hi) - holCount).toBe(bruteCount(lo, hi, hol));
    }
  });

  it("addBusinessDays, 3,000 random cases incl. weekend starts and holidays", () => {
    for (let i = 0; i < 3000; i++) {
      const start = base + (rnd(800) - 400) * DAY;
      const n = rnd(120) - 60;
      const hol = new Set(Array.from({ length: rnd(10) }, () => fmt(start + (rnd(200) - 100) * DAY)));
      expect(fmt(addBusinessDays(start, n, hol))).toBe(fmt(bruteAdd(start, n, hol)));
    }
  });

  it("large ranges stay fast", () => {
    const t0 = performance.now();
    weekdaysBetween(Date.UTC(1900, 0, 1), Date.UTC(2100, 0, 1));
    addBusinessDays(Date.UTC(2026, 0, 1), 1_000_000, new Set(["2026-12-25"]));
    expect(performance.now() - t0).toBeLessThan(5);
  });
});
