import { type Database, schema } from "@notification-service/db";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { desc, eq, inArray, like } from "drizzle-orm";
import { z } from "zod";

import { fail, ok, serializeDevice } from "../shared.js";

export function registerUserTools(server: McpServer, db: Database): void {
  server.registerTool(
    "list_users",
    {
      title: "List users",
      description:
        "List identified users (people in the customer's app, keyed by `distinct_id`), newest " +
        "first, each with its properties and a count of registered push devices. Optionally " +
        "filter by a `distinct_id` prefix.",
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe("Case-sensitive `distinct_id` prefix to filter by."),
        limit: z.number().int().min(1).max(200).default(50).describe("Max users. Default 50."),
        offset: z.number().int().min(0).default(0).describe("Skip this many (pagination)."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ search, limit, offset }) => {
      const users = await db.query.users.findMany({
        where: search ? like(schema.users.distinctId, `${search}%`) : undefined,
        orderBy: desc(schema.users.createdAt),
        limit,
        offset,
      });

      // One query for all device counts rather than N.
      const ids = users.map((u) => u.distinctId);
      const counts = new Map<string, number>();
      if (ids.length > 0) {
        const devices = await db.query.devices.findMany({
          where: inArray(schema.devices.distinctId, ids),
          columns: { distinctId: true },
        });
        for (const d of devices) counts.set(d.distinctId, (counts.get(d.distinctId) ?? 0) + 1);
      }

      return ok({
        count: users.length,
        limit,
        offset,
        users: users.map((u) => ({
          distinct_id: u.distinctId,
          properties: u.properties,
          device_count: counts.get(u.distinctId) ?? 0,
          created_at: u.createdAt,
          updated_at: u.updatedAt,
        })),
      });
    },
  );

  server.registerTool(
    "get_user",
    {
      title: "Get user",
      description:
        "Fetch one user by `distinct_id`: their properties (used for `{{user.y}}` interpolation " +
        "and available to custom functions), their registered push devices (tokens masked), and " +
        "optionally their most recent send attempts.",
      inputSchema: {
        distinct_id: z.string().describe("The user's distinct_id."),
        include_recent_sends: z
          .boolean()
          .default(true)
          .describe("Include the user's recent send attempts. Default true."),
        recent_sends_limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe("How many recent sends to include. Default 20."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ distinct_id, include_recent_sends, recent_sends_limit }) => {
      const user = await db.query.users.findFirst({
        where: eq(schema.users.distinctId, distinct_id),
      });
      if (!user) return fail("user not found", { distinct_id });

      const devices = await db.query.devices.findMany({
        where: eq(schema.devices.distinctId, distinct_id),
        orderBy: desc(schema.devices.lastSeenAt),
      });

      const recentSends = include_recent_sends
        ? await db.query.sends.findMany({
            where: eq(schema.sends.distinctId, distinct_id),
            orderBy: desc(schema.sends.createdAt),
            limit: recent_sends_limit,
          })
        : [];

      return ok({
        user: {
          distinct_id: user.distinctId,
          properties: user.properties,
          created_at: user.createdAt,
          updated_at: user.updatedAt,
        },
        devices: devices.map(serializeDevice),
        ...(include_recent_sends
          ? {
              recent_sends: recentSends.map((r) => ({
                id: r.id,
                notification_id: r.notificationId,
                channel: r.channel,
                status: r.status,
                error_code: r.errorCode,
                created_at: r.createdAt,
              })),
            }
          : {}),
      });
    },
  );
}
