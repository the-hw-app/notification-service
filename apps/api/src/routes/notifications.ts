import {
  channelOverridesSchema,
  channelSchema,
  conditionSchema,
  notificationPayloadSchema,
} from "@notification-service/core";
import { AUTHORING_MODES, NOTIFICATION_STATUSES, createDb, schema } from "@notification-service/db";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import type { HonoEnv } from "../env.js";

export const notificationRoutes = new Hono<HonoEnv>();

/** `async (event, user, ctx) => payload | { skip: true, reason? }`. */
const functionSourceSchema = z.string().min(1).max(64 * 1024);

/**
 * A notification is either `builder` (a `conditions` filter + a `payload`
 * template) or `function` (a `function_source` that does both inside the
 * sandbox). `authoring_mode` defaults to `builder` so existing builder-only
 * clients keep working unchanged; the cross-field `refine` enforces that each
 * mode carries the field it needs.
 */
const createSchema = z
  .object({
    name: z.string().min(1).max(256),
    status: z.enum(NOTIFICATION_STATUSES).default("active"),
    /** Event names that fire this notification. */
    trigger_events: z.array(z.string().min(1).max(128)).min(1),
    authoring_mode: z.enum(AUTHORING_MODES).default("builder"),
    conditions: z.array(conditionSchema).default([]),
    /** Template; `{{event.x}}` / `{{user.y}}` placeholders resolve at send time. */
    payload: notificationPayloadSchema.optional(),
    function_source: functionSourceSchema.optional(),
    channels: z.array(channelSchema).min(1),
    channel_overrides: channelOverridesSchema.default({}),
  })
  .refine((v) => (v.authoring_mode === "function" ? v.function_source != null : v.payload != null), {
    message:
      "builder notifications require `payload`; function notifications require `function_source`",
  });

const updateSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  status: z.enum(NOTIFICATION_STATUSES).optional(),
  trigger_events: z.array(z.string().min(1).max(128)).min(1).optional(),
  authoring_mode: z.enum(AUTHORING_MODES).optional(),
  conditions: z.array(conditionSchema).optional(),
  payload: notificationPayloadSchema.nullable().optional(),
  function_source: functionSourceSchema.nullable().optional(),
  channels: z.array(channelSchema).min(1).optional(),
  channel_overrides: channelOverridesSchema.optional(),
});

function serialize(row: typeof schema.notifications.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    trigger_events: row.triggerEvents,
    authoring_mode: row.authoringMode,
    conditions: row.conditions,
    payload: row.payload,
    function_source: row.functionSource,
    channels: row.channels,
    channel_overrides: row.channelOverrides,
    stats: {
      matched: row.matchedCount,
      enqueued: row.enqueuedCount,
      sent: row.sentCount,
      failed: row.failedCount,
      skipped: row.skippedCount,
    },
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

notificationRoutes.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db.query.notifications.findMany({
    orderBy: desc(schema.notifications.createdAt),
  });
  return c.json({ notifications: rows.map(serialize) });
});

notificationRoutes.post("/", async (c) => {
  const body = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw new HTTPException(400, { message: body.error.message });

  const input = body.data;
  const isFunction = input.authoring_mode === "function";

  const db = createDb(c.env.DB);
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

  return c.json({ notification: serialize(row) }, 201);
});

notificationRoutes.get("/:id", async (c) => {
  const db = createDb(c.env.DB);
  const row = await db.query.notifications.findFirst({
    where: eq(schema.notifications.id, c.req.param("id")),
  });
  if (!row) throw new HTTPException(404, { message: "notification not found" });
  return c.json({ notification: serialize(row) });
});

notificationRoutes.patch("/:id", async (c) => {
  const body = updateSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw new HTTPException(400, { message: body.error.message });

  const patch = body.data;
  const db = createDb(c.env.DB);
  const [row] = await db
    .update(schema.notifications)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.trigger_events !== undefined ? { triggerEvents: patch.trigger_events } : {}),
      ...(patch.authoring_mode !== undefined ? { authoringMode: patch.authoring_mode } : {}),
      ...(patch.conditions !== undefined ? { conditions: patch.conditions } : {}),
      ...(patch.payload !== undefined ? { payload: patch.payload } : {}),
      ...(patch.function_source !== undefined ? { functionSource: patch.function_source } : {}),
      ...(patch.channels !== undefined ? { channels: patch.channels } : {}),
      ...(patch.channel_overrides !== undefined
        ? { channelOverrides: patch.channel_overrides }
        : {}),
    })
    .where(eq(schema.notifications.id, c.req.param("id")))
    .returning();

  if (!row) throw new HTTPException(404, { message: "notification not found" });
  return c.json({ notification: serialize(row) });
});

notificationRoutes.delete("/:id", async (c) => {
  const db = createDb(c.env.DB);
  const deleted = await db
    .delete(schema.notifications)
    .where(eq(schema.notifications.id, c.req.param("id")))
    .returning({ id: schema.notifications.id });
  if (deleted.length === 0) throw new HTTPException(404, { message: "notification not found" });
  // In-flight queue messages for this notification drop silently in the consumer.
  return c.json({ ok: true });
});

/** Recent delivery attempts, most recent first. */
notificationRoutes.get("/:id/sends", async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db.query.sends.findMany({
    where: eq(schema.sends.notificationId, c.req.param("id")),
    orderBy: desc(schema.sends.createdAt),
    limit: 100,
  });
  return c.json({ sends: rows });
});
