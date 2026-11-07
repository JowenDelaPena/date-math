// Bazaar catalogs (Coinbase CDP, PayAI) validate each route's output example against its output schema
// and silently skip routes that fail. These tests keep src/output-examples.json complete and valid.
// Regenerate after changing a tool's output:  UPDATE_EXAMPLES=1 npx vitest run test/output-examples.test.ts
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import examples from "../src/output-examples.json";
import { outputSchemaFor } from "../src/payments";
import { TOOLS } from "../src/tools";

/** Keep only the first element of every array so the example stays small (PAYMENT-REQUIRED is a header). */
function trim(v: unknown): unknown {
  if (Array.isArray(v)) return v.slice(0, 1).map(trim);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trim(x)]));
  return v;
}

describe("output examples", () => {
  if ((globalThis as any).process?.env?.UPDATE_EXAMPLES) {
    it("regenerates src/output-examples.json from each tool's example input", async () => {
      // @ts-ignore: no @types/node in this project; vitest runs in Node
      const { writeFileSync } = await import("node:fs");
      const out = Object.fromEntries(TOOLS.map((t) => [t.path, trim(t.run(t.example as Record<string, unknown>))]));
      writeFileSync(new URL("../src/output-examples.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
    });
    return;
  }

  it("has one example per tool", () => {
    expect(Object.keys(examples).sort()).toEqual(TOOLS.map((t) => t.path).sort());
  });

  for (const t of TOOLS) {
    it(`${t.path} example matches its output schema`, () => {
      const validate = new (Ajv2020 as any)({ strict: false, allErrors: true }).compile(outputSchemaFor(t.path));
      const ok = validate((examples as Record<string, unknown>)[t.path]);
      expect(validate.errors ?? [], JSON.stringify(validate.errors)).toEqual([]);
      expect(ok).toBe(true);
    });
  }
});
