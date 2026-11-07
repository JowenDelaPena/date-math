// Worker entry. Only the default export: Workers treats named exports of the entry module as entrypoints.
//
// Three ways in:
//  1. Direct:  https://<host>/v1/...                 -> x402 pay-per-call (when PAY_TO is set)
//  2. MCP:     https://<host>/mcp                    -> same tools, x402 over MCP, with a small free daily tier (quota.ts)
//  3. Pocket:  https://<host>/<POCKET_PREFIX>/v1/... -> free, for Pocket suppliers' RelayMiners
//     (they are paid on-chain by Pocket). POCKET_PREFIX is a secret: wrangler secret put POCKET_PREFIX
//
// Usage analytics: one JSON log line per tool call, visible in Cloudflare dashboard -> Workers -> date-math ->
// Observability (Workers Logs). Query e.g. `evt = "call"` and group by path/outcome. No request bodies are logged.
import type { ExecutionContext } from "hono";
import { api } from "./app";
import { handleMcp, type McpEnv } from "./mcp";
import { mcpOutcome, mcpRequestInfo, outcome, safeDecode } from "./outcome";
import { paidApp } from "./payments";
import { FreeQuota } from "./quota";
import { PAID_PATHS } from "./tools";

// The one named export besides default: Durable Object classes must be exported from the entry module.
export { FreeQuota };

interface WorkerEnv extends McpEnv {
  POCKET_PREFIX?: string;
}

const PAID = new Set(PAID_PATHS);
/** Outcomes that may mean lost earnings; logged again at error level so Observability's error view shows them. */
const ALERT = new Set(["rpc_error", "payment_failed", "unverified", "unparsable", "error"]);

function log(fields: Record<string, unknown>) {
  console.log(JSON.stringify({ evt: "call", ...fields }));
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const started = Date.now();
    const prefix = env.POCKET_PREFIX ? `/${env.POCKET_PREFIX}` : "";

    if (prefix && (url.pathname === prefix || url.pathname.startsWith(prefix + "/"))) {
      url.pathname = url.pathname.slice(prefix.length) || "/";
      const res = await api.fetch(new Request(url, request), env, ctx);
      if (PAID.has(url.pathname)) log({ via: "pocket", path: url.pathname, status: res.status, outcome: outcome(res, false), ms: Date.now() - started });
      return res;
    }

    if (url.pathname === "/mcp") {
      const { method, tool, attempted } = request.method === "POST" ? await mcpRequestInfo(request) : {};
      const res = await handleMcp(request, env);
      if (method === "tools/call") {
        const r = mcpOutcome(await res.clone().text(), Boolean(attempted));
        log({ via: "mcp", path: tool ?? "?", status: res.status, ...r, ms: Date.now() - started });
        if (ALERT.has(r.outcome)) console.error(JSON.stringify({ evt: "payment_alert", via: "mcp", path: tool, outcome: r.outcome }));
      } else if (method === "tools/list") log({ via: "mcp", path: "tools/list", status: res.status, outcome: "free", ms: Date.now() - started });
      return res;
    }

    const res = await paidApp(env).fetch(request, env, ctx);
    if (request.method === "POST" && PAID.has(url.pathname)) {
      const o = outcome(res, Boolean(env.PAY_TO), request);
      const settle = o === "paid" ? safeDecode(res.headers.get("PAYMENT-RESPONSE")) : undefined;
      log({ via: "http", path: url.pathname, status: res.status, outcome: o, ...(settle?.transaction ? { tx: settle.transaction } : {}), ms: Date.now() - started });
      if (ALERT.has(o)) console.error(JSON.stringify({ evt: "payment_alert", via: "http", path: url.pathname, outcome: o }));
    }
    return res;
  },
};
