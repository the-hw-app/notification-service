import { CHANNELS, type Database, schema } from "@notification-service/db";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, count, desc, eq, gte, type SQL } from "drizzle-orm";
import { z } from "zod";

import { fail, ok } from "../shared.js";

const HOUR_MS = 3_600_000;

export function registerAnalyticsTools(server: McpServer, db: Database): void {
  server.registerTool(
    "get_send_analytics",
    {
      title: "Send analytics (aggregate)",
      description:
        "Aggregate delivery outcomes across all notifications over a time window: totals by " +
        "status (sent / failed / skipped), a per-channel breakdown, and the top error codes among " +
        "failures. This is the go-to tool for 'how many sends failed', 'what's failing', or " +
        "channel health. Filter by notification or channel to narrow it down.",
      inputSchema: {
        window_hours: z
          .number()
          .int()
          .min(1)
          .max(24 * 90)
          .default(24)
          .describe("Look back this many hours from now. Default 24."),
        notification_id: z.string().optional().describe("Restrict to one notification."),
        channel: z.enum(CHANNELS).optional().describe("Restrict to one channel."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ window_hours, notification_id, channel }) => {
      const cutoff = new Date(Date.now() - window_hours * HOUR_MS);
      const filters: SQL[] = [gte(schema.sends.createdAt, cutoff)];
      if (notification_id) filters.push(eq(schema.sends.notificationId, notification_id));
      if (channel) filters.push(eq(schema.sends.channel, channel));
      const where = and(...filters);

      const byStatus = await db
        .select({ status: schema.sends.status, n: count() })
        .from(schema.sends)
        .where(where)
        .groupBy(schema.sends.status);

      const byChannelStatus = await db
        .select({ channel: schema.sends.channel, status: schema.sends.status, n: count() })
        .from(schema.sends)
        .where(where)
        .groupBy(schema.sends.channel, schema.sends.status);

      const errorRows = await db
        .select({ errorCode: schema.sends.errorCode, n: count() })
        .from(schema.sends)
        .where(and(where, eq(schema.sends.status, "failed")))
        .groupBy(schema.sends.errorCode);

      const totals: Record<string, number> = { sent: 0, failed: 0, skipped: 0 };
      for (const row of byStatus) totals[row.status] = row.n;

      // Fold the (channel × status) rows into one object per channel.
      const channelMap = new Map<string, Record<string, number>>();
      for (const row of byChannelStatus) {
        // A `skipped` row has null channel (a skip is about the person, not a device).
        const key = row.channel ?? "(none)";
        const entry = channelMap.get(key) ?? { sent: 0, failed: 0, skipped: 0 };
        entry[row.status] = row.n;
        channelMap.set(key, entry);
      }

      const topErrors = errorRows
        .map((row) => ({ error_code: row.errorCode ?? "(unknown)", count: row.n }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20);

      return ok({
        window_hours,
        since: cutoff.toISOString(),
        filters: { notification_id: notification_id ?? null, channel: channel ?? null },
        totals: {
          sent: totals.sent,
          failed: totals.failed,
          skipped: totals.skipped,
          total: totals.sent + totals.failed + totals.skipped,
        },
        by_channel: [...channelMap.entries()].map(([ch, counts]) => ({ channel: ch, ...counts })),
        top_error_codes: topErrors,
      });
    },
  );

  server.registerTool(
    "list_failed_sends",
    {
      title: "List failed/skipped sends",
      description:
        "Recent individual send attempts that failed (or were skipped), newest first, with their " +
        "error code and message — the detail behind get_send_analytics. Use it to debug why " +
        "deliveries aren't landing (bad tokens, unconfigured channels, function errors, skips).",
      inputSchema: {
        status: z
          .enum(["failed", "skipped"])
          .default("failed")
          .describe("Which terminal outcome to list. Default failed."),
        limit: z.number().int().min(1).max(200).default(50).describe("Max rows. Default 50."),
        notification_id: z.string().optional().describe("Restrict to one notification."),
        channel: z.enum(CHANNELS).optional().describe("Restrict to one channel."),
        window_hours: z
          .number()
          .int()
          .min(1)
          .max(24 * 90)
          .optional()
          .describe("Optional: only sends within this many hours."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ status, limit, notification_id, channel, window_hours }) => {
      const filters: SQL[] = [eq(schema.sends.status, status)];
      if (notification_id) filters.push(eq(schema.sends.notificationId, notification_id));
      if (channel) filters.push(eq(schema.sends.channel, channel));
      if (window_hours) {
        filters.push(gte(schema.sends.createdAt, new Date(Date.now() - window_hours * HOUR_MS)));
      }

      const rows = await db.query.sends.findMany({
        where: and(...filters),
        orderBy: desc(schema.sends.createdAt),
        limit,
      });

      // Resolve notification names in one query rather than N.
      const ids = [...new Set(rows.map((r) => r.notificationId))];
      const names = new Map<string, string>();
      if (ids.length > 0) {
        const notifs = await db.query.notifications.findMany({
          columns: { id: true, name: true },
        });
        for (const n of notifs) names.set(n.id, n.name);
      }

      return ok({
        status,
        count: rows.length,
        sends: rows.map((r) => ({
          id: r.id,
          notification_id: r.notificationId,
          notification_name: names.get(r.notificationId) ?? null,
          distinct_id: r.distinctId,
          channel: r.channel,
          status: r.status,
          error_code: r.errorCode,
          error_message: r.errorMessage,
          created_at: r.createdAt,
        })),
      });
    },
  );

  server.registerTool(
    "get_notification_analytics",
    {
      title: "Notification analytics",
      description:
        "Deep-dive on one notification: its lifetime rollup counters plus its most recent " +
        "individual send attempts (sent / failed / skipped with error detail).",
      inputSchema: {
        notification_id: z.string().describe("The notification's id."),
        recent_limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe("How many recent send attempts to include. Default 20."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ notification_id, recent_limit }) => {
      const notification = await db.query.notifications.findFirst({
        where: eq(schema.notifications.id, notification_id),
      });
      if (!notification) return fail("notification not found", { notification_id });

      const recent = await db.query.sends.findMany({
        where: eq(schema.sends.notificationId, notification_id),
        orderBy: desc(schema.sends.createdAt),
        limit: recent_limit,
      });

      return ok({
        notification: {
          id: notification.id,
          name: notification.name,
          status: notification.status,
          authoring_mode: notification.authoringMode,
        },
        stats: {
          matched: notification.matchedCount,
          enqueued: notification.enqueuedCount,
          sent: notification.sentCount,
          failed: notification.failedCount,
          skipped: notification.skippedCount,
        },
        recent_sends: recent.map((r) => ({
          id: r.id,
          distinct_id: r.distinctId,
          channel: r.channel,
          status: r.status,
          error_code: r.errorCode,
          error_message: r.errorMessage,
          created_at: r.createdAt,
        })),
      });
    },
  );
}
