// Checks where Date Math can be discovered: the MCP Registry, npm, the x402 Bazaar catalogs, and its own
// discovery files. Read-only; spends nothing.   Usage: node tools/discovery-check.mjs
const API = "https://date-math.datemath.workers.dev";
const NAME = "io.github.JowenDelaPena/date-math";
const NPM = "date-math-mcp";
// Paid routes, read from the live service so this never goes stale.
const ROUTES = (await (await fetch(API + "/.well-known/x402")).json()).resources.length;

const line = (ok, msg) => console.log(`  ${ok ? "ok  " : "WARN"}  ${msg}`);
const json = async (url) => (await fetch(url, { headers: { Accept: "application/json" } })).json();

async function section(title, fn) {
  console.log(`\n${title}`);
  try {
    await fn();
  } catch (e) {
    line(false, `check failed: ${e.message}`);
  }
}

await section("Own discovery files", async () => {
  for (const p of ["/openapi.json", "/llms.txt", "/.well-known/x402", "/mcp/server-card", "/.well-known/ai-catalog.json"]) {
    const r = await fetch(API + p);
    line(r.ok, `${p} -> ${r.status}`);
  }
  const v = await json(API + "/v1/version");
  console.log(`        live version: ${v.version}`);
});

await section("MCP Registry", async () => {
  const j = await json(`https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(NAME)}`);
  const latest = (j.servers ?? []).find((x) => x._meta?.["io.modelcontextprotocol.registry/official"]?.isLatest);
  line(Boolean(latest), latest ? `${NAME} latest = ${latest.server.version}` : "not found");
});

await section("npm", async () => {
  const j = await json(`https://registry.npmjs.org/${NPM}`);
  const latest = j["dist-tags"]?.latest;
  line(Boolean(latest) && latest !== "0.0.0-stage", `${NPM} latest = ${latest}`);
  const s = await json(`https://registry.npmjs.org/-/v1/search?text=${NPM}&size=20`);
  const found = (s.objects ?? []).some((o) => o.package.name === NPM);
  line(found, found ? "appears in npm search" : "not in npm search yet (the search index lags new packages by days)");
});

async function bazaar(name, base) {
  let offset = 0, total = Infinity, seen = 0;
  const ours = new Set();
  while (offset < total) {
    const j = await json(`${base}?limit=1000&offset=${offset}`);
    const items = j.items ?? j.resources ?? [];
    total = j.pagination?.total ?? (items.length < 1000 ? offset + items.length : Infinity);
    for (const x of items) {
      let u;
      try {
        u = new URL(String(x.resource));
      } catch {
        continue;
      }
      if (u.origin === new URL(API).origin) ours.add(u.pathname); // exact origin match, not a string prefix
    }
    seen += items.length;
    offset += 1000;
    if (!items.length) break;
  }
  line(ours.size === ROUTES, `${name}: ${ours.size}/${ROUTES} routes listed (catalog has ${seen} listings)`);
  if (ours.size && ours.size < ROUTES) console.log(`        listed: ${[...ours].sort().join(" ")}`);
}

await section("x402 Bazaar catalogs", async () => {
  await bazaar("Coinbase CDP", "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources");
  await bazaar("PayAI", "https://facilitator.payai.network/discovery/resources");
});

await section("Glama", async () => {
  for (const [label, url] of [
    ["repo listing", "https://glama.ai/mcp/servers/JowenDelaPena/date-math/badges/score.svg"],
    ["hosted connector", `https://glama.ai/mcp/connectors/${NAME}/badges/score.svg`],
  ]) {
    const svg = await (await fetch(url)).text();
    const title = /<title>([^<]*)<\/title>/.exec(svg)?.[1];
    line(Boolean(title), `${label}: ${title ?? "not found"}`);
  }
});

console.log("\nManual checks: Glama search (glama.ai/mcp/servers?query=...), x402scan listing, and open directory PRs (github.com/pulls).");
