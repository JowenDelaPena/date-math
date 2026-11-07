# Supplier wanted: date-math (new agent service on Pocket MainNet)

Hi! I've registered **`date-math`** on Pocket MainNet and I'm looking for a supplier to serve it so it can be listed on the Agentic Portal.

**What it is:** deterministic date and time math for AI agents: date differences with business days and holidays, date arithmetic, IANA time-zone conversion (DST-aware), and calendar facts. Nothing like it is in the catalogue (117 services) or on-chain (278 services).

**Why it's easy to serve**
- **No backend to run.** Point your RelayMiner `rest` backend at the existing HTTPS Worker (I send you a private free path, e.g. `https://date-math.datemath.workers.dev/<private-path>`; the public path is pay-per-call). If you'd rather self-host, I'll share the source: it's a tiny TypeScript app with no upstream calls.
- **Light on CPU and memory.** Responses take milliseconds, are deterministic, and need no keys or rate limits.
- **Ready-made config:** a relayer.yaml snippet, a health check (`GET /v1/health` → `"ok"`), and a stake config template.

**Economics**
- **Price:** 100,000 CU/relay ($0.0001 on-chain), the same as comparable agent services (NER, PII, address standardization).
- **Your share:** you keep the supplier share (79% of each settled relay). I only take the standard 2.5% owner share.
- **Cost to add it to your stake:** `stake_per_additional_service` is 0 POKT on MainNet.

**What I need from you**
1. Add `date-math` to your supplier stake (endpoint `rpc_type: REST`).
2. Send a few relays from a test app so one claim settles (audit rule A7).
3. Share your operator address so I can submit the listing request.

**Relayer snippet**
```yaml
services:
  date-math:
    validation_mode: eager
    default_backend: rest
    backends:
      rest:
        url: "https://date-math.datemath.workers.dev/<private-path>"
        health_check: { enabled: true, endpoint: "/v1/health", expected_body: '"ok"', interval_seconds: 10, timeout_seconds: 5, unhealthy_threshold: 3, healthy_threshold: 2 }
```

Card: `pocketd query service card date-math --network=main --raw` · Spec: `https://date-math.datemath.workers.dev/openapi.json`

Thanks!
