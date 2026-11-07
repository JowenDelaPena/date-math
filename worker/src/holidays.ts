// Public holidays from a precomputed table (scripts/build-holidays.mjs, source: date-holidays).
// O(1) lookups at request time: no rule engine, so it fits the Workers free-tier CPU budget.
import data from "./holidays-data.json";
import { InputError } from "./errors";

type Row = [string, number] | [string, number, number]; // [MM-DD, nameIndex, substitute?]
const DB = data as unknown as { years: [number, number]; names: string[]; countries: Record<string, { name: string; days: Record<string, Row[]> }> };
export const HOLIDAY_YEARS = DB.years;
const MAX_YEARS = 50;

function countryCode(country: unknown): string {
  if (typeof country !== "string" || !/^[A-Za-z]{2}$/.test(country)) {
    throw new InputError("invalid_country", 'country must be an ISO 3166-1 alpha-2 code, e.g. "PH", "US", "GB"');
  }
  const c = country.toUpperCase();
  if (!DB.countries[c]) throw new InputError("unsupported_country", `no holiday data for country "${c}"`);
  return c;
}

function checkYear(year: number) {
  if (year < DB.years[0] || year > DB.years[1]) {
    throw new InputError("year_out_of_range", `holiday data covers ${DB.years[0]}–${DB.years[1]}`);
  }
}

export interface HolidayEntry {
  date: string;
  name: string;
  substitute?: boolean;
}

export function listHolidays(country: unknown, year: number): { code: string; countryName: string; holidays: HolidayEntry[] } {
  const code = countryCode(country);
  checkYear(year);
  const rows = DB.countries[code].days[String(year)] ?? [];
  return {
    code,
    countryName: DB.countries[code].name,
    holidays: rows.map(([md, n, sub]) => ({ date: `${year}-${md}`, name: DB.names[n], ...(sub ? { substitute: true } : {}) })),
  };
}

/** Public-holiday dates (YYYY-MM-DD) for a country across [fromYear, toYear]. */
export function countryHolidayDates(country: unknown, fromYear: number, toYear: number): Set<string> {
  if (toYear - fromYear + 1 > MAX_YEARS) throw new InputError("range_too_large", `country holidays cover at most ${MAX_YEARS} years per request`);
  const code = countryCode(country);
  const set = new Set<string>();
  for (let y = Math.max(fromYear, DB.years[0]); y <= Math.min(toYear, DB.years[1]); y++) {
    for (const [md] of DB.countries[code].days[String(y)] ?? []) set.add(`${y}-${md}`);
  }
  if (fromYear < DB.years[0] || toYear > DB.years[1]) {
    // Partial coverage would silently miscount business days; be explicit instead.
    throw new InputError("year_out_of_range", `country holiday data covers ${DB.years[0]}–${DB.years[1]}`);
  }
  return set;
}
