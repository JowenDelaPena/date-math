import { describe, expect, it } from "vitest";
import app from "../src/app";
import { HEADINGS } from "../src/pages";
import { TOOLS } from "../src/tools";

const slug = (n: string) => n.replace(/_/g, "-");

describe("tool pages", () => {
  it("every paid tool has a heading", () => {
    expect(Object.keys(HEADINGS).sort()).toEqual(TOOLS.map((t) => t.name).sort());
  });

  for (const t of TOOLS) {
    it(`/tools/${slug(t.name)} is a complete HTML page`, async () => {
      const res = await app.request(`/tools/${slug(t.name)}`, { headers: { Accept: "*/*" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/html");
      expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
      const html = await res.text();
      expect(html).toContain(`<link rel="canonical" href="https://date-math.datemath.workers.dev/tools/${slug(t.name)}">`);
      expect(html).toContain("<h1>");
      expect(html).toContain(`POST ${t.path}`);
      expect(html).toContain('name="google-site-verification"');
      expect(html).not.toContain("${"); // no unfilled template slots
      const ld = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)![1];
      expect(JSON.parse(ld)["@type"]).toBe("WebAPI");
    });
  }

  it("unknown tool slugs are 404", async () => {
    expect((await app.request("/tools/not-a-tool")).status).toBe(404);
  });

  it("sitemap lists every tool page and the home page links to them", async () => {
    const xml = await (await app.request("/sitemap.xml")).text();
    const home = await (await app.request("/", { headers: { Accept: "text/html" } })).text();
    for (const t of TOOLS) {
      expect(xml).toContain(`<loc>https://date-math.datemath.workers.dev/tools/${slug(t.name)}</loc>`);
      expect(home).toContain(`href="/tools/${slug(t.name)}"`);
    }
  });
});

describe("IndexNow", () => {
  it("serves the key file with the key as its only content", async () => {
    const { INDEXNOW_KEY } = await import("../src/app");
    const res = await app.request(`/${INDEXNOW_KEY}.txt`);
    expect(res.status).toBe(200);
    expect((await res.text()).trim()).toBe(INDEXNOW_KEY);
  });
});
