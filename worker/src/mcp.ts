// Remote MCP server (Streamable HTTP, stateless) exposing the same tools, paid per call via x402 MCP.
// Clients pay with an x402-aware MCP client (e.g. @x402/mcp createx402MCPClient); payment rides in _meta.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  InitializeRequestSchema,
  JSONRPCMessageSchema,
  LATEST_PROTOCOL_VERSION,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";
import { createPaymentWrapper } from "@x402/mcp";
import { declareDiscoveryExtension } from "./bazaar";
import { ORIGIN, VERSION } from "./app";
import { InputError } from "./errors";
import { getPayments, ICON_URL, inputSchemaFor, outputExampleFor, outputSchemaFor, type Env, type Payments } from "./payments";
import { freeLimit, freeTaker, type QuotaNamespace } from "./quota";
import { SEARCH_TAGS } from "./tags";
import { FREE_TOOLS, TOOLS, type Tool } from "./tools";

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean; _meta?: Record<string, unknown> };

/** Result _meta key carrying how many free calls this client has left today (index.ts logs these as "free_tier"). */
export const FREE_META = "date-math/free_calls_remaining";

export interface McpEnv extends Env {
  FREE_QUOTA?: QuotaNamespace; // Durable Object binding (wrangler.toml); unset = no free tier
  FREE_CALLS_PER_DAY?: string; // free MCP tool calls per IP per UTC day; default 25, "0" = off
}
type Handler = (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<ToolResult>;

function runTool(t: Pick<Tool, "run" | "example">, args: Record<string, unknown>): ToolResult {
  try {
    const out = t.run(args ?? {}) as Record<string, unknown>;
    return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
  } catch (e) {
    const err = e instanceof InputError ? { code: e.code, message: e.message, example: t.example } : { code: "internal_error", message: "unexpected error" };
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
      resource: { url: `mcp://tool/${t.name}`, description: `Date Math: ${t.description}`, mimeType: "application/json", serviceName: "Date Math", tags: SEARCH_TAGS[t.name], iconUrl: ICON_URL },
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
    for (const f of FREE_TOOLS) {
      tools.push({
        name: f.name,
        title: f.title,
        description: f.description,
        inputSchema: f.inputSchema as any,
        outputSchema: f.outputSchema as any,
        annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: false },
      });
    }
    listCache.set(key, tools);
  }
  return tools;
}

function priceNote(price: string | null, free: number): string {
  if (!price) return "";
  return free ? ` First ${free} calls per day are free, then ${price} per call (x402).` : ` Costs ${price} per call (x402).`;
}

const SERVER_INFO = { name: "date-math", title: "Date Math", version: VERSION };

function instructionsFor(p: Payments | null, free: number): string {
  const cost = !p ? "Tool calls are free." : free ? `The first ${free} tool calls per day are free; after that each call costs ${p.cfg.PRICE} (x402, USDC on Base).` : `Each tool call costs ${p.cfg.PRICE} (x402, USDC on Base).`;
  return `Exact date/time math. ${cost} Docs: ${ORIGIN}/llms.txt`;
}

function buildServer(p: Payments | null, free: number, takeFree: (() => Promise<number>) | null): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} }, instructions: instructionsFor(p, free) });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolList(p?.cfg.PRICE ?? null, free) as any }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const f = FREE_TOOLS.find((x) => x.name === req.params.name);
    if (f) return runTool(f, args); // free tools: never paid, never counted against the free tier
    const t = TOOLS.find((x) => x.name === req.params.name);
    if (!t) return { content: [{ type: "text", text: `unknown tool: ${req.params.name}` }], isError: true };
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
    let res = await handlers.get(t.name)!(args, { ...extra, _meta: req.params._meta });
    // When a facilitator answers verify with an HTTP error (Coinbase does this for e.g. insufficient funds),
    // @x402/mcp swallows the reason and returns a bare "Internal Server Error". Give the agent fresh terms and a
    // usable reason instead, so its wallet can top up and retry. HTTP keeps the facilitator's own message.
    if (res.isError && res.content?.[0]?.text === "Internal Server Error" && !res._meta?.["x402/payment-response"]) {
      console.error(JSON.stringify({ evt: "payment_alert", via: "mcp", path: t.name, outcome: "verify_error" }));
      const terms = await handlers.get(t.name)!(args, { ...extra, _meta: undefined }); // unpaid: terms only, no facilitator call
      try {
        const body = JSON.parse(terms.content[0].text);
        body.error = "payment_verification_failed: the payment could not be verified. Check that the wallet holds enough USDC on Base, then retry.";
        res = { content: [{ type: "text", text: JSON.stringify(body) }], isError: true };
      } catch {
        // keep the original result
      }
    }
    // x402 puts the payment terms (and settlement errors) in structuredContent as well as content[0].text. The MCP
    // SDK client validates structuredContent against the tool's outputSchema even when isError is set, so once it
    // has seen tools/list it throws -32602 instead of returning "Payment required", and x402 clients never pay.
    // content[0].text is the channel the x402 MCP spec requires, so drop the structured copy on errors.
    if (res.isError && res.structuredContent) {
      const { structuredContent: _, ...rest } = res;
      res = rest;
    }
    // A client without a wallet only sees the JSON terms. Add a plain explanation as a second content item for the
    // agent and the person using it. x402 clients read the terms from content[0] only, so paying is unaffected.
    if (res.isError && !req.params._meta?.["x402/payment"] && isPaymentTerms(res.content?.[0]?.text)) {
      // free > 0 only when this client had a free allowance (known IP and quota store), so reaching paid terms means it is used up.
      res = { ...res, content: [...res.content, { type: "text", text: paymentHelp(p.cfg.PRICE, free) }] };
    }
    return res;
  });
  return server;
}

function isPaymentTerms(text: string | undefined): boolean {
  try {
    const j = JSON.parse(text ?? "");
    return typeof j === "object" && j !== null && "x402Version" in j && Array.isArray(j.accepts);
  } catch {
    return false;
  }
}

/** What an unpaid caller is told when a tool call needs payment. */
export function paymentHelp(price: string, free: number): string {
  const why = free
    ? `This client has used its ${free} free Date Math calls for today (they reset at 00:00 UTC).`
    : "This Date Math tool is paid.";
  return `Payment required. ${why} Each further call costs ${price} in USDC on Base, paid per call with x402: an x402-enabled MCP client or wallet (for example @x402/mcp) pays automatically, no account or API key needed. current_time stays free. Setup: ${ORIGIN}/llms.txt`;
}

type Json = Record<string, any>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Fast path for the hot, simple MCP messages: initialize, ping, notifications, tools/list, and tool calls that are
 * free (payments off, or covered by the free tier). It answers exactly like the SDK (same JSON shape and headers)
 * without building an SDK Server/transport per request, which cost 15–30 ms CPU on each fresh isolate.
 * Returns null for anything else (paid calls, batches, odd input), which then goes through the full SDK.
 */
async function fastPath(request: Request, p: Payments | null, free: number, takeFree: (() => Promise<number>) | null, onFreeExhausted: () => void): Promise<Response | null> {
  const accept = request.headers.get("Accept") ?? "";
  if (!accept.includes("application/json") || !accept.includes("text/event-stream")) return null;
  if (!(request.headers.get("Content-Type") ?? "").includes("application/json")) return null;
  const version = request.headers.get("MCP-Protocol-Version");
  if (version && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) return null;

  let msg: unknown;
  try {
    msg = await request.clone().json();
  } catch {
    return null;
  }
  if (!isObj(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return null;
  if (!("id" in msg)) return msg.method.startsWith("notifications/") ? new Response(null, { status: 202 }) : null;
  if (typeof msg.id !== "string" && typeof msg.id !== "number") return null;
  const params = msg.params === undefined ? {} : msg.params;
  if (!isObj(params)) return null;
  const reply = (result: unknown) => new Response(JSON.stringify({ result, jsonrpc: "2.0", id: msg.id }), { headers: { "content-type": "application/json" } });

  switch (msg.method) {
    case "initialize": {
      const v = params.protocolVersion;
      if (typeof v !== "string" || !isObj(params.capabilities) || !isObj(params.clientInfo)) return null;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(v) ? v : LATEST_PROTOCOL_VERSION;
      return reply({ protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: instructionsFor(p, free) });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: toolList(p?.cfg.PRICE ?? null, free) });
    case "tools/call": {
      const args = params.arguments === undefined ? {} : params.arguments;
      if (typeof params.name !== "string" || !isObj(args)) return null;
      const f = FREE_TOOLS.find((x) => x.name === params.name);
      if (f) return reply(runTool(f, args));
      const t = TOOLS.find((x) => x.name === params.name);
      if (!t) return reply({ content: [{ type: "text", text: `unknown tool: ${params.name}` }], isError: true });
      if (!p) return reply(runTool(t, args));
      if (!takeFree || (isObj(params._meta) && params._meta["x402/payment"])) return null; // paid: x402 via the SDK
      const left = await takeFree();
      if (left < 0) {
        onFreeExhausted(); // nothing was taken; let the SDK path ask for payment without re-checking the quota
        return null;
      }
      return reply({ ...runTool(t, args), _meta: { [FREE_META]: left } });
    }
  }
  return null;
}

export async function handleMcp(request: Request, env: McpEnv, opts: { sdkOnly?: boolean } = {}): Promise<Response> {
  if (request.method === "GET" || request.method === "DELETE") {
    // Stateless server: no standalone SSE stream or sessions.
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: POST JSON-RPC to /mcp" }, id: null }), {
      status: 405,
      headers: { "Content-Type": "application/json", Allow: "POST" },
    });
  }
  const p = getPayments(env);
  let takeFree = p ? freeTaker(env.FREE_QUOTA, env.FREE_CALLS_PER_DAY, request) : null;
  const free = takeFree ? freeLimit(env.FREE_CALLS_PER_DAY) : 0;
  if (!opts.sdkOnly) {
    const fast = await fastPath(request, p, free, takeFree, () => (takeFree = null));
    if (fast) return fast;
  }
  const server = buildServer(p, free, takeFree);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}

// ---- Startup warm-up ----
// Cloudflare runs many isolates, and each one's first MCP request used to pay 20–60 ms of one-time setup
// (resolving schemas, zod compiling the MCP message schemas, JIT of the tools). Startup has its own, larger
// CPU budget than a request, so do that work here and keep requests at a few ms on the free plan.
for (const t of TOOLS) {
  inputSchemaFor(t.path);
  outputSchemaFor(t.path);
  try {
    t.run(t.example);
  } catch {
    // examples are tested; never let warm-up break startup
  }
}
toolList("$0.001", 25);
{
  const base = { jsonrpc: "2.0", id: 0 };
  const call = { ...base, method: "tools/call", params: { name: "date_info", arguments: { date: "2026-01-01" } } };
  JSONRPCMessageSchema.safeParse(call);
  CallToolRequestSchema.safeParse(call);
  ListToolsRequestSchema.safeParse({ ...base, method: "tools/list", params: {} });
  InitializeRequestSchema.safeParse({ ...base, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "warm", version: "1" } } });
  CallToolResultSchema.safeParse(runTool(TOOLS[0], TOOLS[0].example));
  ListToolsResultSchema.safeParse({ tools: toolList("$0.001", 25) });
}
