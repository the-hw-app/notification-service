import { createDb } from "@notification-service/db";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Env } from "../env.js";
import quickjsWasm from "../quickjs.wasm";
import { registerAnalyticsTools } from "./tools/analytics.js";
import { registerChannelTools } from "./tools/channels.js";
import { registerNotificationTools } from "./tools/notifications.js";
import { registerReferenceTool } from "./tools/reference.js";
import { registerTestingTools } from "./tools/testing.js";
import { registerUserTools } from "./tools/users.js";

/**
 * Build a fresh, per-request MCP server bound to this request's `env`.
 *
 * The handler is stateless (`createMcpHandler`, no Durable Object), so a new
 * server is constructed per request — Workers bindings are per-invocation. All
 * tools talk to D1 directly and reuse the `@notification-service/core` zod schemas as their
 * input contracts, so the tool surface can't drift from the real API.
 */
export function buildMcpServer(env: Env): McpServer {
  const db = createDb(env.DB);

  const server = new McpServer(
    { name: "notification-service", version: "1.0.0" },
    {
      instructions:
        "Notification Service is a single-tenant push-notification backend (FCM / APNs / Web Push). " +
        "Manage notification campaigns, their conditions and custom functions, channel " +
        "credentials, and users, and inspect delivery analytics. Call `describe_notification_service` first " +
        "if you're unsure how the pieces fit together. Author custom functions with " +
        "`dry_run_function` before saving them.",
    },
  );

  registerReferenceTool(server);
  registerNotificationTools(server, db);
  registerAnalyticsTools(server, db);
  registerUserTools(server, db);
  registerChannelTools(server, db);
  registerTestingTools(server, { db, queue: env.SEND_QUEUE, quickjsWasm });

  return server;
}
