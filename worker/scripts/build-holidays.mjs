// Precomputes public holidays (country level) so the Worker never runs the slow rule engine at request time.
// Output: src/holidays-data.json = { years: [from, to], countries: { CC: { name, days: { "YYYY": [[ "MM-DD", nameIndex, substitute? ], ...] } } }, names: [...] }
// Run: node scripts/build-holidays.mjs   (re-run yearly or when bumping date-holidays)
import Holidays from "date-holidays";
import { writeFileSync } from "node:fs";

const FROM = 2000, TO = 2050;
const hd = new Holidays();
const names = [], nameIdx = new Map();
const idx = (n) => { if (!nameIdx.has(n)) { nameIdx.set(n, names.length); names.push(n); } return nameIdx.get(n); };
const countries = {};
for (const [cc, cname] of Object.entries(hd.getCountries())) {
  const h = new Holidays(cc);
  const days = {};
  for (let y = FROM; y <= TO; y++) {
    const seen = new Set();
    const list = [];
    for (const x of h.getHolidays(y) || []) {
      if (x.type !== "public") continue;
      const md = x.date.slice(5, 10);
      if (!x.date.startsWith(String(y))) continue; // multi-day spill into next year is listed there
      const key = md + x.name;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(x.substitute ? [md, idx(x.name), 1] : [md, idx(x.name)]);
    }
    list.sort((a, b) => a[0].localeCompare(b[0]));
    days[y] = list;
  }
  countries[cc] = { name: cname, days };
}
const out = { source: "date-holidays", years: [FROM, TO], names, countries };
writeFileSync(new URL("../src/holidays-data.json", import.meta.url), JSON.stringify(out));
console.log("countries", Object.keys(countries).length, "names", names.length);
