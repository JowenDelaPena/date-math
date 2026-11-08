// Human landing page for browsers at GET / (agents and scripts still get the JSON index).
// Built once per isolate at startup. No user input is reflected into the HTML; the try-it box renders
// results with textContent, and a strict CSP limits the page to this origin plus Google Fonts.
import { FREE_TOOLS, TOOLS } from "./tools";

/** Brand mark: a 3x3 grid of day cells, one in calendar red ("today"). Used as favicon and in the header. */
const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="2" y="2" width="8" height="8" rx="1" fill="#141414"/><rect x="12" y="2" width="8" height="8" rx="1" fill="#141414"/><rect x="22" y="2" width="8" height="8" rx="1" fill="#141414"/><rect x="2" y="12" width="8" height="8" rx="1" fill="#141414"/><rect x="12" y="12" width="8" height="8" rx="1" fill="#141414"/><rect x="22" y="12" width="8" height="8" rx="1" fill="#141414"/><rect x="2" y="22" width="8" height="8" rx="1" fill="#141414"/><rect x="12" y="22" width="8" height="8" rx="1" fill="#141414"/><rect x="22" y="22" width="8" height="8" rx="1" fill="#c8372d"/></svg>';
export const ICON_DATA_URI = "data:image/svg+xml," + encodeURIComponent(ICON_SVG);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One-line summaries for the tool list (the MCP descriptions are written for agents and are longer). */
const SHORT: Record<string, string> = {
  date_diff: "Days, weeks, months and business days between two dates",
  date_add: "Add days, months or business days, skipping a country's holidays",
  date_info: "Weekday, ISO week, quarter, day of year, leap year",
  business_day: "Is it a business day? If not, why, and the next one",
  public_holidays: "Public holidays for 207 countries, 2000–2050",
  pay_dates: "Payroll and billing dates moved off weekends and holidays",
  business_hours_deadline: "Deadline N working hours from now, or hours elapsed",
  sla_countdown: "Live SLA clock that pauses outside working hours",
  timezone_convert: "Convert a time between zones, DST-aware",
  city_time: "City name to time zone and local time (7,000+ cities)",
  working_hours_overlap: "When working hours overlap across time zones",
  find_free_slots: "Meeting slots when everyone is free",
  dst_check: "Clock changes, and skipped or repeated local times",
  cron_schedule: "Explain a cron expression and list its next runs",
  recurring_dates: "Expand an RRULE like “every 2nd Tuesday”",
  parse_date_text: "“Next Friday at 3pm” to an exact datetime",
  timestamp_normalize: "Unix, Excel and messy date strings to UTC",
  stay_calculator: "Schengen 90/180 days used, left and next full stay",
  subscription_dates: "Renewals, cancel-by dates and proration",
  market_calendar: "NYSE, London and Tokyo hours, holidays, settlement",
};

const GROUPS: [string, string[]][] = [
  ["Calendar", ["date_diff", "date_add", "date_info", "parse_date_text"]],
  ["Business days", ["business_day", "public_holidays", "pay_dates", "business_hours_deadline", "sla_countdown"]],
  ["Time zones", ["timezone_convert", "city_time", "working_hours_overlap", "find_free_slots", "dst_check"]],
  ["Schedules", ["cron_schedule", "recurring_dates", "timestamp_normalize"]],
  ["Domain", ["stay_calculator", "subscription_dates", "market_calendar"]],
];

const PRESETS: [string, string][] = [
  ["date_add", "Add 5 business days"],
  ["market_calendar", "Is the market open?"],
  ["parse_date_text", "Parse “next friday”"],
  ["sla_countdown", "SLA countdown"],
  ["stay_calculator", "Schengen 90/180"],
  ["dst_check", "DST gap check"],
];

export function landingHtml(origin: string, version: string): string {
  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  const presets = PRESETS.map(([name, label]) => ({ name, label, args: byName.get(name)!.example }));
  const listed = new Set(GROUPS.flatMap(([, n]) => n));
  const extra = TOOLS.filter((t) => !listed.has(t.name)).map((t) => t.name);
  const groups = extra.length ? [...GROUPS, ["More", extra] as [string, string[]]] : GROUPS;
  const mcp = `${origin}/mcp`;
  const toolRows = groups
    .map(
      ([title, names]) => `
      <div class="group">
        <h3>${esc(title)}</h3>
        <ul>${names
          .filter((n) => byName.has(n))
          .map((n) => `<li><code>${esc(n)}</code><span>${esc(SHORT[n] ?? byName.get(n)!.title)}</span></li>`)
          .join("")}</ul>
      </div>`,
    )
    .join("");
  const free = FREE_TOOLS.map((f) => `<code>${esc(f.name)}</code>`).join(", ");
  const json = JSON.stringify({ mcpServers: { "date-math": { url: mcp } } }, null, 2);
  const presetJson = JSON.stringify(presets).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Date Math</title>
<meta name="description" content="Exact date and time math for AI agents: business days, holidays, time zones, SLAs, cron and more. 20 deterministic tools over MCP and HTTP. 25 free calls a day.">
<link rel="icon" type="image/svg+xml" href="${ICON_DATA_URI}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500&family=Newsreader:opsz,wght@6..72,400;6..72,500&display=swap" rel="stylesheet">
<style>
  :root {
    --ink: #141414; --muted: #6a6a6a; --faint: #9a9a9a; --rule: #e7e5e1; --soft: #f7f6f3; --red: #c8372d;
    --serif: "Newsreader", Georgia, serif; --sans: "IBM Plex Sans", system-ui, sans-serif; --mono: "IBM Plex Mono", ui-monospace, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  html { background: #fff; }
  body { margin: 0; background: #fff; color: var(--ink); font: 16px/1.6 var(--sans); -webkit-font-smoothing: antialiased; }
  a { color: inherit; text-decoration-color: var(--rule); text-underline-offset: 3px; }
  a:hover { text-decoration-color: var(--ink); }
  code, pre, .mono { font-family: var(--mono); font-size: 13.5px; }
  .wrap { max-width: 980px; margin: 0 auto; padding: 0 24px; }
  header { border-bottom: 1px solid var(--rule); }
  header .wrap { display: flex; align-items: center; justify-content: space-between; height: 64px; }
  .mark { font: 500 21px var(--serif); letter-spacing: -0.01em; text-decoration: none; display: flex; align-items: baseline; gap: 10px; }
  .mark img { align-self: center; }
  .mark small { font: 12px var(--mono); color: var(--faint); }
  nav { display: flex; gap: 22px; font-size: 14px; color: var(--muted); }
  nav a { text-decoration: none; }
  nav a:hover { color: var(--ink); }
  .hero { padding: 88px 0 56px; }
  .eyebrow { font: 12px var(--mono); color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }
  h1 { font: 400 clamp(40px, 6vw, 64px)/1.04 var(--serif); letter-spacing: -0.02em; margin: 18px 0 22px; max-width: 14ch; }
  .lede { font-size: 19px; color: #333; max-width: 58ch; margin: 0; }
  .facts { display: flex; flex-wrap: wrap; gap: 8px 28px; margin-top: 28px; font: 13px var(--mono); color: var(--muted); }
  .facts b { color: var(--ink); font-weight: 500; }
  .strip { margin-top: 56px; border-top: 1px solid var(--ink); border-bottom: 1px solid var(--rule); display: grid; grid-template-columns: repeat(3, 1fr); }
  .strip div { padding: 16px 18px 18px 0; }
  .strip div + div { padding-left: 18px; border-left: 1px solid var(--rule); }
  .strip span { display: block; font: 11px var(--mono); color: var(--faint); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 6px; }
  .strip strong { font: 400 22px var(--serif); }
  .strip .out strong { color: var(--red); }
  section { padding: 72px 0; border-top: 1px solid var(--rule); }
  h2 { font: 400 32px/1.15 var(--serif); letter-spacing: -0.01em; margin: 0 0 8px; }
  .sub { color: var(--muted); margin: 0 0 32px; max-width: 60ch; }
  .tabs { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; }
  .tabs button { font: 13px var(--sans); background: #fff; border: 1px solid var(--rule); color: var(--muted); padding: 7px 12px; cursor: pointer; border-radius: 2px; }
  .tabs button:hover { color: var(--ink); border-color: #cfccc6; }
  .tabs button[aria-pressed="true"] { color: var(--ink); border-color: var(--ink); }
  .console { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid var(--rule); }
  .pane { min-width: 0; }
  .pane + .pane { border-left: 1px solid var(--rule); }
  .pane-head { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--rule); font: 12px var(--mono); color: var(--muted); }
  textarea, pre.out { display: block; width: 100%; margin: 0; border: 0; padding: 14px; height: 300px; resize: vertical; background: #fff; color: var(--ink); font: 13px/1.55 var(--mono); outline: none; overflow: auto; white-space: pre; }
  pre.out { background: var(--soft); }
  .run { font: 500 13px var(--sans); background: var(--ink); color: #fff; border: 0; padding: 7px 14px; cursor: pointer; border-radius: 2px; }
  .run:disabled { opacity: 0.5; cursor: default; }
  .note { font: 12px var(--mono); color: var(--faint); margin-top: 10px; }
  .connect { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0; border: 1px solid var(--rule); }
  .connect > div { padding: 20px; min-width: 0; }
  .connect > div + div { border-left: 1px solid var(--rule); }
  .connect h3, .group h3 { font: 500 13px var(--sans); margin: 0 0 4px; }
  .connect p { color: var(--muted); font-size: 14px; margin: 0 0 14px; }
  .snip { position: relative; background: var(--soft); border: 1px solid var(--rule); }
  .snip pre { margin: 0; padding: 12px 14px; overflow-x: auto; font-size: 12.5px; line-height: 1.55; }
  .copy { position: absolute; top: 6px; right: 6px; font: 11px var(--mono); background: #fff; border: 1px solid var(--rule); color: var(--muted); padding: 2px 7px; cursor: pointer; }
  .copy:hover { color: var(--ink); }
  .tools { display: grid; grid-template-columns: repeat(2, 1fr); gap: 36px 48px; }
  .group h3 { color: var(--muted); font: 12px var(--mono); text-transform: uppercase; letter-spacing: 0.08em; padding-bottom: 8px; border-bottom: 1px solid var(--ink); margin-bottom: 4px; }
  .group ul { list-style: none; margin: 0; padding: 0; }
  .group li { display: grid; grid-template-columns: 200px 1fr; gap: 16px; padding: 10px 0; border-bottom: 1px solid var(--rule); font-size: 14px; }
  .group li span { color: #444; }
  .pricing { display: grid; grid-template-columns: 1fr 1fr; border-top: 1px solid var(--ink); }
  .pricing > div { padding: 22px 24px 8px 0; }
  .pricing > div + div { padding-left: 24px; border-left: 1px solid var(--rule); }
  .price { font: 400 40px var(--serif); margin: 4px 0 10px; }
  .price small { font: 14px var(--sans); color: var(--muted); }
  .pricing ul { margin: 0; padding-left: 18px; color: #444; font-size: 15px; }
  footer { border-top: 1px solid var(--rule); padding: 32px 0 48px; font-size: 13px; color: var(--muted); }
  footer .wrap { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 16px; }
  footer nav { gap: 18px; flex-wrap: wrap; }
  @media (max-width: 760px) {
    nav.top { display: none; }
    .hero { padding: 56px 0 40px; }
    .strip { grid-template-columns: 1fr; }
    .strip div + div { padding-left: 0; border-left: 0; border-top: 1px solid var(--rule); }
    .console, .connect, .tools, .pricing { grid-template-columns: 1fr; }
    .pane + .pane, .connect > div + div, .pricing > div + div { border-left: 0; border-top: 1px solid var(--rule); }
    .pricing > div + div { padding-left: 0; }
    .group li { grid-template-columns: 1fr; gap: 2px; }
  }
</style>
</head>
<body>
<header>
  <div class="wrap">
    <a class="mark" href="/"><img src="${ICON_DATA_URI}" width="18" height="18" alt="">Date Math <small>v${esc(version)}</small></a>
    <nav class="top"><a href="#try">Try it</a><a href="#connect">Connect</a><a href="#tools">Tools</a><a href="#pricing">Pricing</a><a href="https://www.x402scan.com/server/e4a16a53-40a4-4ca8-aae9-05b0b86b1e52">x402</a><a href="https://github.com/JowenDelaPena/date-math">GitHub</a></nav>
  </div>
</header>

<main>
  <div class="wrap hero">
    <div class="eyebrow">MCP server &middot; HTTP API &middot; <a href="https://www.x402scan.com/server/e4a16a53-40a4-4ca8-aae9-05b0b86b1e52">x402</a></div>
    <h1>Exact date math for AI&nbsp;agents.</h1>
    <p class="lede">Language models guess at business days, time zones, daylight saving and holidays. Date Math calculates them. ${TOOLS.length} deterministic tools your agent can call instead of doing date math in its head.</p>
    <div class="facts"><span><b>25</b> free calls a day</span><span>then <b>$0.001</b> per call</span><span><b>no</b> signup or API key</span></div>
    <div class="strip" aria-label="Example calculation">
      <div><span>Start</span><strong>Fri 27 Nov 2026</strong></div>
      <div><span>Add</span><strong>3 business days</strong></div>
      <div class="out"><span>Result</span><strong>Wed 2 Dec 2026</strong></div>
    </div>
  </div>

  <section id="try">
    <div class="wrap">
      <h2>Try it</h2>
      <p class="sub">Runs the real tool over MCP. Edit the arguments and run. Uses your daily free calls.</p>
      <div class="tabs" role="group" aria-label="Examples"></div>
      <div class="console">
        <div class="pane">
          <div class="pane-head"><span id="tool-name">arguments</span><button class="run" id="run">Run</button></div>
          <textarea id="args" spellcheck="false" aria-label="Tool arguments (JSON)"></textarea>
        </div>
        <div class="pane">
          <div class="pane-head"><span>result</span><span id="meta"></span></div>
          <pre class="out" id="out" aria-live="polite">Pick an example and press Run.</pre>
        </div>
      </div>
    </div>
  </section>

  <section id="connect">
    <div class="wrap">
      <h2>Connect</h2>
      <p class="sub">Point any MCP client at the endpoint. Agents that pay with x402 can call the HTTP API directly.</p>
      <div class="connect">
        <div>
          <h3>Claude Code</h3>
          <p>One command in your terminal.</p>
          <div class="snip"><button class="copy">copy</button><pre>claude mcp add --transport http date-math ${esc(mcp)}</pre></div>
        </div>
        <div>
          <h3>Any MCP client</h3>
          <p>Claude Desktop, Cursor, VS Code, Windsurf.</p>
          <div class="snip"><button class="copy">copy</button><pre>${esc(json)}</pre></div>
        </div>
        <div>
          <h3>HTTP + x402</h3>
          <p>POST JSON; pay the 402 with any <a href="https://www.x402scan.com/server/e4a16a53-40a4-4ca8-aae9-05b0b86b1e52">x402</a> client.</p>
          <div class="snip"><button class="copy">copy</button><pre>curl -X POST ${esc(origin)}/v1/business_day \\
  -H "Content-Type: application/json" \\
  -d '{"date":"2026-12-25","country":"PH"}'</pre></div>
        </div>
      </div>
      <p class="note">Docs for agents: <a href="/llms.txt">llms.txt</a> &middot; <a href="/openapi.json">OpenAPI</a> &middot; <a href="/.well-known/x402">x402 discovery</a> &middot; <a href="/mcp/server-card">server card</a></p>
    </div>
  </section>

  <section id="tools">
    <div class="wrap">
      <h2>${TOOLS.length} tools, plus one free</h2>
      <p class="sub">Every answer is computed, never generated. ${free} is always free and returns today's date, which models don't know.</p>
      <div class="tools">${toolRows}
      </div>
    </div>
  </section>

  <section id="pricing">
    <div class="wrap">
      <h2>Pricing</h2>
      <p class="sub">Pay per call. No plans, accounts or keys.</p>
      <div class="pricing">
        <div>
          <div class="eyebrow">Free</div>
          <div class="price">25 <small>calls a day</small></div>
          <ul><li>Any tool, over MCP</li><li>Per IP address, resets daily (UTC)</li><li>${free} never counts</li></ul>
        </div>
        <div>
          <div class="eyebrow">Paid</div>
          <div class="price">$0.001 <small>per call</small></div>
          <ul><li>USDC on Base, via <a href="https://www.x402scan.com/server/e4a16a53-40a4-4ca8-aae9-05b0b86b1e52">x402</a></li><li>MCP and HTTP</li><li>Listed in the Coinbase x402 Bazaar</li></ul>
        </div>
      </div>
    </div>
  </section>
</main>

<footer>
  <div class="wrap">
    <span>Date Math &middot; MIT licensed</span>
    <nav><a href="https://github.com/JowenDelaPena/date-math">GitHub</a><a href="https://registry.modelcontextprotocol.io/v0/servers?search=io.github.JowenDelaPena/date-math">MCP Registry</a><a href="https://glama.ai/mcp/servers/JowenDelaPena/date-math">Glama</a><a href="https://www.npmjs.com/package/date-math-mcp">npm</a><a href="/openapi.json">OpenAPI</a><a href="/.well-known/x402">x402 discovery</a><a href="https://www.x402scan.com/server/e4a16a53-40a4-4ca8-aae9-05b0b86b1e52">x402scan</a></nav>
  </div>
</footer>

<script>
(() => {
  const presets = ${presetJson};
  const tabs = document.querySelector(".tabs"), args = document.getElementById("args"), out = document.getElementById("out");
  const meta = document.getElementById("meta"), name = document.getElementById("tool-name"), run = document.getElementById("run");
  let current = presets[0];
  const select = (p) => {
    current = p;
    name.textContent = p.name;
    args.value = JSON.stringify(p.args, null, 2);
    for (const b of tabs.children) b.setAttribute("aria-pressed", String(b.dataset.name === p.name));
  };
  for (const p of presets) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = p.label;
    b.dataset.name = p.name;
    b.addEventListener("click", () => select(p));
    tabs.appendChild(b);
  }
  select(current);
  run.addEventListener("click", async () => {
    let parsed;
    try { parsed = JSON.parse(args.value); } catch { out.textContent = "The arguments are not valid JSON."; return; }
    run.disabled = true; out.textContent = "Running\\u2026"; meta.textContent = "";
    const t0 = performance.now();
    try {
      const res = await fetch("/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: current.name, arguments: parsed } }),
      });
      const msg = await res.json();
      const r = msg.result || {};
      const text = (r.content && r.content[0] && r.content[0].text) || JSON.stringify(msg.error || msg);
      if (r.isError && text.includes("Payment required")) out.textContent = "Today's free calls are used up. Connect an x402 client to keep going at $0.001 per call, or come back tomorrow.";
      else { try { out.textContent = JSON.stringify(JSON.parse(text), null, 2); } catch { out.textContent = text; } }
      const left = r._meta && r._meta["date-math/free_calls_remaining"];
      meta.textContent = Math.round(performance.now() - t0) + " ms" + (left !== undefined ? " \\u00b7 " + left + " free left today" : "");
    } catch { out.textContent = "Network error. Try again."; }
    run.disabled = false;
  });
  for (const btn of document.querySelectorAll(".copy")) {
    btn.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(btn.nextElementSibling.textContent); btn.textContent = "copied"; setTimeout(() => (btn.textContent = "copy"), 1200); } catch {}
    });
  }
})();
</script>
</body>
</html>`;
}

export const LANDING_CSP =
  "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
