// Privacy policy page at /privacy (required for directory listings such as Claude's Connectors Directory).
// Keep it in sync with what the code actually does: quota.ts (free-tier counter), index.ts (logs), payments.ts (x402).
import { CSS, FOOTER, headLinks, siteHeader } from "./landing";

export const PRIVACY_UPDATED = "2026-11-09";

const BODY = `
  <h2>Summary</h2>
  <p>Date Math is a calculator. It has no accounts, no sign-up, no cookies and no tracking scripts. It does not store the dates, times or other arguments you send, and it does not sell or share data.</p>

  <h2>What is processed, and why</h2>
  <ul>
    <li><b>Your request.</b> The arguments you send (dates, time zones, country codes and similar) are used only to compute the answer and are discarded when the response is sent. They are not written to logs or storage.</li>
    <li><b>Free-tier counter.</b> To give each user 25 free MCP calls per day, the service keeps a small counter keyed by your IP address (IPv6 addresses are shortened to their /64 network). The counter holds only today's date and a number. The IP address itself is not written to logs.</li>
    <li><b>Service logs.</b> For each call the service logs the tool name, whether it was free or paid, the HTTP status, the response time and, for paid calls, the payment transaction ID. Logs contain no IP addresses and no request arguments, and are kept by Cloudflare for a few days.</li>
    <li><b>Payments.</b> Paid calls use the x402 protocol: USDC on the Base blockchain. The payment, including the paying wallet address, is recorded publicly on the blockchain by design. Payments are verified and settled by a third-party facilitator (Coinbase or PayAI), which processes the payment details under its own privacy policy.</li>
    <li><b>Hosting.</b> The service runs on Cloudflare Workers. Like any website, Cloudflare processes network data such as IP addresses to deliver and protect the service, under the <a href="https://www.cloudflare.com/privacypolicy/">Cloudflare privacy policy</a>.</li>
    <li><b>Web pages.</b> The pages on this site load fonts from Google Fonts, which receives your IP address under the <a href="https://policies.google.com/privacy">Google privacy policy</a>. The "Try it" box sends your arguments to the same service described above.</li>
  </ul>

  <h2>Sharing</h2>
  <p>No data is sold, rented or shared for advertising. Data reaches third parties only as described above: Cloudflare (hosting), the payment facilitator and the public blockchain (paid calls only), and Google Fonts (web pages only).</p>

  <h2>Retention</h2>
  <p>Request arguments: not kept. Free-tier counter: overwritten each day. Service logs: a few days. Blockchain payment records: permanent and public, as with any on-chain payment.</p>

  <h2>Children</h2>
  <p>The service is a developer tool and is not directed at children.</p>

  <h2>Changes and contact</h2>
  <p>Changes to this policy are published on this page with a new date. Questions or requests: open an issue at <a href="https://github.com/JowenDelaPena/date-math/issues">github.com/JowenDelaPena/date-math/issues</a>.</p>
`;

const PAGE_CSS = `
  .doc { max-width: 720px; padding: 56px 0 72px; }
  .doc h1 { font-size: clamp(34px, 5vw, 48px); max-width: none; }
  .doc h2 { font-size: 24px; margin: 36px 0 8px; }
  .doc p, .doc li { color: #333; }
  .doc ul { padding-left: 20px; }
  .doc li { margin-bottom: 10px; }
`;

let cached: string | undefined;

export function privacyHtml(origin: string, version: string): string {
  return (cached ??= `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy policy | Date Math</title>
<meta name="description" content="How Date Math handles data: no accounts, no cookies, request arguments are not stored.">
<link rel="canonical" href="${origin}/privacy">
${headLinks(origin)}<style>
${CSS}${PAGE_CSS}</style>
</head>
<body>
${siteHeader(version, "/#")}
<main>
  <div class="wrap doc">
    <div class="eyebrow">Last updated ${PRIVACY_UPDATED}</div>
    <h1>Privacy policy</h1>
    ${BODY}
  </div>
</main>
${FOOTER}
</body>
</html>`);
}
