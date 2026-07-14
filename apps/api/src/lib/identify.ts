import { type Channel, type Database, schema, type WebPushSubscription } from "@notification-service/db";
import { eq } from "drizzle-orm";

/**
 * The user/device upsert behind `POST /v1/identify` and the `identify_user`
 * MCP tool, extracted so both share one implementation. Input is assumed
 * already validated (both callers parse with zod first); this is pure domain
 * logic against D1.
 */

export interface IdentifyDevice {
  channel: Channel;
  /** FCM/APNs registration token. Web Push passes `subscription` instead. */
  token?: string;
  subscription?: WebPushSubscription;
}

export interface IdentifyInput {
  distinctId: string;
  properties?: Record<string, unknown>;
  device?: IdentifyDevice;
}

export type IdentifyResult = { ok: true } | { ok: false; reason: "device_missing_token" };

export async function identifyUser(db: Database, input: IdentifyInput): Promise<IdentifyResult> {
  const { distinctId, properties, device } = input;

  if (properties) {
    // Properties merge rather than replace: an app that only knows the user's
    // plan shouldn't wipe the name another call set.
    const existing = await db.query.users.findFirst({
      where: eq(schema.users.distinctId, distinctId),
      columns: { id: true, properties: true },
    });

    if (existing) {
      await db
        .update(schema.users)
        .set({ properties: { ...existing.properties, ...properties } })
        .where(eq(schema.users.id, existing.id));
    } else {
      await db.insert(schema.users).values({ distinctId, properties });
    }
  } else {
    await db.insert(schema.users).values({ distinctId }).onConflictDoNothing();
  }

  if (device) {
    // Web Push has no opaque token; its subscription endpoint is the natural key.
    const token = device.channel === "webpush" ? device.subscription?.endpoint : device.token;
    if (!token) return { ok: false, reason: "device_missing_token" };

    // Re-identifying an existing token re-assigns the device to the new user
    // (shared tablet, logout/login) instead of creating a duplicate row.
    await db
      .insert(schema.devices)
      .values({
        distinctId,
        channel: device.channel,
        token,
        subscription: device.subscription ?? null,
      })
      .onConflictDoUpdate({
        target: schema.devices.token,
        set: {
          distinctId,
          channel: device.channel,
          subscription: device.subscription ?? null,
          lastSeenAt: new Date(),
        },
      });
  }

  return { ok: true };
}
