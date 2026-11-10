// Reporting periods (date_range), dashboard time buckets (time_buckets) and business-day job schedules
// (business_day_schedule). Every loop is bounded by input caps (1,000 buckets, 50 runs, ~10 years searched),
// so calls stay inside the Workers free-plan CPU budget.
import { assertTimeZone, DAY_MS, fmtDate, InputError, offsetCursor, parseDate, parseHolidays, parseInstant, parseLocal, parseWorkdays, viewFromWall, wallToInstantWith, WEEKDAYS, type Workweek } from "./date";
import { countryHolidayNames, HOLIDAY_YEARS } from "./holidays";
import { offsetMinutes } from "./more3";
import { dayMatches, parseCron } from "./cron";

const MIN = 60_000;
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTH_ABBR = MONTH_NAMES.map((m) => m.slice(0, 3));
const isoZ = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const day = (label: number) => fmtDate(new Date(label));
const ymd = (label: number) => { const d = new Date(label); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), dow: d.getUTCDay() }; };

type OffsetAt = (ms: number) => number;
const fastCursor = (tz: string): OffsetAt => offsetCursor(tz, (ms) => offsetMinutes(ms, tz));

/**
 * Offset lookups over a known range [lo, hi]: one pass finds every clock change (probes every 14 days, then a
 * binary search to the minute), then each lookup is a binary search. Outside the range it falls back to a direct
 * lookup. Real tz transitions are never less than ~4 weeks apart, so a 14-day probe cannot hide two of them.
 */
function offsetTable(tz: string, lo: number, hi: number): OffsetAt {
  const raw = (ms: number) => offsetMinutes(ms, tz);
  const starts: number[] = [lo], offs: number[] = [raw(lo)];
  const STEP = 14 * DAY_MS; // < half the shortest real gap between clock changes (~4 weeks, e.g. Morocco around Ramadan)
  for (let a = lo; a < hi; a += STEP) {
    const b = Math.min(a + STEP, hi), ob = raw(b);
    if (ob === offs[offs.length - 1]) continue;
    let l = a, h = b; // raw(l) is the current offset, raw(h) the new one
    while (h - l > MIN) {
      const mid = l + Math.floor((h - l) / (2 * MIN)) * MIN;
      if (raw(mid) === offs[offs.length - 1]) l = mid;
      else h = mid;
    }
    starts.push(h);
    offs.push(ob);
  }
  return (ms: number) => {
    if (ms < lo || ms > hi) return raw(ms);
    let l = 0, h = starts.length - 1;
    while (l < h) {
      const mid = (l + h + 1) >> 1;
      if (starts[mid] <= ms) l = mid;
      else h = mid - 1;
    }
    return offs[l];
  };
}

/** Direct offset lookups with a cache: for a few hundred far-apart instants (month and year bucket edges). */
function memoOffsets(tz: string): OffsetAt {
  const memo = new Map<number, number>();
  return (ms: number) => {
    let v = memo.get(ms);
    if (v === undefined) memo.set(ms, (v = offsetMinutes(ms, tz)));
    return v;
  };
}

/** Local wall time (UTC-labelled ms) -> instant. DST gaps move forward, repeated times take the first occurrence. */
function instantOf(offsetAt: OffsetAt, wall: number): number {
  return wallToInstantWith(offsetAt, wall)?.ms ?? wall - offsetAt(wall - DAY_MS) * MIN;
}
/** Local ISO datetime with offset for an instant. */
function localIso(offsetAt: OffsetAt, ms: number, tz: string): string {
  const off = offsetAt(ms);
  return viewFromWall(Math.floor(ms / 1000) * 1000 + off * MIN, off, tz).datetime;
}
/** Local calendar day (UTC-midnight label) that contains an instant. */
function localDay(offsetAt: OffsetAt, ms: number): number {
  return Math.floor((ms + offsetAt(ms) * MIN) / DAY_MS) * DAY_MS;
}

function zoneOf(v: unknown): string {
  return v === undefined ? "UTC" : assertTimeZone(v, "timezone");
}

/** A point in time: YYYY-MM-DD (local midnight), local YYYY-MM-DDTHH:MM[:SS], or ISO 8601 with offset/Z. Years 1000–9999. */
function pointMs(v: unknown, field: string, offsetAt: OffsetAt): number {
  const ms = parsePoint(v, field, offsetAt);
  const y = new Date(ms).getUTCFullYear();
  // Also guards Date.UTC, which reads years 0–99 as 1900–1999.
  if (y < 1000 || y > 9999) throw new InputError("out_of_range", `${field} must be between the years 1000 and 9999`);
  return ms;
}

function parsePoint(v: unknown, field: string, offsetAt: OffsetAt): number {
  if (typeof v === "string") {
    if (/^0\d{3}-/.test(v)) throw new InputError("out_of_range", `${field} must be between the years 1000 and 9999`);
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return instantOf(offsetAt, parseDate(v, field).getTime());
    const l = parseLocal(v);
    if (l) {
      const wall = Date.UTC(l[0], l[1] - 1, l[2], l[3], l[4], l[5]);
      const d = new Date(wall);
      if (d.getUTCMonth() !== l[1] - 1 || d.getUTCDate() !== l[2] || l[3] > 23 || l[4] > 59 || l[5] > 59) {
        throw new InputError("invalid_datetime", `${field} is not a real date and time: "${v}"`);
      }
      return instantOf(offsetAt, wall);
    }
  }
  if (typeof v !== "string") throw new InputError("invalid_datetime", `${field} must be a date (YYYY-MM-DD) or datetime (YYYY-MM-DDTHH:MM, or ISO 8601 with offset)`);
  return parseInstant(v, field).getTime();
}

function intIn(body: Record<string, unknown>, key: string, dflt: number, lo: number, hi: number): number {
  const v = body[key];
  if (v === undefined) return dflt;
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) throw new InputError("invalid_number", `${key} must be an integer between ${lo} and ${hi}`);
  return v;
}

function boolOf(body: Record<string, unknown>, key: string): boolean | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  throw new InputError("invalid_boolean", `${key} must be true or false`);
}

function oneOf<T extends string>(v: unknown, field: string, allowed: readonly T[], dflt: T): T {
  if (v === undefined) return dflt;
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw new InputError(`invalid_${field}`, `${field} must be one of ${allowed.join(", ")}`);
  return v as T;
}

const WEEK_STARTS = ["monday", "sunday", "saturday"] as const;
const weekStartOf = (v: unknown) => ({ monday: 1, sunday: 0, saturday: 6 })[oneOf(v, "week_start", WEEK_STARTS, "monday")];
const fiscalStartOf = (body: Record<string, unknown>) => intIn(body, "fiscal_year_start", 1, 1, 12);

// ---------- calendar units (shared by date_range and time_buckets) ----------

type Unit = "day" | "week" | "month" | "quarter" | "half" | "year";
interface Cal { weekStart: number; fiscal: number } // fiscal: first month of the fiscal year, 1–12

/** Start (UTC-midnight label) of the unit containing a local day. Quarters, halves and years follow the fiscal year. */
function startOf(unit: Unit, label: number, c: Cal): number {
  const { y, m, dow } = ymd(label);
  if (unit === "day") return label;
  if (unit === "week") return label - ((dow - c.weekStart + 7) % 7) * DAY_MS;
  if (unit === "month") return Date.UTC(y, m, 1);
  const off = (m - (c.fiscal - 1) + 12) % 12; // months since the fiscal year started
  const len = unit === "quarter" ? 3 : unit === "half" ? 6 : 12;
  return Date.UTC(y, m - (off % len), 1);
}

/** Move a unit start by n units. */
function addUnits(unit: Unit, label: number, n: number): number {
  if (unit === "day") return label + n * DAY_MS;
  if (unit === "week") return label + n * 7 * DAY_MS;
  const { y, m, d } = ymd(label);
  const months = n * (unit === "month" ? 1 : unit === "quarter" ? 3 : unit === "half" ? 6 : 12);
  return Date.UTC(y, m + months, d);
}

/** Move a date by whole years, clamping Feb 29 to Feb 28. */
function shiftYears(label: number, n: number): number {
  const { y, m, d } = ymd(label);
  return Date.UTC(y + n, m, Math.min(d, new Date(Date.UTC(y + n, m + 1, 0)).getUTCDate()));
}

function isoWeekOf(label: number): { year: number; week: number } {
  const { dow } = ymd(label);
  const thu = label + (4 - (dow || 7)) * DAY_MS;
  const year = new Date(thu).getUTCFullYear();
  return { year, week: Math.floor((thu - Date.UTC(year, 0, 1)) / DAY_MS / 7) + 1 };
}

/** Fiscal year (named by the calendar year it ends in) and fiscal quarter of a unit start. */
function fiscalOf(label: number, c: Cal): { fy: number; q: number; h: number } {
  const { y, m } = ymd(label);
  const off = (m - (c.fiscal - 1) + 12) % 12;
  return { fy: c.fiscal === 1 || m < c.fiscal - 1 ? y : y + 1, q: Math.floor(off / 3) + 1, h: Math.floor(off / 6) + 1 };
}

/** Short label for one whole unit starting at s. long: "October 2026" style for date_range. */
function unitLabel(unit: Unit, s: number, c: Cal, long: boolean): string {
  const { y, m } = ymd(s);
  if (unit === "day") return day(s);
  if (unit === "week") {
    if (c.weekStart !== 1) return long ? `Week of ${day(s)}` : day(s);
    const w = isoWeekOf(s);
    return `${w.year}-W${String(w.week).padStart(2, "0")}`;
  }
  if (unit === "month") return long ? `${MONTH_NAMES[m]} ${y}` : `${y}-${String(m + 1).padStart(2, "0")}`;
  const f = fiscalOf(s, c);
  const fy = c.fiscal === 1 ? String(f.fy) : `FY${f.fy}`;
  if (unit === "quarter") return long ? `Q${f.q} ${fy}` : `${fy}-Q${f.q}`;
  if (unit === "half") return long ? `H${f.h} ${fy}` : `${fy}-H${f.h}`;
  return fy;
}

function rangeOut(s: number, e: number, offsetAt: OffsetAt, tz: string) {
  const a = instantOf(offsetAt, s), b = instantOf(offsetAt, e);
  return {
    start_date: day(s),
    end_date: day(e - DAY_MS),
    days: Math.round((e - s) / DAY_MS),
    start: localIso(offsetAt, a, tz),
    end_exclusive: localIso(offsetAt, b, tz),
    start_utc: isoZ(a),
    end_exclusive_utc: isoZ(b),
  };
}

// ---------- date_range ----------

const UNIT_WORDS: Record<string, Unit> = { day: "day", week: "week", month: "month", quarter: "quarter", year: "year" };
const MAX_UNITS: Record<Unit, number> = { day: 3660, week: 520, month: 120, quarter: 40, half: 20, year: 10 };
const ALIASES: Record<string, string> = {
  mtd: "month_to_date", qtd: "quarter_to_date", ytd: "year_to_date", wtd: "week_to_date",
  current_week: "this_week", current_month: "this_month", current_quarter: "this_quarter", current_year: "this_year",
  this_day: "today", previous_day: "yesterday",
};

interface Range { s: number; e: number; unit: Unit; n: number; whole: boolean }

/** Named calendar periods ("2026-Q3", "Q3 2026", "2026") rather than periods relative to today. */
const isExplicit = (p: string) => /^(\d|q[1-4]\b)/i.test(p.trim());

const PERIOD_HELP = 'period must be like "last_month", "this_quarter", "ytd", "last_7_days", "next_2_weeks", "today", "2026-Q3", "2026-03", "2026", "2026-W14", "2026-H1" or "2026-03-15"';

function parsePeriod(period: unknown, today: number, c: Cal, includeToday: boolean | undefined): Range {
  if (typeof period === "number" && Number.isInteger(period)) period = String(period); // 2026 sent as a JSON number
  if (typeof period !== "string" || !period.trim()) throw new InputError("invalid_period", PERIOD_HELP);
  let p = period.trim().toLowerCase();
  // "2026 Q3", "Q3 2026", "2026-03" keep their shape; word periods use underscores ("last 7 days" -> last_7_days).
  p = isExplicit(p) ? p.replace(/\s+/g, "-") : p.replace(/[\s-]+/g, "_").replace(/^(previous|past)_/, "last_");
  p = ALIASES[p] ?? p;
  const whole = (unit: Unit, s: number, n = 1): Range => ({ s, e: addUnits(unit, s, n), unit, n, whole: true });
  const tomorrow = today + DAY_MS;
  let m: RegExpExecArray | null;

  if (p === "today") return whole("day", today);
  if (p === "yesterday") return whole("day", today - DAY_MS);
  if (p === "tomorrow") return whole("day", tomorrow);
  if ((m = /^(this|last|next)_(week|month|quarter|year)$/.exec(p))) {
    const unit = UNIT_WORDS[m[2]];
    const cur = startOf(unit, today, c);
    return whole(unit, addUnits(unit, cur, m[1] === "this" ? 0 : m[1] === "last" ? -1 : 1));
  }
  if ((m = /^(this|last|next)_half(?:_year)?$/.exec(p))) {
    const cur = startOf("half", today, c);
    return whole("half", addUnits("half", cur, m[1] === "this" ? 0 : m[1] === "last" ? -1 : 1));
  }
  if ((m = /^(week|month|quarter|year)_to_date$/.exec(p))) {
    const unit = UNIT_WORDS[m[1]];
    const s = startOf(unit, today, c);
    const e = includeToday === false ? today : tomorrow;
    if (e <= s) throw new InputError("empty_range", `${p} without today is empty on the first day of the ${unit}`);
    return { s, e, unit, n: 1, whole: false };
  }
  if ((m = /^(last|next)_(\d{1,4})_(day|week|month|quarter|year)s?$/.exec(p))) {
    const unit = UNIT_WORDS[m[3]];
    const n = Number(m[2]);
    if (n < 1 || n > MAX_UNITS[unit]) throw new InputError("invalid_period", `${m[3]}s must be between 1 and ${MAX_UNITS[unit]}`);
    if (unit === "day") {
      const s = m[1] === "last" ? (includeToday ? tomorrow : today) - n * DAY_MS : includeToday ? today : tomorrow;
      return { s, e: s + n * DAY_MS, unit, n, whole: true };
    }
    const cur = startOf(unit, today, c);
    if (m[1] === "next") return whole(unit, addUnits(unit, cur, 1), n);
    if (includeToday) return { s: addUnits(unit, cur, -(n - 1)), e: tomorrow, unit, n, whole: false };
    return whole(unit, addUnits(unit, cur, -n), n);
  }
  // Explicit calendar periods (calendar years; fiscal_year_start does not apply).
  const cal: Cal = { weekStart: 1, fiscal: 1 };
  if ((m = /^(\d{4})$/.exec(p))) return whole("year", Date.UTC(+m[1], 0, 1));
  if ((m = /^(\d{4})-?h([12])$/.exec(p))) return whole("half", Date.UTC(+m[1], (+m[2] - 1) * 6, 1));
  if ((m = /^(\d{4})-?q([1-4])$/.exec(p))) return whole("quarter", Date.UTC(+m[1], (+m[2] - 1) * 3, 1));
  if ((m = /^q([1-4])-?(\d{4})$/.exec(p))) return whole("quarter", Date.UTC(+m[2], (+m[1] - 1) * 3, 1));
  if ((m = /^(\d{4})-?w(\d{2})$/.exec(p))) {
    const y = +m[1], w = +m[2];
    const jan4 = Date.UTC(y, 0, 4);
    const s = startOf("week", jan4, cal) + (w - 1) * 7 * DAY_MS;
    if (w < 1 || isoWeekOf(s).year !== y) throw new InputError("invalid_period", `${y} has no ISO week ${w}`);
    return whole("week", s);
  }
  if ((m = /^(\d{4})-(\d{2})$/.exec(p))) {
    if (+m[2] < 1 || +m[2] > 12) throw new InputError("invalid_period", `month must be 01–12 in "${period}"`);
    return whole("month", Date.UTC(+m[1], +m[2] - 1, 1));
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(p)) return whole("day", parseDate(p, "period").getTime());
  throw new InputError("invalid_period", PERIOD_HELP);
}

function rangeLabel(r: Range, c: Cal, explicitIso: boolean): string {
  if (r.whole && r.n === 1) return unitLabel(r.unit, r.s, explicitIso ? { weekStart: 1, fiscal: 1 } : c, true);
  return `${day(r.s)} to ${day(r.e - DAY_MS)}`;
}

const COMPARE = ["previous_period", "previous_year"] as const;

export function dateRange(body: Record<string, unknown>) {
  const tz = zoneOf(body.timezone);
  const offsetAt = fastCursor(tz);
  const c: Cal = { weekStart: weekStartOf(body.week_start), fiscal: fiscalStartOf(body) };
  const today = localDay(offsetAt, body.as_of === undefined ? Date.now() : pointMs(body.as_of, "as_of", offsetAt));
  const r = parsePeriod(body.period, today, c, boolOf(body, "include_today"));
  const explicit = isExplicit(String(body.period));
  if (new Date(r.s).getUTCFullYear() < 1000 || new Date(r.e).getUTCFullYear() > 9999) throw new InputError("out_of_range", "the range must fall between years 1000 and 9999");

  const out: Record<string, unknown> = {
    period: body.period,
    timezone: tz,
    as_of: day(today),
    label: rangeLabel(r, c, explicit),
    ...rangeOut(r.s, r.e, offsetAt, tz),
  };
  // Named periods ("2026", "2026-Q3", "2026-W14") are calendar/ISO periods, so these options do not apply to them.
  if (!explicit && c.weekStart !== 1) out.week_start = WEEKDAYS[c.weekStart].toLowerCase();
  if (!explicit && c.fiscal !== 1) out.fiscal_year_start = MONTH_NAMES[c.fiscal - 1];

  const compare = body.compare === undefined ? undefined : oneOf(body.compare, "compare", COMPARE, "previous_period");
  if (compare) {
    let s: number, e: number, method: string;
    const len = r.e - r.s;
    if (compare === "previous_period") {
      s = addUnits(r.unit, r.s, -r.n);
      e = r.whole ? r.s : Math.min(s + len, addUnits(r.unit, s, r.n));
      method = r.whole ? `the ${r.n === 1 ? r.unit : `${r.n} ${r.unit}s`} before` : `the same number of days into the previous ${r.unit}`;
    } else if (r.unit === "week") {
      s = r.s - 364 * DAY_MS;
      e = s + len;
      method = "52 weeks earlier (same weekdays)";
    } else {
      s = shiftYears(r.s, -1);
      e = r.whole && r.unit !== "day" ? addUnits(r.unit, s, r.n) : s + len;
      method = "same dates one year earlier";
    }
    const prev: Range = { s, e, unit: r.unit, n: r.n, whole: r.whole && (compare === "previous_period" || r.unit !== "week") };
    out.comparison = { type: compare, method, label: rangeLabel(prev, c, explicit), ...rangeOut(s, e, offsetAt, tz) };
  }
  return out;
}

// ---------- time_buckets ----------

const BUCKETS = ["minute", "hour", "day", "week", "month", "quarter", "year"] as const;
const MAX_BUCKETS = 1000; // minute, hour and day buckets
const MAX_LONG_BUCKETS = 500; // week, month, quarter and year buckets
const MAX_SPAN_YEARS = 200;
const DIVISORS = { minute: [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30], hour: [1, 2, 3, 4, 6, 8, 12] };

/** How far whole buckets can reach beyond [from, to). */
const BUCKET_REACH: Record<(typeof BUCKETS)[number], number> = { minute: 2, hour: 2, day: 2, week: 9, month: 33, quarter: 95, year: 370 };

export function timeBuckets(body: Record<string, unknown>) {
  const tz = zoneOf(body.timezone);
  const parseAt = fastCursor(tz);
  const bucket = oneOf(body.bucket, "bucket", BUCKETS, "day");
  const c: Cal = { weekStart: weekStartOf(body.week_start), fiscal: fiscalStartOf(body) };
  const size = intIn(body, "size", 1, 1, 30);
  if (bucket === "minute" || bucket === "hour") {
    if (!DIVISORS[bucket].includes(size)) throw new InputError("invalid_size", `${bucket} size must be one of ${DIVISORS[bucket].join(", ")} (so buckets line up with the clock)`);
  } else if (size !== 1) throw new InputError("invalid_size", `size applies only to minute and hour buckets`);
  if (body.from === undefined || body.to === undefined) throw new InputError("missing_range", "from and to are required");
  const fromMs = pointMs(body.from, "from", parseAt);
  const toMs = pointMs(body.to, "to", parseAt);
  if (toMs <= fromMs) throw new InputError("invalid_range", "to must be after from (to is exclusive)");
  const clip = boolOf(body, "clip") ?? false;
  if (toMs - fromMs > MAX_SPAN_YEARS * 366 * DAY_MS) throw new InputError("range_too_large", `from and to must be at most ${MAX_SPAN_YEARS} years apart`);
  // Cheap early reject before any offset work: the range is surely too many buckets even if every bucket is as
  // long as it can be (the loop below enforces the exact limit).
  const longest = { minute: size * MIN, hour: size * 60 * MIN, day: 25 * 60 * MIN, week: 7 * DAY_MS + 60 * MIN, month: 31 * DAY_MS + 60 * MIN, quarter: 92 * DAY_MS + 60 * MIN, year: 366 * DAY_MS + 60 * MIN }[bucket];
  // Week and longer buckets need about one time zone lookup per edge (~6 µs each on Workers), so they get a lower cap.
  const maxBuckets = bucket === "minute" || bucket === "hour" || bucket === "day" ? MAX_BUCKETS : MAX_LONG_BUCKETS;
  const tooMany = () => new InputError("too_many_buckets", `more than ${maxBuckets} ${bucket} buckets; use a larger bucket or a shorter range`);
  if ((toMs - fromMs) / longest > maxBuckets + 2) throw tooMany();
  // Minute to week buckets: one offset table for the range (at most ~20 years). Month, quarter and year buckets can
  // span centuries, where a table would cost far more than looking up each of their at most 1,001 edges directly.
  const reach = BUCKET_REACH[bucket] * DAY_MS;
  const offsetAt = ["month", "quarter", "year"].includes(bucket) ? memoOffsets(tz) : offsetTable(tz, fromMs - reach, toMs + reach);

  // Bucket edges (instants); bucket i is [edges[i], edges[i + 1]). Each edge is formatted once and shared.
  const edges: number[] = [];
  const labels: (string | null)[] = []; // null: label from the local start time (minute/hour buckets)
  if (bucket === "minute" || bucket === "hour") {
    // Real elapsed time, aligned to local clock boundaries and re-aligned after a clock change.
    const step = size * (bucket === "hour" ? 60 : 1) * MIN;
    const off0 = offsetAt(fromMs);
    let t = Math.floor((fromMs + off0 * MIN) / step) * step - off0 * MIN;
    edges.push(t);
    while (t < toMs) {
      let next = t + step;
      const offN = offsetAt(next);
      const cand = Math.floor((next + offN * MIN) / step) * step - offN * MIN;
      if (cand > t && offsetAt(cand) === offN) next = cand;
      if (labels.length >= maxBuckets) throw tooMany();
      labels.push(null);
      edges.push((t = next));
    }
  } else {
    const unit = bucket as Unit;
    // Local midnight -> instant. Guess with the previous edge's offset and verify with one lookup: if the offset at
    // the guess equals the guess's offset, that instant really shows this wall time (the first occurrence, since the
    // previous offset is the pre-change one). Only edges just after a clock change need the full method.
    let prevOff = offsetAt(fromMs);
    const edgeAt = (wall: number) => {
      const guess = wall - prevOff * MIN;
      if (offsetAt(guess) === prevOff) return guess;
      const ms = instantOf(offsetAt, wall);
      prevOff = offsetAt(ms);
      return ms;
    };
    let s = startOf(unit, localDay(offsetAt, fromMs), c);
    let a = edgeAt(s);
    edges.push(a);
    while (a < toMs) {
      if (labels.length >= maxBuckets) throw tooMany();
      labels.push(unitLabel(unit, s, c, false));
      s = addUnits(unit, s, 1);
      edges.push((a = edgeAt(s)));
    }
  }
  const last = edges.length - 1;
  const partialFirst = edges[0] < fromMs, partialLast = edges[last] > toMs;
  let local = edges.map((ms) => localIso(offsetAt, ms, tz));
  // Minute/hour labels are the bucket's aligned local start without seconds, keeping the offset: 2026-11-01T01:00-04:00
  const names = labels.map((l, i) => l ?? local[i].slice(0, 16) + local[i].slice(19));
  if (clip) {
    edges[0] = Math.max(edges[0], fromMs);
    edges[last] = Math.min(edges[last], toMs);
    local = [localIso(offsetAt, edges[0], tz), ...local.slice(1, last), localIso(offsetAt, edges[last], tz)];
  }
  const utcs = edges.map(isoZ);

  const buckets = names.map((label, i) => {
    const a = edges[i], b = edges[i + 1];
    const partial = (i === 0 && partialFirst) || (i === labels.length - 1 && partialLast);
    return {
      label,
      start: local[i],
      end: local[i + 1],
      start_utc: utcs[i],
      end_utc: utcs[i + 1],
      hours: Math.round(((b - a) / 3_600_000) * 1e6) / 1e6,
      ...(partial ? { partial: true } : {}),
    };
  });
  return {
    timezone: tz,
    bucket,
    size,
    from: localIso(offsetAt, fromMs, tz),
    to: localIso(offsetAt, toMs, tz),
    ...(bucket === "week" ? { week_start: WEEKDAYS[c.weekStart].toLowerCase() } : {}),
    ...(c.fiscal !== 1 && ["quarter", "year"].includes(bucket) ? { fiscal_year_start: MONTH_NAMES[c.fiscal - 1] } : {}),
    count: buckets.length,
    buckets,
  };
}

// ---------- business_day_schedule ----------

const RULES = ["nth_business_day", "day_of_month", "weekly", "cron"] as const;
const ADJUSTS = ["next", "previous", "modified_following", "modified_preceding", "nearest", "skip", "none"] as const;
type Adjust = (typeof ADJUSTS)[number];
const MAX_CRON_RUNS_PER_DAY = 96;
const MARGIN = 40 * DAY_MS; // adjustments never move a date further than this (longest holiday runs are ~10 days)
const MAX_SEARCH_DAYS = 3660;

/** Business-day calendar with country holidays loaded one year at a time. */
class BizCal {
  private years = new Map<number, Map<string, string>>();
  /** Days with known holidays: [dataStart, dataEnd). Unlimited without a country. */
  readonly dataStart: number;
  readonly dataEnd: number;
  constructor(private ww: Workweek, private country: unknown, private custom: Set<string>) {
    if (country !== undefined) countryHolidayNames(country, HOLIDAY_YEARS[0], HOLIDAY_YEARS[0]); // validates the code
    this.dataStart = country === undefined ? -Infinity : Date.UTC(HOLIDAY_YEARS[0], 0, 1);
    this.dataEnd = country === undefined ? Infinity : Date.UTC(HOLIDAY_YEARS[1] + 1, 0, 1);
  }
  private yearMap(y: number): Map<string, string> {
    let map = this.years.get(y);
    if (!map) {
      if (this.country !== undefined && (y < HOLIDAY_YEARS[0] || y > HOLIDAY_YEARS[1])) {
        throw new InputError("year_out_of_range", `country holiday data covers ${HOLIDAY_YEARS[0]}–${HOLIDAY_YEARS[1]}`);
      }
      map = this.country === undefined ? new Map() : countryHolidayNames(this.country, y, y);
      this.years.set(y, map);
    }
    return map;
  }
  holiday(label: number): string | null {
    const d = day(label);
    return this.yearMap(new Date(label).getUTCFullYear()).get(d) ?? (this.custom.has(d) ? "Custom holiday" : null);
  }
  isBiz(label: number): boolean {
    return this.ww[new Date(label).getUTCDay()] && this.holiday(label) === null;
  }
  reason(label: number): string | null {
    if (!this.ww[new Date(label).getUTCDay()]) return "weekend";
    const h = this.holiday(label);
    return h === null ? null : `holiday: ${h}`;
  }
  roll(label: number, dir: 1 | -1): number {
    for (let i = 0; i < 60; i++, label += dir * DAY_MS) if (this.isBiz(label)) return label;
    throw new InputError("no_business_day", "no business day within 60 days; check workdays and holidays");
  }
  adjust(label: number, how: Adjust): number | null {
    if (how === "none" || this.isBiz(label)) return label;
    if (how === "skip") return null;
    if (how === "next") return this.roll(label, 1);
    if (how === "previous") return this.roll(label, -1);
    const month = new Date(label).getUTCMonth();
    if (how === "modified_following") { const n = this.roll(label, 1); return new Date(n).getUTCMonth() === month ? n : this.roll(label, -1); }
    if (how === "modified_preceding") { const p = this.roll(label, -1); return new Date(p).getUTCMonth() === month ? p : this.roll(label, 1); }
    const p = this.roll(label, -1), n = this.roll(label, 1);
    return label - p <= n - label ? p : n; // nearest; ties go to the earlier day
  }
}

interface Nominal { day: number; tods: number[] } // tods: milliseconds after local midnight

interface Rule {
  kind: (typeof RULES)[number];
  adjust: Adjust;
  /** Scheduled (unadjusted) days in [a, b), in order. nth_business_day days are already business days. */
  nominals(a: number, b: number, cal: BizCal): Nominal[];
  describe: string;
}

function hhmmMs(v: unknown): { ms: number; text: string } {
  const s = v === undefined ? "09:00" : v;
  const m = typeof s === "string" ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s) : null;
  if (!m) throw new InputError("invalid_time", 'time must be HH:MM (24h), e.g. "09:00"');
  return { ms: (Number(m[1]) * 60 + Number(m[2])) * MIN, text: s as string };
}

function monthsFilter(v: unknown): Set<number> | null {
  if (v === undefined) return null;
  if (!Array.isArray(v) || v.length === 0 || v.length > 12 || v.some((x) => !Number.isInteger(x) || x < 1 || x > 12)) {
    throw new InputError("invalid_months", "months must be an array of month numbers 1–12, e.g. [1, 4, 7, 10] for quarterly");
  }
  return new Set(v as number[]);
}

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;

/** Month starts (UTC labels) from the month of a up to b. */
function* monthStarts(a: number, b: number): Generator<number> {
  const { y, m } = ymd(a);
  for (let i = 0; ; i++) {
    const s = Date.UTC(y, m + i, 1);
    if (s >= b) return;
    yield s;
  }
}

function buildRule(body: Record<string, unknown>): Rule {
  if (body.rule === undefined) throw new InputError("invalid_rule", `rule is required: one of ${RULES.join(", ")}`);
  const kind = oneOf(body.rule, "rule", RULES, "weekly");
  const adjust = kind === "nth_business_day" ? "none" : oneOf(body.adjust, "adjust", ADJUSTS, "next");
  const months = monthsFilter(body.months);
  const monthText = months ? [...months].sort((x, y) => x - y).map((x) => MONTH_ABBR[x - 1]).join(", ") : "every month";
  const inMonths = (label: number) => !months || months.has(new Date(label).getUTCMonth() + 1);

  if (kind === "cron") {
    if (typeof body.expression !== "string") throw new InputError("invalid_cron", 'cron rules need expression, e.g. "0 9 * * 1-5"');
    const s = parseCron(body.expression);
    if (s.seconds.length * s.minutes.length * s.hours.length > MAX_CRON_RUNS_PER_DAY) {
      throw new InputError("too_frequent", `business_day_schedule supports cron rules that run at most ${MAX_CRON_RUNS_PER_DAY} times a day (every 15 minutes)`);
    }
    const tods: number[] = [];
    for (const h of s.hours) for (const mi of s.minutes) for (const se of s.seconds) tods.push(((h * 60 + mi) * 60 + se) * 1000);
    return {
      kind, adjust,
      describe: `cron "${body.expression}"`,
      nominals(a, b) {
        const out: Nominal[] = [];
        for (let t = a; t < b; t += DAY_MS) {
          const { y, m, d } = ymd(t);
          if (inMonths(t) && dayMatches(s, y, m + 1, d)) out.push({ day: t, tods });
        }
        return out;
      },
    };
  }

  const time = hhmmMs(body.time);
  const at = ` at ${time.text}`;
  if (kind === "weekly") {
    const w = body.weekdays;
    if (!Array.isArray(w) || w.length === 0 || w.length > 7 || w.some((x) => !Number.isInteger(x) || x < 0 || x > 6)) {
      throw new InputError("invalid_weekdays", "weekly rules need weekdays: weekday numbers 0–6 (0 = Sunday), e.g. [1] for every Monday");
    }
    const set = new Set(w as number[]);
    return {
      kind, adjust,
      describe: `every ${[...set].sort((x, y) => ((x + 6) % 7) - ((y + 6) % 7)).map((x) => WEEKDAYS[x]).join(", ")}${months ? ` in ${monthText}` : ""}${at}`,
      nominals(a, b) {
        const out: Nominal[] = [];
        for (let t = a; t < b; t += DAY_MS) if (set.has(new Date(t).getUTCDay()) && inMonths(t)) out.push({ day: t, tods: [time.ms] });
        return out;
      },
    };
  }
  if (kind === "day_of_month") {
    const dv = body.day;
    if (!(dv === "last" || (Number.isInteger(dv) && (dv as number) >= 1 && (dv as number) <= 31))) {
      throw new InputError("invalid_day", 'day_of_month rules need day: 1–31 or "last" (31 means the month\'s last day in shorter months)');
    }
    return {
      kind, adjust,
      describe: `${dv === "last" ? "last day" : `day ${dv}`} of ${monthText}${at}`,
      nominals(a, b) {
        const out: Nominal[] = [];
        for (const s of monthStarts(a, b)) {
          if (!inMonths(s)) continue;
          const { y, m } = ymd(s);
          const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
          const t = Date.UTC(y, m, dv === "last" ? last : Math.min(dv as number, last));
          if (t >= a && t < b) out.push({ day: t, tods: [time.ms] });
        }
        return out;
      },
    };
  }
  // nth_business_day
  const n = body.n;
  if (!Number.isInteger(n) || n === 0 || Math.abs(n as number) > 23) {
    throw new InputError("invalid_n", "nth_business_day rules need n: 1–23 (1 = first business day), or -1 to -23 counting back from the month end (-1 = last business day)");
  }
  const nn = n as number;
  return {
    kind, adjust,
    describe: `${nn === -1 ? "last" : nn < 0 ? `${ordinal(-nn)}-to-last` : ordinal(nn)} business day of ${monthText}${at}`,
    nominals(a, b, cal) {
      const out: Nominal[] = [];
      for (const s of monthStarts(a, b)) {
        if (!inMonths(s)) continue;
        const e = addUnits("month", s, 1);
        const biz: number[] = [];
        for (let t = s; t < e; t += DAY_MS) if (cal.isBiz(t)) biz.push(t);
        const t = nn > 0 ? biz[nn - 1] : biz[biz.length + nn];
        if (t !== undefined && t >= a && t < b) out.push({ day: t, tods: [time.ms] });
      }
      return out;
    },
  };
}

const ADJUST_TEXT: Record<Adjust, string> = {
  next: "moved to the next business day when it falls on a weekend or holiday",
  previous: "moved to the previous business day when it falls on a weekend or holiday",
  modified_following: "moved to the next business day, or the previous one if that would cross into the next month",
  modified_preceding: "moved to the previous business day, or the next one if that would cross into the previous month",
  nearest: "moved to the nearest business day (the earlier one on a tie)",
  skip: "skipped on weekends and holidays",
  none: "not adjusted for weekends or holidays",
};

interface Run { ms: number; day: number; nominal: number }

/** Runs whose actual (adjusted) day is in [dayLo, dayHi), from scheduled days in [a, b) (clamped to the holiday data). */
function runsIn(rule: Rule, cal: BizCal, a: number, b: number, dayLo: number, dayHi: number, offsetAt: OffsetAt): Run[] {
  const out: Run[] = [];
  [a, b] = [Math.max(a, cal.dataStart), Math.min(b, cal.dataEnd)];
  if (a >= b) return out;
  for (const nom of rule.nominals(a, b, cal)) {
    let d: number | null;
    try {
      d = rule.kind === "nth_business_day" ? nom.day : cal.adjust(nom.day, rule.adjust);
    } catch (e) {
      // Moving this date would cross the end of the holiday data (e.g. 2050-12-31 to 2051): leave it out.
      if (e instanceof InputError && e.code === "year_out_of_range") continue;
      throw e;
    }
    if (d === null || d < dayLo || d >= dayHi) continue;
    for (const tod of nom.tods) out.push({ ms: instantOf(offsetAt, d + tod), day: d, nominal: nom.day });
  }
  return out;
}

/** Sort by time and drop duplicates; when a moved run lands on another scheduled run, report the scheduled one. */
function sortUnique(runs: Run[]): Run[] {
  const seen = new Set<number>();
  const moved = (r: Run) => (r.day === r.nominal ? 0 : 1);
  return runs.sort((x, y) => x.ms - y.ms || moved(x) - moved(y) || x.nominal - y.nominal).filter((r) => !seen.has(r.ms) && (seen.add(r.ms), true));
}

export function businessDaySchedule(body: Record<string, unknown>) {
  const tz = zoneOf(body.timezone);
  const offsetAt = fastCursor(tz);
  const rule = buildRule(body);
  const count = intIn(body, "count", 5, 1, 50);
  const cal = new BizCal(parseWorkdays(body.workdays), body.country, parseHolidays(body.holidays));
  const fromMs = body.from === undefined ? Date.now() : pointMs(body.from, "from", offsetAt);
  const fromDay = localDay(offsetAt, fromMs);
  if (fromDay < cal.dataStart || fromDay >= cal.dataEnd) throw new InputError("year_out_of_range", `country holiday data covers ${HOLIDAY_YEARS[0]}–${HOLIDAY_YEARS[1]}`);

  // Grow the window until `count` runs are certain (no later scheduled date can be moved in front of them).
  // With a country, the search stops where the holiday data ends.
  let runs: Run[] = [];
  let hitDataEnd = false;
  for (let span = 16 * DAY_MS; ; span *= 2) {
    const end = Math.min(fromDay + Math.min(span, MAX_SEARCH_DAYS * DAY_MS), cal.dataEnd);
    runs = sortUnique(runsIn(rule, cal, fromDay - MARGIN, end + MARGIN, fromDay, end, offsetAt)).filter((r) => r.ms >= fromMs);
    if (runs.length >= count || span >= MAX_SEARCH_DAYS * DAY_MS || end === cal.dataEnd) {
      hitDataEnd = runs.length < count && end === cal.dataEnd;
      runs = runs.slice(0, count);
      break;
    }
  }

  const view = (r: Run) => ({
    date: day(r.day),
    datetime: localIso(offsetAt, r.ms, tz),
    utc: isoZ(r.ms),
    weekday: WEEKDAYS[new Date(r.day).getUTCDay()],
    scheduled_date: day(r.nominal),
    adjusted: r.day !== r.nominal,
    is_business_day: cal.isBiz(r.day),
    ...(r.day !== r.nominal ? { reason: cal.reason(r.nominal) } : {}),
  });

  // "Should this run on <date>?" (default: the local date of `from`, i.e. today).
  const checkDay = body.check_date === undefined ? fromDay : parseDate(body.check_date, "check_date").getTime();
  const onDay = sortUnique(runsIn(rule, cal, checkDay - MARGIN, checkDay + MARGIN + DAY_MS, checkDay, checkDay + DAY_MS, offsetAt));
  const scheduledHere = rule.kind === "nth_business_day" ? [] : rule.nominals(checkDay, checkDay + DAY_MS, cal);
  let movedTo: number | null | "unknown" = checkDay;
  try {
    if (scheduledHere.length) movedTo = cal.adjust(checkDay, rule.adjust);
  } catch (e) {
    if (!(e instanceof InputError && e.code === "year_out_of_range")) throw e;
    movedTo = "unknown"; // would move past the end of the holiday data
  }
  const check = {
    date: day(checkDay),
    weekday: WEEKDAYS[new Date(checkDay).getUTCDay()],
    is_business_day: cal.isBiz(checkDay),
    reason: cal.reason(checkDay),
    runs: onDay.length > 0,
    run_times: onDay.map((r) => ({ datetime: localIso(offsetAt, r.ms, tz), utc: isoZ(r.ms), scheduled_date: day(r.nominal) })),
    ...(scheduledHere.length && movedTo !== checkDay ? { scheduled_run_moved_to: movedTo === null ? "skipped" : movedTo === "unknown" ? "beyond holiday data" : day(movedTo) } : {}),
  };

  const holidaysText = body.country !== undefined ? `; holidays: ${String(body.country).toUpperCase()} public holidays` : "";
  return {
    rule: rule.kind,
    description: `${rule.describe} (${tz})${rule.kind === "nth_business_day" ? "" : `, ${ADJUST_TEXT[rule.adjust]}`}${holidaysText}`,
    timezone: tz,
    adjust: rule.adjust,
    from: localIso(offsetAt, fromMs, tz),
    count: runs.length,
    runs: runs.map(view),
    check,
    ...(hitDataEnd ? { note: `country holiday data ends on ${HOLIDAY_YEARS[1]}-12-31, so later runs are not listed` } : {}),
  };
}
