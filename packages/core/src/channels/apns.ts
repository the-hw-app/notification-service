import { ES256, importEs256Key, nowSeconds, signJwt } from "./crypto.js";
import { dead, isTransientStatus, permanent, sent, transient, type SendResult } from "./types.js";
import type { ApnsPayload } from "./mapping.js";

/**
 * APNs over HTTP/2.
 *
 * **This cannot be tested against `wrangler dev`.** Workers' outbound `fetch`
 * only negotiates HTTP/2 on deployed Workers (workerd #4841, #5266); the local
 * runtime falls back to HTTP/1.1, which APNs refuses by closing the connection.
 * Test against a deployed/preview Worker or `wrangler dev --remote`.
 *
 * Implemented directly on `crypto.subtle` + `fetch` rather than via a client
 * library: the whole surface is one signed JWT and one POST, and doing it here
 * keeps token caching and dead-token classification under our control.
 */

export interface ApnsCredentials {
  /** Contents of the `.p8` file, PEM-armored. */
  keyP8: string;
  keyId: string;
  teamId: string;
  bundleId: string;
  /** false → api.sandbox.push.apple.com */
  production: boolean;
}

/**
 * Apple's rule: refresh the provider token no more than once every 20 minutes
 * and no less than once every 60. We sit at 45. Signing on every send would get
 * the connection throttled with `TooManyProviderTokenUpdates`.
 */
const TOKEN_TTL_MS = 45 * 60 * 1000;

const tokenCache = new Map<string, { token: string; createdAt: number }>();

export async function getApnsProviderToken(credentials: ApnsCredentials): Promise<string> {
  const cacheKey = `${credentials.teamId}:${credentials.keyId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < TOKEN_TTL_MS) return cached.token;

  const key = await importEs256Key(credentials.keyP8);
  const token = await signJwt(
    { alg: "ES256", kid: credentials.keyId },
    { iss: credentials.teamId, iat: nowSeconds() },
    key,
    ES256,
  );

  tokenCache.set(cacheKey, { token, createdAt: Date.now() });
  return token;
}

export interface ApnsSendOptions {
  ttlSeconds?: number;
  collapseId?: string;
}

export async function sendApns(
  credentials: ApnsCredentials,
  deviceToken: string,
  payload: ApnsPayload,
  options: ApnsSendOptions = {},
): Promise<SendResult> {
  let providerToken: string;
  try {
    providerToken = await getApnsProviderToken(credentials);
  } catch (error) {
    // A malformed .p8 throws here — that's a config error, not a transient one.
    return permanent(0, "INVALID_SIGNING_KEY", (error as Error).message);
  }

  const host = credentials.production ? "api.push.apple.com" : "api.sandbox.push.apple.com";
  const headers: Record<string, string> = {
    authorization: `bearer ${providerToken}`,
    "apns-topic": credentials.bundleId,
    "apns-push-type": "alert",
    "apns-priority": "10",
    // `apns-expiration: 0` means "deliver now or discard" — the right default
    // for a marketing push. An explicit TTL becomes an absolute unix deadline.
    "apns-expiration":
      options.ttlSeconds === undefined ? "0" : String(nowSeconds() + options.ttlSeconds),
  };
  if (options.collapseId) headers["apns-collapse-id"] = options.collapseId;

  let response: Response;
  try {
    response = await fetch(`https://${host}/3/device/${deviceToken}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  } catch (error) {
    // Most often the HTTP/2 negotiation failure under `wrangler dev`.
    return transient(0, "NETWORK_ERROR", (error as Error).message);
  }

  if (response.status === 200) return sent(200);

  const body = (await response.json().catch(() => ({}))) as { reason?: string };
  const reason = body.reason ?? "UNKNOWN";

  // 410 + Unregistered: the app is gone from that device.
  // BadDeviceToken: the token was never valid for this topic/environment —
  // also unrecoverable, and the commonest cause of a silently dead device row.
  if (response.status === 410 || reason === "Unregistered" || reason === "BadDeviceToken") {
    return dead(response.status, reason);
  }
  if (isTransientStatus(response.status)) return transient(response.status, reason);
  return permanent(response.status, reason);
}
