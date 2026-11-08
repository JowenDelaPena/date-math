// SLA countdown, free-slot finder, subscription dates, stock-exchange calendars and the free current-time tool.
// Every loop is bounded by input caps (days scanned, busy blocks, renewals listed), so calls stay inside the
// Workers free-plan CPU budget.
import {
  assertTimeZone, DAY_MS, fmtDate, InputError, localToInstant, offsetCursor, parseDate, parseHolidays, parseInstant, parseLocal,
  parseWorkdays, viewFromWall, wallToInstantWith, WEEKDAYS, zonedParts, zonedView, type Workweek,
} from "./date";
import { countryHolidayDates, countryHolidayNames, HOLIDAY_YEARS } from "./holidays";
import { offsetMinutes } from "./more3";

const MIN = 60_000;
const isoZ = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const isoDay = (ms: number) => fmtDate(new Date(ms));

function hhmm(v: unknown, field: string, fallback: string): number {
  const s = v === undefined ? fallback : v;
  const m = typeof s === "string" ? /^([01]\d|2[0-4]):([0-5]\d)$/.exec(s) : null;
  if (!m || (m[1] === "24" && m[2] !== "00")) throw new InputError("invalid_time", `${field} must be HH:MM (24h), e.g. "09:00"`);
  return Number(m[1]) * 60 + Number(m[2]);
}

function intIn(body: Record<string, unknown>, key: string, dflt: number, lo: number, hi: number): number {
  const v = body[key];
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) throw new InputError("invalid_number", `${key} must be an integer between ${lo} and ${hi}`);
  return v;
}

/** Local wall time (UTC-labelled ms) -> instant, with DST gaps shifted forward like most calendars do. */
function instantOf(offsetAt: (ms: number) => number, wall: number): number {
  return wallToInstantWith(offsetAt, wall)?.ms ?? wall - offsetAt(wall - DAY_MS) * MIN;
}

/** Local ISO datetime with offset; uses the cheap longOffset lookup (this runs hundreds of times per call). */
const localIso = (ms: number, tz: string) => {
  const off = offsetMinutes(ms, tz);
  return viewFromWall(Math.floor(ms / 1000) * 1000 + off * MIN, off, tz).datetime;
};
/** Week-segment offset cursor backed by the cheap longOffset lookup. */
const fastCursor = (tz: string) => offsetCursor(tz, (ms) => offsetMinutes(ms, tz));

// ---------- working-hours windows (shared by sla_countdown and find_free_slots) ----------

interface WorkCfg {
  tz: string;
  ws: number; // minutes after local midnight
  we: number;
  ww: Workweek;
  holidays: Set<number>; // UTC-midnight labels of local dates
}

function workCfg(o: Record<string, unknown>, where: string, defaults: { ws: number; we: number }, y1: number, y2: number): WorkCfg {
  const tz = assertTimeZone(o.timezone, `${where}timezone`);
  const ws = o.work_start === undefined ? defaults.ws : hhmm(o.work_start, `${where}work_start`, "09:00");
  const we = o.work_end === undefined ? defaults.we : hhmm(o.work_end, `${where}work_end`, "17:00");
  if (we <= ws) throw new InputError("invalid_time", `${where}work_end must be after work_start`);
  const days = new Set<string>(parseHolidays(o.holidays));
  if (o.country !== undefined) {
    if (y1 < HOLIDAY_YEARS[0] || y1 > HOLIDAY_YEARS[1]) throw new InputError("year_out_of_range", `country holiday data covers ${HOLIDAY_YEARS[0]}–${HOLIDAY_YEARS[1]}`);
    for (const d of countryHolidayDates(o.country, y1, Math.min(y2, HOLIDAY_YEARS[1]))) days.add(d);
  }
  return { tz, ws, we, ww: parseWorkdays(o.workdays), holidays: new Set([...days].map((d) => Date.parse(d + "T00:00:00Z"))) };
}

/** Working windows [start, end) in UTC ms, in time order, beginning with the local day of fromMs. */
function* workWindows(cfg: WorkCfg, fromMs: number, maxDays: number): Generator<[number, number]> {
  const offsetAt = fastCursor(cfg.tz);
  const z = zonedParts(new Date(fromMs), cfg.tz);
  let day = Date.UTC(z.y, z.mo - 1, z.d);
  for (let i = 0; i <= maxDays; i++, day += DAY_MS) {
    if (!cfg.ww[new Date(day).getUTCDay()] || cfg.holidays.has(day)) continue;
    const s = instantOf(offsetAt, day + cfg.ws * MIN), e = instantOf(offsetAt, day + cfg.we * MIN);
    if (e > fromMs) yield [Math.max(s, fromMs), e];
  }
}

/** Why there is no working window at ms: weekend, holiday, or outside hours. */
function pauseReason(cfg: WorkCfg, ms: number): "weekend" | "holiday" | "outside_hours" {
  const z = zonedParts(new Date(ms), cfg.tz);
  const day = Date.UTC(z.y, z.mo - 1, z.d);
  if (!cfg.ww[new Date(day).getUTCDay()]) return "weekend";
  return cfg.holidays.has(day) ? "holiday" : "outside_hours";
}

/** Sort and merge intervals. */
function merge(list: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const iv of [...list].sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

/** Pieces of [a, b) not covered by the merged, sorted intervals. */
function subtract(a: number, b: number, cut: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  let cur = a;
  for (const [s, e] of cut) {
    if (e <= cur) continue;
    if (s >= b) break;
    if (s > cur) out.push([cur, Math.min(s, b)]);
    cur = Math.max(cur, e);
    if (cur >= b) break;
  }
  if (cur < b) out.push([cur, b]);
  return out;
}

function intervals(v: unknown, field: string, max: number, openEnd: number | null): [number, number][] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max) throw new InputError("invalid_intervals", `${field} must be an array of up to ${max} {start, end} objects (ISO 8601 with offset)`);
  return v.map((x, i) => {
    if (typeof x !== "object" || x === null) throw new InputError("invalid_intervals", `${field}[${i}] must be an object {start, end}`);
    const o = x as Record<string, unknown>;
    const s = parseInstant(o.start, `${field}[${i}].start`).getTime();
    const e = o.end === undefined && openEnd !== null ? Math.max(s, openEnd) : parseInstant(o.end, `${field}[${i}].end`).getTime();
    if (e < s) throw new InputError("invalid_intervals", `${field}[${i}].end is before its start`);
    return [s, e];
  });
}

// ---------- sla_countdown ----------

const MAX_SLA_MINUTES = 2000 * 60;

export function slaCountdown(body: Record<string, unknown>) {
  const tz = assertTimeZone(body.timezone, "timezone");
  const toInstant = (v: unknown, field: string): number => {
    if (typeof v === "string") {
      const loc = parseLocal(v);
      if (loc) return localToInstant(loc, tz).getTime();
    }
    return parseInstant(v, field).getTime();
  };
  const start = toInstant(body.start, "start");
  const now = body.now === undefined || body.now === "now" ? Date.now() : toInstant(body.now, "now");
  if (body.sla_hours === undefined && body.sla_minutes === undefined) throw new InputError("invalid_sla", "pass sla_hours and/or sla_minutes: the SLA target in business time, e.g. sla_hours: 8");
  const target = Math.round(Number(body.sla_hours ?? 0) * 60 + Number(body.sla_minutes ?? 0));
  if (!Number.isFinite(target) || target <= 0 || target > MAX_SLA_MINUTES) throw new InputError("invalid_sla", "the SLA target must be between 1 minute and 2000 hours");
  if (now < start) throw new InputError("invalid_range", "now must not be before start");
  if (now - start > 366 * DAY_MS) throw new InputError("invalid_range", "start must be within 1 year before now");

  const y = zonedParts(new Date(start), tz).y;
  const cfg = workCfg(body, "", { ws: 9 * 60, we: 17 * 60 }, y, y + 4);
  const pauses = merge(intervals(body.pauses, "pauses", 100, now));
  const openPause = Array.isArray(body.pauses) && body.pauses.some((p) => typeof p === "object" && p !== null && (p as Record<string, unknown>).end === undefined);

  let total = 0, elapsed = 0, deadline: number | null = null;
  let runningNow = false, resumesAt: number | null = null;
  const maxDays = Math.ceil((now - start) / DAY_MS) + 3 * 366 + 7;
  for (const [ws, we] of workWindows(cfg, start, maxDays)) {
    for (const [a, b] of subtract(ws, we, pauses)) {
      if (a <= now && now < b) runningNow = true;
      if (a > now && resumesAt === null) resumesAt = a;
      elapsed += Math.max(0, Math.min(b, now) - a) / MIN;
      const mins = (b - a) / MIN;
      if (deadline === null && total + mins >= target) deadline = a + (target - total) * MIN;
      total += mins;
    }
    if (deadline !== null && ws > now && (runningNow || resumesAt !== null)) break;
  }
  if (deadline === null) throw new InputError("out_of_range", "the deadline is more than 3 years away");

  elapsed = Math.round(elapsed);
  const breached = now >= deadline;
  // An open pause (no end) means the clock is stopped right now; the deadline assumes it resumes now.
  const inPause = openPause || pauses.some(([s, e]) => s <= now && now < e);
  const status = breached ? "breached" : inPause ? "paused_manual" : runningNow ? "running" : `paused_${pauseReason(cfg, now)}`;
  const dv = zonedView(new Date(deadline), tz);
  return {
    timezone: tz,
    start: localIso(start, tz),
    now: localIso(now, tz),
    sla_minutes: target,
    elapsed_business_minutes: elapsed,
    remaining_business_minutes: breached ? 0 : Math.max(0, target - elapsed),
    breached,
    breached_by_business_minutes: breached ? Math.max(0, elapsed - target) : 0,
    percent_used: Math.round((Math.min(elapsed, target) / target) * 1000) / 10,
    status,
    resumes_at: status.startsWith("paused") && !openPause && resumesAt !== null ? localIso(resumesAt, tz) : null,
    deadline: dv.datetime,
    deadline_utc: isoZ(deadline),
    deadline_weekday: dv.weekday,
  };
}

// ---------- find_free_slots ----------

export function freeSlots(body: Record<string, unknown>) {
  const raw = body.participants;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 10) {
    throw new InputError("invalid_participants", "participants must be an array of 1–10 objects {timezone, busy?, work_start?, work_end?, workdays?, country?}");
  }
  const duration = intIn(body, "duration_minutes", NaN, 5, 720);
  if (Number.isNaN(duration)) throw new InputError("invalid_number", "duration_minutes is required: the meeting length, 5–720");
  const days = intIn(body, "days", 5, 1, 14);
  const step = intIn(body, "step_minutes", 30, 5, 60);
  const buffer = intIn(body, "buffer_minutes", 0, 0, 120);
  const maxSlots = intIn(body, "max_slots", 10, 1, 50);
  const defaults = { ws: hhmm(body.work_start, "work_start", "09:00"), we: hhmm(body.work_end, "work_end", "17:00") };
  if (defaults.we <= defaults.ws) throw new InputError("invalid_time", "work_end must be after work_start");

  const first = raw[0] as Record<string, unknown> | null;
  const tz = assertTimeZone(body.timezone ?? first?.timezone, "timezone");
  const from = body.from === undefined ? null : parseDate(body.from, "from");
  const z = zonedParts(new Date(), tz);
  const [y, mo, d] = from ? [from.getUTCFullYear(), from.getUTCMonth() + 1, from.getUTCDate()] : [z.y, z.mo, z.d];
  const rangeStart = localToInstant([y, mo, d, 0, 0, 0], tz).getTime();
  const endLabel = new Date(Date.UTC(y, mo - 1, d + days));
  const rangeEnd = localToInstant([endLabel.getUTCFullYear(), endLabel.getUTCMonth() + 1, endLabel.getUTCDate(), 0, 0, 0], tz).getTime();
  const notBefore = body.not_before === undefined ? rangeStart : body.not_before === "now" ? Date.now() : parseInstant(body.not_before, "not_before").getTime();

  let totalBusy = 0;
  let free: [number, number][] | null = null;
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i];
    if (typeof p !== "object" || p === null) throw new InputError("invalid_participants", `participants[${i}] must be an object with a timezone`);
    const o = p as Record<string, unknown>;
    const cfg = workCfg(o, `participants[${i}].`, defaults, y, endLabel.getUTCFullYear());
    const busyRaw = intervals(o.busy, `participants[${i}].busy`, 100, null);
    totalBusy += busyRaw.length;
    if (totalBusy > 300) throw new InputError("invalid_intervals", "at most 300 busy blocks in total");
    const busy = merge(busyRaw.map(([s, e]) => [s - buffer * MIN, e + buffer * MIN]));
    const mine: [number, number][] = [];
    for (const [a, b] of workWindows(cfg, Math.max(rangeStart, notBefore), days + 2)) {
      if (a >= rangeEnd) break;
      mine.push(...subtract(a, Math.min(b, rangeEnd), busy));
    }
    free = free === null ? mine : intersect(free, mine);
  }

  // One week-segment offset cursor per zone: slot output needs up to 1,000 local times.
  const cursors = new Map<string, (ms: number) => number>();
  const local = (ms: number, zn: string) => {
    let c = cursors.get(zn);
    if (!c) cursors.set(zn, (c = fastCursor(zn)));
    const off = c(ms);
    return viewFromWall(Math.floor(ms / 1000) * 1000 + off * MIN, off, zn).datetime;
  };
  const offsetAt = (ms: number) => { local(ms, tz); return cursors.get(tz)!(ms); };
  const windows = (free ?? []).filter(([a, b]) => b - a >= duration * MIN);
  const slots: { start_utc: string; end_utc: string; local: { timezone: string; start: string; end: string }[] }[] = [];
  const zones = (raw as Record<string, unknown>[]).map((p) => p.timezone as string);
  for (const [a, b] of windows) {
    const off = offsetAt(a);
    let t = Math.ceil((a + off * MIN) / (step * MIN)) * step * MIN - off * MIN; // align to the step in local time
    for (; t + duration * MIN <= b && slots.length < maxSlots; t += step * MIN) {
      const e = t + duration * MIN;
      slots.push({ start_utc: isoZ(t), end_utc: isoZ(e), local: [...new Set(zones)].map((zn) => ({ timezone: zn, start: local(t, zn), end: local(e, zn) })) });
    }
    if (slots.length >= maxSlots) break;
  }
  return {
    timezone: tz,
    range: { start: localIso(rangeStart, tz), end: localIso(rangeEnd, tz) },
    duration_minutes: duration,
    free_windows: windows.slice(0, 50).map(([a, b]) => ({ start: local(a, tz), end: local(b, tz), start_utc: isoZ(a), end_utc: isoZ(b), minutes: Math.round((b - a) / MIN) })),
    count: slots.length,
    slots,
  };
}

function intersect(a: [number, number][], b: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    const s = Math.max(a[i][0], b[j][0]), e = Math.min(a[i][1], b[j][1]);
    if (s < e) out.push([s, e]);
    if (a[i][1] < b[j][1]) i++;
    else j++;
  }
  return out;
}

// ---------- subscription_dates ----------

const UNITS = ["day", "week", "month", "year"] as const;

function daysInMonth(y: number, m0: number): number {
  return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
}

export function subscriptionDates(body: Record<string, unknown>) {
  const start = parseDate(body.start, "start").getTime();
  const unit = body.interval ?? "month";
  if (typeof unit !== "string" || !(UNITS as readonly string[]).includes(unit)) throw new InputError("invalid_interval", `interval must be one of ${UNITS.join(", ")}`);
  const n = intIn(body, "interval_count", 1, 1, 365);
  const count = intIn(body, "count", 3, 1, 24);
  const trial = intIn(body, "trial_days", 0, 0, 730);
  const notice = body.notice_days === undefined ? null : intIn(body, "notice_days", 0, 0, 365);
  const asOf = body.as_of === undefined ? Math.floor(Date.now() / DAY_MS) * DAY_MS : parseDate(body.as_of, "as_of").getTime();
  if (Math.abs(asOf - start) > 100 * 366 * DAY_MS) throw new InputError("range_too_large", "as_of must be within 100 years of start");
  let amount: number | null = null;
  if (body.amount !== undefined) {
    if (typeof body.amount !== "number" || !Number.isFinite(body.amount) || body.amount < 0 || body.amount > 1e12) throw new InputError("invalid_amount", "amount must be a number between 0 and 1e12 (the price of one billing period)");
    amount = body.amount;
  }

  const anchor = start + trial * DAY_MS; // first charge
  const a = new Date(anchor);
  const stepMonths = unit === "month" ? n : unit === "year" ? 12 * n : 0;
  const stepDays = unit === "day" ? n : unit === "week" ? 7 * n : 0;
  // Period k starts k intervals after the anchor, always measured from the anchor (Jan 31 -> Feb 28 -> Mar 31).
  const periodStart = (k: number): number => {
    if (stepDays) return anchor + k * stepDays * DAY_MS;
    const y = a.getUTCFullYear(), m = a.getUTCMonth() + k * stepMonths;
    const ty = y + Math.floor(m / 12), tm = ((m % 12) + 12) % 12;
    return Date.UTC(ty, tm, Math.min(a.getUTCDate(), daysInMonth(ty, tm)));
  };

  const status = asOf < start ? "not_started" : asOf < anchor ? "trial" : "active";
  let k = -1;
  if (status === "active") {
    if (stepDays) k = Math.floor((asOf - anchor) / (stepDays * DAY_MS));
    else {
      const d = new Date(asOf);
      k = Math.floor(((d.getUTCFullYear() - a.getUTCFullYear()) * 12 + d.getUTCMonth() - a.getUTCMonth()) / stepMonths);
      while (k > 0 && periodStart(k) > asOf) k--;
      while (periodStart(k + 1) <= asOf) k++;
    }
  }
  const next = status === "active" ? periodStart(k + 1) : anchor;
  const firstUpcoming = status === "active" ? k + 1 : 0;
  const upcoming = Array.from({ length: count }, (_, i) => isoDay(periodStart(firstUpcoming + i)));

  let current = null, proration = null;
  if (status === "active") {
    const ps = periodStart(k), pe = next;
    const total = Math.round((pe - ps) / DAY_MS), used = Math.round((asOf - ps) / DAY_MS);
    current = { number: k + 1, start: isoDay(ps), end: isoDay(pe - DAY_MS), days: total, days_elapsed: used, days_remaining: total - used };
    if (amount !== null) {
      const r2 = (x: number) => Math.round(x * 100) / 100;
      proration = { amount, daily_rate: Math.round((amount / total) * 1e6) / 1e6, used: r2((amount * used) / total), unused: r2(amount - r2((amount * used) / total)), ratio_unused: Math.round(((total - used) / total) * 1e6) / 1e6 };
    }
  }
  const cancelBy = notice === null ? null : next - notice * DAY_MS;
  return {
    start: isoDay(start),
    billing_start: isoDay(anchor),
    interval: unit,
    interval_count: n,
    as_of: isoDay(asOf),
    status,
    current_period: current,
    next_renewal: isoDay(next),
    next_renewal_weekday: WEEKDAYS[new Date(next).getUTCDay()],
    cancel_by: cancelBy === null ? null : isoDay(cancelBy),
    cancel_by_passed: cancelBy === null ? null : asOf > cancelBy,
    upcoming_renewals: upcoming,
    proration,
    note: "Renewals are measured from the first billing date, so month-end anchors stay at month end (Jan 31 -> Feb 28 -> Mar 31). Proration is by whole days as of the start of as_of.",
  };
}

// ---------- market_calendar ----------

type DayRule = { type: "closed" | "early_close"; name: string; close?: number };
interface Exchange {
  code: string;
  name: string;
  tz: string;
  /** Sessions [open, close] in local minutes for a trading day (by UTC-midnight label). */
  sessions: (day: number) => [number, number][];
  earlyClose?: number;
  special: (y: number) => Map<number, DayRule>;
  settleCycle: (day: number) => number;
  /** Extra non-settlement days (markets open, settlement closed), e.g. US bank holidays. */
  settleHolidays?: (y: number) => Set<number>;
  settleNote: string;
}

const D = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
const wd = (ms: number) => new Date(ms).getUTCDay();
function nthWeekday(y: number, m: number, weekday: number, n: number): number {
  const first = D(y, m, 1);
  return first + (((weekday - wd(first) + 7) % 7) + (n - 1) * 7) * DAY_MS;
}
function lastWeekday(y: number, m: number, weekday: number): number {
  const last = D(y, m + 1, 0);
  return last - ((wd(last) - weekday + 7) % 7) * DAY_MS;
}
function easter(y: number): number {
  // Anonymous Gregorian algorithm
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return D(y, month, day);
}
/** US-style observance: Saturday -> Friday, Sunday -> Monday. */
const observed = (ms: number) => (wd(ms) === 6 ? ms - DAY_MS : wd(ms) === 0 ? ms + DAY_MS : ms);

function nyse(y: number): Map<number, DayRule> {
  const m = new Map<number, DayRule>();
  const close = (ms: number, name: string) => m.set(ms, { type: "closed", name });
  const ny = D(y, 1, 1);
  if (wd(ny) !== 6) close(observed(ny), "New Year's Day"); // Saturday: not observed on the Friday before
  close(nthWeekday(y, 1, 1, 3), "Martin Luther King Jr. Day");
  close(nthWeekday(y, 2, 1, 3), "Washington's Birthday");
  close(easter(y) - 2 * DAY_MS, "Good Friday");
  close(lastWeekday(y, 5, 1), "Memorial Day");
  if (y >= 2022) close(observed(D(y, 6, 19)), "Juneteenth");
  close(observed(D(y, 7, 4)), "Independence Day");
  close(nthWeekday(y, 9, 1, 1), "Labor Day");
  const thanks = nthWeekday(y, 11, 4, 4);
  close(thanks, "Thanksgiving Day");
  close(observed(D(y, 12, 25)), "Christmas Day");
  const specials: [number, number, number, string][] = [
    [2001, 9, 11, "September 11 attacks"], [2001, 9, 12, "September 11 attacks"], [2001, 9, 13, "September 11 attacks"], [2001, 9, 14, "September 11 attacks"],
    [2004, 6, 11, "National Day of Mourning (Reagan)"], [2007, 1, 2, "National Day of Mourning (Ford)"],
    [2012, 10, 29, "Hurricane Sandy"], [2012, 10, 30, "Hurricane Sandy"], [2018, 12, 5, "National Day of Mourning (G. H. W. Bush)"],
    [2025, 1, 9, "National Day of Mourning (Carter)"],
  ];
  for (const [sy, sm, sd, name] of specials) if (sy === y) close(D(sy, sm, sd), name);
  const early = (ms: number, name: string) => {
    if (wd(ms) !== 0 && wd(ms) !== 6 && !m.has(ms)) m.set(ms, { type: "early_close", name, close: 13 * 60 });
  };
  if ([2, 3, 4, 5].includes(wd(D(y, 7, 4)))) early(D(y, 7, 3), "Day before Independence Day");
  early(thanks + DAY_MS, "Day after Thanksgiving");
  if ([1, 2, 3, 4].includes(wd(D(y, 12, 24)))) early(D(y, 12, 24), "Christmas Eve");
  return m;
}

function lse(y: number): Map<number, DayRule> {
  const m = new Map<number, DayRule>();
  const close = (ms: number, name: string) => m.set(ms, { type: "closed", name });
  const ny = D(y, 1, 1);
  close(wd(ny) === 6 ? ny + 2 * DAY_MS : wd(ny) === 0 ? ny + DAY_MS : ny, "New Year's Day");
  const e = easter(y);
  close(e - 2 * DAY_MS, "Good Friday");
  close(e + DAY_MS, "Easter Monday");
  close(y === 2020 ? D(2020, 5, 8) : nthWeekday(y, 5, 1, 1), "Early May Bank Holiday");
  const spring: Record<number, number> = { 2002: D(2002, 6, 4), 2012: D(2012, 6, 4), 2022: D(2022, 6, 2) };
  close(spring[y] ?? lastWeekday(y, 5, 1), "Spring Bank Holiday");
  close(lastWeekday(y, 8, 1), "Summer Bank Holiday");
  const xmas = D(y, 12, 25), box = D(y, 12, 26);
  if (wd(xmas) === 6) { close(xmas + 2 * DAY_MS, "Christmas Day (substitute)"); close(xmas + 3 * DAY_MS, "Boxing Day (substitute)"); }
  else if (wd(xmas) === 0) { close(box, "Boxing Day"); close(xmas + 2 * DAY_MS, "Christmas Day (substitute)"); }
  else { close(xmas, "Christmas Day"); close(wd(box) === 6 ? box + 2 * DAY_MS : box, wd(box) === 6 ? "Boxing Day (substitute)" : "Boxing Day"); }
  const specials: [number, number, number, string][] = [
    [2002, 6, 3, "Golden Jubilee"], [2011, 4, 29, "Royal Wedding"], [2012, 6, 5, "Diamond Jubilee"], [2022, 6, 3, "Platinum Jubilee"],
    [2022, 9, 19, "State Funeral of Queen Elizabeth II"], [2023, 5, 8, "Coronation of King Charles III"],
  ];
  for (const [sy, sm, sd, name] of specials) if (sy === y) close(D(sy, sm, sd), name);
  for (const [md, name] of [[24, "Christmas Eve"], [31, "New Year's Eve"]] as const) {
    const ms = D(y, 12, md);
    if (wd(ms) !== 0 && wd(ms) !== 6 && !m.has(ms)) m.set(ms, { type: "early_close", name, close: 12 * 60 + 30 });
  }
  return m;
}

function tse(y: number): Map<number, DayRule> {
  const m = new Map<number, DayRule>();
  for (const [d, name] of countryHolidayNames("JP", y, y)) m.set(Date.parse(d + "T00:00:00Z"), { type: "closed", name });
  for (const [mo, d, name] of [[1, 1, "New Year holiday"], [1, 2, "New Year holiday"], [1, 3, "New Year holiday"], [12, 31, "Year-end holiday"]] as const) {
    if (!m.has(D(y, mo, d))) m.set(D(y, mo, d), { type: "closed", name });
  }
  return m;
}

function usBankHolidays(y: number): Set<number> {
  const s = new Set<number>([nthWeekday(y, 10, 1, 2)]); // Columbus Day
  const vet = D(y, 11, 11);
  if (wd(vet) !== 6) s.add(wd(vet) === 0 ? vet + DAY_MS : vet); // Veterans Day; Saturday is not observed by the Fed
  return s;
}

const NYSE: Exchange = {
  code: "XNYS", name: "New York Stock Exchange (same holidays as Nasdaq)", tz: "America/New_York",
  sessions: () => [[9 * 60 + 30, 16 * 60]], special: nyse,
  settleCycle: (day) => (day >= D(2024, 5, 28) ? 1 : day >= D(2017, 9, 5) ? 2 : 3),
  settleHolidays: usBankHolidays,
  settleNote: "US equities settle T+1 (since 2024-05-28); settlement also skips Columbus Day and Veterans Day, when markets are open but banks are closed.",
};
const EXCHANGES: Record<string, Exchange> = {
  XNYS: NYSE,
  XNAS: { ...NYSE, code: "XNAS", name: "Nasdaq (same holidays as NYSE)" },
  XLON: {
    code: "XLON", name: "London Stock Exchange", tz: "Europe/London",
    sessions: () => [[8 * 60, 16 * 60 + 30]], special: lse,
    settleCycle: (day) => (day >= D(2027, 10, 11) ? 1 : day >= D(2014, 10, 6) ? 2 : 3),
    settleNote: "UK equities settle T+2; the UK plans to move to T+1 on 2027-10-11.",
  },
  XTKS: {
    code: "XTKS", name: "Tokyo Stock Exchange", tz: "Asia/Tokyo",
    sessions: (day) => [[9 * 60, 11 * 60 + 30], [12 * 60 + 30, day >= D(2024, 11, 5) ? 15 * 60 + 30 : 15 * 60]], special: tse,
    settleCycle: (day) => (day >= D(2019, 7, 16) ? 2 : 3),
    settleNote: "Japanese equities settle T+2 (since 2019-07-16).",
  },
};
const ALIASES: Record<string, string> = { NYSE: "XNYS", NASDAQ: "XNAS", LSE: "XLON", TSE: "XTKS", JPX: "XTKS", TYO: "XTKS", LON: "XLON" };

const ruleCache = new Map<string, Map<number, DayRule>>();
function rulesFor(ex: Exchange, y: number): Map<number, DayRule> {
  if (y < HOLIDAY_YEARS[0] || y > HOLIDAY_YEARS[1]) throw new InputError("year_out_of_range", `exchange calendars cover ${HOLIDAY_YEARS[0]}–${HOLIDAY_YEARS[1]}`);
  const key = ex.code + y;
  let r = ruleCache.get(key);
  if (!r) {
    r = ex.special(y);
    if (ruleCache.size > 200) ruleCache.clear();
    ruleCache.set(key, r);
  }
  return r;
}
const ruleOn = (ex: Exchange, day: number) => rulesFor(ex, new Date(day).getUTCFullYear()).get(day);
const isTradingDay = (ex: Exchange, day: number) => wd(day) !== 0 && wd(day) !== 6 && ruleOn(ex, day)?.type !== "closed";
function stepTrading(ex: Exchange, day: number, dir: 1 | -1): number {
  for (let i = 0; i < 30; i++) {
    day += dir * DAY_MS;
    if (isTradingDay(ex, day)) return day;
  }
  throw new InputError("no_trading_day", "no trading day within 30 days");
}

export function marketCalendar(body: Record<string, unknown>) {
  const key = typeof body.exchange === "string" ? body.exchange.trim().toUpperCase() : "";
  const ex = EXCHANGES[ALIASES[key] ?? key];
  if (!ex) throw new InputError("invalid_exchange", 'exchange must be one of XNYS (NYSE), XNAS (Nasdaq), XLON (LSE), XTKS (Tokyo/JPX)');
  const at = body.at === undefined || body.at === "now" ? Date.now() : parseInstant(body.at, "at").getTime();
  const za = zonedParts(new Date(at), ex.tz);
  const day = body.date === undefined ? Date.UTC(za.y, za.mo - 1, za.d) : parseDate(body.date, "date").getTime();
  const offsetAt = fastCursor(ex.tz);

  const sessionsOn = (d: number) => {
    const rule = ruleOn(ex, d);
    return ex.sessions(d).map(([o, c], i, all) => {
      const close = rule?.type === "early_close" && i === all.length - 1 ? rule.close! : c;
      return [instantOf(offsetAt, d + o * MIN), instantOf(offsetAt, d + close * MIN)] as [number, number];
    }).filter(([o, c]) => c > o);
  };

  const rule = ruleOn(ex, day);
  const trading = isTradingDay(ex, day);
  const sessions = trading ? sessionsOn(day) : [];
  let session = null;
  if (sessions.length) {
    session = {
      open: localIso(sessions[0][0], ex.tz),
      close: localIso(sessions[sessions.length - 1][1], ex.tz),
      open_utc: isoZ(sessions[0][0]),
      close_utc: isoZ(sessions[sessions.length - 1][1]),
      break: sessions.length > 1 ? { start: localIso(sessions[0][1], ex.tz), end: localIso(sessions[1][0], ex.tz) } : null,
    };
  }

  // Status at `at`: walk the sessions of at's local day and the following trading days.
  const atDay = Date.UTC(za.y, za.mo - 1, za.d);
  let isOpen = false, nextOpen: number | null = null, nextClose: number | null = null;
  const todays = isTradingDay(ex, atDay) ? sessionsOn(atDay) : [];
  for (const [o, c] of todays) {
    if (o <= at && at < c) { isOpen = true; nextClose = c; }
    else if (o > at && nextOpen === null) { nextOpen = o; if (!isOpen) nextClose ??= c; }
  }
  if (nextOpen === null) {
    const nd = stepTrading(ex, atDay, 1);
    const ns = sessionsOn(nd);
    nextOpen = ns[0][0];
    nextClose ??= ns[0][1];
  }
  const phase = isOpen ? "open" : todays.length === 0 ? "closed_today" : at < todays[0][0] ? "pre_open" : at >= todays[todays.length - 1][1] ? "after_close" : "break";

  let settlement = null;
  if (trading) {
    const n = ex.settleCycle(day);
    let s = day;
    for (let left = n; left > 0; ) {
      s += DAY_MS;
      if (isTradingDay(ex, s) && !ex.settleHolidays?.(new Date(s).getUTCFullYear()).has(s)) left--;
    }
    settlement = { cycle: `T+${n}`, settlement_date: isoDay(s), note: ex.settleNote };
  }

  let calendar = null;
  if (body.list_year !== undefined) {
    const ly = intIn(body, "list_year", 0, HOLIDAY_YEARS[0], HOLIDAY_YEARS[1]);
    calendar = [...rulesFor(ex, ly).entries()]
      .filter(([d]) => wd(d) !== 0 && wd(d) !== 6)
      .sort((p, q) => p[0] - q[0])
      .map(([d, r]) => ({ date: isoDay(d), name: r.name, type: r.type, ...(r.close !== undefined ? { close: `${String(Math.floor(r.close / 60)).padStart(2, "0")}:${String(r.close % 60).padStart(2, "0")}` } : {}) }));
  }

  return {
    exchange: ex.code,
    name: ex.name,
    timezone: ex.tz,
    date: isoDay(day),
    weekday: WEEKDAYS[wd(day)],
    is_trading_day: trading,
    reason: trading ? null : wd(day) === 0 || wd(day) === 6 ? "weekend" : "holiday",
    holiday: rule?.type === "closed" ? rule.name : null,
    early_close: trading && rule?.type === "early_close" ? rule.name : null,
    session,
    previous_trading_day: isoDay(stepTrading(ex, day, -1)),
    next_trading_day: isoDay(stepTrading(ex, day, 1)),
    settlement,
    status: { at: isoZ(at), local: viewFromWall(at + za.offsetMin * MIN, za.offsetMin, ex.tz).datetime, is_open: isOpen, phase, next_open: isoZ(nextOpen), next_close: nextClose === null ? null : isoZ(nextClose) },
    calendar,
    note: "Regular sessions only (no pre/after-hours). Unscheduled closures (e.g. national mourning days) are added when announced.",
  };
}

// ---------- current_time (free) ----------

export function currentTime(body: Record<string, unknown>) {
  let zones: unknown = body.timezones ?? (body.timezone !== undefined ? [body.timezone] : ["UTC"]);
  if (typeof zones === "string") zones = zones.split(",").map((s) => s.trim()).filter(Boolean);
  if (!Array.isArray(zones) || zones.length === 0 || zones.length > 10) throw new InputError("invalid_timezone", 'pass "timezone" (an IANA name) or "timezones" (1–10 names), e.g. "Asia/Manila"');
  const now = new Date();
  return {
    utc: isoZ(now.getTime()),
    unix_seconds: Math.floor(now.getTime() / 1000),
    unix_ms: now.getTime(),
    times: zones.map((z, i) => zonedView(now, assertTimeZone(z, `timezones[${i}]`))),
  };
}
