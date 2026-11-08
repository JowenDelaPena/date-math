// Pure date/time logic. No dependencies; uses Date (UTC math) + Intl for time zones.

import { InputError } from "./errors";
import { countryHolidayDates } from "./holidays";
export { InputError };

export const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MAX_BUSINESS_DAYS = 1_000_000; // ~3,800 years; computed in O(1), so the cap only guards range

// ---------- parsing ----------

/** Parse YYYY-MM-DD into a UTC-midnight Date. */
export function parseDate(value: unknown, field: string): Date {
  if (typeof value !== "string") throw new InputError("invalid_date", `${field} must be a string YYYY-MM-DD`);
  const m = DATE_RE.exec(value);
  if (!m) throw new InputError("invalid_date", `${field} must be YYYY-MM-DD, got "${value}"`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    throw new InputError("invalid_date", `${field} is not a real calendar date: "${value}"`);
  }
  return date;
}

/** Parse a date (YYYY-MM-DD) or ISO 8601 datetime with offset/Z. */
export function parseDateOrDateTime(value: unknown, field: string): { date: Date; hasTime: boolean } {
  if (typeof value === "string" && DATE_RE.test(value)) return { date: parseDate(value, field), hasTime: false };
  return { date: parseInstant(value, field), hasTime: true };
}

/** Parse an ISO 8601 datetime that includes an offset or Z. */
export function parseInstant(value: unknown, field: string): Date {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new InputError(
      "invalid_datetime",
      `${field} must be ISO 8601 with offset, e.g. 2026-11-07T14:30:00Z or 2026-11-07T14:30:00+08:00`,
    );
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new InputError("invalid_datetime", `${field} is not a valid datetime`);
  return d;
}

/** Parse a local wall-clock datetime without offset: YYYY-MM-DDTHH:MM[:SS]. */
export function parseLocal(value: string): [number, number, number, number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
}

export function assertTimeZone(tz: unknown, field: string): string {
  if (typeof tz !== "string" || tz.length === 0) throw new InputError("invalid_timezone", `${field} must be an IANA time zone, e.g. "Asia/Manila"`);
  try {
    formatterFor(tz);
  } catch {
    throw new InputError("invalid_timezone", `${field} is not a known IANA time zone: "${tz}"`);
  }
  return tz;
}

export function parseHolidays(value: unknown): Set<string> {
  if (value === undefined || value === null) return new Set();
  if (!Array.isArray(value) || value.length > 1000) throw new InputError("invalid_holidays", "holidays must be an array of up to 1000 YYYY-MM-DD strings");
  return new Set(value.map((h, i) => fmtDate(parseDate(h, `holidays[${i}]`))));
}

/** Working days of the week as flags indexed by getUTCDay() (0 = Sunday). */
export type Workweek = readonly boolean[];
export const MON_FRI: Workweek = [false, true, true, true, true, true, false];

/** workdays: weekday numbers 0–6 (0 = Sunday). Default Mon–Fri. */
export function parseWorkdays(value: unknown): Workweek {
  if (value === undefined || value === null) return MON_FRI;
  if (!Array.isArray(value) || value.length === 0 || value.length > 7 || value.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw new InputError("invalid_workdays", "workdays must be an array of weekday numbers 0–6 (0 = Sunday), e.g. [1,2,3,4,5] for Mon–Fri, [0,1,2,3,4] for Sun–Thu, [1,2,3,4,5,6] for Mon–Sat");
  }
  const w = Array<boolean>(7).fill(false);
  for (const d of value as number[]) w[d] = true;
  return w;
}

export function intField(body: Record<string, unknown>, key: string, max = 1_000_000): number {
  const v = body[key];
  if (v === undefined || v === null) return 0;
  if (typeof v !== "number" || !Number.isInteger(v) || Math.abs(v) > max) {
    throw new InputError("invalid_number", `${key} must be an integer between -${max} and ${max}`);
  }
  return v;
}

// ---------- helpers ----------

export function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m0: number): number {
  return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
}

/** Add calendar months, clamping the day (Jan 31 + 1 month = Feb 28/29). Preserves time of day. */
function addMonths(d: Date, months: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const ty = y + Math.floor(m / 12);
  const tm = ((m % 12) + 12) % 12;
  const day = Math.min(d.getUTCDate(), daysInMonth(ty, tm));
  return new Date(Date.UTC(ty, tm, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
}

export function isBusinessDay(d: Date, holidays: Set<string>, ww: Workweek = MON_FRI): boolean {
  return ww[d.getUTCDay()] && !holidays.has(fmtDate(d));
}

const isWorkdayMs = (ms: number, ww: Workweek) => ww[new Date(ms).getUTCDay()];
const perWeek = (ww: Workweek) => ww.filter(Boolean).length;

/** Holidays (as UTC-midnight ms) that fall on a working day. */
function workdayHolidayMs(holidays: Set<string>, ww: Workweek): number[] {
  return [...holidays].map((h) => Date.parse(h + "T00:00:00Z")).filter((ms) => isWorkdayMs(ms, ww));
}

/** Working days in [lo, hi) in O(1): perWeek per full week plus the remainder. lo/hi are UTC midnights. */
export function weekdaysBetween(loMs: number, hiMs: number, ww: Workweek = MON_FRI): number {
  const days = Math.round((hiMs - loMs) / DAY_MS);
  let count = Math.floor(days / 7) * perWeek(ww);
  const startDow = new Date(loMs).getUTCDay();
  for (let i = 0; i < days % 7; i++) if (ww[(startDow + i) % 7]) count++;
  return count;
}

/** Move n working days (no holidays) from d, counting the days stepped onto. O(1): whole weeks, then at most ~13 steps. */
function addWeekdays(ms: number, n: number, ww: Workweek): number {
  const step = n > 0 ? 1 : -1;
  const pw = perWeek(ww);
  let weeks = Math.floor(Math.abs(n) / pw);
  let rem = Math.abs(n) % pw;
  if (rem === 0 && weeks > 0) {
    weeks--; // land on a working day, never a rest day
    rem = pw;
  }
  ms += step * weeks * 7 * DAY_MS;
  while (rem > 0) {
    ms += step * DAY_MS;
    if (isWorkdayMs(ms, ww)) rem--;
  }
  return ms;
}

/** Add n business days (skipping rest days and holidays). Work is bounded by holiday count, not n. */
export function addBusinessDays(ms: number, n: number, holidays: Set<string>, ww: Workweek = MON_FRI): number {
  const hol = workdayHolidayMs(holidays, ww);
  while (n !== 0) {
    const target = addWeekdays(ms, n, ww);
    // Holidays stepped over in this segment each cost one extra business day.
    const missed = n > 0 ? hol.filter((h) => h > ms && h <= target).length : hol.filter((h) => h < ms && h >= target).length;
    ms = target;
    n = (n > 0 ? 1 : -1) * missed;
  }
  return ms;
}

function isoWeek(d: Date): { iso_year: number; iso_week: number } {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const wd = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - wd); // Thursday of this ISO week
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  return { iso_year: t.getUTCFullYear(), iso_week: Math.ceil(((t.getTime() - yearStart) / DAY_MS + 1) / 7) };
}

/** Calendar difference a→b as years/months/days (a <= b). */
function calendarDiff(a: Date, b: Date): { years: number; months: number; days: number; remMs: number } {
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (addMonths(a, months).getTime() > b.getTime()) months--;
  const rest = b.getTime() - addMonths(a, months).getTime();
  return { years: Math.trunc(months / 12), months: months % 12, days: Math.floor(rest / DAY_MS), remMs: rest % DAY_MS };
}

/** Wall-clock parts of an instant in a time zone. */
// Constructing Intl.DateTimeFormat is expensive (~1ms); reuse one per zone (bounded cache).
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "long",
    });
    if (formatters.size > 500) formatters.clear();
    formatters.set(tz, f);
  }
  return f;
}

export function zonedParts(instant: Date, tz: string) {
  const parts = formatterFor(tz).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const y = Number(get("year")), mo = Number(get("month")), d = Number(get("day"));
  const h = Number(get("hour")), mi = Number(get("minute")), s = Number(get("second"));
  const offsetMin = Math.round((Date.UTC(y, mo - 1, d, h, mi, s) - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
  return { y, mo, d, h, mi, s, weekday: get("weekday"), offsetMin };
}

function fmtOffset(min: number): string {
  const sign = min < 0 ? "-" : "+";
  const a = Math.abs(min);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function zonedView(instant: Date, tz: string) {
  const p = zonedParts(instant, tz);
  const offset = fmtOffset(p.offsetMin);
  return {
    timezone: tz,
    datetime: `${pad(p.y, 4)}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${offset}`,
    date: `${pad(p.y, 4)}-${pad(p.mo)}-${pad(p.d)}`,
    time: `${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`,
    weekday: p.weekday,
    utc_offset: offset,
  };
}

/**
 * Fast UTC-offset lookups over a time range. Offsets only change at DST/rule transitions, which in real tz data
 * are never less than ~4 weeks apart, so we verify the offset at both ends of 7-day segments (2 Intl calls/week)
 * and binary-search the exact transition minute when the ends differ.
 */
export function offsetCursor(tz: string, rawOffset?: (ms: number) => number) {
  const WEEK = 7 * DAY_MS;
  const segs: { a: number; b: number; off: number }[] = [];
  const raw = rawOffset ?? ((ms: number) => zonedParts(new Date(ms), tz).offsetMin);
  return function offsetAt(ms: number): number {
    for (let i = segs.length - 1; i >= 0; i--) if (ms >= segs[i].a && ms <= segs[i].b) return segs[i].off;
    const a = ms, b = ms + WEEK;
    const oa = raw(a), ob = raw(b);
    if (oa === ob) {
      segs.push({ a, b, off: oa });
      return oa;
    }
    let lo = a, hi = b; // raw(lo) === oa, raw(hi) === ob
    while (hi - lo > 60_000) {
      const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000;
      if (raw(mid) === oa) lo = mid;
      else hi = mid;
    }
    segs.push({ a, b: lo, off: oa }, { a: hi, b, off: ob });
    if (segs.length > 64) segs.splice(0, segs.length - 64);
    return oa;
  };
}

/** Wall time (as UTC ms) -> instant using an offsetCursor. Returns null for nonexistent local times (DST gaps). */
export function wallToInstantWith(offsetAt: (ms: number) => number, wall: number): { ms: number; offset: number } | null {
  const o1 = offsetAt(wall);
  let ms = wall - o1 * 60_000;
  let o2 = offsetAt(ms);
  if (o2 !== o1) {
    ms = wall - o2 * 60_000;
    if (offsetAt(ms) !== o2) return null; // gap: this wall time never happens
  }
  // Repeated wall time (fall-back): prefer the earlier instant.
  const earlier = ms - 3_600_000;
  const oe = offsetAt(earlier);
  if (oe !== o2 && earlier + oe * 60_000 === wall) return { ms: earlier, offset: oe };
  return { ms, offset: o2 };
}

/** Format a wall time (UTC ms) + offset as a zonedView-compatible object without Intl. */
export function viewFromWall(wall: number, offsetMin: number, tz: string) {
  const d = new Date(wall);
  const date = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  const offset = fmtOffset(offsetMin);
  return { timezone: tz, datetime: `${date}T${time}${offset}`, date, time, weekday: WEEKDAYS[d.getUTCDay()], utc_offset: offset };
}

/** Convert a local wall-clock time in tz to a UTC instant (DST gaps resolve forward). */
export function localToInstant(parts: [number, number, number, number, number, number], tz: string): Date {
  const [y, mo, d, h, mi, s] = parts;
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const off = zonedParts(new Date(guess), tz).offsetMin;
    const next = wall - off * 60_000;
    if (next === guess) break; // fixed point reached (same result as iterating further)
    guess = next;
  }
  return new Date(guess);
}

// ---------- operations ----------

export function info(body: Record<string, unknown>) {
  const d = parseDate(body.date, "date");
  const y = d.getUTCFullYear();
  const m0 = d.getUTCMonth();
  const dayOfYear = Math.round((d.getTime() - Date.UTC(y, 0, 1)) / DAY_MS) + 1;
  return {
    date: fmtDate(d),
    weekday: WEEKDAYS[d.getUTCDay()],
    weekday_number: d.getUTCDay() || 7, // ISO: Monday=1 … Sunday=7
    ...isoWeek(d),
    quarter: Math.floor(m0 / 3) + 1,
    day_of_year: dayOfYear,
    days_in_year: isLeap(y) ? 366 : 365,
    days_remaining_in_year: (isLeap(y) ? 366 : 365) - dayOfYear,
    days_in_month: daysInMonth(y, m0),
    is_leap_year: isLeap(y),
    is_weekend: d.getUTCDay() === 0 || d.getUTCDay() === 6,
    unix_seconds: d.getTime() / 1000,
  };
}

export function diff(body: Record<string, unknown>) {
  const a = parseDateOrDateTime(body.from, "from");
  const b = parseDateOrDateTime(body.to, "to");
  if (a.hasTime !== b.hasTime) throw new InputError("mixed_formats", "from and to must both be dates or both be datetimes");
  const holidays = parseHolidays(body.holidays);
  const ww = parseWorkdays(body.workdays);
  if (body.country !== undefined && !a.hasTime) {
    const [y1, y2] = [a.date.getUTCFullYear(), b.date.getUTCFullYear()].sort((x, y) => x - y);
    for (const h of countryHolidayDates(body.country, y1, y2)) holidays.add(h);
  }

  const sign = b.date.getTime() >= a.date.getTime() ? 1 : -1;
  const [lo, hi] = sign === 1 ? [a.date, b.date] : [b.date, a.date];
  const ms = hi.getTime() - lo.getTime();
  const cal = calendarDiff(lo, hi);

  const result: Record<string, unknown> = {
    from: body.from,
    to: body.to,
    direction: sign === 1 ? "forward" : "backward",
    total_days: (sign * Math.floor(ms / DAY_MS)),
    total_weeks: sign * Math.floor(ms / DAY_MS / 7),
    calendar: { years: sign * cal.years, months: sign * cal.months, days: sign * cal.days },
  };

  if (!a.hasTime) {
    const [l, h] = [lo.getTime(), hi.getTime()];
    const hol = workdayHolidayMs(holidays, ww).filter((x) => x >= l && x < h).length;
    result.business_days = sign * (weekdaysBetween(l, h, ww) - hol); // counts [from, to): start inclusive, end exclusive
  } else {
    result.total_hours = sign * Math.floor(ms / 3_600_000);
    result.total_minutes = sign * Math.floor(ms / 60_000);
    result.total_seconds = sign * Math.floor(ms / 1000);
  }
  result.iso_duration = isoDuration(sign, cal, cal.remMs);
  return result;
}

function isoDuration(sign: number, cal: { years: number; months: number; days: number }, remMs: number): string {
  let s = "P";
  if (cal.years) s += `${cal.years}Y`;
  if (cal.months) s += `${cal.months}M`;
  if (cal.days) s += `${cal.days}D`;
  if (remMs) {
    const h = Math.floor(remMs / 3_600_000), mi = Math.floor((remMs % 3_600_000) / 60_000), sec = Math.floor((remMs % 60_000) / 1000);
    s += "T" + (h ? `${h}H` : "") + (mi ? `${mi}M` : "") + (sec ? `${sec}S` : "");
  }
  if (s === "P" || s.endsWith("T")) s = s === "P" ? "P0D" : s.slice(0, -1);
  return (sign < 0 ? "-" : "") + s;
}

export function add(body: Record<string, unknown>) {
  const { date, hasTime } = parseDateOrDateTime(body.date, "date");
  const years = intField(body, "years", 10_000);
  const months = intField(body, "months", 120_000);
  const weeks = intField(body, "weeks");
  const days = intField(body, "days", 10_000_000);
  const hours = intField(body, "hours", 100_000_000);
  const minutes = intField(body, "minutes", 1_000_000_000);
  const seconds = intField(body, "seconds", 1_000_000_000);
  const businessDays = intField(body, "business_days", MAX_BUSINESS_DAYS);
  const holidays = parseHolidays(body.holidays);
  const ww = parseWorkdays(body.workdays);

  if (!hasTime && (hours || minutes || seconds)) {
    throw new InputError("time_on_date", "hours/minutes/seconds require a datetime input, e.g. 2026-11-07T00:00:00Z");
  }

  // Order: years+months (clamped), then weeks+days, then business days, then time.
  let d = addMonths(date, years * 12 + months);
  d = new Date(d.getTime() + (weeks * 7 + days) * DAY_MS);
  if (body.country !== undefined) {
    // Cover every year the business-day walk can reach (~250 business days per year), plus the start year.
    const y = d.getUTCFullYear();
    const span = Math.ceil(Math.abs(businessDays) / 240) + 1;
    const [y1, y2] = businessDays >= 0 ? [y, y + span] : [y - span, y];
    for (const h of countryHolidayDates(body.country, y1, y2)) holidays.add(h);
  }
  if (businessDays) d = new Date(addBusinessDays(d.getTime(), businessDays, holidays, ww));
  d = new Date(d.getTime() + hours * 3_600_000 + minutes * 60_000 + seconds * 1000);
  if (Number.isNaN(d.getTime()) || Math.abs(d.getUTCFullYear()) > 275_000) throw new InputError("out_of_range", "result is out of range");

  const out = hasTime ? d.toISOString().replace(".000Z", "Z") : fmtDate(d);
  return { input: body.date, result: out, weekday: WEEKDAYS[d.getUTCDay()], is_business_day: isBusinessDay(d, holidays, ww) };
}

export function convert(body: Record<string, unknown>) {
  const toTz = assertTimeZone(body.to_timezone, "to_timezone");
  let instant: Date;
  const dt = body.datetime;
  const local = typeof dt === "string" ? parseLocal(dt) : null;
  if (local) {
    const fromTz = assertTimeZone(body.from_timezone, "from_timezone (required when datetime has no offset)");
    instant = localToInstant(local, fromTz);
  } else if (dt === undefined || dt === "now") {
    instant = new Date();
  } else {
    instant = parseInstant(dt, "datetime");
  }
  const fromTz = typeof body.from_timezone === "string" ? assertTimeZone(body.from_timezone, "from_timezone") : "UTC";
  return {
    utc: instant.toISOString().replace(".000Z", "Z"),
    unix_seconds: Math.floor(instant.getTime() / 1000),
    from: zonedView(instant, fromTz),
    to: zonedView(instant, toTz),
  };
}

// Warm ICU time-zone data at Worker startup so the first request doesn't pay the one-time Intl init cost.
zonedParts(new Date(0), "UTC");
zonedParts(new Date(0), "America/New_York");
