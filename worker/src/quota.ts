// Free MCP tier: a small number of free tool calls per client IP per UTC day, so MCP apps that can't pay
// x402 yet (Claude Desktop, Cursor, ...) can try the tools. After that, calls are paid as usual.
//
// Only MCP gets the free tier. Plain HTTP routes always answer unpaid calls with 402, because x402
// discovery (x402scan, Coinbase and PayAI Bazaars) probes them and expects a 402.
//
// Storage: one SQLite-backed Durable Object per IP (or IPv6 /64), holding only {day, count}. The IP
// itself is never stored: idFromName hashes it. Durable Objects are on the Workers Free plan.
// Written as a classic fetch() Durable Object so the module has no `cloudflare:workers` import (vitest runs in Node).

/** The parts of the Durable Object APIs we use (avoids a @cloudflare/workers-types dependency). */
interface DOStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}
interface DOState {
  storage: DOStorage;
}
export interface QuotaNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
}

export const DEFAULT_FREE_CALLS = 25;

export class FreeQuota {
  constructor(private state: DOState) {}

  /** POST {day, limit} -> {remaining}: remaining free calls after taking one, or -1 if none were left. */
  async fetch(request: Request): Promise<Response> {
    const { day, limit } = (await request.json()) as { day: string; limit: number };
    const cur = await this.state.storage.get<{ day: string; n: number }>("q");
    const used = cur?.day === day ? cur.n : 0;
    if (used >= limit) return Response.json({ remaining: -1 });
    await this.state.storage.put("q", { day, n: used + 1 });
    return Response.json({ remaining: limit - used - 1 });
  }
}

/** Rate-limit key for an IP: IPv4 as is, IPv6 by its /64 (one household or server usually owns a whole /64). */
export function clientKey(ip: string | null): string | null {
  if (!ip) return null;
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = ip.includes("::") && tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

export function freeLimit(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_FREE_CALLS;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * Returns a function that takes one free call for this request's client, resolving to the free calls left
 * afterwards, or -1 when none are left (or the tier is off or unavailable; then the call is paid as usual).
 */
export function freeTaker(ns: QuotaNamespace | undefined, rawLimit: string | undefined, request: Request): (() => Promise<number>) | null {
  const limit = freeLimit(rawLimit);
  const key = clientKey(request.headers.get("CF-Connecting-IP"));
  if (!ns || !limit || !key) return null;
  return async () => {
    try {
      const res = await ns.get(ns.idFromName(key)).fetch("https://quota/take", {
        method: "POST",
        body: JSON.stringify({ day: new Date().toISOString().slice(0, 10), limit }),
      });
      return ((await res.json()) as { remaining: number }).remaining;
    } catch (err) {
      console.error("free quota unavailable", err);
      return -1;
    }
  };
}
