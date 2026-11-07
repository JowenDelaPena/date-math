// Additional tools: holidays, working-hours overlap, cron schedules, natural-language date parsing.
import cronstrue from "cronstrue";
import { nextRuns, parseCron } from "./cron";

const MACRO_EXPANSION: Record<string, string> = {
  "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *", "@monthly": "0 0 1 * *", "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@hourly": "0 * * * *",
};
import * as chrono from "chrono-node";
import { assertTimeZone, localToInstant, parseInstant, zonedParts, zonedView } from "./date";
import { InputError } from "./errors";
import { HOLIDAY_YEARS, listHolidays } from "./holidays";

const MIN = 60_000;
const DAY = 86_400_000;

// ---------- /v1/holidays ----------
export function holidays(body: Record<string, unknown>) {
  const year = body.year ?? new Date().getUTCFullYear();
  if (typeof year !== "number" || !Number.isInteger(year)) {
    throw new InputError("invalid_year", `year must be an integer (${HOLIDAY_YEARS[0]}–${HOLIDAY_YEARS[1]})`);
  }
  const { code, countryName, holidays: list } = listHolidays(body.country, year);
  return { country: code, country_name: countryName, year, type: "public", count: list.length, holidays: list, source: "date-holidays (CC BY 3.0)" };
}

// ---------- /v1/overlap ----------
type Participant = { timezone: string; work_start: number; work_end: number };

function parseHHMM(v: unknown, field: string, fallback: string): number {
  const s = v === undefined ? fallback : v;
  const m = typeof s === "string" ? /^([01]\d|2[0-4]):([0-5]\d)$/.exec(s) : null;
  if (!m || (m[1] === "24" && m[2] !== "00")) throw new InputError("invalid_time", `${field} must be HH:MM (24h), e.g. "09:00"`);
  return Number(m[1]) * 60 + Number(m[2]);
}

function parseParticipants(body: Record<string, unknown>): Participant[] {
  const defStart = parseHHMM(body.work_start, "work_start", "09:00");
  const defEnd = parseHHMM(body.work_end, "work_end", "17:00");
  const raw = body.participants ?? body.timezones;
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 10) {
    throw new InputError("invalid_participants", 'pass 2–10 "timezones" (IANA strings) or "participants" ({timezone, work_start?, work_end?})');
  }
  return raw.map((p, i) => {
    const o = typeof p === "string" ? { timezone: p } : (p as Record<string, unknown>);
    if (!o || typeof o !== "object") throw new InputError("invalid_participants", `participants[${i}] must be a string or object`);
    const tz = assertTimeZone(o.timezone, `participants[${i}].timezone`);
    const ws = o.work_start === undefined ? defStart : parseHHMM(o.work_start, `participants[${i}].work_start`, "09:00");
    const we = o.work_end === undefined ? defEnd : parseHHMM(o.work_end, `participants[${i}].work_end`, "17:00");
    if (we <= ws) throw new InputError("invalid_time", `participants[${i}]: work_end must be after work_start`);
    return { timezone: tz, work_start: ws, work_end: we };
  });
}

/** One participant's working intervals (UTC ms) for local days around the window. */
function workIntervals(p: Participant, fromMs: number, toMs: number, skipWeekends: boolean): [number, number][] {
  const out: [number, number][] = [];
  // Walk local calendar days arithmetically (one Intl lookup to find the first local day).
  const z0 = zonedParts(new Date(fromMs - DAY), p.timezone);
  const firstDay = Date.UTC(z0.y, z0.mo - 1, z0.d);
  const nDays = Math.ceil((toMs - fromMs) / DAY) + 3;
  for (let i = 0; i < nDays; i++) {
    const day = firstDay + i * DAY; // UTC-midnight label of the local date
    const dt = new Date(day);
    const wd = dt.getUTCDay();
    if (skipWeekends && (wd === 0 || wd === 6)) continue;
    const wallStart = day + p.work_start * MIN, wallEnd = day + p.work_end * MIN;
    // Offset at both ends of the working window; equal => no DST change inside it, so plain arithmetic.
    const offA = zonedParts(new Date(wallStart - z0.offsetMin * MIN), p.timezone).offsetMin;
    const offB = zonedParts(new Date(wallEnd - offA * MIN), p.timezone).offsetMin;
    const iv: [number, number] =
      offA === offB
        ? [wallStart - offA * MIN, wallEnd - offA * MIN]
        : [
            localToInstant([dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), Math.floor(p.work_start / 60), p.work_start % 60, 0], p.timezone).getTime(),
            localToInstant([dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), Math.floor(p.work_end / 60), p.work_end % 60, 0], p.timezone).getTime(),
          ];
    if (iv[1] > fromMs - DAY && iv[0] < toMs + DAY) out.push(iv);
  }
  return out;
}

function intersect(a: [number, number][], b: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const x of a) for (const y of b) {
    const s = Math.max(x[0], y[0]), e = Math.min(x[1], y[1]);
    if (e > s) out.push([s, e]);
  }
  return out.sort((p, q) => p[0] - q[0]);
}

export function overlap(body: Record<string, unknown>) {
  const ps = parseParticipants(body);
  const ref = ps[0].timezone;
  const dateStr = body.date ?? new Date().toISOString().slice(0, 10);
  const m = typeof dateStr === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr) : null;
  if (!m) throw new InputError("invalid_date", "date must be YYYY-MM-DD (interpreted in the first participant's time zone)");
  const days = body.days === undefined ? 1 : body.days;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 14) throw new InputError("invalid_days", "days must be an integer 1–14");
  const skipWeekends = body.skip_weekends !== false;

  const from = localToInstant([+m[1], +m[2], +m[3], 0, 0, 0], ref).getTime();
  const to = from + days * DAY;
  let windows = workIntervals(ps[0], from, to, skipWeekends);
  for (const p of ps.slice(1)) windows = intersect(windows, workIntervals(p, from, to, skipWeekends));
  windows = windows.map(([s, e]) => [Math.max(s, from), Math.min(e, to)] as [number, number]).filter(([s, e]) => e > s);

  return {
    reference_timezone: ref,
    from: zonedView(new Date(from), ref).datetime,
    to: zonedView(new Date(to), ref).datetime,
    participants: ps.map((p) => ({ timezone: p.timezone, work_start: fmtHM(p.work_start), work_end: fmtHM(p.work_end) })),
    total_overlap_minutes: windows.reduce((n, [s, e]) => n + (e - s) / MIN, 0),
    windows: windows.map(([s, e]) => ({
      start_utc: iso(s),
      end_utc: iso(e),
      duration_minutes: (e - s) / MIN,
      local: ps.map((p) => ({ timezone: p.timezone, start: zonedView(new Date(s), p.timezone).datetime, end: zonedView(new Date(e), p.timezone).datetime })),
    })),
  };
}

const fmtHM = (mins: number) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

// ---------- /v1/cron ----------
export function cron(body: Record<string, unknown>) {
  const expr = body.expression;
  if (typeof expr !== "string" || !expr.trim() || expr.length > 200) {
    throw new InputError("invalid_cron", 'expression must be a cron string with 5 or 6 fields, e.g. "0 9 * * 1-5"');
  }
  const tz = body.timezone === undefined ? "UTC" : assertTimeZone(body.timezone, "timezone");
  const count = body.count === undefined ? 5 : body.count;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 100) throw new InputError("invalid_count", "count must be an integer 1–100");
  const from = body.from === undefined || body.from === "now" ? new Date() : parseInstant(body.from, "from");

  const runs = nextRuns(parseCron(expr), tz, from, count);
  let description: string;
  try {
    description = cronstrue.toString(MACRO_EXPANSION[expr.trim().toLowerCase()] ?? expr, { use24HourTimeFormat: true });
  } catch {
    description = "";
  }
  return {
    expression: expr,
    timezone: tz,
    description,
    from: iso(from.getTime()),
    next_runs: runs.map((d) => {
      const v = zonedView(d, tz);
      return { utc: iso(d.getTime()), local: v.datetime, weekday: v.weekday };
    }),
    ...(runs.length < count ? { note: "fewer runs than requested within the next 8 years" } : {}),
  };
}

// ---------- /v1/parse ----------
export function parse(body: Record<string, unknown>) {
  const text = body.text;
  if (typeof text !== "string" || !text.trim() || text.length > 1000) throw new InputError("invalid_text", "text must be a non-empty string up to 1000 characters");
  const tz = body.timezone === undefined ? "UTC" : assertTimeZone(body.timezone, "timezone");
  const ref = body.reference === undefined || body.reference === "now" ? new Date() : parseInstant(body.reference, "reference");
  const offset = zonedParts(ref, tz).offsetMin;

  const results = chrono.parse(text, { instant: ref, timezone: offset }, { forwardDate: body.forward_date !== false });
  const view = (d: Date) => {
    const v = zonedView(d, tz);
    return { utc: iso(d.getTime()), local: v.datetime, date: v.date, weekday: v.weekday };
  };
  return {
    text,
    timezone: tz,
    reference: zonedView(ref, tz).datetime,
    count: results.length,
    results: results.map((r) => ({
      matched: r.text,
      index: r.index,
      start: view(r.start.date()),
      ...(r.end ? { end: view(r.end.date()) } : {}),
      certain: Object.keys((r.start as unknown as { knownValues: Record<string, number> }).knownValues ?? {}),
    })),
  };
}

// Warm lazily-initialized libraries at Worker startup (their first call compiles patterns/regexes).
chrono.parse("next friday at 3pm", { instant: new Date(0), timezone: 0 });
try {
  cronstrue.toString("0 9 * * 1-5");
} catch {}
