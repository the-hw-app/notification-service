import type { schema } from "@notification-service/db";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Every tool returns JSON as text content — the widest-supported result shape. */
export function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/** A tool-level error the LLM can read and recover from (not a transport error). */
export function fail(message: string, detail?: unknown): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          detail !== undefined ? { error: message, detail } : { error: message },
          null,
          2,
        ),
      },
    ],
  };
}

/** The wire shape for a notification — mirrors the REST `/v1/notifications` serializer. */
export function serializeNotification(row: typeof schema.notifications.$inferSelect) {
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

/** Masked device view — never leaks the full push token / subscription endpoint. */
export function serializeDevice(row: typeof schema.devices.$inferSelect) {
  return {
    id: row.id,
    channel: row.channel,
    token_tail: row.token.length > 8 ? `…${row.token.slice(-8)}` : row.token,
    has_subscription: row.subscription != null,
    created_at: row.createdAt,
    last_seen_at: row.lastSeenAt,
  };
}
