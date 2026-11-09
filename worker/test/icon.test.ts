import { describe, expect, it } from "vitest";
import app from "../src/app";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("service icon", () => {
  for (const path of ["/favicon.ico", "/icon.png", "/apple-touch-icon.png"]) {
    it(`${path} is a real PNG (bazaars skip SVG favicons)`, async () => {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/png");
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect([...bytes.slice(0, 8)]).toEqual(PNG_MAGIC);
      expect(bytes.length).toBeGreaterThan(1000);
    });
  }

  it("/favicon.svg stays SVG and the landing page links the PNG", async () => {
    expect((await app.request("/favicon.svg")).headers.get("Content-Type")).toBe("image/svg+xml");
    const html = await (await app.request("/", { headers: { Accept: "text/html" } })).text();
    expect(html).toContain('<link rel="icon" type="image/png" sizes="512x512" href="/icon.png">');
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">');
    expect(html).toContain('<meta name="google-site-verification" content="uBzxHhIeHn_ebQ4B9OiQ_a4XiYmNKiuYiuv7hYf7BFU">');
  });
});

describe("search engines", () => {
  it("robots.txt allows crawling and points to the sitemap", async () => {
    const txt = await (await app.request("/robots.txt")).text();
    expect(txt).toContain("Allow: /");
    expect(txt).toContain("Sitemap: https://date-math.datemath.workers.dev/sitemap.xml");
  });

  it("sitemap.xml lists the landing page", async () => {
    const res = await app.request("/sitemap.xml");
    expect(res.headers.get("Content-Type")).toContain("application/xml");
    expect(await res.text()).toContain("<loc>https://date-math.datemath.workers.dev/</loc>");
  });
});

describe("home page for search engines", () => {
  for (const ua of ["Mozilla/5.0 (compatible; Google-Site-Verification/1.0)", "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)"]) {
    it(`${ua.slice(25, 50)} gets the HTML page with the verification tag even with Accept */*`, async () => {
      const res = await app.request("/", { headers: { Accept: "*/*", "User-Agent": ua } });
      expect(res.headers.get("Content-Type")).toContain("text/html");
      expect(await res.text()).toContain('name="google-site-verification"');
    });
  }

  it("agents without text/html still get the JSON index", async () => {
    const res = await app.request("/", { headers: { Accept: "*/*", "User-Agent": "node" } });
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });
});
