import { describe, expect, it } from "vitest";
import { cdpAuthHeaders, cdpJwt } from "../src/cdp";

const b64urlDecode = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

describe("CDP Ed25519 JWT", () => {
  it("matches the CDP SDK format and verifies with the public key", async () => {
    const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
    const secret = btoa(String.fromCharCode(...b64urlDecode(jwk.d!), ...b64urlDecode(jwk.x!))); // CDP format: seed || public key
    const jwt = await cdpJwt("organizations/x/apiKeys/y", secret, "POST", "/platform/v2/x402/settle", 1_800_000_000);
    const [h, c, sig] = jwt.split(".");
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(h)));
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(c)));
    expect(header).toMatchObject({ alg: "EdDSA", kid: "organizations/x/apiKeys/y", typ: "JWT" });
    expect(header.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(claims).toEqual({ sub: "organizations/x/apiKeys/y", iss: "cdp", uris: ["POST api.cdp.coinbase.com/platform/v2/x402/settle"], iat: 1_800_000_000, nbf: 1_800_000_000, exp: 1_800_000_120 });
    const ok = await crypto.subtle.verify("Ed25519", kp.publicKey, b64urlDecode(sig), new TextEncoder().encode(`${h}.${c}`));
    expect(ok).toBe(true);
  });

  it("returns per-path headers as @x402/core requires", async () => {
    const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign"])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
    const secret = btoa(String.fromCharCode(...b64urlDecode(jwk.d!), ...b64urlDecode(jwk.x!)));
    const headers = await cdpAuthHeaders("kid", secret)();
    expect(Object.keys(headers)).toEqual(["verify", "settle", "supported"]);
    expect(headers.settle.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("rejects a non-Ed25519 secret clearly", async () => {
    await expect(cdpJwt("kid", btoa("short"), "GET", "/x")).rejects.toThrow(/Ed25519/);
  });
});
