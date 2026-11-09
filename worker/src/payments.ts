// x402 pay-per-call for direct (non-Pocket) access. Payments go straight to PAY_TO in USDC.
import { Hono } from "hono";
import { paymentMiddlewareFromHTTPServer, x402HTTPResourceServer, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient, type RoutesConfig } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { api } from "./app";
import { CDP_FACILITATOR_URL, cdpAuthHeaders } from "./cdp";
import outputExamples from "./output-examples.json";
import spec from "./openapi.json";
import { SEARCH_TAGS } from "./tags";

/** Public PNG icon for Bazaar listings (served by app.ts at /icon.png). */
export const ICON_URL = "https://date-math.datemath.workers.dev/icon.png";
import { PAID_PATHS, TOOLS } from "./tools";

export interface Env {
  PAY_TO?: string; // your wallet (0x...). Unset = payments off (everything free).
  PRICE?: string; // per call, e.g. "$0.001"
  X402_NETWORK?: string; // CAIP-2: eip155:8453 = Base mainnet, eip155:84532 = Base Sepolia (test)
  FACILITATOR_URL?: string; // verifies + settles payments; must support the network above
  PUBLIC_URL?: string; // canonical origin, used in discovery metadata
  CDP_API_KEY_ID?: string; // optional secret: settle via Coinbase CDP first (lists you in Coinbase's Bazaar)
  CDP_API_KEY_SECRET?: string; // optional secret: base64 Ed25519 key
}

export interface PayConfig {
  PAY_TO: string;
  PRICE: string;
  X402_NETWORK: `${string}:${string}`;
  FACILITATOR_URL: string;
  PUBLIC_URL?: string;
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
}

/** Inline OpenAPI $refs so each tool ships a self-contained JSON Schema. */
export function resolveRefs(node: unknown, depth = 0): unknown {
  if (depth > 12 || node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((n) => resolveRefs(n, depth + 1));
  const obj = node as Record<string, unknown>;
  if (typeof obj.$ref === "string") {
    const target = obj.$ref.replace(/^#\//, "").split("/").reduce<any>((o, k) => o?.[k], spec);
    return resolveRefs(target, depth + 1);
  }
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolveRefs(v, depth + 1)]));
}
const op = (path: string) => (spec.paths as any)[path].post;
// Resolved schemas are memoized per isolate (resolving $refs is the expensive part) and warmed at startup in mcp.ts.
const schemaCache = new Map<string, Record<string, unknown>>();
const memo = (key: string, build: () => unknown) => {
  let v = schemaCache.get(key);
  if (!v) schemaCache.set(key, (v = build() as Record<string, unknown>));
  return v;
};
export const inputSchemaFor = (path: string) => memo("in " + path, () => resolveRefs(op(path).requestBody.content["application/json"].schema));
/** Complete output example for a tool (generated; see test/output-examples.test.ts). Bazaars reject incomplete ones. */
export const outputExampleFor = (path: string) => (outputExamples as Record<string, unknown>)[path];
export const outputSchemaFor = (path: string) => memo("out " + path, () => resolveRefs(op(path).responses["200"].content["application/json"].schema));

export function payConfig(env: Env): PayConfig | null {
  if (!env.PAY_TO) return null;
  return {
    PAY_TO: env.PAY_TO,
    PRICE: env.PRICE || "$0.001",
    X402_NETWORK: (env.X402_NETWORK || "eip155:8453") as `${string}:${string}`,
    FACILITATOR_URL: env.FACILITATOR_URL || "https://facilitator.payai.network",
    PUBLIC_URL: env.PUBLIC_URL,
    CDP_API_KEY_ID: env.CDP_API_KEY_ID,
    CDP_API_KEY_SECRET: env.CDP_API_KEY_SECRET,
  };
}

export function buildRoutes(cfg: PayConfig): RoutesConfig {
  const routes: RoutesConfig = {};
  for (const t of TOOLS) {
    routes[`POST ${t.path}`] = {
      accepts: { scheme: "exact", price: cfg.PRICE, network: cfg.X402_NETWORK, payTo: cfg.PAY_TO },
      description: `Date Math: ${t.description}`,
      mimeType: "application/json",
      serviceName: "Date Math",
      tags: SEARCH_TAGS[t.name],
      iconUrl: ICON_URL, // Bazaar / Agentic.Market listing icon (read at settle time)
      ...(cfg.PUBLIC_URL ? { resource: cfg.PUBLIC_URL + t.path } : {}),
      unpaidResponseBody: () => ({
        contentType: "application/json",
        body: { error: { code: "payment_required", message: `This call costs ${cfg.PRICE} in USDC via x402. See the PAYMENT-REQUIRED header.` } },
      }),
      extensions: declareDiscoveryExtension({
        bodyType: "json",
        input: t.example,
        inputSchema: inputSchemaFor(t.path),
        output: { example: outputExampleFor(t.path), schema: outputSchemaFor(t.path) },
      }),
    };
  }
  return routes;
}

/** One x402 resource server per isolate+config, shared by HTTP and MCP. */
export interface Payments {
  cfg: PayConfig;
  server: x402ResourceServer;
  httpServer: x402HTTPResourceServer;
  /** Initialize inside the current request (Workers forbid awaiting another request's I/O). Caches only the outcome. */
  ensureReady(): Promise<void>;
}

let cached: { key: string; payments: Payments } | undefined;

export function getPayments(env: Env): Payments | null {
  const cfg = payConfig(env);
  if (!cfg) return null;
  const key = JSON.stringify(cfg);
  if (cached?.key === key) return cached.payments;

  // First facilitator that supports the network settles; others are fallbacks (e.g. if CDP auth fails).
  const facilitators = [new HTTPFacilitatorClient({ url: cfg.FACILITATOR_URL })];
  if (cfg.CDP_API_KEY_ID && cfg.CDP_API_KEY_SECRET) {
    facilitators.unshift(new HTTPFacilitatorClient({ url: CDP_FACILITATOR_URL, createAuthHeaders: cdpAuthHeaders(cfg.CDP_API_KEY_ID, cfg.CDP_API_KEY_SECRET) }));
  }
  const server = new x402ResourceServer(facilitators)
    .register(cfg.X402_NETWORK, new ExactEvmScheme())
    .registerExtension(bazaarResourceServerExtension);
  const httpServer = new x402HTTPResourceServer(server, buildRoutes(cfg));
  let ready = false;
  const payments: Payments = {
    cfg,
    server,
    httpServer,
    async ensureReady() {
      if (ready) return;
      await httpServer.initialize(); // fetches the facilitator's /supported kinds
      ready = true;
    },
  };
  cached = { key, payments };
  return payments;
}

let appCache: { p: Payments; app: Hono } | undefined;

/** The paid HTTP app for this env. Without PAY_TO, the free API. */
export function paidApp(env: Env): Hono {
  const p = getPayments(env);
  if (!p) return api;
  if (appCache?.p === p) return appCache.app;

  // syncFacilitatorOnStart=false: the built-in sync creates its promise in one request and awaits it in
  // others, which hangs on Workers. ensureReady() runs inside each request instead.
  const mw = paymentMiddlewareFromHTTPServer(p.httpServer, undefined, undefined, false);
  const paid = new Set(PAID_PATHS);
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (c.req.method !== "POST" || !paid.has(c.req.path)) return next(); // probes/spec stay free and fast
    try {
      await p.ensureReady();
    } catch (err) {
      console.error("x402 facilitator init failed", err);
      return c.json({ error: { code: "payments_unavailable", message: "payment facilitator unreachable, try again shortly" } }, 503);
    }
    return mw(c, next);
  });
  app.route("/", api);
  app.notFound((c) => c.json({ error: { code: "not_found", message: `no route for ${c.req.method} ${c.req.path}; see /openapi.json` } }, 404));
  appCache = { p, app };
  return app;
}
