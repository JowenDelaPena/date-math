// Remote MCP server (Streamable HTTP, stateless) exposing the same tools, paid per call via x402 MCP.
// Clients pay with an x402-aware MCP client (e.g. @x402/mcp createx402MCPClient); payment rides in _meta.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createPaymentWrapper } from "@x402/mcp";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { ORIGIN, VERSION } from "./app";
import { InputError } from "./errors";
import { getPayments, inputSchemaFor, outputExampleFor, outputSchemaFor, type Env, type Payments } from "./payments";
import { freeLimit, freeTaker, type QuotaNamespace } from "./quota";
import { TOOLS, type Tool } from "./tools";

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean; _meta?: Record<string, unknown> };

/** Result _meta key carrying how many free calls this client has left today (index.ts logs these as "free_tier"). */
export const FREE_META = "date-math/free_calls_remaining";

export interface McpEnv extends Env {
  FREE_QUOTA?: QuotaNamespace; // Durable Object binding (wrangler.toml); unset = no free tier
  FREE_CALLS_PER_DAY?: string; // free MCP tool calls per IP per UTC day; default 25, "0" = off
}
type Handler = (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<ToolResult>;

function runTool(t: Tool, args: Record<string, unknown>): ToolResult {
  try {
    const out = t.run(args ?? {}) as Record<string, unknown>;
    return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
  } catch (e) {
    const err = e instanceof InputError ? { code: e.code, message: e.message } : { code: "internal_error", message: "unexpected error" };
    return { content: [{ type: "text", text: JSON.stringify({ error: err }) }], isError: true };
  }
}

// Paid handlers are built once per isolate after the facilitator is initialized (inside a request).
let paidCache: { p: Payments; handlers: Map<string, Handler> } | undefined;

async function paidHandlers(p: Payments): Promise<Map<string, Handler>> {
  await p.ensureReady();
  if (paidCache?.p === p) return paidCache.handlers;
  const accepts = await p.server.buildPaymentRequirements({ scheme: "exact", network: p.cfg.X402_NETWORK, payTo: p.cfg.PAY_TO, price: p.cfg.PRICE });
  const handlers = new Map<string, Handler>();
  for (const t of TOOLS) {
    const wrap = createPaymentWrapper(p.server, {
      accepts,
      resource: { url: `mcp://tool/${t.name}`, description: `Date Math: ${t.description}`, mimeType: "application/json", serviceName: "Date Math", tags: ["date", "time", "timezone", "calendar"] },
      extensions: declareDiscoveryExtension({
        toolName: t.name,
        description: t.description,
        transport: "streamable-http",
        inputSchema: inputSchemaFor(t.path),
        example: t.example,
        output: { example: outputExampleFor(t.path), schema: outputSchemaFor(t.path) },
      }),
    });
    handlers.set(t.name, wrap(async (args: Record<string, unknown>) => runTool(t, args)) as unknown as Handler);
  }
  paidCache = { p, handlers };
  return handlers;
}

// Tool listings are static per price: build once per isolate (schema $ref resolution is the expensive part).
const listCache = new Map<string, unknown[]>();
function toolList(price: string | null, free: number) {
  const key = `${price ?? ""}|${free}`;
  let tools = listCache.get(key);
  if (!tools) {
    tools = TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      description: `${t.description}${priceNote(price, free)}`,
      inputSchema: { type: "object" as const, ...inputSchemaFor(t.path) },
      outputSchema: { type: "object" as const, ...outputSchemaFor(t.path) },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    }));
    listCache.set(key, tools);
  }
  return tools;
}

function priceNote(price: string | null, free: number): string {
  if (!price) return "";
  return free ? ` First ${free} calls per day are free, then ${price} per call (x402).` : ` Costs ${price} per call (x402).`;
}

function buildServer(p: Payments | null, free: number, takeFree: (() => Promise<number>) | null): Server {
  const cost = !p ? "Tool calls are free." : free ? `The first ${free} tool calls per day are free; after that each call costs ${p.cfg.PRICE} (x402, USDC on Base).` : `Each tool call costs ${p.cfg.PRICE} (x402, USDC on Base).`;
  const server = new Server({ name: "date-math", title: "Date Math", version: VERSION }, { capabilities: { tools: {} }, instructions: `Exact date/time math. ${cost} Docs: ${ORIGIN}/llms.txt` });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolList(p?.cfg.PRICE ?? null, free) as any }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const t = TOOLS.find((x) => x.name === req.params.name);
    if (!t) return { content: [{ type: "text", text: `unknown tool: ${req.params.name}` }], isError: true };
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    if (!p) return runTool(t, args);
    // Free tier: only when the client sent no payment (a paying client never burns free calls).
    if (takeFree && !req.params._meta?.["x402/payment"]) {
      const left = await takeFree();
      if (left >= 0) return { ...runTool(t, args), _meta: { [FREE_META]: left } };
    }
    let handlers: Map<string, Handler>;
    try {
      handlers = await paidHandlers(p);
    } catch (err) {
      console.error("x402 init failed", err);
      return { content: [{ type: "text", text: "payment facilitator unreachable, try again shortly" }], isError: true };
    }
    return handlers.get(t.name)!(args, { ...extra, _meta: req.params._meta });
  });
  return server;
}

export async function handleMcp(request: Request, env: McpEnv): Promise<Response> {
  if (request.method === "GET" || request.method === "DELETE") {
    // Stateless server: no standalone SSE stream or sessions.
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: POST JSON-RPC to /mcp" }, id: null }), {
      status: 405,
      headers: { "Content-Type": "application/json", Allow: "POST" },
    });
  }
  const p = getPayments(env);
  const takeFree = p ? freeTaker(env.FREE_QUOTA, env.FREE_CALLS_PER_DAY, request) : null;
  const server = buildServer(p, takeFree ? freeLimit(env.FREE_CALLS_PER_DAY) : 0, takeFree);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}
