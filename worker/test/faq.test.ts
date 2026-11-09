import { describe, expect, it } from "vitest";
import app from "../src/app";
import { FAQS } from "../src/faq";
import { TOOLS } from "../src/tools";

const get = (obj: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);

describe("tool page Q&A", () => {
  it("every paid tool has 3 questions with non-trivial answers", () => {
    expect(Object.keys(FAQS).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    for (const [name, faqs] of Object.entries(FAQS)) {
      expect(faqs, name).toHaveLength(3);
      for (const f of faqs) {
        expect(f.q.endsWith("?"), `${name}: ${f.q}`).toBe(true);
        expect(f.a.length, `${name}: ${f.q}`).toBeGreaterThan(60);
      }
    }
  });

  // Answers that quote a computed value must match what the tool actually returns.
  for (const [name, faqs] of Object.entries(FAQS)) {
    for (const f of faqs) {
      if (!f.check) continue;
      it(`${name}: "${f.q}" matches the tool`, () => {
        const tool = TOOLS.find((t) => t.name === name)!;
        expect(get(tool.run(f.check!.args), f.check!.path)).toEqual(f.check!.equals);
      });
    }
  }

  it("tool pages show the questions and publish FAQPage structured data", async () => {
    for (const t of TOOLS) {
      const html = await (await app.request(`/tools/${t.name.replace(/_/g, "-")}`)).text();
      expect(html).toContain('<section id="faq">');
      const blocks = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
      const faqPage = blocks.find((b) => b["@type"] === "FAQPage");
      expect(faqPage, t.name).toBeTruthy();
      expect(faqPage.mainEntity).toHaveLength(3);
      expect(faqPage.mainEntity[0].acceptedAnswer.text).toBe(FAQS[t.name][0].a);
    }
  });
});
