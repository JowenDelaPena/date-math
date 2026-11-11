// Workers-only shim for "@x402/extensions/bazaar" (wired via [alias] in wrangler.toml; tests use the real module).
//
// @x402/hono (2.29+) loads "@x402/extensions/bazaar" with a dynamic import() to (1) register the bazaar
// extension when the server lacks it (ours registers it in payments.ts, so hono skips that) and (2) call
// validateBazaarRouteExtensions. That validator compiles JSON Schemas with Ajv, which generates code via
// `new Function` (blocked on Workers), logged 11 errors and burned ~75 ms CPU per cold isolate, so it is a no-op.
//
// This file must import NOTHING. esbuild wraps a dynamically imported module and its whole import graph in
// lazy init functions; re-exporting the real module here wrapped zod too, and the MCP SDK then called
// z.custom() before zod's lazy init ran ("Class2 is not a constructor", Cloudflare rejected the deploy with
// error 10021 on 2026-11-11). Our own code imports the real module statically via src/bazaar.ts.
export function validateBazaarRouteExtensions(): void {}
