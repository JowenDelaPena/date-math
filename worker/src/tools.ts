// Single registry of paid tools. HTTP routes, x402 payments, discovery files and the MCP server all read this.
import { add, convert, diff, info } from "./date";
import { cron, holidays, overlap, parse } from "./more";
import { businessHours, cityTime, recurrence } from "./more2";
import { businessDay, payDates } from "./biz";

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
);

export const PAID_PATHS = TOOLS.map((t) => t.path);
