import { z } from "zod";

/**
 * The queue message contract between the ingest producer and the consumer.
 *
 * One message per (recipient × matched notification). Fan-out to that
 * recipient's devices happens in the consumer, not the producer, because
 * device lists go stale and messages can sit in the queue for hours.
 *
 * Versioned from day one: Queues is at-least-once with retention measured in
 * days, so a deploy that changes this shape will meet in-flight messages
 * written by the previous version. The consumer must be able to tell them apart.
 */
export const SEND_MESSAGE_VERSION = 1;

export const sendMessageSchema = z.object({
  v: z.literal(SEND_MESSAGE_VERSION),
  notificationId: z.string().min(1),
  distinctId: z.string().min(1),
  /**
   * The triggering event, carried inline rather than re-read from storage —
   * raw events are never persisted, so this is the only copy.
   */
  event: z.object({
    name: z.string().min(1),
    properties: z.record(z.string(), z.unknown()),
    /** Epoch ms at ingest, so a delayed send can reason about staleness. */
    timestamp: z.number().int(),
  }),
});

export type SendMessage = z.infer<typeof sendMessageSchema>;

/**
 * Queues caps a message at 128KB. An event with a pathological property bag
 * would otherwise fail the whole `sendBatch` — reject it at ingest instead,
 * where we can return a 4xx the customer can act on.
 */
export const MAX_MESSAGE_BYTES = 128 * 1024;

export function messageSizeBytes(message: SendMessage): number {
  return new TextEncoder().encode(JSON.stringify(message)).length;
}
