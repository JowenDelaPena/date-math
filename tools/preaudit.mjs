#!/usr/bin/env node
// Pre-audit for a Pocket Network service card, mirroring Service Audit rules A1–A9.
// Read-only: it only GETs the public chain REST API and calls your backend's probes.
// It is NOT the official audit; run that too before requesting a listing.
//
// Usage (from repo root):
//   node tools/preaudit.mjs [--card pocket/card.json] [--service date-math] [--name "Date Math"]
//                           [--cu 100000] [--network main|beta] [--backend https://host]
import { readFileSync } from "node:fs";
import { isIP } from "node:net";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const CARD = args.card ?? new URL("../pocket/card.json", import.meta.url);
const SERVICE = args.service ?? "date-math";
const NAME = args.name ?? "Date Math";
const CU = Number(args.cu ?? 100000);
const NETWORK = args.network ?? "main";
const REST = {
  main: "https://sauron-api.infra.pocket.network/pokt-network/poktroll",
  beta: "https://sauron-api.beta.infra.pocket.network/pokt-network/poktroll",
}[NETWORK];
if (!REST) throw new Error("--network must be main or beta");

const results = [];
const report = (rule, status, msg) => results.push({ rule, status, msg });
const PASS = "PASS", FAIL = "FAIL", WARN = "WARN", PEND = "PENDING";

async function getJson(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = undefined; }
  return { status: res.status, text, body, headers: res.headers };
}

function jsonPath(obj, path) {
  // Supports $.a.b and $.a[0].b
  if (!path.startsWith("$")) return undefined;
  const parts = path.slice(1).match(/\.[A-Za-z0-9_-]+|\[\d+\]/g) ?? [];
  return parts.reduce((o, p) => (o == null ? undefined : p.startsWith("[") ? o[Number(p.slice(1, -1))] : o[p.slice(1)]), obj);
}

function checkUrl(rule, label, url) {
  let u;
  try { u = new URL(url); } catch { return report(rule, FAIL, `${label}: not a URL (${url})`), false; }
  if (u.protocol !== "https:") return report(rule, FAIL, `${label}: must be https:// (${url})`), false;
  if (isIP(u.hostname.replace(/^\[|\]$/g, ""))) return report(rule, FAIL, `${label}: must be a hostname, not an IP (${url})`), false;
  return true;
}

// ---------- A2: card ----------
const raw = readFileSync(CARD);
let card;
try { card = JSON.parse(raw.toString("utf8")); } catch (e) { report("A2", FAIL, `card is not valid JSON: ${e.message}`); }
if (card) {
  const minified = Buffer.byteLength(JSON.stringify(card));
  if (card.schema !== "pocket-service-card/v1") report("A2", FAIL, `schema must be "pocket-service-card/v1"`);
  else if (raw.length >= 4096) report("A2", minified < 4096 ? WARN : FAIL, `card file is ${raw.length} B (limit 4 KiB); minified ${minified} B${minified < 4096 ? " — submit minified" : ""}`);
  else report("A2", PASS, `valid pocket-service-card/v1, ${raw.length} B (minified ${minified} B) < 4096`);
  if ((card.description ?? "").length > 2048) report("A2", FAIL, `description is ${card.description.length} chars (max 2048)`);
  if (raw.toString().includes("REPLACE_")) report("A2", FAIL, "card still contains REPLACE_ placeholders (set your Worker host)");
}

// ---------- chain data ----------
let services = [];
try {
  const r = await getJson(`${REST}/service/service?pagination.limit=1000`);
  services = r.body?.service ?? [];
} catch (e) {
  report("CHAIN", WARN, `could not read services from ${NETWORK}: ${e.message}`);
}
const decode = (s) => { try { return JSON.parse(Buffer.from(s.metadata?.card ?? "", "base64").toString()); } catch { return null; } };
const others = services.filter((s) => s.id !== SERVICE);

// ---------- A1: registration ----------
const mine = services.find((s) => s.id === SERVICE);
if (!mine) report("A1", PEND, `service "${SERVICE}" not registered on ${NETWORK} yet (scripts/register.sh ${NETWORK})`);
else {
  const onchain = decode(mine);
  const same = card && onchain && JSON.stringify(onchain) === JSON.stringify(card);
  report("A1", PASS, `registered: name "${mine.name}", ${mine.compute_units_per_relay} CU, owner ${mine.owner_address}`);
  if (!same) report("A1", WARN, "on-chain card differs from local card (re-run add-service to update)");
  if (Number(mine.compute_units_per_relay) !== CU) report("A1", WARN, `on-chain CU ${mine.compute_units_per_relay} != --cu ${CU}`);
}

// ---------- A3: api uniqueness ----------
if (card) {
  const apis = card.apis ?? [];
  const dup = apis.filter((a, i) => apis.indexOf(a) !== i);
  const claimed = new Map();
  for (const s of others) for (const a of decode(s)?.apis ?? []) claimed.set(a, s.id);
  const clash = apis.filter((a) => claimed.has(a));
  if (!apis.length) report("A3", WARN, "card has no apis[]");
  else if (dup.length) report("A3", FAIL, `duplicate apis: ${dup.join(", ")}`);
  else if (clash.length) report("A3", FAIL, clash.map((a) => `"${a}" already claimed by ${claimed.get(a)}`).join("; "));
  else report("A3", PASS, `apis ${JSON.stringify(apis)} unique across ${others.length} on-chain services`);
}

// ---------- A4 / A5 / A6: suppliers + endpoints ----------
let endpoints = [];
try {
  const r = await getJson(`${REST}/supplier/supplier?service_id=${encodeURIComponent(SERVICE)}&pagination.limit=200`);
  const sups = (r.body?.supplier ?? []).filter((s) => (s.services ?? []).some((x) => x.service_id === SERVICE));
  if (!sups.length) report("A4", PEND, "no supplier staked for this service yet (needs a supplier partner)");
  else report("A4", PASS, `${sups.length} supplier(s) staked: ${sups.map((s) => s.operator_address).join(", ")}`);
  for (const s of sups) for (const x of s.services) if (x.service_id === SERVICE) endpoints.push(...x.endpoints);
} catch (e) {
  report("A4", WARN, `could not query suppliers: ${e.message}`);
}
const rpcTypes = (card?.rpc_types ?? []).map((t) => t.type);
for (const ep of endpoints) {
  if (checkUrl("A5", "supplier endpoint", ep.url)) {
    if (!rpcTypes.includes(ep.rpc_type)) report("A5", FAIL, `endpoint ${ep.url} rpc_type ${ep.rpc_type} not in card rpc_types ${JSON.stringify(rpcTypes)}`);
    else report("A5", PASS, `endpoint ${ep.url} (${ep.rpc_type})`);
    try { await fetch(ep.url, { signal: AbortSignal.timeout(15000) }); report("A6", PASS, `TLS ok: ${ep.url}`); }
    catch (e) { report("A6", FAIL, `TLS/connection failed for ${ep.url}: ${e.cause?.code ?? e.message}`); }
  }
}

// ---------- A8: content quality (probes run against the backend) ----------
const specUrl = card?.specs?.find((s) => s.kind === "openapi")?.url;
const backend = (args.backend ?? (specUrl && !specUrl.includes("REPLACE_") ? new URL(specUrl).origin : "")).replace(/\/$/, "");
if (NAME.trim().length < 3) report("A8", WARN, "display name should be human-readable");
else report("A8", PASS, `display name "${NAME}"`);
const probes = card?.serving?.healthcheck ?? [];
const identity = probes.find((p) => p.expect?.json_path === "$.service" && p.expect?.matches === `^${SERVICE}$`);
report("A8", identity ? PASS : WARN, identity ? "identity probe pins the service id" : `no identity probe with $.service matching ^${SERVICE}$`);
const functional = probes.filter((p) => !/version|health/i.test(p.request?.path ?? ""));
report("A8", functional.length ? PASS : WARN, functional.length ? `functional probe: ${functional.map((p) => p.request.path).join(", ")}` : "no functional probe beyond health/version");

if (!backend) report("A8", WARN, "no backend URL (replace REPLACE_WORKER_HOST in the card or pass --backend)");
else {
  if (checkUrl("A5", "backend/spec", backend)) report("A5", PASS, `backend ${backend} is https on a hostname`);
  for (const p of probes) {
    const { path, method = "GET", body } = p.request ?? {};
    try {
      const r = await getJson(backend + path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const val = r.body === undefined ? undefined : jsonPath(r.body, p.expect.json_path);
      const ok = r.status === 200 && r.text.trimStart().startsWith("{") && val !== undefined && new RegExp(p.expect.matches).test(String(val));
      const enc = r.headers.get("content-encoding");
      report("A8", ok ? PASS : FAIL, `probe ${method} ${path} -> ${r.status}, ${p.expect.json_path}=${JSON.stringify(val)} ${ok ? "matches" : "does NOT match"} /${p.expect.matches}/${enc && enc !== "identity" ? ` (content-encoding ${enc}!)` : ""}`);
    } catch (e) {
      report("A6", FAIL, `could not reach ${backend}${path}: ${e.cause?.code ?? e.message}`);
    }
  }
  try {
    const url = specUrl && !specUrl.includes("REPLACE_") ? specUrl : `${backend}/openapi.json`;
    const r = await getJson(url);
    report("A8", r.body?.openapi ? PASS : FAIL, r.body?.openapi ? `spec reachable: OpenAPI ${r.body.openapi}, ${Object.keys(r.body.paths ?? {}).length} paths` : `spec at ${url} is not OpenAPI JSON`);
    if (url.startsWith("https://")) report("A6", PASS, `TLS ok: ${new URL(url).host}`);
  } catch (e) {
    report("A6", FAIL, `spec fetch failed: ${e.cause?.code ?? e.message}`);
  }
}

// ---------- A9: price ----------
const prices = others.filter((s) => s.metadata?.card).map((s) => Number(s.compute_units_per_relay)).sort((a, b) => a - b);
if (prices.length) {
  const q = (p) => prices[Math.min(prices.length - 1, Math.floor(p * prices.length))];
  const p95 = q(0.95);
  const msg = `${CU} CU vs catalogue median ${q(0.5)}, p95 ${p95} (${prices.length} carded services) ≈ $${(CU / 1e9).toFixed(6)}/relay`;
  report("A9", CU > p95 ? WARN : PASS, CU > p95 ? `${msg} — above p95, will be flagged` : msg);
}

// ---------- A7 ----------
report("A7", PEND, `needs a settled claim (supplier + test app). Check: pocketd query proof list-claims --supplier-operator-address <op> --network=${NETWORK}`);

// ---------- output ----------
const order = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "CHAIN"];
results.sort((a, b) => order.indexOf(a.rule) - order.indexOf(b.rule));
const icon = { PASS: "✔", FAIL: "✘", WARN: "!", PENDING: "…" };
console.log(`Pre-audit: ${SERVICE} on ${NETWORK}${backend ? ` (backend ${backend})` : ""}\n`);
for (const r of results) console.log(`${icon[r.status]} ${r.rule.padEnd(5)} ${r.status.padEnd(7)} ${r.msg}`);
const fails = results.filter((r) => r.status === FAIL).length;
console.log(`\n${fails ? `${fails} failing check(s).` : "No failing checks."} PENDING items need registration/supplier steps.`);
process.exitCode = fails ? 1 : 0;
