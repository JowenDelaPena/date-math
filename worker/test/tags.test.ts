import { describe, expect, it } from "vitest";
import { buildRoutes } from "../src/payments";
import { SEARCH_TAGS } from "../src/tags";
import { TOOLS } from "../src/tools";

describe("Bazaar search tags", () => {
  it("every paid tool has exactly 5 short, lowercase, distinct tags (Agentic.Market keeps the first 5)", () => {
    expect(Object.keys(SEARCH_TAGS).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    for (const [name, tags] of Object.entries(SEARCH_TAGS)) {
      expect(tags, name).toHaveLength(5);
      expect(new Set(tags).size, name).toBe(5);
      for (const tag of tags) {
        expect(tag, name).toBe(tag.toLowerCase().trim());
        expect(tag.length, `${name}: ${tag}`).toBeLessThanOrEqual(40);
      }
    }
  });

  it("each HTTP route advertises its own tool's tags", () => {
    const routes = buildRoutes({ PAY_TO: "0x0000000000000000000000000000000000000001", PRICE: "$0.001", X402_NETWORK: "eip155:8453", FACILITATOR_URL: "https://example.com" }) as unknown as Record<string, { tags?: string[] }>;
    for (const t of TOOLS) {
      expect(routes[`POST ${t.path}`].tags, t.name).toEqual(SEARCH_TAGS[t.name]);
    }
  });
});
