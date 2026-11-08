// Stay limits (Schengen 90/180), timestamp normalization and DST checks.
// Every loop is bounded by input caps (trips, values, a year of weekly probes), so calls stay inside the
// Workers free-plan CPU budget.
import { assertTimeZone, DAY_MS, fmtDate, InputError, parseDate, parseLocal, viewFromWall, zonedParts } from "./date";

// UTC offset in minutes from a "longOffset" formatter: ~4x cheaper than formatToParts (zonedParts), which
// matters for tools that need hundreds of lookups per call. Bounded cache, one formatter per zone.
const offsetFormatters = new Map<string, Intl.DateTimeFormat>();
export function offsetMinutes(ms: number, tz: string): number {
  let f = offsetFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset", hour: "numeric" });
    if (offsetFormatters.size > 200) offsetFormatters.clear();
    offsetFormatters.set(tz, f);
  }
  const m = /GMT(?:([+-])(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(f.format(ms));
  if (!m) return zonedParts(new Date(ms), tz).offsetMin; // unexpected format: fall back to the slow exact path
  if (!m[1]) return 0;
  // Match zonedParts: offsets are compared at whole-second precision, then rounded to minutes.
  const sec = Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4] ?? 0);
  return Math.round(((m[1] === "-" ? -1 : 1) * sec) / 60);
}

// ---------- stay_calculator: rolling "N days in any M days" rules ----------

const MAX_TRIPS = 200;
const MAX_SPAN_DAYS = 3660; // trips + check dates must fit in ~10 years

function posInt(body: Record<string, unknown>, key: string, dflt: number, max: number): number {
  const v = body[key];
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > max) throw new InputError("invalid_number", `${key} must be an integer between 1 and ${max}`);
  return v;
}

export function stay(body: Record<string, unknown>) {
  const maxDays = posInt(body, "max_days", 90, 365);
  const windowDays = posInt(body, "window_days", 180, 730);
  if (maxDays > windowDays) throw new InputError("invalid_rule", "max_days must not exceed window_days");

  const trips = body.trips;
  if (!Array.isArray(trips) || trips.length > MAX_TRIPS) {
    throw new InputError("invalid_trips", `trips must be an array of up to ${MAX_TRIPS} {entry, exit} objects (YYYY-MM-DD; both days count as days of stay)`);
  }
  let tripDays = 0;
  const ranges = trips.map((t, i) => {
    if (typeof t !== "object" || t === null) throw new InputError("invalid_trips", `trips[${i}] must be an object {entry, exit}`);
    const r = t as Record<string, unknown>;
    const a = parseDate(r.entry, `trips[${i}].entry`).getTime() / DAY_MS;
    const b = parseDate(r.exit, `trips[${i}].exit`).getTime() / DAY_MS;
    if (b < a) throw new InputError("invalid_trips", `trips[${i}].exit is before its entry`);
    tripDays += b - a + 1;
    if (tripDays > 2 * MAX_SPAN_DAYS) throw new InputError("range_too_large", "trips cover too many days in total; send at most about 10 years of trips");
    return [a, b] as const;
  });

  const day = body.date === undefined ? Math.floor(Date.now() / DAY_MS) : parseDate(body.date, "date").getTime() / DAY_MS;
  const entry = body.entry === undefined ? null : parseDate(body.entry, "entry").getTime() / DAY_MS;

  // Day-indexed presence with prefix sums: count(lo..hi) is O(1).
  const points = [day, ...ranges.flat(), ...(entry === null ? [] : [entry])];
  if (Math.max(...points) - Math.min(...points) > MAX_SPAN_DAYS) {
    throw new InputError("range_too_large", "trips, date and entry must all fall within about 10 years of each other");
  }
  const minDay = Math.min(...points) - windowDays;
  const maxDay = Math.max(...points) + windowDays + 2 * maxDays + 1; // covers every day the searches below touch
  const n = maxDay - minDay + 1;
  const present = new Uint8Array(n);
  for (const [a, b] of ranges) for (let d = a; d <= b; d++) present[d - minDay] = 1;
  const prefix = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + present[i];
  const count = (lo: number, hi: number) => {
    const l = Math.max(lo, minDay) - minDay, h = Math.min(hi, maxDay) - minDay;
    return h < l ? 0 : prefix[h + 1] - prefix[l];
  };
  const usedOn = (d: number) => count(d - windowDays + 1, d);
  const iso = (d: number) => fmtDate(new Date(d * DAY_MS));

  /** Longest stay starting on day s, given past presence (days already present are not double counted). */
  const maxStayFrom = (s: number): number => {
    // Hot loop (up to ~1,100 starts x 365 days): plain prefix-sum reads, all indexes in range by construction.
    const si = s - minDay, w = windowDays - 1, ps = prefix[si];
    let k = 0;
    for (; k < maxDays; k++) {
      const ti = si + k; // would stay on days s..s+k
      const used = prefix[ti + 1] - prefix[ti - w];
      const extra = k + 1 - (prefix[ti + 1] - ps); // new days the stay adds
      if (used + extra > maxDays) break;
    }
    return k;
  };

  let firstOverstay: number | null = null;
  for (const [a, b] of ranges) {
    for (let d = a; d <= b; d++) {
      if (usedOn(d) > maxDays && (firstOverstay === null || d < firstOverstay)) {
        firstOverstay = d;
        break;
      }
    }
  }

  const used = usedOn(day);
  let fullFrom: number | null = null;
  for (let d = day + 1; d <= day + windowDays + maxDays; d++) {
    if (maxStayFrom(d) >= maxDays) {
      fullFrom = d;
      break;
    }
  }

  let maxStay = null;
  if (entry !== null) {
    const k = maxStayFrom(entry);
    maxStay = { entry: iso(entry), days_allowed: k, latest_exit: k === 0 ? null : iso(entry + k - 1) };
  }

  return {
    date: iso(day),
    rule: { max_days: maxDays, window_days: windowDays, window_start: iso(day - windowDays + 1), window_end: iso(day) },
    days_used: used,
    days_remaining: Math.max(0, maxDays - used),
    overstay_days: Math.max(0, used - maxDays),
    in_compliance: used <= maxDays,
    first_overstay: firstOverstay === null ? null : iso(firstOverstay),
    max_stay: maxStay,
    next_full_stay_date: fullFrom === null ? null : iso(fullFrom),
    note: "Entry and exit days both count. A planning aid; border officials and the official calculator have the final say.",
  };
}

// ---------- timestamp_normalize ----------

const MAX_VALUES = 100;
const EXCEL_EPOCH = Date.UTC(1899, 11, 30); // serial 1 = 1900-01-01; handles Excel's 1900 leap bug for serials >= 61
const FILETIME_EPOCH_MS = -11_644_473_600_000; // 1601-01-01
const MIN_MS = -62_135_596_800_000, MAX_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
const HINTS = ["auto", "unix_seconds", "unix_ms", "unix_us", "unix_ns", "excel", "filetime"] as const;
const ORDERS = ["MDY", "DMY"] as const;
const ZONE_ABBR: Record<string, number> = { UT: 0, UTC: 0, GMT: 0, Z: 0, EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420 };

type Reading = { format: string; ms: number; naive: boolean };

/** Integer-or-decimal numeric string -> value in ms for the given unit, without losing precision on big ints. */
function numericToMs(s: string, unit: string): number | null {
  if (unit === "excel") {
    const v = Number(s);
    return EXCEL_EPOCH + Math.round(v * DAY_MS);
  }
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const neg = m[1] === "-";
  const per: Record<string, [bigint, number]> = { unix_seconds: [1000n, 1], unix_ms: [1n, 1], unix_us: [1n, 1000], unix_ns: [1n, 1_000_000], filetime: [1n, 10_000] };
  const [mul, div] = per[unit];
  const scaled = (BigInt(m[2]) * mul) / BigInt(div);
  const frac = m[3] ? Number("0." + m[3]) * Number(mul) / div : 0;
  let ms = Number(scaled) + frac;
  if (neg) ms = -ms;
  if (unit === "filetime") ms += FILETIME_EPOCH_MS;
  return ms;
}

function autoUnit(s: string): { unit: string; alt: string | null } {
  const v = Math.abs(Number(s));
  const hasFrac = s.includes(".");
  if (v >= 20_000 && v < 80_000) return hasFrac ? { unit: "excel", alt: null } : { unit: "excel", alt: "unix_seconds" }; // 1954–2119 as a spreadsheet date
  if (v < 1e11) return { unit: "unix_seconds", alt: null };
  if (v < 1e14) return { unit: "unix_ms", alt: null };
  if (v < 1e16) return { unit: "unix_us", alt: null };
  return { unit: "unix_ns", alt: null };
}

function to24(h: number, ampm: string | undefined): number | null {
  if (!ampm) return h <= 23 ? h : null;
  if (h < 1 || h > 12) return null;
  const pm = ampm.toLowerCase() === "pm";
  return (h % 12) + (pm ? 12 : 0);
}

function wall(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, frac = 0): number | null {
  const ms = Date.UTC(y, mo - 1, d, h, mi, s) + frac;
  const t = new Date(ms);
  if (y < 1 || t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null;
  return ms;
}

const TIME = String.raw`(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*([AaPp][Mm])?)?`;
const ZONE = String.raw`\s*(Z|[+-]\d{2}:?\d{2}|UTC|GMT|UT|[ECMP][SD]T)?`;
const RE_ISO = new RegExp(String.raw`^(\d{4})-(\d{2})-(\d{2})${TIME}${ZONE}$`);
const RE_YMD = new RegExp(String.raw`^(\d{4})[/.](\d{1,2})[/.](\d{1,2})${TIME}${ZONE}$`);
const RE_SLASH = new RegExp(String.raw`^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})${TIME}${ZONE}$`);
const RE_DMONY = new RegExp(String.raw`^(?:[A-Za-z]{3,9},?\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})${TIME}${ZONE}$`);
const RE_MONDY = new RegExp(String.raw`^(?:[A-Za-z]{3,9},?\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})${TIME}${ZONE}$`);

function zoneOffset(z: string | undefined): number | null {
  if (!z) return null;
  const u = z.toUpperCase();
  if (u in ZONE_ABBR) return ZONE_ABBR[u];
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(z)!;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
function month(name: string): number | null {
  const n = name.toLowerCase();
  const i = MONTH_NAMES.findIndex((full) => full === n || (n.length >= 3 && full.startsWith(n)) || (n === "sept" && full === "september"));
  return i < 0 ? null : i + 1;
}

/** Build a reading from date parts plus the shared time/zone capture groups (h, mi, s, frac, ampm, zone). */
function fromParts(format: string, y: number, mo: number | null, d: number, g: (string | undefined)[]): Reading | null {
  if (mo === null) return null;
  const h = to24(g[0] ? Number(g[0]) : 0, g[4]);
  if (h === null) return null;
  const frac = g[3] ? Math.floor(Number("0." + g[3]) * 1000) : 0;
  const w = wall(y, mo, d, h, g[1] ? Number(g[1]) : 0, g[2] ? Number(g[2]) : 0, frac);
  if (w === null) return null;
  const off = zoneOffset(g[5]);
  return off === null ? { format, ms: w, naive: true } : { format, ms: w - off * 60_000, naive: false };
}

function readString(s: string, order: string | null): { r: Reading; alts: Reading[] } | null {
  let m = RE_ISO.exec(s);
  if (m) {
    const r = fromParts("iso8601", +m[1], +m[2], +m[3], m.slice(4));
    return r && { r, alts: [] };
  }
  if ((m = RE_YMD.exec(s))) {
    const r = fromParts("ymd", +m[1], +m[2], +m[3], m.slice(4));
    return r && { r, alts: [] };
  }
  if ((m = RE_SLASH.exec(s))) {
    const [a, b, y] = [+m[1], +m[2], +m[3]];
    const mdy = fromParts("mdy", y, a, b, m.slice(4)), dmy = fromParts("dmy", y, b, a, m.slice(4));
    if (mdy && dmy && a !== b) {
      const first = order === "DMY" ? dmy : mdy;
      return { r: first, alts: [first === mdy ? dmy : mdy] };
    }
    const r = mdy ?? dmy;
    return r && { r, alts: [] };
  }
  if ((m = RE_DMONY.exec(s))) {
    const r = fromParts("text_date", +m[3], month(m[2]), +m[1], m.slice(4));
    return r && { r, alts: [] };
  }
  if ((m = RE_MONDY.exec(s))) {
    const r = fromParts("text_date", +m[3], month(m[1]), +m[2], m.slice(4));
    return r && { r, alts: [] };
  }
  return null;
}

export function timestamp(body: Record<string, unknown>) {
  const values = body.values;
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_VALUES) {
    throw new InputError("invalid_values", `values must be an array of 1–${MAX_VALUES} timestamps (strings or numbers), e.g. [1762500000, "03/04/2026 14:30", "2026-11-07T09:00:00Z"]`);
  }
  const tz = body.timezone === undefined ? "UTC" : assertTimeZone(body.timezone, "timezone");
  const hint = body.numeric_format ?? "auto";
  if (typeof hint !== "string" || !(HINTS as readonly string[]).includes(hint)) throw new InputError("invalid_numeric_format", `numeric_format must be one of ${HINTS.join(", ")}`);
  const order = body.date_order ?? null;
  if (order !== null && (typeof order !== "string" || !(ORDERS as readonly string[]).includes(order))) {
    throw new InputError("invalid_date_order", 'date_order must be "MDY" (US, 03/04 = March 4) or "DMY" (most other countries, 03/04 = 3 April)');
  }

  // Offsets via one Intl call each (none for UTC), memoized per call. Values can span centuries, so a
  // week-segment cursor would not help here.
  const memo = new Map<number, number>();
  const offsetAt = (ms: number): number => {
    if (tz === "UTC") return 0;
    let o = memo.get(ms);
    if (o === undefined) {
      o = offsetMinutes(ms, tz);
      if (memo.size < 1000) memo.set(ms, o);
    }
    return o;
  };
  // Naive wall times (no offset) are read in tz, DST-aware: repeated times take the first occurrence, skipped
  // times (spring-forward gap) shift forward like most systems do. Usually 2 Intl calls.
  const toInstant = (r: Reading) => {
    if (!r.naive) return r.ms;
    if (!Number.isFinite(r.ms) || r.ms < MIN_MS || r.ms > MAX_MS) return NaN;
    const w = r.ms;
    const o1 = offsetAt(w);
    let o2 = offsetAt(w - o1 * 60_000);
    if (o2 !== o1 && offsetAt(w - o2 * 60_000) !== o2) {
      // Gap: this wall time never happens; read it with the offset in force before the jump (shifts forward).
      return w - Math.min(o1, o2) * 60_000;
    }
    const ms = w - o2 * 60_000;
    // Repeated (fall-back) wall time: prefer the earlier instant if the offset 3 h before also maps here.
    const oe = offsetAt(ms - 3 * 3_600_000);
    if (oe !== o2 && oe > o2 && offsetAt(w - oe * 60_000) === oe) return w - oe * 60_000;
    return ms;
  };
  const localView = (ms: number) => {
    const off = offsetAt(ms);
    return viewFromWall(ms + off * 60_000, off, tz).datetime;
  };
  const show = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

  const results = values.map((v) => {
    const input = v;
    const fail = (error: string) => ({ input, ok: false as const, error });
    let s: string;
    if (typeof v === "number" && Number.isFinite(v)) s = String(v).includes("e") ? BigInt(Math.trunc(v)).toString() : String(v);
    else if (typeof v === "string" && v.length <= 100) s = v.trim();
    else return fail("each value must be a string (up to 100 characters) or a finite number");

    let reading: Reading | null = null;
    let alts: Reading[] = [];
    if (/^-?\d+(\.\d+)?$/.test(s)) {
      const { unit, alt } = hint === "auto" ? autoUnit(s) : { unit: hint, alt: null };
      const ms = numericToMs(s, unit);
      if (ms !== null) reading = { format: unit, ms, naive: unit === "excel" };
      if (alt) {
        const ams = numericToMs(s, alt);
        if (ams !== null) alts = [{ format: alt, ms: ams, naive: false }];
      }
    } else {
      const got = readString(s, order as string | null);
      if (got) [reading, alts] = [got.r, got.alts];
    }
    if (!reading) return fail('unrecognized format; supported: Unix s/ms/µs/ns, Excel serial, Windows FILETIME (numeric_format), ISO 8601, YYYY/MM/DD, MM/DD/YYYY or DD/MM/YYYY, "7 Nov 2026", "Nov 7, 2026", RFC 2822. For phrases like "next Friday" use parse_date_text.');
    const ms = toInstant(reading);
    if (!Number.isFinite(ms) || ms < MIN_MS || ms > MAX_MS) return fail("timestamp is outside years 1–9999");
    return {
      input,
      ok: true as const,
      format: reading.format,
      utc: show(ms),
      unix_seconds: Math.floor(ms / 1000),
      unix_ms: Math.floor(ms),
      local: localView(ms),
      assumed_timezone: reading.naive ? tz : null,
      ambiguous: alts.length > 0,
      alternatives: alts
        .map((a) => ({ format: a.format, ms: toInstant(a) }))
        .filter((a) => Number.isFinite(a.ms) && a.ms >= MIN_MS && a.ms <= MAX_MS)
        .map((a) => ({ format: a.format, utc: show(a.ms) })),
    };
  });
  return { timezone: tz, count: results.length, ok: results.filter((r) => r.ok).length, results };
}

// ---------- dst_check ----------

type Transition = { at: number; before: number; after: number };

/** Offset transitions in [from, to) using weekly probes plus binary search to the minute. ~110 Intl calls per year. */
function transitionsBetween(tz: string, from: number, to: number): Transition[] {
  const off = (ms: number) => offsetMinutes(ms, tz);
  const out: Transition[] = [];
  const WEEK = 7 * DAY_MS;
  let a = from, oa = off(a);
  while (a < to) {
    const b = Math.min(a + WEEK, to), ob = off(b);
    if (ob !== oa) {
      let lo = a, hi = b;
      while (hi - lo > 60_000) {
        const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000;
        if (off(mid) === oa) lo = mid;
        else hi = mid;
      }
      out.push({ at: hi, before: oa, after: ob });
    }
    a = b;
    oa = ob;
  }
  return out;
}

export function dst(body: Record<string, unknown>) {
  const tz = assertTimeZone(body.timezone, "timezone");
  let local: ReturnType<typeof parseLocal> = null;
  if (body.datetime !== undefined) {
    local = typeof body.datetime === "string" ? parseLocal(body.datetime) : null;
    if (!local || wall(...local) === null) throw new InputError("invalid_datetime", 'datetime must be a local wall-clock time without offset, YYYY-MM-DDTHH:MM[:SS], e.g. "2026-03-08T02:30"');
  }
  let year: number;
  if (body.year !== undefined) {
    if (typeof body.year !== "number" || !Number.isInteger(body.year) || body.year < 1900 || body.year > 2100) throw new InputError("invalid_year", "year must be an integer between 1900 and 2100");
    year = body.year;
  } else year = local ? local[0] : new Date().getUTCFullYear();

  const off = (ms: number) => offsetMinutes(ms, tz);
  const fmtOff = (min: number) => viewFromWall(0, min, tz).utc_offset;
  const show = (ms: number, o: number) => viewFromWall(ms + o * 60_000, o, tz).datetime;

  const list = transitionsBetween(tz, Date.UTC(year, 0, 1) - 14 * 3_600_000, Date.UTC(year + 1, 0, 1) + 14 * 3_600_000)
    .filter((t) => new Date(t.at + t.after * 60_000).getUTCFullYear() === year)
    .map((t) => ({
      at_utc: new Date(t.at).toISOString().replace(".000Z", "Z"),
      local_before: show(t.at, t.before),
      local_after: show(t.at, t.after),
      offset_before: fmtOff(t.before),
      offset_after: fmtOff(t.after),
      change_minutes: t.after - t.before,
      type: t.after > t.before ? "clocks_forward" : "clocks_back",
    }));

  let check = null;
  if (local) {
    const w = wall(...local)!;
    const oBefore = off(w - DAY_MS), oAfter = off(w + DAY_MS);
    const cands = [...new Set([oBefore, oAfter])].filter((o) => off(w - o * 60_000) === o).map((o) => ({ ms: w - o * 60_000, o })).sort((x, y) => x.ms - y.ms);
    const asked = viewFromWall(w, 0, tz).datetime.slice(0, 19);
    if (cands.length === 0) {
      const ms = w - oBefore * 60_000; // clocks moved past it: read with the old offset, i.e. shift forward
      check = {
        local: asked,
        status: "skipped",
        instants: [],
        resolved: show(ms, oAfter),
        note: `This local time does not exist: clocks jump forward ${oAfter - oBefore} minutes. Most systems shift it forward to ${show(ms, oAfter).slice(11, 16)}.`,
      };
    } else if (cands.length === 2) {
      check = {
        local: asked,
        status: "repeated",
        instants: cands.map((c) => show(c.ms, c.o)),
        resolved: show(cands[0].ms, cands[0].o),
        note: `This local time happens twice: clocks go back ${oBefore - oAfter} minutes. The first occurrence (${fmtOff(cands[0].o)}) is the usual default; pass an explicit offset to pick one.`,
      };
    } else {
      check = { local: asked, status: "valid", instants: [show(cands[0].ms, cands[0].o)], resolved: show(cands[0].ms, cands[0].o), note: "This local time occurs exactly once." };
    }
  }

  const jan = off(Date.UTC(year, 0, 15)), jul = off(Date.UTC(year, 6, 15));
  return {
    timezone: tz,
    year,
    observes_dst: jan !== jul,
    standard_offset: fmtOff(Math.min(jan, jul)),
    dst_offset: jan !== jul ? fmtOff(Math.max(jan, jul)) : null,
    transitions: list,
    check,
  };
}

// Warm the longOffset formatter path at startup (same reason as the warm-up in date.ts).
offsetMinutes(0, "America/New_York");
