#!/usr/bin/env node
// date-math-mcp: a local stdio MCP server that forwards every request to the hosted Date Math server
// (https://date-math.datemath.workers.dev/mcp). It lets any MCP app that only runs local commands use Date Math.
//
// Free: the first 25 tool calls per day (per IP) need nothing.
// Paid (optional): set DATE_MATH_PRIVATE_KEY to a wallet key holding a little USDC on Base and calls beyond the
// free tier are paid automatically with x402, at most DATE_MATH_MAX_PRICE per call (default $0.001).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const URL_ = process.env.DATE_MATH_URL || "https://date-math.datemath.workers.dev/mcp";
const KEY = process.env.DATE_MATH_PRIVATE_KEY?.trim();
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const log = (msg) => process.stderr.write(`[date-math-mcp] ${msg}\n`); // stdout belongs to the MCP protocol

/** "$0.001" -> 1000 (USDC has 6 decimals). */
function usdcUnits(price) {
  const m = /^\$?(\d+(?:\.\d{1,6})?)$/.exec(String(price).trim());
  if (!m) throw new Error(`DATE_MATH_MAX_PRICE must look like $0.001, got ${price}`);
  const [whole, frac = ""] = m[1].split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
}

async function connectUpstream() {
  const transport = new StreamableHTTPClientTransport(new URL(URL_));
  const info = { name: "date-math-mcp", version };
  if (!KEY) {
    const client = new Client(info);
    await client.connect(transport);
    return client;
  }
  // Payment libraries load only when a key is configured.
  const [{ createx402MCPClient }, { ExactEvmScheme }, { privateKeyToAccount }] = await Promise.all([
    import("@x402/mcp"),
    import("@x402/evm/exact/client"),
    import("viem/accounts"),
  ]);
  const account = privateKeyToAccount(KEY.startsWith("0x") ? KEY : `0x${KEY}`);
  const max = usdcUnits(process.env.DATE_MATH_MAX_PRICE || "$0.001");
  log(`paid calls enabled from wallet ${account.address} (max ${process.env.DATE_MATH_MAX_PRICE || "$0.001"} per call)`);
  const client = createx402MCPClient({
    ...info,
    schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(account) }],
    autoPayment: true,
    // Only ever pay in USDC on Base, and never more than the configured cap.
    onPaymentRequested: ({ paymentRequired }) =>
      paymentRequired.accepts.some((a) => a.network === "eip155:8453" && a.asset?.toLowerCase() === BASE_USDC.toLowerCase() && BigInt(a.amount) <= max),
  });
  await client.connect(transport);
  return client;
}

let upstream;
const ready = () => (upstream ??= connectUpstream().catch((e) => ((upstream = undefined), Promise.reject(e))));

const server = new Server({ name: "date-math", title: "Date Math", version }, { capabilities: { tools: {} }, instructions: "Exact date/time math. The first 25 tool calls per day are free. Docs: https://date-math.datemath.workers.dev/llms.txt" });

server.setRequestHandler(ListToolsRequestSchema, async () => (await ready()).listTools());

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  let client;
  try {
    client = await ready();
  } catch (e) {
    return { content: [{ type: "text", text: `Date Math is unreachable (${e.message}). Try again shortly.` }], isError: true };
  }
  let r;
  try {
    r = await client.callTool(KEY ? req.params.name : { name: req.params.name, arguments: req.params.arguments }, KEY ? req.params.arguments : undefined);
  } catch (e) {
    return { content: [{ type: "text", text: `Date Math call failed: ${e.message}` }], isError: true };
  }
  const out = { content: r.content, isError: r.isError };
  if (r.structuredContent) out.structuredContent = r.structuredContent;
  if (r._meta) out._meta = r._meta;
  if (r.isError && !KEY && JSON.stringify(r.content).includes("Payment required")) {
    out.content = [...r.content, { type: "text", text: "Today's free calls are used up. They reset at 00:00 UTC, or set DATE_MATH_PRIVATE_KEY (a wallet with USDC on Base) to pay $0.001 per call: https://github.com/JowenDelaPena/date-math#use-it-in-your-app" }];
  }
  return out;
});

await server.connect(new StdioServerTransport());
