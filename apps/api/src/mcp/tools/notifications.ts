import {
  channelOverridesSchema,
  channelSchema,
  conditionSchema,
  notificationPayloadSchema,
} from "@notification-service/core";
import { AUTHORING_MODES, type Database, NOTIFICATION_STATUSES, schema } from "@notification-service/db";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { fail, ok, serializeNotification } from "../shared.js";

const functionSourceSchema = z
  .string()
  .min(1)
  .max(64 * 1024)
  .describe(
    "Custom function body: `async (event, user, ctx) => payload | { skip: true, reason? }`. " +
      "`event` is the flattened event properties plus `event.__name` (the trigger event name); " +
      "`user` is the identified user's properties; `ctx.fetch(url, init)` calls an external API " +
      "(10s wall-clock, 64MB cap). Return a payload object ({title, body, image?, url?, data?}) " +
      "or `{ skip: true, reason? }` to deliberately not send to this user. Validate it first with " +
      "`dry_run_function`.",
  );

const conditionsField = z
  .array(conditionSchema)
  .describe(
    "Builder-mode filter, ANDed together. Each: {property, operator, value?}. Operators: " +
      "=, !=, >, <, >=, <=, contains, exists (no value), in (array value). Evaluated against the " +
      "event's flat properties at ingest. Ignored for function mode.",
  );

const payloadField = notificationPayloadSchema.describe(
  "Builder-mode payload template. `{{event.x}}` and `{{user.y}}` placeholders resolve at send " +
    "time from the triggering event and the identified user's properties. Fields: title, body, " +
    "image? (url), url? (deeplink, e.g. myapp://x), data? (string→string map).",
);

const channelsField = z
  .array(channelSchema)
  .min(1)
  .describe("Push channels to fan out on: any of fcm, apns, webpush. Must be configured first.");

export function registerNotificationTools(server: McpServer, db: Database): void {
  server.registerTool(
    "list_notifications",
    {
      title: "List notifications",
      description:
        "List all notification definitions (campaigns), newest first, each with its lifetime " +
        "stats (matched/enqueued/sent/failed/skipped). Use this to see what's configured.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const rows = await db.query.notifications.findMany({
        orderBy: desc(schema.notifications.createdAt),
      });
      return ok({ notifications: rows.map(serializeNotification) });
    },
  );

  server.registerTool(
    "get_notification",
    {
      title: "Get notification",
      description: "Fetch one notification definition by id, including its lifetime stats.",
      inputSchema: { notification_id: z.string().describe("The notification's id.") },
      annotations: { readOnlyHint: true },
    },
    async ({ notification_id }) => {
      const row = await db.query.notifications.findFirst({
        where: eq(schema.notifications.id, notification_id),
      });
      if (!row) return fail("notification not found", { notification_id });
      return ok({ notification: serializeNotification(row) });
    },
  );

  server.registerTool(
    "create_notification",
    {
      title: "Create notification",
      description:
        "Create a notification (campaign) that fires when a matching event is ingested. Two " +
        "authoring modes:\n" +
        "• builder (default) — a `conditions` AND-filter + a `payload` template with " +
        "`{{event.x}}`/`{{user.y}}` placeholders. Requires `payload`.\n" +
        "• function — a `function_source` `async (event, user, ctx) => payload | {skip}` that runs " +
        "in a sandbox and is both filter and payload builder. Requires `function_source`; " +
        "`conditions`/`payload` are ignored.\n" +
        "Delivery is async: after an event matches, one queue message per user fans out to their " +
        "devices. Check results with get_notification / get_send_analytics.",
      inputSchema: {
        name: z.string().min(1).max(256).describe("Human-readable name."),
        status: z
          .enum(NOTIFICATION_STATUSES)
          .default("active")
          .describe("`active` matches events; `paused` does not. Defaults to active."),
        trigger_events: z
          .array(z.string().min(1).max(128))
          .min(1)
          .describe("Event names (from `send_test_event`/ingest) that fire this notification."),
        authoring_mode: z.enum(AUTHORING_MODES).default("builder").describe("builder | function."),
        conditions: conditionsField.default([]),
        payload: payloadField.optional(),
        function_source: functionSourceSchema.optional(),
        channels: channelsField,
        channel_overrides: channelOverridesSchema
          .default({})
          .describe("Optional per-channel escape hatches (ttl, sound, badge, urgency, …)."),
      },
    },
    async (input) => {
      const isFunction = input.authoring_mode === "function";
      if (isFunction && input.function_source == null) {
        return fail("function notifications require `function_source`");
      }
      if (!isFunction && input.payload == null) {
        return fail("builder notifications require `payload`");
      }

      const [row] = await db
        .insert(schema.notifications)
        .values({
          name: input.name,
          status: input.status,
          triggerEvents: input.trigger_events,
          authoringMode: input.authoring_mode,
          // A function is its own filter, so its conditions/payload are never stored.
          conditions: isFunction ? [] : input.conditions,
          payload: isFunction ? null : (input.payload ?? null),
          functionSource: isFunction ? (input.function_source ?? null) : null,
          channels: input.channels,
          channelOverrides: input.channel_overrides,
        })
        .returning();
      return ok({ notification: serializeNotification(row) });
    },
  );

  server.registerTool(
    "update_notification",
    {
      title: "Update notification",
      description:
        "Patch a notification. Only the fields you pass change. Use this to edit conditions, the " +
        "payload template, the function source, channels, trigger events, or to pause/activate " +
        "(via `status`).",
      inputSchema: {
        notification_id: z.string().describe("The notification's id."),
        name: z.string().min(1).max(256).optional(),
        status: z.enum(NOTIFICATION_STATUSES).optional(),
        trigger_events: z.array(z.string().min(1).max(128)).min(1).optional(),
        authoring_mode: z.enum(AUTHORING_MODES).optional(),
        conditions: conditionsField.optional(),
        payload: payloadField.nullable().optional(),
        function_source: functionSourceSchema.nullable().optional(),
        channels: channelsField.optional(),
        channel_overrides: channelOverridesSchema.optional(),
      },
    },
    async (patch) => {
      const [row] = await db
        .update(schema.notifications)
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.trigger_events !== undefined ? { triggerEvents: patch.trigger_events } : {}),
          ...(patch.authoring_mode !== undefined ? { authoringMode: patch.authoring_mode } : {}),
          ...(patch.conditions !== undefined ? { conditions: patch.conditions } : {}),
          ...(patch.payload !== undefined ? { payload: patch.payload } : {}),
          ...(patch.function_source !== undefined
            ? { functionSource: patch.function_source }
            : {}),
          ...(patch.channels !== undefined ? { channels: patch.channels } : {}),
          ...(patch.channel_overrides !== undefined
            ? { channelOverrides: patch.channel_overrides }
            : {}),
        })
        .where(eq(schema.notifications.id, patch.notification_id))
        .returning();
      if (!row) return fail("notification not found", { notification_id: patch.notification_id });
      return ok({ notification: serializeNotification(row) });
    },
  );

  server.registerTool(
    "set_notification_status",
    {
      title: "Pause or activate notification",
      description:
        "Convenience toggle: set a notification to `active` (matches events) or `paused` (does " +
        "not). Equivalent to update_notification with just `status`.",
      inputSchema: {
        notification_id: z.string().describe("The notification's id."),
        status: z.enum(NOTIFICATION_STATUSES).describe("active | paused."),
      },
    },
    async ({ notification_id, status }) => {
      const [row] = await db
        .update(schema.notifications)
        .set({ status })
        .where(eq(schema.notifications.id, notification_id))
        .returning();
      if (!row) return fail("notification not found", { notification_id });
      return ok({ notification: serializeNotification(row) });
    },
  );

  server.registerTool(
    "delete_notification",
    {
      title: "Delete notification",
      description:
        "Permanently delete a notification definition. In-flight queue messages for it drop " +
        "silently in the consumer. Its historical `sends` rows remain.",
      inputSchema: { notification_id: z.string().describe("The notification's id.") },
      annotations: { destructiveHint: true },
    },
    async ({ notification_id }) => {
      const deleted = await db
        .delete(schema.notifications)
        .where(eq(schema.notifications.id, notification_id))
        .returning({ id: schema.notifications.id });
      if (deleted.length === 0) return fail("notification not found", { notification_id });
      return ok({ ok: true, deleted: notification_id });
    },
  );
}
