// @ts-ignore: no @types/node in this project; vitest runs in Node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// src/shims/bazaar.ts is what @x402/hono's dynamic import("@x402/extensions/bazaar") loads on Workers.
// Any import in it makes esbuild lazily wrap that import graph (zod included), which broke the deploy
// on 2026-11-11 ("Class2 is not a constructor", Cloudflare error 10021). See the comment in the shim.
describe("bazaar shim", () => {
  const src = readFileSync(new URL("../src/shims/bazaar.ts", import.meta.url), "utf8");
  const code = src.replace(/^\s*\/\/.*$/gm, "");

  it("imports and re-exports nothing", () => {
    expect(code).not.toMatch(/\bimport\b|\bexport\s*\*|\bexport\s*\{[^}]*\}\s*from\b|\brequire\(/);
  });

  it("still provides the no-op validator hono calls", () => {
    expect(code).toMatch(/export function validateBazaarRouteExtensions\(/);
  });

  it("is not imported by our own code (it lacks the real exports)", () => {
    for (const f of ["payments.ts", "mcp.ts"]) {
      const s = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
      expect(s).not.toMatch(/["']@x402\/extensions\/bazaar["']/);
    }
  });
});
