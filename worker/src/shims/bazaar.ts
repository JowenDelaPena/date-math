// Workers-only shim for "@x402/extensions/bazaar" (wired via [alias] in wrangler.toml; tests use the real module).
// validateBazaarRouteExtensions compiles JSON Schemas with Ajv, which generates code via `new Function` —
// blocked on Cloudflare Workers. It only validates our own route config at startup, failed with 11 logged errors,
// and burned ~75ms CPU per cold isolate. Everything else is re-exported unchanged.
// @ts-ignore - direct file import of the real module (bypasses the alias)
export * from "../../node_modules/@x402/extensions/dist/esm/bazaar/index.mjs";
export function validateBazaarRouteExtensions(): void {}
