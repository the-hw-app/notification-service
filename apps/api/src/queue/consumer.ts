import {
  functionResultSchema,
  interpolateDeep,
  isSkip,
  notificationPayloadSchema,
  sendMessageSchema,
  sendToDevice,
  type SendMessage,
  type SendResult,
} from "@notification-service/core";
import { createDb, schema, type Channel, type Database, type NotificationPayload } from "@notification-service/db";
import { runCustomFunction, SandboxError } from "@notification-service/sandbox";
import { and, eq, inArray, sql } from "drizzle-orm";

import quickjsWasm from "../quickjs.wasm";
import type { Env } from "../env.js";

/**
 * Keep in step with `max_retries` in wrangler.jsonc. Once a message has burned
 * its attempts, Queues routes it to the DLQ on the next `retry()`.
 */
const MAX_ATTEMPTS = 3;

type DeviceRow = typeof schema.devices.$inferSelect;

/**
 * Batch consumer.
 *
 * Messages are independent, so one poisoned notification must not stall the
 * other 24 in the batch: each is acked or retried on its own.
 */
export async function handleQueue(batch: MessageBatch<SendMessage>, env: Env): Promise<void> {
  const db = createDb(env.DB);

  await Promise.all(
    batch.messages.map(async (message) => {
      try {
        const outcome = await processMessage(db, message.body, message.attempts);
        if (outcome === "retry") message.retry();
        else message.ack();
      } catch (error) {
        console.error("send message failed", {
          messageId: message.id,
          attempts: message.attempts,
          error: (error as Error).message,
        });
        // An unexpected throw is a bug, not a provider hiccup. Retry a couple of
        // times in case it was transient, then let it fall into the DLQ.
        if (message.attempts >= MAX_ATTEMPTS) message.ack();
        else message.retry();
      }
    }),
  );
}

type Outcome = "done" | "retry";

async function processMessage(db: Database, raw: unknown, attempts: number): Promise<Outcome> {
  const parsed = sendMessageSchema.safeParse(raw);
  if (!parsed.success) {
    // A message this consumer cannot understand — most likely written by an
    // older deploy. Retrying will never help.
    console.error("dropping unparseable queue message", parsed.error.message);
    return "done";
  }
  const message = parsed.data;

  const notification = await db.query.notifications.findFirst({
    where: eq(schema.notifications.id, message.notificationId),
  });
  // Deleted or paused between enqueue and delivery — drop silently.
  if (!notification || notification.status !== "active") return "done";

  const user = await db.query.users.findFirst({
    where: eq(schema.users.distinctId, message.distinctId),
  });
  const userProperties = user?.properties ?? {};
  const eventProperties = message.event.properties;

  // ---- Resolve the payload ------------------------------------------------
  //
  // Two authoring modes converge on a single validated `NotificationPayload`:
  // the builder interpolates its stored template; the function runs user code
  // in the QuickJS sandbox — **here in the consumer, never on the ingest hot
  // path** — and its return value is zod-validated before any provider sees it.
  let payload: NotificationPayload;
  if (notification.authoringMode === "function") {
    if (!notification.functionSource) {
      await recordFailure(db, message, "MISSING_FUNCTION_SOURCE");
      return "done";
    }

    let result: unknown;
    try {
      result = await runCustomFunction(
        quickjsWasm,
        notification.functionSource,
        {
          // Event properties are flattened (as `{{event.x}}` interpolation sees
          // them), with the event name exposed as `event.__name`.
          event: { ...eventProperties, __name: message.event.name },
          user: userProperties,
        },
        { timeoutMs: 10_000 },
      );
    } catch (error) {
      const code = error instanceof SandboxError ? error.code : "THROWN";
      await recordFailure(db, message, `SANDBOX_${code}`, (error as Error).message);
      return "done";
    }

    const validated = functionResultSchema.safeParse(result);
    if (!validated.success) {
      await recordFailure(db, message, "INVALID_FUNCTION_RESULT", validated.error.message);
      return "done";
    }
    if (isSkip(validated.data)) {
      await recordSkip(db, message, validated.data.reason ?? "skipped by custom function");
      return "done";
    }
    payload = validated.data;
  } else {
    if (!notification.payload) {
      await recordFailure(db, message, "MISSING_PAYLOAD");
      return "done";
    }
    const interpolated = interpolateDeep(notification.payload, {
      event: eventProperties,
      user: userProperties,
    });
    const validated = notificationPayloadSchema.safeParse(interpolated);
    if (!validated.success) {
      // Interpolation can empty a required field — e.g. a title that is only
      // `{{user.firstName}}` for a user we never identified.
      await recordFailure(db, message, "INVALID_PAYLOAD", validated.error.message);
      return "done";
    }
    payload = validated.data;
  }

  // ---- Fan out to devices -------------------------------------------------
  const channels = notification.channels;
  if (channels.length === 0) {
    await recordSkip(db, message, "NO_CHANNELS_ENABLED");
    return "done";
  }

  const userDevices = await db.query.devices.findMany({
    where: and(
      eq(schema.devices.distinctId, message.distinctId),
      inArray(schema.devices.channel, channels),
    ),
  });
  if (userDevices.length === 0) {
    await recordSkip(db, message, "NO_DEVICES");
    return "done";
  }

  const credentialRows = await db.query.channelCredentials.findMany({
    where: eq(schema.channelCredentials.enabled, true),
  });
  const credentialsByChannel = new Map(credentialRows.map((row) => [row.channel, row.credentials]));

  const results = await Promise.all(
    userDevices.map(async (device) => {
      const credentials = credentialsByChannel.get(device.channel);
      const sendId = crypto.randomUUID();
      if (!credentials) {
        return {
          device,
          sendId,
          result: {
            ok: false,
            status: 0,
            errorCode: "CHANNEL_NOT_CONFIGURED",
            deadToken: false,
            retryable: false,
          } satisfies SendResult,
        };
      }

      const result = await sendToDevice(
        credentials,
        { channel: device.channel, token: device.token, subscription: device.subscription },
        payload,
        notification.channelOverrides,
        sendId,
      );
      return { device, sendId, result };
    }),
  );

  // ---- Decide: retry the whole message, or commit the outcome -------------
  //
  // We write nothing before deciding. If any device hit a transient provider
  // error we retry the *message*, which means the devices that already
  // succeeded will be pushed again — unavoidable under at-least-once delivery.
  // What we refuse to do is write their `sent` rows twice and double-count the
  // rollups, so on a retry path we persist nothing at all.
  const retryable = results.some((entry) => entry.result.retryable);
  if (retryable && attempts < MAX_ATTEMPTS) return "retry";

  await pruneDeadDevices(
    db,
    results.filter((entry) => entry.result.deadToken).map((entry) => entry.device),
  );

  await commitSends(db, message, results);
  return "done";
}

async function commitSends(
  db: Database,
  message: SendMessage,
  results: Array<{ device: DeviceRow; sendId: string; result: SendResult }>,
): Promise<void> {
  if (results.length === 0) return;

  const rows = results.map(({ device, sendId, result }) => ({
    id: sendId,
    notificationId: message.notificationId,
    distinctId: message.distinctId,
    // A pruned device leaves the send row behind, pointing at nothing.
    deviceId: result.deadToken ? null : device.id,
    channel: device.channel as Channel,
    status: result.ok ? ("sent" as const) : ("failed" as const),
    errorCode: result.errorCode ?? null,
    errorMessage: result.errorMessage ?? null,
  }));

  const sent = rows.filter((row) => row.status === "sent").length;
  const failed = rows.length - sent;

  await db.batch([
    db.insert(schema.sends).values(rows),
    db
      .update(schema.notifications)
      .set({
        sentCount: sql`${schema.notifications.sentCount} + ${sent}`,
        failedCount: sql`${schema.notifications.failedCount} + ${failed}`,
      })
      .where(eq(schema.notifications.id, message.notificationId)),
  ]);
}

/** FCM UNREGISTERED / APNs 410 / Web Push 404|410 — the destination is gone for good. */
async function pruneDeadDevices(db: Database, devices: DeviceRow[]): Promise<void> {
  if (devices.length === 0) return;
  await db.delete(schema.devices).where(
    inArray(
      schema.devices.id,
      devices.map((device) => device.id),
    ),
  );
}

async function recordSkip(db: Database, message: SendMessage, reason: string): Promise<void> {
  await db.batch([
    db.insert(schema.sends).values({
      notificationId: message.notificationId,
      distinctId: message.distinctId,
      // A skip is a decision about the person, not about any one device.
      channel: null,
      status: "skipped",
      errorCode: reason.slice(0, 64),
    }),
    db
      .update(schema.notifications)
      .set({ skippedCount: sql`${schema.notifications.skippedCount} + 1` })
      .where(eq(schema.notifications.id, message.notificationId)),
  ]);
}

async function recordFailure(
  db: Database,
  message: SendMessage,
  code: string,
  detail?: string,
): Promise<void> {
  await db.batch([
    db.insert(schema.sends).values({
      notificationId: message.notificationId,
      distinctId: message.distinctId,
      channel: null,
      status: "failed",
      errorCode: code.slice(0, 64),
      errorMessage: detail?.slice(0, 1024),
    }),
    db
      .update(schema.notifications)
      .set({ failedCount: sql`${schema.notifications.failedCount} + 1` })
      .where(eq(schema.notifications.id, message.notificationId)),
  ]);
}
