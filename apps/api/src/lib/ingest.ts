import {
  MAX_MESSAGE_BYTES,
  matchesConditions,
  messageSizeBytes,
  SEND_MESSAGE_VERSION,
  type SendMessage,
} from "@notification-service/core";
import { type Database, schema } from "@notification-service/db";
import { eq, sql } from "drizzle-orm";

/**
 * The match → enqueue core behind `POST /v1/ingest` and the `send_test_event`
 * MCP tool, extracted so both share one implementation. Raw events are never
 * stored: matching happens here and now, inline, and the triggering event
 * rides inside each queue message. Input is assumed already validated.
 */

/** Queues caps `sendBatch` at 100 messages per call. */
const QUEUE_BATCH_LIMIT = 100;

export interface IngestInput {
  distinctId: string;
  event: string;
  properties: Record<string, unknown>;
  timestamp: number;
}

export type IngestResult =
  | { ok: true; matched: number; enqueued: number }
  | { ok: false; reason: "oversized"; maxBytes: number };

export async function ingestEvent(
  db: Database,
  queue: Queue<SendMessage>,
  input: IngestInput,
): Promise<IngestResult> {
  const { distinctId, event: eventName, properties, timestamp } = input;

  const candidates = await db.query.notifications.findMany({
    where: eq(schema.notifications.status, "active"),
  });

  const matched = candidates.filter((notification) => {
    if (!notification.triggerEvents.includes(eventName)) return false;
    // Custom functions do their own filtering inside the sandbox, in the queue
    // consumer — never on this request's CPU budget. Conditions are ignored.
    if (notification.authoringMode === "function") return true;
    return matchesConditions(notification.conditions, properties);
  });

  if (matched.length === 0) return { ok: true, matched: 0, enqueued: 0 };

  const messages: SendMessage[] = matched.map((notification) => ({
    v: SEND_MESSAGE_VERSION,
    notificationId: notification.id,
    distinctId,
    event: { name: eventName, properties, timestamp },
  }));

  // Reject an oversized event before touching the queue: `sendBatch` would
  // otherwise fail the whole call opaquely.
  const oversized = messages.find((message) => messageSizeBytes(message) > MAX_MESSAGE_BYTES);
  if (oversized) return { ok: false, reason: "oversized", maxBytes: MAX_MESSAGE_BYTES };

  for (let i = 0; i < messages.length; i += QUEUE_BATCH_LIMIT) {
    await queue.sendBatch(messages.slice(i, i + QUEUE_BATCH_LIMIT).map((body) => ({ body })));
  }

  await Promise.all(
    matched.map((notification) =>
      db
        .update(schema.notifications)
        .set({
          matchedCount: sql`${schema.notifications.matchedCount} + 1`,
          enqueuedCount: sql`${schema.notifications.enqueuedCount} + 1`,
        })
        .where(eq(schema.notifications.id, notification.id)),
    ),
  );

  return { ok: true, matched: matched.length, enqueued: messages.length };
}
