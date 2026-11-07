// Classifies each paid-route call for the usage logs. "paid" requires proof of settlement, so a broken payment
// flow shows up as its own outcome instead of hiding among real payments.
import { FREE_META } from "./mcp";

/** HTTP outcome. "paid" only when x402 actually attached a settlement (PAYMENT-RESPONSE header). */
export function outcome(res: Response, paymentsOn: boolean, request?: Request): string {
  const attempted = Boolean(request?.headers.get("PAYMENT-SIGNATURE") || request?.headers.get("X-PAYMENT"));
  if (res.status === 402) return attempted ? "payment_failed" : "unpaid";
  if (res.status >= 500) return "error";
  if (res.status >= 400) return "bad_request";
  if (!paymentsOn) return "free";
  return res.headers.get("PAYMENT-RESPONSE") ? "paid" : "unverified";
}

export async function mcpRequestInfo(request: Request): Promise<{ method?: string; tool?: string; attempted?: boolean }> {
  try {
    const body = (await request.clone().json()) as { method?: string; params?: { name?: string; _meta?: Record<string, unknown> } };
    return { method: body.method, tool: body.params?.name, attempted: Boolean(body.params?._meta?.["x402/payment"]) };
  } catch {
    return {};
  }
}

/**
 * MCP tools/call outcome, read from the JSON-RPC body (HTTP status is 200 either way). "paid" only with a successful
 * x402 settlement in the result; anything unexpected gets its own label so it shows up in Observability.
 */
export function mcpOutcome(text: string, attempted: boolean): { outcome: string; tx?: string } {
  let msg: any;
  try {
    msg = JSON.parse(text);
  } catch {
    return { outcome: "unparsable" };
  }
  if (msg.error) return { outcome: "rpc_error" }; // protocol-level failure (how the 1.4.0 output-schema bug looked)
  const r = msg.result ?? {};
  const settle = r._meta?.["x402/payment-response"];
  if (r.isError) {
    if (attempted) return { outcome: "payment_failed" };
    return { outcome: String(r.content?.[0]?.text ?? "").includes("Payment required") ? "unpaid" : "tool_error" };
  }
  if (r._meta && FREE_META in r._meta) return { outcome: "free_tier" };
  if (settle?.success) return { outcome: "paid", tx: settle.transaction };
  return { outcome: attempted ? "payment_failed" : "free" };
}

export function safeDecode(header: string | null): { transaction?: string } | undefined {
  if (!header) return undefined;
  try {
    return JSON.parse(atob(header));
  } catch {
    return undefined;
  }
}
