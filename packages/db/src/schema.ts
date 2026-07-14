import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import type {
  AuthoringMode,
  Channel,
  ChannelCredentials,
  ChannelOverrides,
  Condition,
  NotificationPayload,
  NotificationStatus,
  SendStatus,
  WebPushSubscription,
} from "./types.js";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`);

const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`)
    .$onUpdateFn(() => new Date());

/**
 * A person in the customer's app, keyed by their opaque `distinct_id`
 * (CleverTap/PostHog-style). `properties` comes from `POST /v1/identify` and
 * is used for template interpolation (`{{user.plan}}`) only.
 */
export const users = sqliteTable("users", {
  id: id(),
  distinctId: text("distinct_id").notNull().unique(),
  properties: text("properties", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * A push destination. One user commonly has several. For Web Push the `token`
 * IS the subscription endpoint URL and the full `{endpoint, keys}` blob lives
 * in `subscription`. Re-identifying an existing token re-assigns the row to
 * the new `distinct_id` (shared tablet, logout/login) instead of duplicating.
 */
export const devices = sqliteTable(
  "devices",
  {
    id: id(),
    distinctId: text("distinct_id").notNull(),
    channel: text("channel").$type<Channel>().notNull(),
    token: text("token").notNull().unique(),
    subscription: text("subscription", { mode: "json" }).$type<WebPushSubscription | null>(),
    createdAt: createdAt(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [index("devices_distinct_id_idx").on(table.distinctId)],
);

/** Provider credentials, one row per channel. */
export const channelCredentials = sqliteTable(
  "channel_credentials",
  {
    id: id(),
    channel: text("channel").$type<Channel>().notNull(),
    credentials: text("credentials", { mode: "json" }).$type<ChannelCredentials>().notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("channel_credentials_channel_idx").on(table.channel)],
);

/**
 * A notification definition: which events trigger it, the conditions the
 * event's properties must satisfy, the payload template, and the channels to
 * fan out on. The rollup counters are bumped by the ingest handler
 * (matched/enqueued) and the queue consumer (sent/failed/skipped).
 */
export const notifications = sqliteTable(
  "notifications",
  {
    id: id(),
    name: text("name").notNull(),
    status: text("status").$type<NotificationStatus>().notNull().default("active"),
    triggerEvents: text("trigger_events", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    authoringMode: text("authoring_mode").$type<AuthoringMode>().notNull().default("builder"),
    conditions: text("conditions", { mode: "json" })
      .$type<Condition[]>()
      .notNull()
      .default(sql`'[]'`),
    /** `async (event, user, ctx) => payload | { skip: true, reason? }`. Null unless function mode. */
    functionSource: text("function_source"),
    /** Template for builder mode; null for function mode, which builds its own. */
    payload: text("payload", { mode: "json" }).$type<NotificationPayload>(),
    channels: text("channels", { mode: "json" }).$type<Channel[]>().notNull().default(sql`'[]'`),
    channelOverrides: text("channel_overrides", { mode: "json" })
      .$type<ChannelOverrides>()
      .notNull()
      .default(sql`'{}'`),
    matchedCount: integer("matched_count").notNull().default(0),
    enqueuedCount: integer("enqueued_count").notNull().default(0),
    sentCount: integer("sent_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("notifications_status_idx").on(table.status)],
);

/**
 * One delivery attempt's terminal record. `device_id`/`channel` are null for
 * skips (a skip is a decision about the person, not any one device) and
 * `device_id` outlives pruned devices as null.
 */
export const sends = sqliteTable(
  "sends",
  {
    id: id(),
    notificationId: text("notification_id").notNull(),
    distinctId: text("distinct_id").notNull(),
    deviceId: text("device_id"),
    channel: text("channel").$type<Channel>(),
    status: text("status").$type<SendStatus>().notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: createdAt(),
  },
  (table) => [
    index("sends_notification_idx").on(table.notificationId, table.createdAt),
    index("sends_created_idx").on(table.createdAt),
  ],
);
