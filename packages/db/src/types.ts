/**
 * Literal unions shared by the schema, the zod contracts in `@notification-service/core`,
 * and the API. D1 is SQLite — no native enums — so these `const` arrays are
 * the single source of truth for every enum-ish text column.
 */

/** Push channels a notification can fan out to. */
export const CHANNELS = ["fcm", "apns", "webpush"] as const;
export type Channel = (typeof CHANNELS)[number];

/** `active` is the only state a notification matches events in. */
export const NOTIFICATION_STATUSES = ["active", "paused"] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/**
 * How a notification decides its payload.
 * - `builder`  — flat AND-`conditions` filter (evaluated at ingest) + a
 *   `{{event.x}}`/`{{user.y}}` payload template (interpolated in the consumer).
 * - `function` — `functionSource` runs in the QuickJS sandbox in the consumer
 *   and returns either a payload or `{ skip: true }`. It is filter and payload
 *   in one; `conditions` and `payload` are ignored.
 */
export const AUTHORING_MODES = ["builder", "function"] as const;
export type AuthoringMode = (typeof AUTHORING_MODES)[number];

/** Terminal state of a single delivery attempt. */
export const SEND_STATUSES = ["sent", "failed", "skipped"] as const;
export type SendStatus = (typeof SEND_STATUSES)[number];

/**
 * Condition operators, evaluated on the ingest path against flat event
 * properties and ANDed together. No OR-groups in v1; the planned
 * custom-function escape hatch will cover anything these can't express.
 */
export const CONDITION_OPERATORS = [
  "=",
  "!=",
  ">",
  "<",
  ">=",
  "<=",
  "contains",
  "exists",
  "in",
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

/** One rule in a notification's flat AND-list. */
export interface Condition {
  property: string;
  operator: ConditionOperator;
  /** Absent for `exists`; an array for `in`; a scalar otherwise. */
  value?: string | number | boolean | Array<string | number>;
}

/**
 * The unified notification payload, before per-channel mapping. `{{event.x}}`
 * and `{{user.y}}` placeholders are interpolated by `@notification-service/core`.
 */
export interface NotificationPayload {
  title: string;
  body: string;
  image?: string;
  /** Deeplink. Not necessarily http(s) — `myapp://product/42` is valid. */
  url?: string;
  /** Providers only carry string values in their data dictionaries. */
  data?: Record<string, string>;
}

/** Optional advanced per-channel escape hatches on top of the unified payload. */
export interface ChannelOverrides {
  fcm?: { collapseKey?: string; ttlSeconds?: number };
  apns?: { sound?: string; badge?: number; collapseId?: string; ttlSeconds?: number };
  webpush?: { ttlSeconds?: number; urgency?: "very-low" | "low" | "normal" | "high" };
}

/** Shape of the `credentials` JSON blob, discriminated by the `channel` column. */
export type ChannelCredentials =
  | { channel: "fcm"; serviceAccount: Record<string, unknown> }
  | {
      channel: "apns";
      keyP8: string;
      keyId: string;
      teamId: string;
      bundleId: string;
      production: boolean;
    }
  | { channel: "webpush"; publicKey: string; privateKey: string; subject: string };

/** Web Push subscription as handed over by the browser's PushManager. */
export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
