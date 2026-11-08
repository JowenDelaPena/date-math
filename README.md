# Date Math

[![Listed on mcpservers.org](https://mcpservers.org/badge.svg)](https://mcpservers.org/servers/jowendelapena/date-math)
[![Date Math – Business Days, Holidays & Time Zones MCP server – quality and maintenance score on Glama](https://glama.ai/mcp/servers/JowenDelaPena/date-math/badges/score.svg)](https://glama.ai/mcp/servers/JowenDelaPena/date-math)

[![Date Math – Business Days, Holidays & Time Zones MCP server – quality and maintenance score on Glama](https://glama.ai/mcp/servers/JowenDelaPena/date-math/badges/card.svg)](https://glama.ai/mcp/servers/JowenDelaPena/date-math)

**Exact date and time math for AI agents, paid per call.** LLMs are unreliable at business days, DST, recurring schedules and holiday calendars. Date Math gives them deterministic answers over HTTP or MCP.

- **Price:** $0.001 per call in USDC on Base, via [x402](https://x402.org)
- **Free to try:** 25 free MCP tool calls per day, works in any MCP app (Claude Desktop, Cursor, ...)
- **Access:** no signup, no API keys
- **Base URL:** `https://date-math.datemath.workers.dev`
- **MCP endpoint:** `https://date-math.datemath.workers.dev/mcp` (Streamable HTTP)
- **Docs for agents:** [`/llms.txt`](https://date-math.datemath.workers.dev/llms.txt) · [`/openapi.json`](https://date-math.datemath.workers.dev/openapi.json)

## Tools

| HTTP (`POST`, JSON body) | MCP tool | What it does |
|---|---|---|
| `/v1/diff` | `date_diff` | Days, weeks, months and business days between two dates. Pass `country` to skip its public holidays, `workdays` for non Mon–Fri weeks. |
| `/v1/add` | `date_add` | The date N days, weeks, months or business days before or after a date |
| `/v1/convert` | `timezone_convert` | Converts a time between IANA time zones (DST-aware) |
| `/v1/info` | `date_info` | Weekday, ISO week, quarter, day of year, leap year |
| `/v1/holidays` | `public_holidays` | Public holidays for 207 countries, 2000–2050 |
| `/v1/overlap` | `working_hours_overlap` | When working hours overlap across time zones (meeting slots) |
| `/v1/cron` | `cron_schedule` | Explains a cron expression and lists its next runs in any zone |
| `/v1/parse` | `parse_date_text` | "next Friday at 3pm" → an exact ISO datetime |
| `/v1/city` | `city_time` | City name → time zone and local time (7,000+ cities) |
| `/v1/recurrence` | `recurring_dates` | Expands an iCal RRULE ("every 2nd Tuesday") into dates |
| `/v1/business_hours` | `business_hours_deadline` | SLA deadline N working hours from now, or working time elapsed |
| `/v1/business_day` | `business_day` | Is a date a business day, and if not, why (weekend or which holiday); next/previous business day; the month's business days |
| `/v1/pay_dates` | `pay_dates` | Payroll and billing dates (monthly, 15th and last, biweekly, weekly) moved off weekends and holidays |
| `/v1/stay` | `stay_calculator` | Schengen-style 90/180 stay limits: days used and left, overstay check, the longest stay from a planned entry date, the next date a full stay is possible |
| `/v1/timestamp` | `timestamp_normalize` | Converts up to 100 mixed timestamps (Unix s/ms/µs/ns, Excel serials, FILETIME, ISO 8601, RFC 2822, slash dates) to UTC and flags ambiguous ones like 03/04/2026 |
| `/v1/dst` | `dst_check` | A zone's daylight-saving clock changes for a year, and whether a local time is valid, skipped (spring-forward gap) or repeated (fall-back) |
| `/v1/sla` | `sla_countdown` | Live SLA clock for support tickets: business minutes elapsed and remaining, breached or not, deadline. Pauses outside working hours, on holidays and during manual pauses |
| `/v1/free_slots` | `find_free_slots` | Meeting slots when everyone is free: each person's working hours in their own zone (and holidays) minus their busy blocks |
| `/v1/subscription` | `subscription_dates` | Billing period, next renewal, cancel-by date for a notice period, trial start and day-based proration; month-end anchors stay at month end |
| `/v1/market` | `market_calendar` | NYSE/Nasdaq, London and Tokyo: open now, session hours (early closes, lunch break), holidays, next open/close, settlement date (T+1/T+2) |
| `GET /v1/now` | `current_time` | **Free:** the current date and time in up to 10 time zones. No payment, and it doesn't use the daily free calls |

## Use it in your app

The first 25 tool calls per day are free in all of these. No signup, no API key.

**Claude Code**

```bash
claude mcp add --transport http date-math https://date-math.datemath.workers.dev/mcp
```

**Claude Desktop / claude.ai:** Settings → Connectors → Add custom connector, and paste `https://date-math.datemath.workers.dev/mcp`. Or use the local package in `claude_desktop_config.json`:

```json
{ "mcpServers": { "date-math": { "command": "npx", "args": ["-y", "date-math-mcp"] } } }
```

**Cursor** (`~/.cursor/mcp.json`)

```json
{ "mcpServers": { "date-math": { "url": "https://date-math.datemath.workers.dev/mcp" } } }
```

**VS Code** (`.vscode/mcp.json`)

```json
{ "servers": { "date-math": { "type": "http", "url": "https://date-math.datemath.workers.dev/mcp" } } }
```

**Windsurf** (`~/.codeium/windsurf/mcp_config.json`)

```json
{ "mcpServers": { "date-math": { "serverUrl": "https://date-math.datemath.workers.dev/mcp" } } }
```

**Cline** (MCP Servers → Configure)

```json
{ "mcpServers": { "date-math": { "type": "streamableHttp", "url": "https://date-math.datemath.workers.dev/mcp" } } }
```

**Any app that only runs local commands:** `npx -y date-math-mcp` ([npm package](npm/README.md)). Set `DATE_MATH_PRIVATE_KEY` to a wallet with USDC on Base and it pays for calls beyond the free tier automatically.

**Vercel AI SDK**

```ts
import { createMCPClient } from "@ai-sdk/mcp";

const mcp = await createMCPClient({ transport: { type: "http", url: "https://date-math.datemath.workers.dev/mcp" } });
const tools = await mcp.tools(); // pass to generateText / streamText
```

**LangChain / LangGraph (Python)**

```python
from langchain_mcp_adapters.client import MultiServerMCPClient

client = MultiServerMCPClient({"date-math": {"transport": "streamable_http", "url": "https://date-math.datemath.workers.dev/mcp"}})
tools = await client.get_tools()
```

Business-day tools take `workdays` (weekday numbers, 0 = Sunday) for other workweeks, e.g. `[0,1,2,3,4]` for Sun–Thu or `[1,2,3,4,5,6]` for Mon–Sat.

Every response is a JSON object. Errors look like `{"error":{"code","message","example"}}`, where `example` is a valid request body for that tool. Full schemas and examples are in [`/openapi.json`](https://date-math.datemath.workers.dev/openapi.json).

## Examples

```bash
# Unpaid call → HTTP 402 with payment terms in the PAYMENT-REQUIRED header
curl -i -X POST https://date-math.datemath.workers.dev/v1/business_hours \
  -H "Content-Type: application/json" \
  -d '{"start":"2026-11-06T16:00","hours":2,"timezone":"Asia/Manila","country":"PH"}'
```

| Request body | Result |
|---|---|
| `/v1/business_hours` `{"start":"2026-11-06T16:00","hours":2,"timezone":"Asia/Manila"}` | `"deadline":"2026-11-09T10:00:00+08:00"` (Monday) |
| `/v1/add` `{"date":"2026-12-22","business_days":5,"country":"PH"}` | `"result":"2026-12-31"` (skips Christmas and Rizal Day) |
| `/v1/overlap` `{"timezones":["Asia/Manila","Europe/London"],"date":"2026-11-10","work_end":"18:00"}` | One window: `09:00–10:00Z` |
| `/v1/recurrence` `{"rrule":"FREQ=MONTHLY;BYDAY=2TU","start":"2026-01-01T10:00","timezone":"Asia/Manila","count":3}` | Jan 13, Feb 10, Mar 10 at 10:00 +08:00 |
| `/v1/business_day` `{"date":"2026-12-25","country":"PH"}` | Not a business day: `"holiday":"Christmas Day"`, next is `2026-12-28` |
| `/v1/pay_dates` `{"schedule":"semi_monthly","from":"2027-01-01","count":2}` | Jan 15, then Jan 31 (Sunday) moved to Fri Jan 29 |

## Paying from code

Any x402 client pays automatically. With the official TypeScript client:

```ts
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(privateKeyToAccount(process.env.KEY as `0x${string}`)) }],
});

const res = await pay("https://date-math.datemath.workers.dev/v1/city", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ cities: ["Cebu", "London"] }),
});
console.log(await res.json());
```

The wallet needs USDC on Base. No ETH is required, because the facilitator pays gas.

## Using it over MCP

- **Endpoint:** `https://date-math.datemath.workers.dev/mcp` (Streamable HTTP, stateless)
- **Listing tools** (`tools/list`) is free.
- **The first 25 tool calls per day are free** (per IP, reset at 00:00 UTC). Each free result carries `_meta["date-math/free_calls_remaining"]`.
- **After that, each tool call** costs $0.001 via x402 MCP. Payment travels in the tool call's `_meta`, and x402-aware clients handle it automatically:

```ts
import { createx402MCPClient } from "@x402/mcp";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = createx402MCPClient({
  name: "my-agent", version: "1.0.0",
  schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(account) }],
  autoPayment: true,
});
await client.connect(new StreamableHTTPClientTransport(new URL("https://date-math.datemath.workers.dev/mcp")));
const r = await client.callTool("public_holidays", { country: "US", year: 2026 });
```

MCP clients without x402 support can use the free daily calls; after those, calls return "Payment required". A client that attaches a payment never uses up free calls.

The free tier is MCP only. Plain HTTP calls always need payment (an unpaid call returns 402), because x402 discovery services check for that.

## Run your own copy

The service is a single Cloudflare Worker and fits the free plan: every tool uses 0–6 ms of CPU per call.

```bash
cd worker
npm install
npm test                 # 189 tests, including end-to-end payments with the real x402 clients
npx wrangler login
npx wrangler deploy
```

Set your own wallet and price in [`worker/wrangler.toml`](worker/wrangler.toml):

| Setting | Meaning |
|---|---|
| `PAY_TO` | Your wallet address. Leave empty to make every endpoint free. |
| `PRICE` | Price per call, e.g. `$0.001` |
| `X402_NETWORK` | `eip155:8453` (Base) or `eip155:84532` (Base Sepolia, for testing) |
| `FACILITATOR_URL` | Defaults to PayAI: no key needed, and it pays gas |
| `FREE_CALLS_PER_DAY` | Free MCP tool calls per IP per day (default `25`, `0` turns it off). Counters live in the `FREE_QUOTA` Durable Object. |

Optional secrets (set with `npx wrangler secret put`):
- **`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`:** settle through Coinbase's facilitator first.
- **`POCKET_PREFIX`:** a private, unpaid path for trusted relays.

To check your deployment against x402scan's discovery rules, run `node tools/x402scan-audit.mjs https://your-worker.workers.dev`.
To check that it can actually take payments (HTTP and MCP, the way agents pay), run `API_URL=https://your-worker.workers.dev EXPECTED_PAY_TO=0xYourWallet node worker/scripts/payment-monitor.mjs`.

## How it's built

- **Stack:** [Hono](https://hono.dev) on Cloudflare Workers, plus [`@x402/hono`](https://www.npmjs.com/package/@x402/hono) and [`@x402/mcp`](https://www.npmjs.com/package/@x402/mcp).
- **Discovery:** OpenAPI with `x-payment-info`, `/.well-known/x402`, x402 Bazaar metadata on every 402, `llms.txt`, and an MCP [Server Card](https://modelcontextprotocol.io/seps/2127-mcp-server-cards) at `/mcp/server-card` listed in `/.well-known/ai-catalog.json`.
- **Precomputed data:** the holiday and city tables are built at build time (`worker/scripts/build-*.mjs`), so lookups are O(1) per request.
- **Time zones:** UTC offsets come from cached `Intl` formatters and a week-segment cache. They're tested against direct lookups for tricky zones (Morocco, Lord Howe, Chatham).
- **Cron:** a built-in engine (`worker/src/cron.ts`), checked against `cron-parser` on 400 random expressions.
- **Workers-specific shim:** x402's Bazaar route validator uses Ajv code generation (`new Function`), which Workers blocks. `wrangler.toml` aliases it to a no-op shim (`worker/src/shims/bazaar.ts`).

## Data and license

- **Code:** MIT, see [LICENSE](LICENSE). Third-party data notices are in [NOTICE](NOTICE).
- **Holiday data:** derived from [date-holidays](https://github.com/commenthol/date-holidays) (CC BY 3.0). Lunar or government-proclaimed dates are rule-based estimates.
- **City data:** derived from [city-timezones](https://github.com/kevinroberts/city-timezones) (MIT), based on Natural Earth (public domain).

Contact: see `info.contact` in [`/openapi.json`](https://date-math.datemath.workers.dev/openapi.json).
