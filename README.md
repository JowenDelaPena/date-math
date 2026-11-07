# Date Math: a pay-per-call API for AI agents

**Two ways to earn, from the same Worker:**
1. **Direct x402 (live, no cost):** agents pay **$0.001 per call in USDC on Base** straight to your wallet. No Pocket, no supplier.
2. **Pocket Network (optional):** register as owner for 1,000 POKT and earn 2.5% of each relay once a supplier serves it. Details below.

## Tools (11), each $0.001 over HTTP and MCP

| HTTP | MCP tool | What it does |
|---|---|---|
| `POST /v1/diff` | `date_diff` | Days/weeks/months/business days between dates. `country` skips that country's public holidays. |
| `POST /v1/add` | `date_add` | Date N days/weeks/months/business days before or after a date |
| `POST /v1/convert` | `timezone_convert` | Time-zone conversion, DST-aware |
| `POST /v1/info` | `date_info` | Weekday, ISO week, quarter, leap year |
| `POST /v1/holidays` | `public_holidays` | Public holidays: 207 countries, 2000–2050 (precomputed table) |
| `POST /v1/overlap` | `working_hours_overlap` | Meeting windows where working hours overlap across zones |
| `POST /v1/cron` | `cron_schedule` | Cron in plain English plus the next run times in any zone |
| `POST /v1/parse` | `parse_date_text` | "next Friday at 3pm" → an exact datetime |
| `POST /v1/city` | `city_time` | City name → IANA time zone and local time (7k+ cities) |
| `POST /v1/recurrence` | `recurring_dates` | Expands an iCal RRULE ("every 2nd Tuesday") into dates, DST-aware |
| `POST /v1/business_hours` | `business_hours_deadline` | SLA deadline N working hours from now, or working hours elapsed |

**MCP server:** `https://date-math.datemath.workers.dev/mcp` (Streamable HTTP, stateless).
- `tools/list` is free. Each `tools/call` costs $0.001 via x402 MCP: an unpaid call returns the payment terms, and an x402-aware client (for example `createx402MCPClient` from `@x402/mcp`) pays and retries automatically. See `worker/scripts/first-payment.mjs`.
- Plain MCP clients without x402 support see the tools, but calls return "Payment required".

**Free-tier CPU (10 ms/request):** measured on Cloudflare at 0–6 ms per call, even with worst-case inputs.
- **Precomputed data:** the holiday table (`scripts/build-holidays.mjs`) and city table (`scripts/build-cities.mjs`) are built ahead of time. Re-run them when bumping the data packages.
- **Caching:** time-zone formatters are cached, and UTC offsets are looked up per week via `offsetCursor` (tested against direct lookups for Morocco, Lord Howe, Chatham and others).
- **Cron:** a small built-in engine (`src/cron.ts`), matched against `cron-parser` on 400 random expressions.
- **Startup work:** libraries with lazy initialization (ICU, chrono, rrule) are warmed when the Worker starts.
- **Bazaar shim:** `[alias]` in `wrangler.toml` swaps x402's Ajv-based route validator, which needs `new Function` and is blocked on Workers, for a no-op. See `src/shims/bazaar.ts`.

## Growth setup

**Usage analytics (free):**
- Every tool call logs one JSON line: `{"evt":"call","via":"http|mcp|pocket","path","status","outcome":"paid|unpaid|..."}`.
- To view: Cloudflare dashboard → Workers & Pages → `date-math` → **Observability** → filter `evt = "call"`, then group by `path` or `outcome`.
- The unpaid/paid ratio per tool shows which tools agents want.

**Coinbase CDP Bazaar (optional, recommended):**
1. Create a free account at https://portal.cdp.coinbase.com, then go to **API Keys** → **Create API key**. Choose **Ed25519** (the default).
2. Copy the **Key ID** and **Secret**, then run in `worker/`:
   ```powershell
   npx wrangler secret put CDP_API_KEY_ID
   npx wrangler secret put CDP_API_KEY_SECRET
   ```
3. Payments then settle through Coinbase first (PayAI stays as a fallback), which lists the service in Coinbase's Bazaar after the next paid call.

The JWT auth is implemented in [worker/src/cdp.ts](worker/src/cdp.ts) without the heavy CDP SDK.

**Official MCP Registry:** uses [server.json](server.json).
1. Install the publisher (PowerShell):
   ```powershell
   $arch = if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq "Arm64") { "arm64" } else { "amd64" }; Invoke-WebRequest -Uri "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_$arch.tar.gz" -OutFile "mcp-publisher.tar.gz"; tar xf mcp-publisher.tar.gz mcp-publisher.exe; rm mcp-publisher.tar.gz
   ```
2. From the repo root:
   ```powershell
   .\mcp-publisher.exe login github
   .\mcp-publisher.exe publish
   ```
   GitHub login uses a device code in your browser.

**Other directories:** submit `https://date-math.datemath.workers.dev/mcp` at Smithery (smithery.ai), Glama (glama.ai/mcp/servers) and PulseMCP (pulsemcp.com/submit).

**Promo drafts:** [PROMO.md](PROMO.md).

## Direct x402 payments

| Path | Access |
|---|---|
| All 11 tool routes (`POST /v1/...`) and MCP `tools/call` | **Paid**: $0.001 (x402 v2, `exact`, USDC on Base `eip155:8453`) |
| `GET /`, `/v1/version`, `/v1/health`, `/openapi.json` | Free |
| `/<POCKET_PREFIX>/...` | Free, a private path for Pocket suppliers' RelayMiners (they're paid on-chain) |

- **How a call works:** an unpaid call returns `402` with terms in the `PAYMENT-REQUIRED` header. The agent signs a USDC authorization and retries with `PAYMENT-SIGNATURE`. The facilitator (`facilitator.payai.network`, no API key, pays the gas) settles the USDC to `PAY_TO`.
- **Discovery:** each paid route declares x402 **Bazaar** metadata (input/output examples, tags), so facilitator catalogs can list it.
- **Settings** in [worker/wrangler.toml](worker/wrangler.toml): `PAY_TO` (your address; empty = everything free), `PRICE`, `X402_NETWORK`, `FACILITATOR_URL`. To create the Pocket path: `npx wrangler secret put POCKET_PREFIX`.
- **Implementation:** [worker/src/payments.ts](worker/src/payments.ts) and [worker/src/index.ts](worker/src/index.ts). The facilitator sync runs inside each request until it succeeds, because Workers can't share I/O across requests.

---

# Pocket Network (optional)

Deterministic date and time math for AI agents (LLMs are unreliable at it), sold per request through Pocket Network.
You **own** the service on-chain and earn **2.5% of every settled relay**, no matter which supplier serves it.

**Your only spend: the 1,000 POKT registration fee** (plus under 1 POKT of gas).
The API runs on Cloudflare's free tier. Registration runs from WSL on this PC, so there's no VPS.

## Pricing: 100,000 CU per relay (= $0.0001 on-chain)

Chosen from live MainNet data (2026-11-07, 183 services with cards):

| | CU per relay | $ per relay |
|---|---|---|
| Catalogue median | 50,000 | $0.00005 |
| Peers: address-standardization, NER, sentiment, PII, table-extraction | 100,000 | $0.0001 |
| **95th percentile (audit flags above this, rule A9)** | **100,000** | $0.0001 |
| **date-math** | **100,000** | **$0.0001** |

- **Reasonable:** the same price as comparable rule-based services, and it doesn't trigger the A9 price warning.
- **Sustainable:** the best price for suppliers without a warning, and you need a supplier to serve the service.
- **Adjustable:** re-run `scripts/register.sh main` with `CU=...` to change it (gas only).

Pocket pegs 1B CU to $1. Agents pay the Agentic Portal about $0.005 per call in USDC. On-chain payouts follow the CU price.

### What the owner earns (2.5%)

| Relays per month | Owner (you) | Supplier (79%) |
|---|---|---|
| 100k | $0.25 | $7.90 |
| 1M | $2.50 | $79 |
| 10M | $25 | $790 |
| 100M | $250 | $7,900 |

Break-even on the 1,000 POKT fee (≈ $7.25 at $0.0072/POKT) is about 2.9M relays. Owner income is passive and grows with every supplier that serves the service. The volumes are hypothetical: Pocket doesn't publish per-service traffic.

## Requirements for listing (Service Audit)

| Rule | Status | How |
|---|---|---|
| A1 Registered | You | `scripts/register.sh main` |
| A2 Card valid, < 4 KiB | ✔ | [pocket/card.json](pocket/card.json), submitted minified |
| A3 API name unique | ✔ | `date-math-api` is unclaimed |
| A4 Staked supplier | **Needs a supplier partner** | [SUPPLIER_PITCH.md](SUPPLIER_PITCH.md) |
| A5/A6 https hostname + TLS | ✔ | `*.workers.dev`; the supplier provides its own TLS endpoint |
| A7 Settled claim | Needs a supplier | The supplier stakes a test app and sends relays |
| A8 Content quality | ✔ | Name, identity/readiness/functional probes, OpenAPI spec |
| A9 Price | ✔ | 100,000 CU (= p95, not above) |

Check it any time with `node tools/preaudit.mjs` (read-only).

**Owning the service doesn't earn anything until a supplier serves it.** Registration makes it yours and permanent. A supplier makes it earn.

---

## Steps

### 1. Deploy the API (Windows)
```bash
cd worker
npm install
npm test               # 28 tests
npx wrangler login     # free Cloudflare account, opens a browser
npm run deploy         # prints https://date-math.<your-subdomain>.workers.dev
```
Replace `REPLACE_WORKER_HOST` in `pocket/card.json` (and in `pocket/config/relayer.yaml` for suppliers) with that host. Then:
```bash
node ../tools/preaudit.mjs   # A2, A3, A5, A6, A8, A9 should pass; A1/A4/A7 pending
```

### 2. Install WSL (once, about 10 min)
In PowerShell **as Administrator**: `wsl --install`, then reboot and create a Linux username and password.
Open "Ubuntu" from the Start menu. Your project is at `/mnt/c/Users/Test/Downloads/POKT_Try`.

### 3. Install pocketd and create your wallet (in Ubuntu)
```bash
cd /mnt/c/Users/Test/Downloads/POKT_Try
bash scripts/install-pocketd.sh
pocketd keys add owner --keyring-backend file
```
**Write the 24-word mnemonic on paper.** Anyone with it controls your POKT and the service. Never paste it anywhere.
Show your address with `pocketd keys show owner -a --keyring-backend file`.

### 4. Free dry run on Beta
Get Beta POKT from the faucet (linked on the Pocket docs "Networks" page), then:
```bash
bash scripts/register.sh beta
node tools/preaudit.mjs --network beta
```

### 5. Buy POKT and register on MainNet
1. Buy **about 1,003 POKT**: the 1,000 fee plus gas headroom. The script checks you have fee + 2 POKT.
2. Withdraw to your `pokt1...` address on the **Shannon (current) Pocket chain**. Send a small test amount first.
3. Run:
   ```bash
   bash scripts/register.sh main
   ```
   The script re-reads the live fee and your balance, validates the card, shows a summary, and only sends after you type the service ID.

### 6. Find a supplier
Send [SUPPLIER_PITCH.md](SUPPLIER_PITCH.md) to Pocket community suppliers (Discord or forum), or to operators already serving agent services. Once one is staked and a claim settles:
- run `node tools/preaudit.mjs` until there are no failures
- email **directors@pokt.foundation** with: service ID `date-math`, network `main`, the supplier's operator address, "Deterministic date/time math (diffs, business days, time zones) for AI agents", and the audit output

The portal delists services with no requests for 30 days.

---

## API

All requests are POST with a JSON body, and every response is a JSON object. Errors look like `{"error":{"code","message"}}`. Spec: `/openapi.json`.

| Endpoint | Example body |
|---|---|
| `POST /v1/info` | `{"date":"2026-11-07"}` |
| `POST /v1/diff` | `{"from":"2026-01-31","to":"2026-03-15","holidays":["2026-02-17"]}` |
| `POST /v1/add` | `{"date":"2026-11-06","business_days":10}` |
| `POST /v1/convert` | `{"datetime":"2026-11-07T14:30:00","from_timezone":"Asia/Manila","to_timezone":"America/New_York"}` |
| `GET /v1/version`, `/v1/health`, `/v1/openapi.json` | Probes and spec |

Pocket backend rules it follows:
- Every body starts with `{`.
- Input is a JSON body. No auth.
- No gzip (`Content-Encoding: identity`).
- Responses take milliseconds. Business-day math is O(1), so it fits the Workers free tier's 10 ms CPU limit.
- The free tier covers 100k requests a day (about 3M a month). Beyond that, Workers Paid is $5/month, which supplier income at that volume (~$237/month) easily covers.

## Layout
- [worker/](worker/): Cloudflare Worker (Hono, TypeScript) and tests
- [pocket/card.json](pocket/card.json): on-chain service card
- [pocket/](pocket/): RelayMiner stack for a **supplier** (docker compose, relayer/miner config, stake template). Not needed for owner-only.
- [scripts/](scripts/): `install-pocketd.sh`, `register.sh` (run in WSL)
- [tools/preaudit.mjs](tools/preaudit.mjs): local Service Audit checker
