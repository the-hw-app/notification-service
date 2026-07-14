import type { ChannelOverrides, NotificationPayload } from "@notification-service/db/types";

/**
 * Maps the unified payload onto each provider's wire format.
 *
 * These are pure functions with no I/O so the mapping rules — which are the
 * fiddliest, most convention-laden part of the whole system — are unit-testable
 * without touching a provider.
 *
 * Every mapping carries `send_id` through to the client, because that is the
 * only handle `POST /track` has to correlate a `delivered`/`clicked` back to a
 * campaign.
 */

export const SEND_ID_KEY = "send_id";

/** FCM HTTP v1 `message` object, minus the `token` the sender fills in. */
export interface FcmMessage {
  token: string;
  notification: { title: string; body: string; image?: string };
  data?: Record<string, string>;
  android?: { ttl?: string; collapse_key?: string };
}

/**
 * FCM carries the deeplink as `data.url` rather than a notification field, and
 * we emit no CTA buttons — both carried over from the predecessor system's
 * conventions (DESIGN.md) so existing client handlers keep working.
 */
export function toFcmMessage(
  payload: NotificationPayload,
  overrides: ChannelOverrides["fcm"],
  token: string,
  sendId: string,
): FcmMessage {
  const data: Record<string, string> = { ...payload.data, [SEND_ID_KEY]: sendId };
  if (payload.url) data.url = payload.url;

  const message: FcmMessage = {
    token,
    notification: {
      title: payload.title,
      body: payload.body,
      ...(payload.image ? { image: payload.image } : {}),
    },
    data,
  };

  if (overrides?.ttlSeconds !== undefined || overrides?.collapseKey !== undefined) {
    message.android = {
      ...(overrides.ttlSeconds !== undefined ? { ttl: `${overrides.ttlSeconds}s` } : {}),
      ...(overrides.collapseKey !== undefined ? { collapse_key: overrides.collapseKey } : {}),
    };
  }

  return message;
}

/** The JSON body POSTed to `api.push.apple.com/3/device/{token}`. */
export interface ApnsPayload {
  aps: {
    alert: { title: string; body: string };
    sound?: string;
    badge?: number;
    "mutable-content"?: 1;
  };
  [key: string]: unknown;
}

/**
 * `mutable-content: 1` is set whenever there is an image, so a Notification
 * Service Extension in the customer's app can download and attach it. Without
 * an extension the notification still displays, just without the image.
 */
export function toApnsPayload(
  payload: NotificationPayload,
  overrides: ChannelOverrides["apns"],
  sendId: string,
): ApnsPayload {
  const result: ApnsPayload = {
    aps: {
      alert: { title: payload.title, body: payload.body },
      ...(overrides?.sound ? { sound: overrides.sound } : {}),
      ...(overrides?.badge !== undefined ? { badge: overrides.badge } : {}),
      ...(payload.image ? { "mutable-content": 1 as const } : {}),
    },
    [SEND_ID_KEY]: sendId,
    ...payload.data,
  };

  if (payload.url) result.url = payload.url;
  if (payload.image) result.image = payload.image;

  return result;
}

/** The encrypted body a service worker receives as `event.data.json()`. */
export interface WebPushPayload {
  title: string;
  body: string;
  image?: string;
  data: Record<string, string> & { [SEND_ID_KEY]: string; url?: string };
}

export function toWebPushPayload(
  payload: NotificationPayload,
  sendId: string,
): WebPushPayload {
  return {
    title: payload.title,
    body: payload.body,
    ...(payload.image ? { image: payload.image } : {}),
    data: {
      ...payload.data,
      [SEND_ID_KEY]: sendId,
      ...(payload.url ? { url: payload.url } : {}),
    },
  };
}
