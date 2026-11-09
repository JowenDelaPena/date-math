// Per-tool search tags for the x402 Bazaars (Coinbase CDP, Agentic.Market).
// Agents find paid tools by searching these phrases, and Agentic.Market keeps only the
// first 5, so each list is exactly 5, most-searched phrase first.
export const SEARCH_TAGS: Record<string, string[]> = {
  date_diff: ["days between dates", "business days between", "date difference", "working days count", "age calculator"],
  date_add: ["add business days", "add days to date", "date calculator", "due date", "working days from now"],
  timezone_convert: ["convert timezone", "timezone conversion", "time zone", "dst aware", "iana timezone"],
  date_info: ["day of week", "iso week number", "quarter of year", "leap year", "calendar date info"],
  public_holidays: ["public holidays", "bank holidays", "holiday calendar", "national holidays", "holidays api"],
  working_hours_overlap: ["meeting time overlap", "working hours overlap", "time zone meeting planner", "best meeting time", "team availability"],
  cron_schedule: ["cron next run", "cron expression", "cron schedule", "explain cron", "cron parser"],
  parse_date_text: ["parse date", "natural language date", "date parser", "relative date", "text to datetime"],
  city_time: ["time in city", "city timezone", "local time", "world clock", "timezone lookup"],
  recurring_dates: ["rrule", "recurring dates", "recurrence rule", "repeating events", "ical rrule"],
  business_hours_deadline: ["business hours deadline", "working hours calculator", "add business hours", "support hours", "office hours"],
  business_day: ["business day", "is business day", "next business day", "business day calculator", "shipping cutoff"],
  pay_dates: ["payroll dates", "pay dates", "payday calendar", "pay schedule", "biweekly payroll"],
  stay_calculator: ["schengen calculator", "90/180 rule", "visa stay", "travel days", "schengen days left"],
  timestamp_normalize: ["timestamp converter", "unix timestamp", "normalize dates", "iso 8601", "epoch converter"],
  dst_check: ["daylight saving time", "dst transition", "dst check", "clock change", "nonexistent local time"],
  sla_countdown: ["sla deadline", "sla countdown", "response time sla", "support ticket sla", "sla breach"],
  find_free_slots: ["free time slots", "meeting scheduler", "calendar availability", "find meeting time", "open slots"],
  subscription_dates: ["subscription billing dates", "renewal date", "billing cycle", "trial end date", "proration"],
  market_calendar: ["market holidays", "stock market hours", "trading calendar", "nyse early close", "settlement date"],
};
