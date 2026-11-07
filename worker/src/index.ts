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
import { FREE_META, handleMcp, type McpEnv } from "./mcp";
import { paidApp } from "./payments";
import { FreeQuota } from "./quota";
import { PAID_PATHS } from "./tools";

// The one named export besides default: Durable Object classes must be exported from the entry module.
export { FreeQuota };

interface WorkerEnv extends McpEnv {
  POCKET_PREFIX?: string;
}

const PAID = new Set(PAID_PATHS);

function log(fields: Record<string, unknown>) {
  console.log(JSON.stringify({ evt: "call", ...fields }));
}

function outcome(status: number, paid: boolean): string {
  if (status === 402) return "unpaid";
  if (status >= 500) return "error";
  if (status >= 400) return "bad_request";
  return paid ? "paid" : "free";
}

async function mcpToolName(request: Request): Promise<{ method?: string; tool?: string }> {
  try {
    const body = (await request.clone().json()) as { method?: string; params?: { name?: string } };
    return { method: body.method, tool: body.params?.name };
  } catch {
    return {};
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const started = Date.now();
    const prefix = env.POCKET_PREFIX ? `/${env.POCKET_PREFIX}` : "";

    if (prefix && (url.pathname === prefix || url.pathname.startsWith(prefix + "/"))) {
      url.pathname = url.pathname.slice(prefix.length) || "/";
      const res = await api.fetch(new Request(url, request), env, ctx);
      if (PAID.has(url.pathname)) log({ via: "pocket", path: url.pathname, status: res.status, outcome: outcome(res.status, false), ms: Date.now() - started });
      return res;
    }

    if (url.pathname === "/mcp") {
      const { method, tool } = request.method === "POST" ? await mcpToolName(request) : {};
      const res = await handleMcp(request, env);
      if (method === "tools/call") {
        // MCP payment status lives in the JSON-RPC result; HTTP status is 200 either way.
        const text = await res.clone().text();
        const result = text.includes('"isError":true') ? (text.includes("Payment required") ? "unpaid" : "tool_error") : text.includes(FREE_META) ? "free_tier" : "paid";
        log({ via: "mcp", path: tool ?? "?", status: res.status, outcome: result, ms: Date.now() - started });
      } else if (method === "tools/list") log({ via: "mcp", path: "tools/list", status: res.status, outcome: "free", ms: Date.now() - started });
      return res;
    }

    const res = await paidApp(env).fetch(request, env, ctx);
    if (request.method === "POST" && PAID.has(url.pathname)) {
      log({ via: "http", path: url.pathname, status: res.status, outcome: outcome(res.status, Boolean(env.PAY_TO)), ms: Date.now() - started });
    }
    return res;
  },
};
