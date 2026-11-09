// Questions and answers shown on each tool page (/tools/<name>) and published as FAQPage structured data.
// Written the way people ask search engines and AI assistants. Every answer that quotes a computed value has a
// `check`: test/faq.test.ts runs the tool with those arguments and asserts the value, so answers cannot drift.
export interface FaqCheck {
  args: Record<string, unknown>;
  path: string; // dotted path into the result, e.g. "pay_dates.0.pay_date"
  equals: unknown;
}
export interface Faq {
  q: string;
  a: string;
  check?: FaqCheck;
}

export const FAQS: Record<string, Faq[]> = {
  date_diff: [
    {
      q: "How do I count business days between two dates, excluding public holidays?",
      a: 'Send from, to and a country code. The result includes business_days: weekdays in the range minus that country\'s public holidays. For example, from 2026-12-01 to 2027-01-01 with country GB gives 21 business days, because Christmas Day and the Boxing Day substitute holiday are skipped.',
      check: { args: { from: "2026-12-01", to: "2027-01-01", country: "GB" }, path: "business_days", equals: 21 },
    },
    {
      q: "Is the end date included in the count?",
      a: "Business days count the range [from, to): the start date is included and the end date is not, the same convention as most spreadsheet and programming functions. Calendar totals (days, weeks) are the plain difference between the two dates.",
    },
    {
      q: "Can it handle workweeks other than Monday to Friday?",
      a: "Yes. Pass workdays to use a different workweek, for example Sunday to Thursday as used in parts of the Middle East, or Monday to Saturday. Holidays from the chosen country are still excluded.",
    },
  ],
  date_add: [
    {
      q: "How do I add business days to a date, skipping weekends and holidays?",
      a: "Send a date, business_days and an optional country. Weekends and that country's public holidays are skipped. For example, 3 business days after 2026-12-23 in the UK is 2026-12-30, because Christmas Day, the weekend and the Boxing Day substitute holiday are skipped.",
      check: { args: { date: "2026-12-23", business_days: 3, country: "GB" }, path: "result", equals: "2026-12-30" },
    },
    {
      q: "What happens when I add one month to January 31?",
      a: "The result is clamped to the last day of the shorter month: January 31 plus one month is February 28 (or February 29 in a leap year), never March 3.",
    },
    {
      q: "Can I subtract days or add hours and minutes?",
      a: "Yes. Use negative numbers to go backwards, including business days: 3 business days before 2026-12-30 in the UK is 2026-12-23. Years, months, weeks and days work on a date; hours, minutes and seconds need a datetime such as 2026-11-07T09:00:00Z.",
      check: { args: { date: "2026-12-30", business_days: -3, country: "GB" }, path: "result", equals: "2026-12-23" },
    },
  ],
  timezone_convert: [
    {
      q: "How do I convert a time between time zones, including daylight saving time?",
      a: "Send a local datetime with from_timezone and to_timezone as IANA names (Europe/London, America/New_York, Asia/Tokyo). The offsets for that exact date are applied, so daylight saving is handled automatically.",
    },
    {
      q: "Why is the time difference between London and New York sometimes 4 hours instead of 5?",
      a: "The US and the UK change their clocks on different dates. In 2026 the US moves forward on March 8 and the UK on March 29, so for three weeks the gap is 4 hours. For example, 15:00 in London on 2026-03-20 is 11:00 in New York.",
      check: { args: { datetime: "2026-03-20T15:00:00", from_timezone: "Europe/London", to_timezone: "America/New_York" }, path: "to.time", equals: "11:00:00" },
    },
    {
      q: "Does it return the UTC time and offset too?",
      a: "Yes. Every result includes the UTC instant, Unix seconds, and the UTC offset and weekday on both sides of the conversion.",
    },
  ],
  date_info: [
    {
      q: "What ISO week number is a date in?",
      a: "Send the date and read iso_week and iso_year. Around New Year the ISO year can differ from the calendar year: 2027-01-01 is in ISO week 53 of 2026.",
      check: { args: { date: "2027-01-01" }, path: "iso_week", equals: 53 },
    },
    {
      q: "How do I find the day of the week for any date?",
      a: "The result includes weekday (for example Friday), weekday_number (Monday = 1 to Sunday = 7) and whether the date falls on a weekend.",
    },
    {
      q: "What else does it return?",
      a: "Quarter, day of the year, days left in the year, days in the month, whether the year is a leap year, and the Unix timestamp for the start of the day.",
    },
  ],
  public_holidays: [
    {
      q: "Which countries and years are covered?",
      a: "Public holidays for 207 countries, for every year from 2000 to 2050, by ISO country code (US, GB, DE, JP, BR, IN and so on).",
    },
    {
      q: "Are substitute holidays included when a holiday falls on a weekend?",
      a: "Yes, and they are marked substitute: true. For example, in the UK in 2027 Christmas Day and Boxing Day fall on a weekend, so December 27 and 28 are listed as substitute days.",
      check: { args: { country: "GB", year: 2027 }, path: "holidays.7.date", equals: "2027-12-27" },
    },
    {
      q: "How accurate are holidays based on the moon or announced by governments?",
      a: "Holidays with fixed rules (Easter, fixed dates, nth weekday) are exact. Lunar dates and holidays that a government declares each year are rule-based estimates and can differ by a day from the official announcement, so confirm those against the official source.",
    },
  ],
  working_hours_overlap: [
    {
      q: "When do working hours in New York and London overlap?",
      a: "With both offices working 09:00 to 17:00, the overlap is 3 hours: 09:00 to 12:00 in New York, which is 14:00 to 17:00 in London (outside the weeks when only one country is on daylight saving time).",
      check: { args: { timezones: ["America/New_York", "Europe/London"], date: "2026-11-10" }, path: "total_overlap_minutes", equals: 180 },
    },
    {
      q: "Can each person have different working hours?",
      a: "Yes. Give each participant their own time zone and working hours. Weekends are skipped by default, and you can check up to 14 days at once.",
    },
    {
      q: "What if there is no overlap at all?",
      a: "The result returns an empty list of windows and zero overlap minutes, so an agent can suggest async work or a meeting outside someone's normal hours instead of guessing.",
    },
  ],
  cron_schedule: [
    {
      q: "What does a cron expression mean in plain English?",
      a: 'Send the expression and you get a description plus the next run times. For example, "0 9 1 * *" means "At 09:00, on day 1 of the month".',
      check: { args: { expression: "0 9 1 * *", timezone: "Europe/Berlin", count: 1, from: "2026-11-09T00:00:00Z" }, path: "description", equals: "At 09:00, on day 1 of the month" },
    },
    {
      q: "Can I see the next run times in my own time zone?",
      a: "Yes. Pass a time zone and each next run is listed in UTC and local time, including across daylight saving changes.",
    },
    {
      q: "Can cron skip public holidays?",
      a: "Standard cron has no idea of holidays, so this tool lists the runs exactly as cron would. To check whether a run date is a working day, combine it with the business-day tool.",
    },
  ],
  parse_date_text: [
    {
      q: 'How do I turn text like "next Friday at 3pm" into an exact date and time?',
      a: "Send the text with a time zone and a reference time (usually now). The result gives the matched phrase and the exact date and time in UTC and local time.",
    },
    {
      q: 'What does "in 2 weeks" resolve to?',
      a: "It is counted from the reference time. With a reference of 2026-11-09 10:00 in Paris, \"in 2 weeks\" is 2026-11-23 at 10:00 local time.",
      check: { args: { text: "in 2 weeks", timezone: "Europe/Paris", reference: "2026-11-09T10:00:00+01:00" }, path: "results.0.start.date", equals: "2026-11-23" },
    },
    {
      q: "Does it handle date ranges?",
      a: 'Yes. Text like "Dec 25 to Jan 2" returns a start and an end, and the result shows which parts were stated and which were inferred.',
    },
  ],
  city_time: [
    {
      q: "What time zone is a city in?",
      a: "Send up to 10 city names. Each result gives the IANA time zone, the current local time and UTC offset. For example, São Paulo is America/Sao_Paulo.",
      check: { args: { cities: ["São Paulo"] }, path: "results.0.best.timezone", equals: "America/Sao_Paulo" },
    },
    {
      q: "What about cities with the same name in different places?",
      a: "The most populous match is returned first, with alternatives listed. Springfield, for example, returns Springfield, Massachusetts and other Springfields in different US time zones. Add a country to narrow it down.",
    },
    {
      q: "How many cities are covered?",
      a: "More than 7,000 cities worldwide, with accented and unaccented spellings both accepted.",
    },
  ],
  recurring_dates: [
    {
      q: 'How do I list the dates for "the last Friday of every month"?',
      a: "Use the RRULE FREQ=MONTHLY;BYDAY=-1FR with a start date and time zone. Starting January 2026, the first three dates are January 30, February 27 and March 27.",
      check: { args: { rrule: "FREQ=MONTHLY;BYDAY=-1FR", start: "2026-01-01T10:00", timezone: "Europe/London", count: 3 }, path: "occurrences.1.date", equals: "2026-02-27" },
    },
    {
      q: "Does a recurring meeting keep its local time across daylight saving changes?",
      a: "Yes. Occurrences are expanded in the given time zone, so a 10:00 meeting stays at 10:00 local time and its UTC time shifts when the clocks change.",
    },
    {
      q: "Can I skip specific dates?",
      a: "Yes. Pass excluded dates and they are removed from the list, for example a meeting cancelled for a holiday.",
    },
  ],
  business_hours_deadline: [
    {
      q: "How do I calculate a deadline in business hours?",
      a: "Send a start time, the number of business hours, working hours and a time zone. A 4-hour target on a ticket opened Friday 16:00 in London (working hours 09:00 to 17:00) is due Monday 12:00.",
      check: { args: { start: "2026-11-13T16:00", hours: 4, timezone: "Europe/London", work_start: "09:00", work_end: "17:00", country: "GB" }, path: "deadline", equals: "2026-11-16T12:00:00+00:00" },
    },
    {
      q: "Are public holidays excluded?",
      a: "Yes, when you pass a country. You can also add your own holiday dates and custom workdays.",
    },
    {
      q: "Can it measure business time already elapsed?",
      a: "Yes. Send a start and an end instead of a number of hours, and it returns the business time between them.",
    },
  ],
  business_day: [
    {
      q: "Is a given date a business day, and if not, why?",
      a: "Send the date and a country. You get is_business_day, the reason (weekend or the holiday's name), and the next and previous business day. For example, 2026-12-28 in the UK is not a business day: it is the Boxing Day substitute holiday.",
      check: { args: { date: "2026-12-28", country: "GB" }, path: "holiday", equals: "Boxing Day (substitute day)" },
    },
    {
      q: "How many business days are in a month?",
      a: "Every result includes the month's business-day count and its first and last business day, which is useful for month-end processes.",
    },
    {
      q: "Can I use my company's own holidays?",
      a: "Yes. Add custom holiday dates on top of or instead of the country's public holidays, and set a custom workweek.",
    },
  ],
  pay_dates: [
    {
      q: "What happens when payday falls on a weekend or holiday?",
      a: "It is moved to the previous, next or nearest business day, as you choose. With monthly pay on the last day of the month, January 31, 2027 is a Sunday, so payday moves to Friday January 29.",
      check: { args: { schedule: "monthly", from: "2027-01-01", count: 1, country: "US" }, path: "pay_dates.0.pay_date", equals: "2027-01-29" },
    },
    {
      q: "Which pay schedules are supported?",
      a: "Monthly, semi-monthly (for example the 15th and the last day), biweekly and weekly.",
    },
    {
      q: "Can it be used for invoices and billing too?",
      a: "Yes. Any recurring due date that must land on a business day works the same way.",
    },
  ],
  stay_calculator: [
    {
      q: "How does the Schengen 90/180 rule work?",
      a: "You can stay up to 90 days in any rolling 180-day period, counting both entry and exit days. After a stay from June 1 to July 15, 2026 (45 days), on September 1 you have 45 days left.",
      check: { args: { trips: [{ entry: "2026-06-01", exit: "2026-07-15" }], date: "2026-09-01" }, path: "days_remaining", equals: 45 },
    },
    {
      q: "When can I come back for a full 90-day stay?",
      a: "The result includes next_full_stay_date. For the example above, a full 90-day stay is possible again from 2026-10-14.",
      check: { args: { trips: [{ entry: "2026-06-01", exit: "2026-07-15" }], date: "2026-09-01" }, path: "next_full_stay_date", equals: "2026-10-14" },
    },
    {
      q: "Can it check other stay limits?",
      a: "Yes. Set max_days and window_days for any rolling limit. The result is a planning aid; border officials and the official EU calculator have the final say.",
    },
  ],
  timestamp_normalize: [
    {
      q: "How do I convert a Unix timestamp to a date?",
      a: "Send it in values. Seconds, milliseconds, microseconds and nanoseconds are detected automatically: 1700000000 is 2023-11-14T22:13:20Z.",
      check: { args: { values: [1700000000], timezone: "UTC" }, path: "results.0.utc", equals: "2023-11-14T22:13:20Z" },
    },
    {
      q: "Is 03/04/2026 March 4 or April 3?",
      a: "It is ambiguous, so the result is flagged ambiguous: true and both readings are returned, instead of silently guessing.",
      check: { args: { values: ["03/04/2026"], timezone: "UTC" }, path: "results.0.ambiguous", equals: true },
    },
    {
      q: "Which formats are recognised?",
      a: "Unix time in any unit, Excel serial dates, Windows FILETIME, ISO 8601, RFC 2822 email dates, YYYY/MM/DD and dates with month names, up to 100 values per call.",
    },
  ],
  dst_check: [
    {
      q: "When do the clocks change this year?",
      a: "Send a time zone and year to get each transition with the exact UTC instant and local time before and after. In 2026 the UK moves forward on March 29 and back on October 25.",
      check: { args: { timezone: "Europe/London", year: 2026 }, path: "transitions.1.at_utc", equals: "2026-10-25T01:00:00Z" },
    },
    {
      q: "Does 2:30 AM exist on the day the clocks go forward?",
      a: "No. In New York on 2026-03-08 the clocks jump from 02:00 to 03:00, so 02:30 is reported as skipped, with the nearest valid time. Times in the repeated hour in autumn are reported as happening twice.",
      check: { args: { timezone: "America/New_York", datetime: "2026-03-08T02:30" }, path: "check.status", equals: "skipped" },
    },
    {
      q: "Why does this matter for scheduled jobs?",
      a: "A job set for a skipped time may not run at all, and one in the repeated hour may run twice. Checking first avoids both.",
    },
  ],
  sla_countdown: [
    {
      q: "How do I track an SLA that only counts working hours?",
      a: "Send the ticket start, the current time, the SLA length and working hours. A 4-hour SLA opened Friday 16:00 in London has used 2 business hours by Monday 10:00, with 2 hours left.",
      check: { args: { start: "2026-11-13T16:00", now: "2026-11-16T10:00", sla_hours: 4, timezone: "Europe/London" }, path: "remaining_business_minutes", equals: 120 },
    },
    {
      q: "Can the clock pause while waiting on the customer?",
      a: "Yes. Pass pause intervals and they are excluded, along with nights, weekends and the country's holidays.",
    },
    {
      q: "Does it say when the SLA is breached?",
      a: "Yes. The result includes breached, by how many business minutes, the percent used and the exact deadline.",
    },
  ],
  find_free_slots: [
    {
      q: "How do I find a meeting time when everyone is free?",
      a: "Give each participant their time zone, working hours and busy blocks. The tool intersects everyone's free time and lists slots of the length you need.",
    },
    {
      q: "Does it respect each person's public holidays?",
      a: "Yes. Give a participant a country and their public holidays are treated as busy.",
    },
    {
      q: "How many people and days can it handle?",
      a: "Up to 10 participants over up to 14 days, with an optional buffer between meetings.",
    },
  ],
  subscription_dates: [
    {
      q: "If a subscription starts on January 31, when does it renew?",
      a: "Renewals stay anchored to the month end: February 28, then March 31, then April 30. They never drift to the 28th for the rest of the year.",
      check: { args: { start: "2026-01-31", interval: "month", as_of: "2026-02-10", count: 3 }, path: "upcoming_renewals.1", equals: "2026-03-31" },
    },
    {
      q: "How do I find the last day to cancel before renewal?",
      a: "Pass notice_days and the result includes cancel_by, the last date a cancellation still counts for the current period.",
    },
    {
      q: "Can it prorate a price?",
      a: "Yes. Pass an amount and it returns the day-based proration for the current period, useful for upgrades, downgrades and refunds.",
    },
  ],
  market_calendar: [
    {
      q: "Is the stock market open the day after Thanksgiving?",
      a: "Yes, but it closes early. On 2026-11-27 NYSE and Nasdaq trade from 09:30 to 13:00 Eastern time. The result marks it as a trading day with early_close set, not as a holiday.",
      check: { args: { exchange: "NYSE", date: "2026-11-27" }, path: "early_close", equals: "Day after Thanksgiving" },
    },
    {
      q: "Does the Tokyo Stock Exchange have a lunch break?",
      a: "Yes. The session runs 09:00 to 15:30 Tokyo time with a break from 11:30 to 12:30, and the result includes the break.",
      check: { args: { exchange: "TSE", date: "2026-11-10" }, path: "session.break.start", equals: "2026-11-10T11:30:00+09:00" },
    },
    {
      q: "What is the settlement date for a trade?",
      a: "It is returned for each date: T+1 for US equities and T+2 for London and Tokyo. A trade on the London Stock Exchange on 2026-12-24 settles on 2026-12-30, after the Christmas holidays.",
      check: { args: { exchange: "LSE", date: "2026-12-24" }, path: "settlement.settlement_date", equals: "2026-12-30" },
    },
  ],
};
