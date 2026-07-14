import type { ChannelCredentials, ChannelOverrides, NotificationPayload } from "@notification-service/db/types";

import { sendApns, type ApnsCredentials } from "./apns.js";
import { sendFcm, type FcmServiceAccount } from "./fcm.js";
import { toApnsPayload, toFcmMessage, toWebPushPayload } from "./mapping.js";
import { permanent, type SendResult } from "./types.js";
import { sendWebPush } from "./webpush.js";

/** The minimum a sender needs to know about a device row. */
export interface SendTarget {
  channel: "fcm" | "apns" | "webpush";
  /** FCM/APNs registration token, or the Web Push endpoint URL. */
  token: string;
  subscription?: { endpoint: string; keys: { p256dh: string; auth: string } } | null;
}

/**
 * Route one payload to one device.
 *
 * The `credentials.channel` discriminant is checked against the device's
 * channel rather than trusted, because both come from the database and a
 * mismatch would otherwise send an APNs body to FCM and get a confusing
 * provider error instead of a clear one.
 */
export async function sendToDevice(
  credentials: ChannelCredentials,
  target: SendTarget,
  payload: NotificationPayload,
  overrides: ChannelOverrides,
  sendId: string,
): Promise<SendResult> {
  if (credentials.channel !== target.channel) {
    return permanent(
      0,
      "CHANNEL_MISMATCH",
      `credentials are for ${credentials.channel} but device is ${target.channel}`,
    );
  }

  switch (credentials.channel) {
    case "fcm":
      return sendFcm(
        credentials.serviceAccount as unknown as FcmServiceAccount,
        toFcmMessage(payload, overrides.fcm, target.token, sendId),
      );

    case "apns": {
      const apnsCredentials: ApnsCredentials = {
        keyP8: credentials.keyP8,
        keyId: credentials.keyId,
        teamId: credentials.teamId,
        bundleId: credentials.bundleId,
        production: credentials.production,
      };
      return sendApns(apnsCredentials, target.token, toApnsPayload(payload, overrides.apns, sendId), {
        ttlSeconds: overrides.apns?.ttlSeconds,
        collapseId: overrides.apns?.collapseId,
      });
    }

    case "webpush": {
      if (!target.subscription) {
        return permanent(0, "MISSING_SUBSCRIPTION", "web push device has no stored subscription");
      }
      return sendWebPush(
        {
          publicKey: credentials.publicKey,
          privateKey: credentials.privateKey,
          subject: credentials.subject,
        },
        target.subscription,
        toWebPushPayload(payload, sendId),
        { ttlSeconds: overrides.webpush?.ttlSeconds, urgency: overrides.webpush?.urgency },
      );
    }

    default: {
      const _never: never = credentials;
      void _never;
      return permanent(0, "UNKNOWN_CHANNEL", "unsupported channel");
    }
  }
}
