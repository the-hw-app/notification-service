import {
  buildPushPayload,
  type PushSubscription as BlockPushSubscription,
  type VapidKeys,
} from "@block65/webcrypto-web-push";
import type { WebPushSubscription } from "@notification-service/db/types";

import { base64urlEncode } from "./crypto.js";
import { dead, isTransientStatus, permanent, sent, transient, type SendResult } from "./types.js";
import type { WebPushPayload } from "./mapping.js";

/**
 * Web Push (RFC 8291 / VAPID).
 *
 * `web-push`, the usual choice, is Node-only. `@block65/webcrypto-web-push` is
 * a pure-WebCrypto *payload builder*: it does the VAPID JWT and the aes128gcm
 * content encryption and hands back a `fetch` init. It deliberately does not
 * make the request, which is what we want — we own the `fetch` and therefore
 * the 404/410 dead-subscription handling.
 */

export interface WebPushCredentials {
  /** Raw uncompressed P-256 public point, base64url. Also the client's `applicationServerKey`. */
  publicKey: string;
  /** PKCS#8 private key, base64url. */
  privateKey: string;
  /** `mailto:` or an https URL — the push service contacts you here. */
  subject: string;
}

/**
 * Generate a VAPID keypair for a project at channel-setup time. The operator
 * never sees these; the public key is handed to the customer's web app.
 */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  // `generateKey` is typed as `CryptoKey | CryptoKeyPair`; an asymmetric
  // algorithm always yields the pair.
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;

  // Likewise `exportKey` is `ArrayBuffer | JsonWebKey`; "raw"/"pkcs8" are buffers.
  const [raw, pkcs8] = (await Promise.all([
    crypto.subtle.exportKey("raw", pair.publicKey),
    crypto.subtle.exportKey("pkcs8", pair.privateKey),
  ])) as [ArrayBuffer, ArrayBuffer];

  return { publicKey: base64urlEncode(raw), privateKey: base64urlEncode(pkcs8) };
}

export async function sendWebPush(
  credentials: WebPushCredentials,
  subscription: WebPushSubscription,
  payload: WebPushPayload,
  options: { ttlSeconds?: number; urgency?: "very-low" | "low" | "normal" | "high" } = {},
): Promise<SendResult> {
  const vapid: VapidKeys = {
    subject: credentials.subject,
    publicKey: credentials.publicKey,
    privateKey: credentials.privateKey,
  };

  const target: BlockPushSubscription = {
    endpoint: subscription.endpoint,
    expirationTime: null,
    keys: subscription.keys,
  };

  let init: RequestInit;
  try {
    init = (await buildPushPayload(
      { data: JSON.stringify(payload), options: { ttl: options.ttlSeconds ?? 2419200 } },
      target,
      vapid,
    )) as RequestInit;
  } catch (error) {
    // Bad VAPID keys or an unparseable subscription — neither will fix itself.
    return permanent(0, "ENCRYPTION_FAILED", (error as Error).message);
  }

  let response: Response;
  try {
    response = await fetch(subscription.endpoint, init);
  } catch (error) {
    return transient(0, "NETWORK_ERROR", (error as Error).message);
  }

  // 201 Created is the success code; some services answer 200/202.
  if (response.status >= 200 && response.status < 300) return sent(response.status);

  // 404 Not Found / 410 Gone: the browser dropped the subscription.
  if (response.status === 404 || response.status === 410) {
    return dead(response.status, "SUBSCRIPTION_GONE");
  }
  if (isTransientStatus(response.status)) {
    return transient(response.status, `HTTP_${response.status}`);
  }
  return permanent(response.status, `HTTP_${response.status}`, await response.text().catch(() => ""));
}
