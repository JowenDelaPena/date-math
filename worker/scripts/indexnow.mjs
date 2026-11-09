// Tells IndexNow search engines (Bing, Yandex, Seznam, Naver...) that our pages changed, so they recrawl
// soon instead of whenever they next pass by. Run after a deploy that changes pages:
//   cd worker; node scripts/indexnow.mjs
// Submits every URL in the live sitemap. Free, no account. The key is public by design (served at /<key>.txt).
const ORIGIN = process.env.API_URL ?? "https://date-math.datemath.workers.dev";
const KEY = "c85e783d609e7cc2e582e722ed10b4bd"; // must match INDEXNOW_KEY in src/app.ts

const headers = { "X-Date-Math-Internal": "1" };
const keyRes = await fetch(`${ORIGIN}/${KEY}.txt`, { headers });
if (!keyRes.ok || (await keyRes.text()).trim() !== KEY) {
  console.error(`Key file ${ORIGIN}/${KEY}.txt is not live yet. Deploy first.`);
  process.exit(1);
}
const xml = await (await fetch(`${ORIGIN}/sitemap.xml`, { headers })).text();
const urlList = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

const res = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify({ host: new URL(ORIGIN).host, key: KEY, keyLocation: `${ORIGIN}/${KEY}.txt`, urlList }),
});
// 200 = accepted, 202 = accepted (key check pending). Anything else is an error.
console.log(`IndexNow: HTTP ${res.status} for ${urlList.length} URLs`);
if (res.status !== 200 && res.status !== 202) {
  console.error(await res.text());
  process.exit(1);
}
