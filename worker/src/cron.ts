// Small, fast cron engine (5 or 6 fields) with IANA time zones, built on the cached Intl formatter.
// Supports: * ? lists , ranges a-b, steps */n a-b/n a/n, month/day names, 7=Sunday, @yearly/@monthly/@weekly/@daily/@hourly.
// Day matching follows Vixie cron: if both day-of-month and day-of-week are restricted, either may match.
import { InputError } from "./errors";
import { zonedParts } from "./date";

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *", "@monthly": "0 0 1 * *", "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@hourly": "0 * * * *",
};
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

interface FieldSpec { name: string; min: number; max: number; names?: string[]; nameBase?: number }
const SPECS: Record<string, FieldSpec> = {
  second: { name: "second", min: 0, max: 59 },
  minute: { name: "minute", min: 0, max: 59 },
  hour: { name: "hour", min: 0, max: 23 },
  dom: { name: "day-of-month", min: 1, max: 31 },
  month: { name: "month", min: 1, max: 12, names: MONTHS, nameBase: 1 },
  dow: { name: "day-of-week", min: 0, max: 7, names: DAYS, nameBase: 0 },
};

const bad = (msg: string) => new InputError("invalid_cron", msg);

function parseField(src: string, spec: FieldSpec): { values: number[]; restricted: boolean } {
  const restricted = !(src === "*" || src === "?");
  const set = new Set<number>();
  const num = (s: string): number => {
    const up = s.toUpperCase();
    if (spec.names) {
      const i = spec.names.indexOf(up);
      if (i >= 0) return i + (spec.nameBase ?? 0);
    }
    if (!/^\d+$/.test(s)) throw bad(`invalid ${spec.name} value "${s}"${/[LW#]/i.test(s) ? " (L, W and # are not supported)" : ""}`);
    const n = Number(s);
    if (n < spec.min || n > spec.max) throw bad(`${spec.name} value ${n} out of range ${spec.min}-${spec.max}`);
    return n;
  };
  for (const part of src.split(",")) {
    if (!part) throw bad(`empty item in ${spec.name} field`);
    const [rangePart, stepPart, extra] = part.split("/");
    if (extra !== undefined) throw bad(`invalid step in ${spec.name} field "${part}"`);
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1 || (stepPart !== undefined && !/^\d+$/.test(stepPart))) throw bad(`invalid step "${stepPart}" in ${spec.name} field`);
    let lo: number, hi: number;
    if (rangePart === "*" || rangePart === "?") [lo, hi] = [spec.min, spec.max];
    else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      [lo, hi] = [num(a), num(b)];
      if (hi < lo) throw bad(`range ${rangePart} in ${spec.name} field is reversed`);
    } else {
      lo = num(rangePart);
      hi = stepPart === undefined ? lo : spec.max; // "a/n" means a, a+n, ... up to max
    }
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  let values = [...set];
  if (spec === SPECS.dow) values = [...new Set(values.map((v) => (v === 7 ? 0 : v)))];
  return { values: values.sort((a, b) => a - b), restricted };
}

export interface CronSchedule {
  seconds: number[]; minutes: number[]; hours: number[];
  dom: Set<number>; months: Set<number>; dow: Set<number>;
  domRestricted: boolean; dowRestricted: boolean;
}

export function parseCron(expression: string): CronSchedule {
  const expr = MACROS[expression.trim().toLowerCase()] ?? expression.trim();
  const f = expr.split(/\s+/);
  if (f.length !== 5 && f.length !== 6) throw bad('cron expression must have 5 or 6 fields, e.g. "0 9 * * 1-5"');
  const [sec, min, hour, dom, month, dow] = f.length === 6 ? f : ["0", ...f];
  const d = parseField(dom, SPECS.dom), w = parseField(dow, SPECS.dow);
  return {
    seconds: parseField(sec, SPECS.second).values,
    minutes: parseField(min, SPECS.minute).values,
    hours: parseField(hour, SPECS.hour).values,
    dom: new Set(d.values), months: new Set(parseField(month, SPECS.month).values), dow: new Set(w.values),
    domRestricted: d.restricted, dowRestricted: w.restricted,
  };
}

export function dayMatches(s: CronSchedule, y: number, mo: number, d: number): boolean {
  if (!s.months.has(mo)) return false;
  const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  const domOk = s.dom.has(d), dowOk = s.dow.has(wd);
  if (s.domRestricted && s.dowRestricted) return domOk || dowOk;
  if (s.domRestricted) return domOk;
  if (s.dowRestricted) return dowOk;
  return true;
}

/** Instant for a local wall time, or null if it doesn't exist (DST gap). For repeated times, the first occurrence. */
function wallToInstant(y: number, mo: number, d: number, h: number, mi: number, se: number, tz: string, hintOffset: number): { ms: number; offset: number } | null {
  const wall = Date.UTC(y, mo - 1, d, h, mi, se);
  for (const off of [hintOffset, null]) {
    const o = off ?? zonedParts(new Date(wall - hintOffset * 60_000), tz).offsetMin;
    // Try the earlier (larger) offset first so repeated wall times resolve to their first occurrence.
    for (const cand of [o, o + 60, o - 60]) {
      const ms = wall - cand * 60_000;
      const p = zonedParts(new Date(ms), tz);
      if (p.y === y && p.mo === mo && p.d === d && p.h === h && p.mi === mi && p.s === se) {
        // Prefer the earliest matching instant.
        const earlier = ms - 3_600_000;
        const pe = zonedParts(new Date(earlier), tz);
        if (pe.y === y && pe.mo === mo && pe.d === d && pe.h === h && pe.mi === mi && pe.s === se) return { ms: earlier, offset: pe.offsetMin };
        return { ms, offset: p.offsetMin };
      }
    }
  }
  return null;
}

/** Next `count` run times strictly after `from`. Searches up to ~8 years ahead. */
export function nextRuns(s: CronSchedule, tz: string, from: Date, count: number): Date[] {
  const out: Date[] = [];
  const start = zonedParts(from, tz);
  let offset = start.offsetMin;
  let day = Date.UTC(start.y, start.mo - 1, start.d);
  const fromMs = from.getTime();
  for (let i = 0; i < 366 * 8 && out.length < count; i++, day += 86_400_000) {
    const dt = new Date(day);
    const y = dt.getUTCFullYear(), mo = dt.getUTCMonth() + 1, d = dt.getUTCDate();
    if (!dayMatches(s, y, mo, d)) continue;
    // Offset at the start and end of this local day (2 Intl calls). Equal => no DST change today,
    // so every candidate is plain arithmetic; otherwise fall back to exact per-candidate resolution.
    const offStart = zonedParts(new Date(day - offset * 60_000), tz).offsetMin;
    const offEnd = zonedParts(new Date(day + 86_399_000 - offStart * 60_000), tz).offsetMin;
    const stable = offStart === offEnd;
    offset = offEnd;
    for (const h of s.hours) {
      for (const mi of s.minutes) {
        for (const se of s.seconds) {
          const wall = Date.UTC(y, mo - 1, d, h, mi, se);
          let ms: number;
          if (stable) ms = wall - offStart * 60_000;
          else {
            const r = wallToInstant(y, mo, d, h, mi, se, tz, offStart);
            if (!r) continue; // nonexistent local time (spring-forward gap)
            ms = r.ms;
          }
          if (ms <= fromMs) continue;
          out.push(new Date(ms));
          if (out.length >= count) return out;
        }
      }
    }
  }
  return out;
}
