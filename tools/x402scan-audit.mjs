#!/usr/bin/env node
// Local re-implementation of the x402scan discovery checks (https://x402scan.com/discovery/spec).
// Read-only: GETs /openapi.json and probes each paid route without payment (expects 402).
// Usage: node tools/x402scan-audit.mjs [origin]
const ORIGIN = (process.argv[2] ?? "https://date-math.datemath.workers.dev").replace(/\/$/, "");
const out = [];
const ok = (m) => out.push(["PASS", m]);
const warn = (m) => out.push(["WARN", m]);
const fail = (m) => out.push(["FAIL", m]);

const res = await fetch(`${ORIGIN}/openapi.json`);
if (res.status !== 200) { console.log(`FAIL OpenAPI not found at ${ORIGIN}/openapi.json (${res.status})`); process.exit(1); }
const spec = await res.json();

// Top-level requirements
for (const [k, v] of [["openapi", spec.openapi], ["info.title", spec.info?.title], ["info.version", spec.info?.version], ["info.x-guidance", spec.info?.["x-guidance"]], ["paths", spec.paths]]) {
  v ? ok(`${k} present`) : fail(`${k} missing`);
}
spec.info?.contact?.email ? ok(`info.contact.email = ${spec.info.contact.email}`) : warn("info.contact.email missing (recommended: ownership verification + merchant page)");

const resolve = (node) => (node?.$ref ? node.$ref.replace(/^#\//, "").split("/").reduce((o, k) => o?.[k], spec) : node);
const paid = [];
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(item)) {
    const label = `${method.toUpperCase()} ${path}`;
    const xpi = op["x-payment-info"];
    if (!xpi) { ok(`${label}: free (no x-payment-info)`); continue; }
    paid.push({ path, method, xpi });
    const price = xpi.price;
    const priceOk = price && price.currency === "USD" && ((price.mode === "fixed" && /^\d+(\.\d+)?$/.test(price.amount)) || (price.mode === "dynamic" && price.min && price.max));
    priceOk ? ok(`${label}: price ${JSON.stringify(price)}`) : fail(`${label}: invalid x-payment-info.price ${JSON.stringify(price)}`);
    const protoOk = Array.isArray(xpi.protocols) && xpi.protocols.some((p) => p && typeof p === "object" && "x402" in p);
    protoOk ? ok(`${label}: protocols [{x402:{}}]`) : fail(`${label}: protocols must be an array of objects like [{"x402":{}}], got ${JSON.stringify(xpi.protocols)}`);
    op.responses?.["402"] ? ok(`${label}: responses.402`) : fail(`${label}: responses.402 missing`);
    const inSchema = resolve(op.requestBody?.content?.["application/json"]?.schema);
    inSchema?.properties ? ok(`${label}: input schema (${Object.keys(inSchema.properties).join(", ")})`) : fail(`${label}: input schema missing`);
    const outSchema = resolve(op.responses?.["200"]?.content?.["application/json"]?.schema);
    outSchema?.properties ? ok(`${label}: output schema (${Object.keys(outSchema.properties).length} fields)`) : fail(`${label}: output schema missing`);
  }
}

// Runtime probes: unauthenticated, no body. Must reach a parseable 402 before validation.
for (const { path, method, xpi } of paid) {
  const label = `probe ${method.toUpperCase()} ${path}`;
  const r = await fetch(ORIGIN + path, { method: method.toUpperCase() });
  if (r.status !== 402) { fail(`${label}: expected 402, got ${r.status}`); continue; }
  const header = r.headers.get("payment-required");
  if (!header) { fail(`${label}: 402 without PAYMENT-REQUIRED header`); continue; }
  let t;
  try { t = JSON.parse(Buffer.from(header, "base64").toString("utf8")); } catch { fail(`${label}: PAYMENT-REQUIRED not base64 JSON`); continue; }
  const a = (t.accepts ?? [])[0];
  if (!a) { fail(`${label}: accepts is empty`); continue; }
  if (!/^\d+$/.test(a.amount ?? "")) { fail(`${label}: accepts[].amount must be atomic units, got ${a.amount}`); continue; }
  const expected = xpi.price?.mode === "fixed" ? Math.round(Number(xpi.price.amount) * 1e6).toString() : null;
  if (expected && expected !== a.amount) fail(`${label}: runtime amount ${a.amount} != OpenAPI ${xpi.price.amount} USD (${expected})`);
  else ok(`${label}: 402 v${t.x402Version}, ${a.scheme} ${a.network}, amount ${a.amount} (= $${Number(a.amount) / 1e6}), payTo ${a.payTo}`);
  const b = t.extensions?.bazaar;
  b?.info?.input && b?.schema ? ok(`${label}: bazaar input/output metadata present`) : fail(`${label}: missing bazaar input schema (route would be skipped)`);
}

for (const [s, m] of out) console.log(`${s === "PASS" ? "✔" : s === "WARN" ? "!" : "✘"} ${s.padEnd(4)} ${m}`);
const f = out.filter(([s]) => s === "FAIL").length, w = out.filter(([s]) => s === "WARN").length;
console.log(`\n${paid.length} paid route(s). ${f} failure(s), ${w} warning(s).`);
process.exitCode = f ? 1 : 0;
