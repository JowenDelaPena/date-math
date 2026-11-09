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
  });
});
