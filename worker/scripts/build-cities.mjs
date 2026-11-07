// Compact city -> IANA time zone table from city-timezones (MIT; data derived from Natural Earth populated places).
// Output: src/cities-data.json = { zones: [...], cities: [[name, iso2, province, zoneIndex, population, "normalized|normalizedAscii"], ...] } sorted by population desc.
// Run: node scripts/build-cities.mjs
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const { cityMapping } = createRequire(import.meta.url)("city-timezones");
const zones = [], zi = new Map();
const z = (t) => { if (!zi.has(t)) { zi.set(t, zones.length); zones.push(t); } return zi.get(t); };
const norm = (x) => x.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const rows = cityMapping
  .filter((c) => c.timezone && c.city)
  .sort((a, b) => (b.pop || 0) - (a.pop || 0))
  .map((c) => { const n1 = norm(c.city), n2 = c.city_ascii ? norm(c.city_ascii) : ""; return [c.city, c.iso2, c.province || "", z(c.timezone), Math.round(c.pop || 0), n2 && n2 !== n1 ? n1 + "|" + n2 : n1]; });
writeFileSync(new URL("../src/cities-data.json", import.meta.url), JSON.stringify({ source: "city-timezones (Natural Earth)", zones, cities: rows }));
console.log("cities", rows.length, "zones", zones.length);
