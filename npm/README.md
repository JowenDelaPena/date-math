# date-math-mcp

Exact date and time math for AI agents, as an MCP server: business days with public holidays for 207 countries, time-zone conversion, meeting-time overlap, cron schedules, RRULE expansion, SLA deadlines, payroll dates and natural-language date parsing.

This package runs a small local (stdio) server that forwards to the hosted Date Math server. If your app supports remote MCP servers, you can skip the package and connect to `https://date-math.datemath.workers.dev/mcp` directly.

## Setup

Add this to your MCP app's config (for example `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "date-math": { "command": "npx", "args": ["-y", "date-math-mcp"] }
  }
}
```

The first 25 tool calls per day are free. No signup and no API key.

## Paying for more calls (optional)

After the free calls, each call costs $0.001 in USDC on Base, paid automatically with [x402](https://x402.org). Set a wallet key that holds a little USDC (no ETH is needed):

```json
"date-math": {
  "command": "npx",
  "args": ["-y", "date-math-mcp"],
  "env": { "DATE_MATH_PRIVATE_KEY": "0x..." }
}
```

Use a separate wallet with only a few dollars in it. The key stays on your machine and only signs payments.

| Variable | Default | Meaning |
|---|---|---|
| `DATE_MATH_PRIVATE_KEY` | none | Wallet key for paid calls. Without it, only the free calls work. |
| `DATE_MATH_MAX_PRICE` | `$0.001` | The most it will ever pay for one call. |
| `DATE_MATH_URL` | hosted server | Point at your own deployment. |

## Tools

`date_diff`, `date_add`, `timezone_convert`, `date_info`, `public_holidays`, `working_hours_overlap`, `cron_schedule`, `parse_date_text`, `city_time`, `recurring_dates`, `business_hours_deadline`, `business_day`, `pay_dates`.

Full docs: https://github.com/JowenDelaPena/date-math
