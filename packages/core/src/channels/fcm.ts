import { RS256, importRs256Key, nowSeconds, signJwt } from "./crypto.js";
import { dead, isTransientStatus, permanent, sent, transient, type SendResult } from "./types.js";
import type { FcmMessage } from "./mapping.js";

/**
 * FCM HTTP v1.
 *
 * The legacy `fcm.googleapis.com/fcm/send` server-key API is retired, so this
 * mints a short-lived OAuth2 access token from the project's service-account
 * JSON (RS256-signed JWT → token endpoint) and caches it per project.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

export interface FcmServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

/**
 * Access tokens live an hour; we refresh at 55 minutes. Cached at module scope,
 * which on Workers means per-isolate — a cold isolate simply mints a new one.
 * Keyed by `client_email` so two projects never share a token.
 */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function getFcmAccessToken(account: FcmServiceAccount): Promise<string> {
  const cached = tokenCache.get(account.client_email);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const issuedAt = nowSeconds();
  const key = await importRs256Key(account.private_key);
  const assertion = await signJwt(
    { alg: "RS256", typ: "JWT" },
    {
      iss: account.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + 3600,
    },
    key,
    RS256,
  );

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!response.ok) {
    throw new Error(`FCM token exchange failed (${response.status}): ${await response.text()}`);
  }

  const body = (await response.json()) as { access_token: string; expires_in: number };
  tokenCache.set(account.client_email, {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in - 300) * 1000,
  });
  return body.access_token;
}

interface FcmErrorBody {
  error?: {
    status?: string;
    message?: string;
    details?: Array<{ "@type"?: string; errorCode?: string }>;
  };
}

export async function sendFcm(
  account: FcmServiceAccount,
  message: FcmMessage,
): Promise<SendResult> {
  let accessToken: string;
  try {
    accessToken = await getFcmAccessToken(account);
  } catch (error) {
    // A token exchange failure is usually Google being slow, not bad creds.
    return transient(0, "TOKEN_EXCHANGE_FAILED", (error as Error).message);
  }

  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message }),
    },
  );

  if (response.ok) return sent(response.status);

  const body = (await response.json().catch(() => ({}))) as FcmErrorBody;
  const errorCode =
    body.error?.details?.find((d) => d.errorCode)?.errorCode ?? body.error?.status ?? "UNKNOWN";
  const errorMessage = body.error?.message;

  // UNREGISTERED: the app was uninstalled or the token rotated. It will never
  // work again — prune it. INVALID_ARGUMENT means *we* sent garbage (often a
  // malformed token), which is a bug to surface, not a device to delete.
  if (errorCode === "UNREGISTERED" || errorCode === "NOT_FOUND" || response.status === 404) {
    return dead(response.status, errorCode, errorMessage);
  }
  if (isTransientStatus(response.status)) {
    return transient(response.status, errorCode, errorMessage);
  }
  return permanent(response.status, errorCode, errorMessage);
}
