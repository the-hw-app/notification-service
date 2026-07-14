/**
 * WebCrypto helpers shared by the channel senders.
 *
 * Every provider wants a signed JWT and none of the popular Node libraries run
 * on Workers, so we sign with `crypto.subtle` directly. APNs and Web Push use
 * ES256 (ECDSA P-256); FCM's OAuth2 exchange uses RS256.
 */

const encoder = new TextEncoder();

export function base64urlEncode(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Strip the PEM armor and base64-decode to DER. Handles both PKCS#8 headers. */
export function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function encodeSegment(value: unknown): string {
  return base64urlEncode(encoder.encode(JSON.stringify(value)));
}

/**
 * Sign a JWT. `crypto.subtle.sign` with ECDSA returns the raw `r||s`
 * concatenation, which is exactly the JOSE ES256 signature format — no DER
 * unwrapping needed (this is the step most hand-rolled implementations get
 * wrong).
 */
export async function signJwt(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  key: CryptoKey,
  algorithm: string | SubtleCryptoSignAlgorithm,
): Promise<string> {
  const signingInput = `${encodeSegment(header)}.${encodeSegment(claims)}`;
  const signature = await crypto.subtle.sign(algorithm, key, encoder.encode(signingInput));
  return `${signingInput}.${base64urlEncode(signature)}`;
}

/** Import a `.p8` / PEM ES256 signing key (APNs, VAPID). */
export function importEs256Key(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(pem),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

/** Import a service-account RS256 signing key (FCM OAuth2). */
export function importRs256Key(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export const ES256: SubtleCryptoSignAlgorithm = { name: "ECDSA", hash: "SHA-256" };
export const RS256 = "RSASSA-PKCS1-v1_5";

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
