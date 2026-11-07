import { Hono, type Context } from "hono";
import { InputError } from "./errors";
import spec from "./openapi.json";
import { TOOLS } from "./tools";

// The free API (no payments). index.ts wraps it with x402 for direct paid access and adds /mcp.
export const SERVICE = "date-math";
export const VERSION = "1.2.0";
export const ORIGIN = "https://date-math.datemath.workers.dev";
const specBody = JSON.stringify(spec);

const app = new Hono();

// Pocket backend rules: JSON object bodies only, no compression, no auth.
app.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store, no-transform");
  c.header("Content-Encoding", "identity"); // tells Cloudflare not to gzip/brotli the body
});

const fail = (c: Context, status: 400 | 404 | 405 | 413 | 500, code: string, message: string) =>
  c.json({ error: { code, message } }, status);

export function parseBody(text: string): Record<string, unknown> {
  if (text.length > 64 * 1024) throw new InputError("body_too_large", "request body must be under 64 KiB");
  let body: unknown;
  try {
    body = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    throw new InputError("invalid_json", "request body must be valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InputError("invalid_json", "request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

// Human-readable overview (card "docs" URL). Still a JSON object, per Pocket backend rules.
app.get("/", (c) =>
  c.json({
    service: SERVICE,
    name: "Date Math",
    version: VERSION,
    description: "Deterministic date and time math for AI agents. POST a JSON body; every response is a JSON object.",
    spec: "/openapi.json",
    mcp: `${ORIGIN}/mcp (Streamable HTTP; first 25 tool calls per day free, then paid per call via x402 MCP)`,
    endpoints: Object.fromEntries(TOOLS.map((t) => [`POST ${t.path}`, { mcp_tool: t.name, description: t.description, example: t.example }])),
    free: ["GET /v1/version", "GET /v1/health", "GET /openapi.json", "GET /llms.txt", "GET /.well-known/x402"],
    errors: '{"error":{"code","message"}} with HTTP 400/404/413',
    payment:
      "Pay per call with x402 v2 (USDC on Base, $0.001). POST without payment returns 402 with terms in the PAYMENT-REQUIRED header; retry with PAYMENT-SIGNATURE.",
  }),
);
app.get("/v1/version", (c) => c.json({ service: SERVICE, version: VERSION }));
app.get("/v1/health", (c) => c.json({ status: "ok" }));
const serveSpec = (c: Context) => c.body(specBody, 200, { "Content-Type": "application/json" });
app.get("/openapi.json", serveSpec);
app.get("/v1/openapi.json", serveSpec);

// ---- Agent discovery (free) ----
// x402scan compatibility fan-out: https://x402scan.com/discovery/spec
app.get("/.well-known/x402", (c) => c.json({ version: 1, resources: TOOLS.map((t) => ORIGIN + t.path) }));

// llms.txt: plain-language guide for LLM agents (https://llmstxt.org)
const LLMS_TXT = `# Date Math

> Deterministic date and time math for AI agents: business days with country holidays, date arithmetic, DST-aware time-zone conversion, meeting-time overlap, cron schedules and natural-language date parsing. Use it instead of computing dates yourself; LLM date math is error-prone.

Base URL: ${ORIGIN}
Payment: x402 v2, $0.001 per call in USDC on Base (eip155:8453). An unpaid call returns HTTP 402 with terms in the PAYMENT-REQUIRED header; pay and retry with PAYMENT-SIGNATURE. Any x402 client (e.g. @x402/fetch) handles this automatically.
MCP: ${ORIGIN}/mcp (Streamable HTTP). Same tools. The first 25 tool calls per day per IP are free, so any MCP client can try them; after that, calls are paid via x402 MCP (e.g. @x402/mcp client). Plain HTTP calls are always paid.
All HTTP calls: POST a JSON body, get a JSON object back. Errors: {"error":{"code","message"}}.

## Tools

${TOOLS.map((t) => `- [POST ${t.path}](${ORIGIN}/openapi.json) (MCP: ${t.name}): ${t.description} Example body: ${JSON.stringify(t.example)}`).join("\n")}

## Free

- [OpenAPI spec](${ORIGIN}/openapi.json)
- [x402 resources](${ORIGIN}/.well-known/x402)
- GET /v1/health, GET /v1/version
`;
app.get("/llms.txt", (c) => c.text(LLMS_TXT));

for (const t of TOOLS) app.post(t.path, async (c) => c.json(t.run(parseBody(await c.req.text())) as object));

app.notFound((c) => fail(c, 404, "not_found", `no route for ${c.req.method} ${c.req.path}; see /openapi.json`));
app.onError((err, c) => {
  if (err instanceof InputError) return fail(c, err.code === "body_too_large" ? 413 : 400, err.code, err.message);
  console.error(err);
  return fail(c, 500, "internal_error", "unexpected error");
});

export const api = app;
export default app;
