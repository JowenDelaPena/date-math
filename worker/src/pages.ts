// One HTML page per paid tool at /tools/<slug>, for search engines and people who land from search.
// Built from the tool registry (description, example input) and the generated output examples,
// so pages stay in sync with the API. Built once per isolate and cached.
import { CSS, esc, FOOTER, GROUPS, headLinks, SHORT, siteHeader, toolSlug, tryScript } from "./landing";
import { FAQS } from "./faq";
import outputExamples from "./output-examples.json";
import { TOOLS, type Tool } from "./tools";

/** Page headings, phrased the way people search. */
export const HEADINGS: Record<string, string> = {
  date_diff: "Business days between two dates",
  date_add: "Add business days to a date",
  date_info: "Day of week, ISO week and quarter for any date",
  business_day: "Is it a business day?",
  public_holidays: "Public holidays for 207 countries",
  pay_dates: "Payroll dates that skip weekends and holidays",
  business_hours_deadline: "Deadlines in business hours",
  sla_countdown: "SLA countdown in working hours",
  timezone_convert: "Convert time between time zones",
  city_time: "Time zone and local time for any city",
  working_hours_overlap: "Working hours overlap across time zones",
  find_free_slots: "Find free meeting slots",
  dst_check: "Daylight saving time transitions",
  cron_schedule: "Cron expression next runs, explained",
  recurring_dates: "Expand RRULE recurring dates",
  parse_date_text: "Parse natural-language dates",
  timestamp_normalize: "Normalize timestamps to UTC",
  stay_calculator: "Schengen 90/180 stay calculator",
  subscription_dates: "Subscription renewal and proration dates",
  market_calendar: "Stock market hours, holidays and early closes",
};

const PAGE_CSS = `
  .hero.tool { padding: 64px 0 40px; }
  .hero.tool h1 { max-width: 20ch; font-size: clamp(34px, 5vw, 52px); }
  .hero.tool .lede { font-size: 17px; }
  .crumbs { font: 12px var(--mono); color: var(--muted); }
  .crumbs a { text-decoration: none; }
  .related { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--ink); }
  .related li { display: grid; grid-template-columns: 220px 1fr; gap: 16px; padding: 10px 0; border-bottom: 1px solid var(--rule); font-size: 14px; }
  .related li span { color: #444; }
  .tabs.single { display: none; }
  .faq { border-top: 1px solid var(--ink); }
  .faq details { border-bottom: 1px solid var(--rule); padding: 14px 0; }
  .faq summary { cursor: pointer; font-weight: 500; list-style: none; }
  .faq summary::-webkit-details-marker { display: none; }
  .faq summary::before { content: "+"; display: inline-block; width: 20px; color: var(--muted); font-family: var(--mono); }
  .faq details[open] summary::before { content: "-"; }
  .faq p { margin: 8px 0 0 20px; color: #333; max-width: 70ch; }
  @media (max-width: 760px) { .related li { grid-template-columns: 1fr; gap: 2px; } }
`;

const cache = new Map<string, string>();

export function toolByName(slug: string): Tool | undefined {
  return TOOLS.find((t) => toolSlug(t.name) === slug);
}

export function toolPageHtml(origin: string, version: string, t: Tool): string {
  const hit = cache.get(t.name);
  if (hit) return hit;
  const heading = HEADINGS[t.name] ?? t.title;
  const short = SHORT[t.name] ?? t.title;
  const url = `${origin}/tools/${toolSlug(t.name)}`;
  const mcp = `${origin}/mcp`;
  const input = JSON.stringify(t.example, null, 2);
  const output = JSON.stringify((outputExamples as Record<string, unknown>)[t.path] ?? {}, null, 2);
  const presetJson = JSON.stringify([{ name: t.name, label: t.title, args: t.example }]).replace(/</g, "\\u003c");
  const group = GROUPS.find(([, names]) => names.includes(t.name));
  const related = (group ? group[1] : []).filter((n) => n !== t.name && TOOLS.some((x) => x.name === n));
  const relatedRows = related
    .map((n) => `<li><a href="/tools/${toolSlug(n)}"><code>${esc(n)}</code></a><span>${esc(SHORT[n] ?? n)}</span></li>`)
    .join("");
  const description = `${short}. A deterministic API and MCP tool for AI agents: 25 free calls a day, then $0.001 per call. No signup or API key.`;
  const ld = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebAPI",
    name: `Date Math: ${heading}`,
    description: t.description,
    url,
    documentation: `${origin}/openapi.json`,
    provider: { "@type": "Organization", name: "Date Math", url: origin },
  }).replace(/</g, "\\u003c");
  const faqs = FAQS[t.name] ?? [];
  const faqLd = faqs.length
    ? JSON.stringify({
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
      }).replace(/</g, "\\u003c")
    : "";
  const faqRows = faqs
    .map((f, i) => `<details${i === 0 ? " open" : ""}><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`)
    .join("\n        ");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(heading)} | Date Math API</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
${headLinks(origin)}<style>
${CSS}${PAGE_CSS}</style>
<script type="application/ld+json">${ld}</script>${faqLd ? `\n<script type="application/ld+json">${faqLd}</script>` : ""}
</head>
<body>
${siteHeader(version, "/#")}

<main>
  <div class="wrap hero tool">
    <div class="crumbs"><a href="/">Date Math</a> / <a href="/#tools">Tools</a> / ${esc(t.name)}</div>
    <h1>${esc(heading)}</h1>
    <p class="lede">${esc(t.description)}</p>
    <div class="facts"><span>MCP tool <b>${esc(t.name)}</b></span><span>HTTP <b>POST ${esc(t.path)}</b></span><span><b>25</b> free calls a day, then <b>$0.001</b></span></div>
  </div>

  <section id="try">
    <div class="wrap">
      <h2>Try it</h2>
      <p class="sub">Runs the real tool over MCP. Edit the arguments and run. Uses your daily free calls.</p>
      <div class="tabs single" role="group" aria-label="Examples"></div>
      <div class="console">
        <div class="pane">
          <div class="pane-head"><span id="tool-name">${esc(t.name)}</span><button class="run" id="run">Run</button></div>
          <textarea id="args" spellcheck="false" aria-label="Tool arguments (JSON)">${esc(input)}</textarea>
        </div>
        <div class="pane">
          <div class="pane-head"><span>result</span><span id="meta"></span></div>
          <pre class="out" id="out" aria-live="polite">${esc(output)}</pre>
        </div>
      </div>
      <p class="note">The result shown before you run is a saved example response.</p>
    </div>
  </section>

  <section id="connect">
    <div class="wrap">
      <h2>Use it from your agent</h2>
      <p class="sub">Add the MCP server once and your agent can call <code>${esc(t.name)}</code> and the other ${TOOLS.length - 1} tools.</p>
      <div class="connect">
        <div>
          <h3>Claude Code</h3>
          <p>One command in your terminal.</p>
          <div class="snip"><button class="copy">copy</button><pre>claude mcp add --transport http date-math ${esc(mcp)}</pre></div>
        </div>
        <div>
          <h3>Any MCP client</h3>
          <p>Claude Desktop, Cursor, VS Code, Windsurf.</p>
          <div class="snip"><button class="copy">copy</button><pre>${esc(JSON.stringify({ mcpServers: { "date-math": { url: mcp } } }, null, 2))}</pre></div>
        </div>
        <div>
          <h3>HTTP + x402</h3>
          <p>POST JSON; pay the 402 with any x402 client.</p>
          <div class="snip"><button class="copy">copy</button><pre>curl -X POST ${esc(origin + t.path)} \\
  -H "Content-Type: application/json" \\
  -d '${esc(JSON.stringify(t.example))}'</pre></div>
        </div>
      </div>
      <p class="note">Full schema: <a href="/openapi.json">OpenAPI</a> &middot; <a href="/llms.txt">llms.txt</a></p>
    </div>
  </section>
${
  faqRows
    ? `
  <section id="faq">
    <div class="wrap">
      <h2>Questions</h2>
      <p class="sub">Common questions, answered with real results from the tool.</p>
      <div class="faq">
        ${faqRows}
      </div>
    </div>
  </section>
`
    : ""
}${
  relatedRows
    ? `
  <section id="related">
    <div class="wrap">
      <h2>Related tools</h2>
      <p class="sub">${esc(group![0])} tools in Date Math. <a href="/#tools">See all ${TOOLS.length}</a>.</p>
      <ul class="related">${relatedRows}</ul>
    </div>
  </section>
`
    : ""
}</main>

${FOOTER}

${tryScript(presetJson)}
</body>
</html>`;
  cache.set(t.name, html);
  return html;
}

/** Paths of all tool pages, for the sitemap. */
export const TOOL_PAGE_PATHS = TOOLS.map((t) => `/tools/${toolSlug(t.name)}`);
