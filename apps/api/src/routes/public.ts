import { CHANNELS, createDb } from "@notification-service/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import type { HonoEnv } from "../env.js";
import { identifyUser } from "../lib/identify.js";
import { ingestEvent } from "../lib/ingest.js";

/** The two endpoints a customer's app calls: register a token, send an event. */
export const publicRoutes = new Hono<HonoEnv>();

const deviceSchema = z.object({
  channel: z.enum(CHANNELS),
  /** FCM/APNs registration token. For webpush, pass `subscription` instead. */
  token: z.string().min(1).max(1024).optional(),
  subscription: z
    .object({
      endpoint: z.url(),
      keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
    })
    .optional(),
});

const identifySchema = z.object({
  distinct_id: z.string().min(1).max(256),
  properties: z.record(z.string(), z.unknown()).optional(),
  device: deviceSchema.optional(),
});

publicRoutes.post("/identify", async (c) => {
  const body = identifySchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw new HTTPException(400, { message: body.error.message });

  const { distinct_id: distinctId, properties, device } = body.data;
  const db = createDb(c.env.DB);

  const result = await identifyUser(db, { distinctId, properties, device });
  if (!result.ok) {
    throw new HTTPException(400, {
      message:
        device?.channel === "webpush"
          ? "webpush devices require `subscription`"
          : "`token` is required",
    });
  }

  return c.json({ ok: true });
});

const ingestSchema = z.object({
  distinct_id: z.string().min(1).max(256),
  event: z.string().min(1).max(128),
  properties: z.record(z.string(), z.unknown()).default({}),
  timestamp: z.number().int().optional(),
});

publicRoutes.post("/ingest", async (c) => {
  const body = ingestSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw new HTTPException(400, { message: body.error.message });

  const { distinct_id: distinctId, event: eventName, properties } = body.data;
  const timestamp = body.data.timestamp ?? Date.now();
  const db = createDb(c.env.DB);

  const result = await ingestEvent(db, c.env.SEND_QUEUE, {
    distinctId,
    event: eventName,
    properties,
    timestamp,
  });

  if (!result.ok) {
    // The customer gets an actionable 413 rather than an opaque queue failure.
    throw new HTTPException(413, {
      message: `event exceeds the ${result.maxBytes} byte queue message limit`,
    });
  }

  return c.json({ ok: true, matched: result.matched, enqueued: result.enqueued });
});
