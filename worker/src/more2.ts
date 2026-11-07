// More tools: city -> time zone, recurring dates (RRULE), business-hours deadlines/SLA.
import { rrulestr } from "rrule";
import cities from "./cities-data.json";
import { assertTimeZone, localToInstant, offsetCursor, parseInstant, parseLocal, viewFromWall, wallToInstantWith, zonedParts, zonedView } from "./date";
import { InputError } from "./errors";
import { countryHolidayDates } from "./holidays";

const MIN = 60_000;
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

// ---------- /v1/city ----------
type CityRow = [string, string, string, number, number, string]; // name, iso2, region, zoneIdx, population, "norm|normAscii"
const C = cities as unknown as { zones: string[]; cities: CityRow[] };
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Lazily built once per isolate (~1ms): exact-name map + flat name list for prefix search.
let byName: Map<string, number[]> | undefined;
let flat: { name: string; row: number }[] | undefined;
function cityIndex() {
  if (!byName) {
    byName = new Map();
    flat = [];
    C.cities.forEach((r, i) => {
      for (const n of r[5].split("|")) {
        const list = byName!.get(n);
        list ? list.push(i) : byName!.set(n, [i]);
        flat!.push({ name: n, row: i });
      }
    });
  }
  return { byName, flat: flat! };
}

cityIndex(); // eager: runs during Worker startup, not on the first request's CPU budget
norm("São Paulo"); // warm ICU normalization data at startup too

/** Exact name match first (rows are population-sorted), then prefix. */
function lookupCity(query: string, country?: string) {
  const q = norm(query);
  if (!q) return [];
  const { byName, flat } = cityIndex();
  let ids = (byName.get(q) ?? []).filter((i) => !country || C.cities[i][1] === country);
  let match = "exact";
  if (ids.length === 0 && q.length >= 3) {
    match = "prefix";
    const seen = new Set<number>();
    for (const e of flat) {
      if (e.name.startsWith(q) && !seen.has(e.row) && (!country || C.cities[e.row][1] === country)) seen.add(e.row);
    }
    ids = [...seen].sort((x, y) => x - y);
  }
  const res = ids.slice(0, 5).map((i) => {
    const r = C.cities[i];
    return { name: r[0], country: r[1], region: r[2], timezone: C.zones[r[3]], population: r[4], match };
  });
  if (res.length === 0 && !country) {
    for (const tz of C.zones) {
      const city = tz.split("/").pop()!.replace(/_/g, " ");
      if (norm(city) === q) res.push({ name: city, country: "", region: "", timezone: tz, population: 0, match: "timezone" });
    }
  }
  return res;
}

export function cityTime(body: Record<string, unknown>) {
  const list = body.cities ?? (body.city !== undefined ? [body.city] : undefined);
  if (!Array.isArray(list) || list.length === 0 || list.length > 10 || list.some((c) => typeof c !== "string" || !c.trim() || c.length > 100)) {
    throw new InputError("invalid_city", 'pass "city" (string) or "cities" (1–10 strings), e.g. {"city":"Cebu"}');
  }
  const country = body.country === undefined ? undefined : String(body.country).toUpperCase();
  if (country !== undefined && !/^[A-Z]{2}$/.test(country)) throw new InputError("invalid_country", "country must be an ISO 3166-1 alpha-2 code");
  const at = body.at === undefined || body.at === "now" ? new Date() : parseInstant(body.at, "at");
  return {
    at: iso(at.getTime()),
    results: (list as string[]).map((q) => {
      const matches = lookupCity(q, country).map((m) => {
        const v = zonedView(at, m.timezone);
        return { ...m, local_time: v.datetime, weekday: v.weekday, utc_offset: v.utc_offset };
      });
      return { query: q, found: matches.length > 0, best: matches[0] ?? null, alternatives: matches.slice(1) };
    }),
  };
}

// ---------- /v1/recurrence ----------
export function recurrence(body: Record<string, unknown>) {
  const rule = body.rrule;
  if (typeof rule !== "string" || !rule.trim() || rule.length > 500) {
    throw new InputError("invalid_rrule", 'rrule must be an iCalendar RRULE, e.g. "FREQ=MONTHLY;BYDAY=2TU" or "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6"');
  }
  if (/DTSTART|TZID|EXDATE|RDATE/i.test(rule)) throw new InputError("invalid_rrule", "pass start and timezone as separate fields; DTSTART/TZID/EXDATE/RDATE are not accepted inside rrule");
  const tz = body.timezone === undefined ? "UTC" : assertTimeZone(body.timezone, "timezone");
  const count = body.count === undefined ? 10 : body.count;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 200) throw new InputError("invalid_count", "count must be an integer 1–200");
  const startRaw = body.start;
  const local = typeof startRaw === "string" ? parseLocal(startRaw.length === 10 ? startRaw + "T00:00" : startRaw) : null;
  if (!local) throw new InputError("invalid_start", 'start must be a local date or datetime in the given timezone, e.g. "2026-01-06" or "2026-01-06T10:00"');
  const exclude = new Set<string>(Array.isArray(body.exclude) ? body.exclude.filter((d): d is string => typeof d === "string").map((d) => d.slice(0, 10)) : []);

  // Expand in floating local time (wall clock as UTC), then map each wall time to a real instant in tz.
  let r;
  try {
    r = rrulestr(rule.replace(/^RRULE:/i, ""), { dtstart: new Date(Date.UTC(local[0], local[1] - 1, local[2], local[3], local[4], local[5])) });
  } catch (e) {
    throw new InputError("invalid_rrule", `could not parse rrule: ${(e as Error).message}`);
  }
  const walls: Date[] = [];
  const limit = count + exclude.size;
  r.all((d, i) => {
    if (i >= limit + 1 || d.getUTCFullYear() > local[0] + 100) return false;
    walls.push(d);
    return walls.length < limit;
  });
  const offsetAt = offsetCursor(tz);
  const occurrences = walls
    .filter((w) => !exclude.has(w.toISOString().slice(0, 10)))
    .slice(0, count)
    .map((w) => {
      let wall = w.getTime();
      let r = wallToInstantWith(offsetAt, wall);
      if (!r) {
        // Nonexistent local time (DST gap): shift forward like most calendars do.
        const inst = localToInstant([w.getUTCFullYear(), w.getUTCMonth() + 1, w.getUTCDate(), w.getUTCHours(), w.getUTCMinutes(), w.getUTCSeconds()], tz).getTime();
        r = { ms: inst, offset: offsetAt(inst) };
        wall = inst + r.offset * MIN;
      }
      const v = viewFromWall(wall, r.offset, tz);
      return { local: v.datetime, date: v.date, weekday: v.weekday, utc: iso(r.ms) };
    });
  let text = "";
  try {
    text = r.toText();
  } catch {}
  return { rrule: rule, timezone: tz, start: startRaw, description: text, count: occurrences.length, occurrences };
}

// ---------- /v1/business_hours ----------
function hhmm(v: unknown, field: string, fallback: string): number {
  const s = v === undefined ? fallback : v;
  const m = typeof s === "string" ? /^([01]\d|2[0-4]):([0-5]\d)$/.exec(s) : null;
  if (!m || (m[1] === "24" && m[2] !== "00")) throw new InputError("invalid_time", `${field} must be HH:MM (24h)`);
  return Number(m[1]) * 60 + Number(m[2]);
}

const MAX_BUSINESS_MINUTES = 2000 * 60;

export function businessHours(body: Record<string, unknown>) {
  const tz = assertTimeZone(body.timezone, "timezone");
  const ws = hhmm(body.work_start, "work_start", "09:00"), we = hhmm(body.work_end, "work_end", "17:00");
  if (we <= ws) throw new InputError("invalid_time", "work_end must be after work_start");
  const workdays = new Set<number>(Array.isArray(body.workdays) ? (body.workdays as unknown[]).map(Number) : [1, 2, 3, 4, 5]);
  if ([...workdays].some((d) => !Number.isInteger(d) || d < 0 || d > 6) || workdays.size === 0) throw new InputError("invalid_workdays", "workdays must be weekday numbers 0–6 (0 = Sunday), e.g. [1,2,3,4,5]");

  const toInstant = (v: unknown, field: string): number => {
    if (typeof v === "string") {
      const loc = parseLocal(v);
      if (loc) return localToInstant(loc, tz).getTime();
    }
    return parseInstant(v, field).getTime();
  };
  const start = body.start === undefined || body.start === "now" ? Date.now() : toInstant(body.start, "start");
  const addMin = body.hours !== undefined || body.minutes !== undefined ? Math.round(Number(body.hours ?? 0) * 60 + Number(body.minutes ?? 0)) : null;
  const end = body.end !== undefined ? toInstant(body.end, "end") : null;
  if ((addMin === null) === (end === null)) throw new InputError("invalid_request", 'pass either "hours"/"minutes" (find the deadline) or "end" (count business time between start and end)');
  if (addMin !== null && (!Number.isFinite(addMin) || addMin < 0 || addMin > MAX_BUSINESS_MINUTES)) throw new InputError("invalid_hours", "hours must be between 0 and 2000");
  if (end !== null && (end < start || end - start > 366 * DAY)) throw new InputError("invalid_range", "end must be after start and within 1 year");

  const z0 = zonedParts(new Date(start), tz);
  const holidayStr = new Set<string>(Array.isArray(body.holidays) ? (body.holidays as unknown[]).filter((d): d is string => typeof d === "string") : []);
  if (body.country !== undefined) for (const h of countryHolidayDates(body.country, z0.y, z0.y + 3)) holidayStr.add(h);
  const holidays = new Set<number>([...holidayStr].map((h) => Date.parse(h.slice(0, 10) + "T00:00:00Z")));

  let remaining = addMin ?? Infinity;
  let counted = 0;
  const offsetAt = offsetCursor(tz);
  let prevOff = z0.offsetMin;
  const at = (wall: number, y: number, mo: number, d: number, mins: number) =>
    wallToInstantWith(offsetAt, wall)?.ms ?? localToInstant([y, mo, d, Math.floor(mins / 60), mins % 60, 0], tz).getTime();
  for (let i = 0, day = Date.UTC(z0.y, z0.mo - 1, z0.d); i < 3 * 366 + 7; i++, day += DAY) {
    const dt = new Date(day);
    if (!workdays.has(dt.getUTCDay()) || holidays.has(day)) continue;
    const wallS = day + ws * MIN, wallE = day + we * MIN;
    // Fast path: same offset at both ends of the window (no DST change inside it) => plain arithmetic.
    const oS = offsetAt(wallS - prevOff * MIN), oE = offsetAt(wallE - oS * MIN);
    let winS: number, winE: number;
    if (oS === oE && offsetAt(wallS - oS * MIN) === oS) {
      winS = wallS - oS * MIN;
      winE = wallE - oE * MIN;
    } else {
      const [y, mo, d] = [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
      winS = at(wallS, y, mo, d, ws);
      winE = at(wallE, y, mo, d, we);
    }
    prevOff = oE;
    const from = Math.max(winS, start);
    const to = end === null ? winE : Math.min(winE, end);
    if (to <= from) {
      if (end !== null && winS >= end) break;
      continue;
    }
    const avail = (to - from) / MIN;
    if (addMin !== null) {
      if (remaining <= avail) {
        const deadline = from + remaining * MIN;
        const v = zonedView(new Date(deadline), tz);
        return { mode: "deadline", timezone: tz, start: zonedView(new Date(start), tz).datetime, business_minutes: addMin, deadline: v.datetime, deadline_utc: iso(deadline), weekday: v.weekday };
      }
      remaining -= avail;
    } else counted += avail;
  }
  if (addMin !== null) throw new InputError("out_of_range", "deadline is more than 3 years away");
  return {
    mode: "elapsed", timezone: tz, start: zonedView(new Date(start), tz).datetime, end: zonedView(new Date(end!), tz).datetime,
    business_minutes: Math.round(counted), business_hours: Math.round((counted / 60) * 100) / 100,
  };
}
rrulestr("FREQ=WEEKLY;COUNT=2", { dtstart: new Date(0) }).all(); // warm rrule at startup
