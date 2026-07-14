import { channelCredentialsSchema, channelSchema, generateVapidKeys } from "@notification-service/core";
import { createDb, schema } from "@notification-service/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import type { HonoEnv } from "../env.js";

export const channelRoutes = new Hono<HonoEnv>();

/** Credentials are write-only: listing reports configuration, never secrets. */
channelRoutes.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db.query.channelCredentials.findMany();
  return c.json({
    channels: rows.map((row) => ({
      channel: row.channel,
      enabled: row.enabled,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    })),
  });
});

const putSchema = z.object({
  credentials: channelCredentialsSchema,
  enabled: z.boolean().default(true),
});

channelRoutes.put("/:channel", async (c) => {
  const channel = channelSchema.safeParse(c.req.param("channel"));
  if (!channel.success) throw new HTTPException(404, { message: "unknown channel" });

  const body = putSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw new HTTPException(400, { message: body.error.message });
  if (body.data.credentials.channel !== channel.data) {
    throw new HTTPException(400, { message: "credentials.channel does not match the URL" });
  }

  const db = createDb(c.env.DB);
  await db
    .insert(schema.channelCredentials)
    .values({
      channel: channel.data,
      credentials: body.data.credentials,
      enabled: body.data.enabled,
    })
    .onConflictDoUpdate({
      target: schema.channelCredentials.channel,
      set: { credentials: body.data.credentials, enabled: body.data.enabled },
    });

  return c.json({ ok: true, channel: channel.data });
});

channelRoutes.delete("/:channel", async (c) => {
  const channel = channelSchema.safeParse(c.req.param("channel"));
  if (!channel.success) throw new HTTPException(404, { message: "unknown channel" });

  const db = createDb(c.env.DB);
  await db
    .delete(schema.channelCredentials)
    .where(eq(schema.channelCredentials.channel, channel.data));
  return c.json({ ok: true });
});

/**
 * Mint a VAPID keypair for Web Push setup. Store the result via
 * `PUT /v1/channels/webpush`; hand `public_key` to the web app as its
 * `applicationServerKey`.
 */
channelRoutes.post("/webpush/keys", async (c) => {
  const keys = await generateVapidKeys();
  return c.json({ public_key: keys.publicKey, private_key: keys.privateKey });
});
