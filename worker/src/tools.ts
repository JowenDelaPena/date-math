// Single registry of paid tools. HTTP routes, x402 payments, discovery files and the MCP server all read this.
import { add, convert, diff, info } from "./date";
import { cron, holidays, overlap, parse } from "./more";
import { businessHours, cityTime, recurrence } from "./more2";
import { businessDay, payDates } from "./biz";
import { dst, stay, timestamp } from "./more3";
import { currentTime, freeSlots, marketCalendar, slaCountdown, subscriptionDates } from "./more4";

export interface Tool {
  name: string; // MCP tool name
  path: string; // HTTP route (POST)
  title: string;
  description: string;
  run: (body: Record<string, unknown>) => unknown;
  example: Record<string, unknown>;
}

export const TOOLS: Tool[] = [
  {
    name: "date_diff",
    path: "/v1/diff",
    title: "Date difference",
    description:
      "How many days, weeks, months or business days between two dates or datetimes: calendar (Y/M/D), totals, and business days (weekdays in [from, to) minus holidays; pass country to exclude its public holidays). Use for age, tenure, countdowns, notice periods and working days until a deadline.",
    run: diff,
    example: { from: "2026-01-31", to: "2026-03-15", country: "US" },
  },
  {
    name: "date_add",
    path: "/v1/add",
    title: "Add to a date",
    description:
      "Add or subtract years/months/weeks/days/business days/hours/minutes/seconds from a date. Month-end clamping; business days skip weekends, given holidays, and the public holidays of an optional country. Use for due dates, deadlines, delivery estimates, expiry and \"N working days from today\".",
    run: add,
    example: { date: "2026-12-22", business_days: 5, country: "PH" },
  },
  {
    name: "timezone_convert",
    path: "/v1/convert",
    title: "Convert time zones",
    description: "Convert a time between time zones (IANA names like Asia/Manila, America/New_York), DST-aware. Use for \"what time is 3pm Manila in New York\", scheduling across zones and UTC offsets.",
    run: convert,
    example: { datetime: "2026-11-07T14:30:00", from_timezone: "Asia/Manila", to_timezone: "America/New_York" },
  },
  {
    name: "date_info",
    path: "/v1/info",
    title: "Date facts",
    description: "Calendar facts for a date: day of the week, ISO week number, quarter, day of year, leap year, weekend. Use for \"what day is\", week numbers and fiscal quarters.",
    run: info,
    example: { date: "2026-11-07" },
  },
  {
    name: "public_holidays",
    path: "/v1/holidays",
    title: "Public holidays",
    description: "List public holidays (bank holidays, national holidays) for a country and year: 207 countries, 2000–2050. Use for holiday calendars, office closures and checking if a date is a holiday. Lunar or government-proclaimed dates are rule-based estimates.",
    run: holidays,
    example: { country: "PH", year: 2026 },
  },
  {
    name: "working_hours_overlap",
    path: "/v1/overlap",
    title: "Working-hours overlap",
    description:
      "Find when working hours overlap across time zones: the best meeting times for a distributed or remote team. Per-participant hours optional; skips weekends by default; up to 14 days.",
    run: overlap,
    example: { timezones: ["Asia/Manila", "Europe/London"], date: "2026-11-10", work_start: "09:00", work_end: "18:00" },
  },
  {
    name: "cron_schedule",
    path: "/v1/cron",
    title: "Cron schedule",
    description: "Explain a cron expression in plain English and list its next run times in any time zone. Use to check or debug crontab and scheduled-job schedules.",
    run: cron,
    example: { expression: "0 9 * * 1-5", timezone: "Asia/Manila", count: 3 },
  },
  {
    name: "parse_date_text",
    path: "/v1/parse",
    title: "Parse natural-language dates",
    description:
      'Parse natural-language dates and relative times like "next Friday at 3pm", "in 2 weeks", "tomorrow morning" or "Dec 25 to Jan 2" into exact ISO datetimes, relative to a reference time and time zone. Use before acting on any date a user typed.',
    run: parse,
    example: { text: "next friday at 3pm", timezone: "Asia/Manila", reference: "2026-11-07T14:00:00+08:00" },
  },
];

TOOLS.push(
  {
    name: "city_time",
    path: "/v1/city",
    title: "City time zone and local time",
    description: 'Find the time zone and current local time in up to 10 cities by name ("Cebu", "São Paulo", "Springfield" + country). 7,000+ cities. Use for "what time is it in" questions and to get the IANA zone the other tools need.',
    run: cityTime,
    example: { cities: ["Cebu", "London", "New York"] },
  },
  {
    name: "recurring_dates",
    path: "/v1/recurrence",
    title: "Expand recurring events (RRULE)",
    description:
      'Expand a recurring event or iCalendar RRULE ("every 2nd Tuesday", "Mon/Wed until June") into concrete dates and times in a time zone, DST-aware, with optional excluded dates. Use for repeating meetings, calendar invites and schedules.',
    run: recurrence,
    example: { rrule: "FREQ=MONTHLY;BYDAY=2TU", start: "2026-01-01T10:00", timezone: "Asia/Manila", count: 3 },
  },
  {
    name: "business_hours_deadline",
    path: "/v1/business_hours",
    title: "Business-hours deadline / SLA",
    description:
      "SLA math in working hours: the deadline N business hours after a start time, or business time elapsed between two times. Use for support-ticket SLAs, response-time targets and office-hours deadlines. Custom hours and workdays, holidays, country public holidays, DST-aware.",
    run: businessHours,
    example: { start: "2026-11-06T16:00", hours: 2, timezone: "Asia/Manila", work_start: "09:00", work_end: "17:00", country: "PH" },
  },
  {
    name: "business_day",
    path: "/v1/business_day",
    title: "Business-day check",
    description:
      "Is a date a business day? If not, why (weekend, or which public holiday). Also the next and previous business day, and the month's business-day count, first and last business day. Use for office-open checks, shipping cut-offs, settlement dates. Country holidays, custom holidays and custom workweeks (e.g. Sun–Thu, Mon–Sat).",
    run: businessDay,
    example: { date: "2026-12-25", country: "PH" },
  },
  {
    name: "pay_dates",
    path: "/v1/pay_dates",
    title: "Payroll and billing dates",
    description:
      "Upcoming pay or billing dates for monthly, semi-monthly (e.g. 15th and last day), biweekly or weekly schedules, moved off weekends and public holidays (to the previous, next or nearest business day). Use for payroll calendars, invoice due dates and recurring billing.",
    run: payDates,
    example: { schedule: "semi_monthly", from: "2026-12-01", count: 4, country: "PH" },
  },
  {
    name: "stay_calculator",
    path: "/v1/stay",
    title: "Visa stay calculator (Schengen 90/180)",
    description:
      'Rolling stay-limit math such as the Schengen 90/180 rule: days used in the window, days left, overstay check, the longest stay allowed from a planned entry date, and the next date a full stay is possible. Entry and exit days both count. Custom rules via max_days/window_days. Use for travel planning, visa-free stays and "can I enter on".',
    run: stay,
    example: { trips: [{ entry: "2026-06-01", exit: "2026-07-15" }, { entry: "2026-09-10", exit: "2026-09-30" }], date: "2026-10-01", entry: "2026-11-01" },
  },
  {
    name: "timestamp_normalize",
    path: "/v1/timestamp",
    title: "Normalize timestamps",
    description:
      "Detect and convert up to 100 mixed timestamps to UTC ISO 8601: Unix seconds/ms/µs/ns, Excel serial dates, Windows FILETIME, ISO 8601, RFC 2822, YYYY/MM/DD, month-name dates. Flags ambiguous values (03/04/2026: March 4 or 3 April? 45000: Excel date or Unix seconds?) with alternatives. Use for cleaning CSV, log and spreadsheet data.",
    run: timestamp,
    example: { values: [1762500000, "03/04/2026 14:30", 45000, "Tue, 10 Nov 2026 14:30:00 GMT"], timezone: "Asia/Manila" },
  },
  {
    name: "dst_check",
    path: "/v1/dst",
    title: "DST transitions and local-time check",
    description:
      "Daylight saving time for a time zone: does it observe DST, the year's exact clock changes (UTC instant, local before/after), and whether a local time is valid, skipped (spring-forward gap, e.g. 02:30) or repeated (fall-back, happens twice). Use before scheduling jobs, alarms or meetings near clock changes.",
    run: dst,
    example: { timezone: "America/New_York", datetime: "2026-03-08T02:30" },
  },
  {
    name: "sla_countdown",
    path: "/v1/sla",
    title: "SLA countdown (business hours)",
    description:
      "Live SLA clock for a support ticket: business minutes elapsed and remaining, breached or not, and the deadline. The clock pauses outside working hours, on weekends and holidays, and during manual pauses (e.g. waiting on customer). Custom hours, workdays, country holidays, DST-aware. Use for support-agent SLA tracking and escalation.",
    run: slaCountdown,
    example: { start: "2026-11-06T16:00", now: "2026-11-09T10:30", sla_hours: 4, timezone: "Asia/Manila", country: "PH", pauses: [{ start: "2026-11-09T01:00:00Z", end: "2026-11-09T01:30:00Z" }] },
  },
  {
    name: "find_free_slots",
    path: "/v1/free_slots",
    title: "Find free meeting slots",
    description:
      "Find meeting times when everyone is free: intersects each participant's working hours (own time zone, workdays, country holidays) minus their busy blocks, then lists slots of the requested length. Up to 10 people, 14 days, optional buffer between meetings. Use for scheduling across calendars and time zones.",
    run: freeSlots,
    example: {
      participants: [
        { timezone: "Asia/Manila", busy: [{ start: "2026-11-10T01:00:00Z", end: "2026-11-10T02:00:00Z" }] },
        { timezone: "Europe/London", work_start: "08:00", work_end: "16:00" },
      ],
      from: "2026-11-10",
      days: 2,
      duration_minutes: 30,
      max_slots: 3,
    },
  },
  {
    name: "subscription_dates",
    path: "/v1/subscription",
    title: "Subscription renewal and proration",
    description:
      "Subscription and contract date math: current billing period, next renewal, upcoming renewals, cancel-by date for a notice period, free-trial start, and day-based proration of a price. Month-end anchors stay at month end (Jan 31, Feb 28, Mar 31). Use for SaaS billing, renewals, cancellation deadlines and refunds.",
    run: subscriptionDates,
    example: { start: "2026-01-31", interval: "month", as_of: "2026-03-10", notice_days: 7, amount: 30 },
  },
  {
    name: "market_calendar",
    path: "/v1/market",
    title: "Stock market hours and holidays",
    description:
      "Stock exchange calendar for NYSE/Nasdaq, London (LSE) and Tokyo (JPX): is the market open now, today's session (early closes, lunch break), next open and close, holidays, previous/next trading day, and the trade settlement date (T+1/T+2). Use for trading agents, order timing and settlement.",
    run: marketCalendar,
    example: { exchange: "NYSE", date: "2026-11-27", at: "2026-11-27T17:00:00Z" },
  },
);

/** Free tools: no payment and no free-tier quota, over MCP (listed with the paid tools) and HTTP GET. */
export interface FreeTool {
  name: string;
  path: string; // HTTP route (GET)
  title: string;
  description: string;
  run: (body: Record<string, unknown>) => unknown;
  example: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

const zonedViewSchema = {
  type: "object",
  required: ["timezone", "datetime", "date", "time", "weekday", "utc_offset"],
  properties: { timezone: { type: "string" }, datetime: { type: "string" }, date: { type: "string" }, time: { type: "string" }, weekday: { type: "string" }, utc_offset: { type: "string" } },
};

export const FREE_TOOLS: FreeTool[] = [
  {
    name: "current_time",
    path: "/v1/now",
    title: "Current date and time (free)",
    description:
      "Free: the current date, time, weekday and UTC offset in up to 10 time zones, plus UTC and Unix time. Use when today's date or the current time is needed. Does not use the daily free calls.",
    run: currentTime,
    example: { timezones: ["Asia/Manila", "America/New_York"] },
    inputSchema: {
      type: "object",
      properties: {
        timezone: { type: "string", description: "IANA time zone, e.g. Asia/Manila" },
        timezones: { type: "array", items: { type: "string" }, maxItems: 10, description: "Up to 10 IANA time zones (default UTC)" },
      },
    },
    outputSchema: {
      type: "object",
      required: ["utc", "unix_seconds", "unix_ms", "times"],
      properties: { utc: { type: "string" }, unix_seconds: { type: "integer" }, unix_ms: { type: "integer" }, times: { type: "array", items: zonedViewSchema } },
    },
  },
];

export const PAID_PATHS = TOOLS.map((t) => t.path);

/** Top-level arguments that are always numbers in every tool. Clients sometimes send them as text ("5"). */
const NUMERIC_KEYS = new Set([
  "years", "months", "weeks", "days", "hours", "minutes", "seconds", "business_days", "count", "year", "list_year",
  "max_days", "window_days", "interval_count", "notice_days", "trial_days", "amount",
  "duration_minutes", "step_minutes", "buffer_minutes", "max_slots", "sla_hours", "sla_minutes",
]);
const NUMBER_TEXT = /^\s*-?\d+(\.\d+)?\s*$/;

/** Top-level arguments where an empty list means something (no trips yet = 0 days used). */
const EMPTY_LIST_MEANINGFUL = new Set(["trips"]);

/**
 * Form-based MCP clients (e.g. Glama's inspector) send untouched optional fields as "", null or [], and some
 * clients send numbers as text. Treat blanks as "not given" and numeric text as numbers, so neither turns a
 * valid call into an error.
 */
export function cleanArgs(body: Record<string, unknown>): Record<string, unknown> {
  if (!body || typeof body !== "object") return body;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (v === null || v === "" || (Array.isArray(v) && v.length === 0 && !EMPTY_LIST_MEANINGFUL.has(k))) continue;
    out[k] = typeof v === "string" && NUMERIC_KEYS.has(k) && NUMBER_TEXT.test(v) ? Number(v) : v;
  }
  return out;
}

// Every caller (HTTP, MCP paid and free, warm-up) goes through t.run, so clean arguments here once.
for (const t of [...TOOLS, ...FREE_TOOLS]) {
  const run = t.run;
  t.run = (body) => run(cleanArgs(body));
}
