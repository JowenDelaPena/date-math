// Business-day check and pay-date schedules. All loops are bounded (a month, a year of stepping, 24 dates),
// so every call stays well inside the Workers free-plan CPU budget.
import { DAY_MS, fmtDate, InputError, intField, parseDate, parseHolidays, parseWorkdays, WEEKDAYS, type Workweek } from "./date";
import { countryHolidayNames, HOLIDAY_YEARS } from "./holidays";

/** Holiday calendar (date -> name) from an optional country plus custom dates, covering [y1, y2]. */
function holidayCalendar(body: Record<string, unknown>, y1: number, y2: number): Map<string, string> {
  const names = new Map<string, string>();
  if (body.country !== undefined) {
    if (y1 > HOLIDAY_YEARS[1] || y2 < HOLIDAY_YEARS[0]) throw new InputError("year_out_of_range", `country holiday data covers ${HOLIDAY_YEARS[0]}–${HOLIDAY_YEARS[1]}`);
    for (const [d, n] of countryHolidayNames(body.country, y1, y2)) names.set(d, n);
  }
  for (const d of parseHolidays(body.holidays)) if (!names.has(d)) names.set(d, "Custom holiday");
  return names;
}

class Calendar {
  constructor(private ww: Workweek, private holidays: Map<string, string>) {}
  isBusiness(ms: number): boolean {
    return this.ww[new Date(ms).getUTCDay()] && !this.holidays.has(fmtDate(new Date(ms)));
  }
  /** Why ms is not a business day, or null if it is. */
  reason(ms: number): "weekend" | "holiday" | null {
    if (!this.ww[new Date(ms).getUTCDay()]) return "weekend";
    return this.holidays.has(fmtDate(new Date(ms))) ? "holiday" : null;
  }
  holidayName(ms: number): string | null {
    return this.holidays.get(fmtDate(new Date(ms))) ?? null;
  }
  /** Nearest business day strictly after (dir 1) or before (dir -1) ms. */
  step(ms: number, dir: 1 | -1): number {
    for (let i = 0; i < 400; i++) {
      ms += dir * DAY_MS;
      if (this.isBusiness(ms)) return ms;
    }
    throw new InputError("no_business_day", "no business day within a year of this date; check workdays and holidays");
  }
  /** ms itself if it is a business day, else the nearest one in direction dir. */
  roll(ms: number, dir: 1 | -1): number {
    return this.isBusiness(ms) ? ms : this.step(ms, dir);
  }
}

const iso = (ms: number) => fmtDate(new Date(ms));
const weekday = (ms: number) => WEEKDAYS[new Date(ms).getUTCDay()];

export function businessDay(body: Record<string, unknown>) {
  const ms = parseDate(body.date, "date").getTime();
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const cal = new Calendar(parseWorkdays(body.workdays), holidayCalendar(body, y - 1, y + 1));

  const first = Date.UTC(y, d.getUTCMonth(), 1);
  const next = Date.UTC(y, d.getUTCMonth() + 1, 1);
  let count = 0, firstBiz: number | null = null, lastBiz: number | null = null, nth: number | null = null;
  for (let t = first; t < next; t += DAY_MS) {
    if (!cal.isBusiness(t)) continue;
    count++;
    firstBiz ??= t;
    lastBiz = t;
    if (t === ms) nth = count;
  }

  return {
    date: iso(ms),
    weekday: weekday(ms),
    is_business_day: cal.isBusiness(ms),
    reason: cal.reason(ms),
    holiday: cal.holidayName(ms),
    next_business_day: iso(cal.step(ms, 1)),
    previous_business_day: iso(cal.step(ms, -1)),
    month: {
      business_days: count,
      first_business_day: firstBiz === null ? null : iso(firstBiz),
      last_business_day: lastBiz === null ? null : iso(lastBiz),
      business_day_number: nth,
    },
  };
}

const SCHEDULES = ["monthly", "semi_monthly", "biweekly", "weekly"] as const;
const ADJUST = ["previous", "next", "nearest", "none"] as const;
type Day = number | "last";

function parseDays(value: unknown, schedule: string): Day[] {
  const want = schedule === "monthly" ? 1 : 2;
  const days = value === undefined ? (schedule === "monthly" ? ["last"] : [15, "last"]) : value;
  const ok = Array.isArray(days) && days.length === want && days.every((x) => x === "last" || (Number.isInteger(x) && x >= 1 && x <= 31));
  if (!ok) throw new InputError("invalid_days", `${schedule} needs days: an array of ${want} day-of-month value(s), 1–31 or "last", e.g. ${schedule === "monthly" ? '["last"] or [25]' : '[15, "last"] or [10, 25]'}`);
  return days as Day[];
}

/** Scheduled (unadjusted) pay dates on or after fromMs. */
function scheduled(body: Record<string, unknown>, schedule: string, fromMs: number, count: number): number[] {
  const out: number[] = [];
  if (schedule === "weekly" || schedule === "biweekly") {
    if (body.anchor === undefined) throw new InputError("missing_anchor", `${schedule} needs anchor: any one known pay date, e.g. "2026-11-06"`);
    const anchor = parseDate(body.anchor, "anchor").getTime();
    const period = (schedule === "weekly" ? 7 : 14) * DAY_MS;
    let t = anchor + Math.ceil((fromMs - anchor) / period) * period;
    while (out.length < count) {
      out.push(t);
      t += period;
    }
    return out;
  }
  const days = parseDays(body.days, schedule);
  const from = new Date(fromMs);
  for (let m = 0; out.length < count; m++) {
    const y = from.getUTCFullYear(), mo = from.getUTCMonth() + m;
    const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    const inMonth = days.map((x) => Date.UTC(y, mo, x === "last" ? last : Math.min(x, last))).sort((a, b) => a - b);
    for (const t of new Set(inMonth)) if (t >= fromMs && out.length < count) out.push(t);
  }
  return out;
}

export function payDates(body: Record<string, unknown>) {
  const schedule = body.schedule;
  if (typeof schedule !== "string" || !(SCHEDULES as readonly string[]).includes(schedule)) {
    throw new InputError("invalid_schedule", `schedule must be one of ${SCHEDULES.join(", ")}`);
  }
  const adjust = body.adjust ?? "previous";
  if (typeof adjust !== "string" || !(ADJUST as readonly string[]).includes(adjust)) {
    throw new InputError("invalid_adjust", `adjust must be one of ${ADJUST.join(", ")} (what to do when a pay date falls on a weekend or holiday)`);
  }
  const count = body.count === undefined ? 6 : intField(body, "count", 24);
  if (count < 1) throw new InputError("invalid_number", "count must be an integer between 1 and 24");
  const fromMs = parseDate(body.from, "from").getTime();

  const dates = scheduled(body, schedule, fromMs, count);
  const y1 = new Date(dates[0]).getUTCFullYear() - 1, y2 = new Date(dates[dates.length - 1]).getUTCFullYear() + 1;
  const cal = new Calendar(parseWorkdays(body.workdays), holidayCalendar(body, y1, y2));

  const pay_dates = dates.map((t) => {
    let p = t;
    if (!cal.isBusiness(t) && adjust !== "none") {
      if (adjust === "nearest") {
        const prev = cal.step(t, -1), next = cal.step(t, 1);
        p = t - prev <= next - t ? prev : next;
      } else p = cal.roll(t, adjust === "next" ? 1 : -1);
    }
    const why = cal.reason(t);
    return {
      scheduled: iso(t),
      pay_date: iso(p),
      weekday: weekday(p),
      adjusted: p !== t,
      ...(why ? { reason: why === "holiday" ? `holiday: ${cal.holidayName(t)}` : "weekend" } : {}),
      ...(adjust === "none" ? { is_business_day: cal.isBusiness(t) } : {}),
    };
  });
  return { schedule, adjust, count: pay_dates.length, pay_dates };
}
