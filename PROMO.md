# Promo drafts for Date Math

Links used below:
- API: https://date-math.datemath.workers.dev
- MCP: https://date-math.datemath.workers.dev/mcp
- Docs for agents: https://date-math.datemath.workers.dev/llms.txt
- x402scan listing: https://www.x402scan.com (search "Date Math")
- Repo: https://github.com/JowenDelaPena/date-math

---

## 1. Show HN (news.ycombinator.com/submit)

**Title:** Show HN: Date Math – pay-per-call date/time API for AI agents ($0.001 via x402)

**URL:** https://github.com/JowenDelaPena/date-math

**First comment:**
> LLMs are surprisingly bad at date arithmetic: business days, "the 2nd Tuesday of each month", DST, which day a holiday falls on. So I built a small API that agents call instead of guessing.
>
> 11 tools:
> - business days, with public holidays for 207 countries
> - date add/diff
> - time-zone conversion and city → time zone
> - meeting-overlap windows
> - cron next runs
> - RRULE expansion
> - SLA/business-hours deadlines
> - natural-language date parsing
>
> Everything is deterministic and runs on a Cloudflare Worker in a few ms.
>
> No signup and no API keys. Each call costs $0.001 in USDC, paid over x402 (HTTP 402 Payment Required), and works over plain HTTP or as a remote MCP server. Discovery runs through OpenAPI, llms.txt and the x402 Bazaar.
>
> Some notes from building it:
> - The Workers free plan gives you about 10 ms of CPU per request. My first version took 30–170 ms on some tools. Most of that was creating a new `Intl.DateTimeFormat` on every time-zone lookup. Caching one formatter per zone, precomputing the holiday table, and writing a small cron engine (tested against cron-parser on 400 random expressions) brought every tool to 0–6 ms on Cloudflare.
> - x402's Bazaar validator compiles JSON Schemas with `new Function`, which Workers blocks. A one-line build alias fixed it.
>
> Happy to answer questions about x402 or running paid MCP tools on Workers.

---

## 2. Reddit, r/mcp (also fits r/LocalLLaMA and r/ClaudeAI)

**Title:** I made a remote MCP server for exact date/time math (business days, holidays, time zones, cron, RRULE). Agents pay $0.001/call with x402.

**Body:**
> Agents keep getting dates wrong, so I wrapped the hard parts in 11 deterministic MCP tools:
>
> - `date_diff` / `date_add`: business days that skip a country's public holidays (207 countries)
> - `timezone_convert`, `city_time`: DST-aware, 7k+ cities
> - `working_hours_overlap`: when a Manila/London/NY team can actually meet
> - `cron_schedule`: plain-English explanation plus the next runs in any zone
> - `recurring_dates`: expand an iCal RRULE ("every 2nd Tuesday")
> - `business_hours_deadline`: "48 business hours from now, PH holidays excluded"
> - `parse_date_text`: "next Friday at 3pm" → an exact ISO datetime
> - `public_holidays`, `date_info`
>
> **Endpoint:** `https://date-math.datemath.workers.dev/mcp` (Streamable HTTP)
>
> `tools/list` is free. Each call costs $0.001 via x402 MCP, which needs an x402-capable client (for example `@x402/mcp`). No keys, no signup.
>
> Feedback welcome, especially on which date/time tools you'd want next.

---

## 3. X / Twitter

**Post 1:**
> LLMs are bad at dates. So I built Date Math: 11 deterministic date/time tools for AI agents.
>
> Business days with holidays in 207 countries, time zones, cron, RRULE, SLA deadlines, "next Friday at 3pm" → ISO.
>
> $0.001 per call via #x402. HTTP or MCP. No API keys.
>
> https://date-math.datemath.workers.dev/llms.txt

**Post 2 (reply):**
> Listed on @x402scan and the x402 Bazaar.
>
> Runs on a @CloudflareDev Worker free plan at 0–6 ms CPU per call.
>
> MCP endpoint: https://date-math.datemath.workers.dev/mcp
>
> Repo: https://github.com/JowenDelaPena/date-math

---

## 4. Discord: x402 / Coinbase Developer Platform, #showcase or #projects

> Hey all 👋 Shipped a small x402 service: **Date Math**, exact date/time math for agents.
>
> - **What:** 11 tools: business days with holidays in 207 countries, time zones, city lookup, meeting overlap, cron, RRULE, SLA deadlines, NL date parsing.
> - **Price:** $0.001 per call in USDC on Base, `exact` scheme, x402 v2.
> - **Access:** HTTP (OpenAPI with `x-payment-info`) plus a remote MCP server with x402 MCP payments.
> - **Discovery:** x402scan (0 audit failures), PayAI Bazaar, llms.txt.
> - **Links:** https://date-math.datemath.workers.dev · https://date-math.datemath.workers.dev/mcp
>
> Tip for anyone running x402 on Cloudflare Workers: the Bazaar route validator uses Ajv → `new Function`, which Workers blocks. Alias `@x402/extensions/bazaar` to a shim that no-ops `validateBazaarRouteExtensions` (see the repo).
