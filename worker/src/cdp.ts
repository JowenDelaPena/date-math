// Coinbase CDP facilitator auth, without the CDP SDK (too heavy for a Worker).
// Mirrors @coinbase/x402 createCdpAuthHeaders + cdp-sdk generateJwt for Ed25519 API keys:
//   header {alg: EdDSA, kid: <key id>, typ: JWT, nonce}, claims {sub, iss: "cdp", uris: ["METHOD host/path"], iat, nbf, exp}
// Settling through CDP gets the service listed in Coinbase's x402 Bazaar.
export const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const HOST = "api.cdp.coinbase.com";
const ROUTE = "/platform/v2/x402";
const CORRELATION = "sdk_version=1.29.0,sdk_language=typescript,source=x402,source_version=2.1.0";

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

let keyCache: { secret: string; key: CryptoKey } | undefined;

async function importEd25519(secret: string): Promise<CryptoKey> {
  if (keyCache?.secret === secret) return keyCache.key;
  const raw = Uint8Array.from(atob(secret.trim()), (c) => c.charCodeAt(0));
  if (raw.length !== 64) throw new Error("CDP_API_KEY_SECRET must be a base64 Ed25519 key (64 bytes). Create an Ed25519 key in the CDP portal.");
  const jwk = { kty: "OKP", crv: "Ed25519", d: b64url(raw.subarray(0, 32)), x: b64url(raw.subarray(32)) };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
  keyCache = { secret, key };
  return key;
}

export async function cdpJwt(keyId: string, secret: string, method: string, path: string, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const header = { alg: "EdDSA", kid: keyId, typ: "JWT", nonce };
  const claims = { sub: keyId, iss: "cdp", uris: [`${method} ${HOST}${path}`], iat: now, nbf: now, exp: now + 120 };
  const input = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", await importEd25519(secret), new TextEncoder().encode(input)));
  return `${input}.${b64url(sig)}`;
}

/** createAuthHeaders for HTTPFacilitatorClient (keyed by path, as @x402/core requires). */
export function cdpAuthHeaders(keyId: string, secret: string) {
  return async () => {
    const h = async (method: string, sub: string) => ({ "Correlation-Context": CORRELATION, Authorization: `Bearer ${await cdpJwt(keyId, secret, method, `${ROUTE}/${sub}`)}` });
    return { verify: await h("POST", "verify"), settle: await h("POST", "settle"), supported: await h("GET", "supported") };
  };
}
