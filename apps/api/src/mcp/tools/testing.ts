import { functionResultSchema, isSkip, type SendMessage } from "@notification-service/core";
import { CHANNELS, type Database } from "@notification-service/db";
import { runCustomFunction, SandboxError } from "@notification-service/sandbox";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { identifyUser } from "../../lib/identify.js";
import { ingestEvent } from "../../lib/ingest.js";
import { fail, ok } from "../shared.js";

export interface TestingContext {
  db: Database;
  queue: Queue<SendMessage>;
  quickjsWasm: WebAssembly.Module;
}

export function registerTestingTools(server: McpServer, ctx: TestingContext): void {
  const { db, queue, quickjsWasm } = ctx;

  server.registerTool(
    "dry_run_function",
    {
      title: "Dry-run a custom function",
      description:
        "Run a custom-function source in the QuickJS sandbox against a sample event + user and " +
        "return the resolved payload, a skip decision, or the exact error — WITHOUT sending " +
        "anything or saving a notification. This is the same code path the queue consumer uses, " +
        "so use it to author and verify a `function_source` before create_notification. The " +
        "function is `async (event, user, ctx) => payload | { skip: true, reason? }`; `ctx.fetch` " +
        "is available for outbound HTTP.",
      inputSchema: {
        function_source: z
          .string()
          .min(1)
          .max(64 * 1024)
          .describe("The `async (event, user, ctx) => …` source to run."),
        event_name: z
          .string()
          .default("test_event")
          .describe("Trigger event name, exposed to the function as `event.__name`."),
        event_properties: z
          .record(z.string(), z.unknown())
          .default({})
          .describe("Sample event properties (the `event` arg, flattened)."),
        user_properties: z
          .record(z.string(), z.unknown())
          .default({})
          .describe("Sample identified-user properties (the `user` arg)."),
        timeout_ms: z
          .number()
          .int()
          .min(100)
          .max(10_000)
          .default(10_000)
          .describe("Wall-clock ceiling. Default (and max) 10000."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ function_source, event_name, event_properties, user_properties, timeout_ms }) => {
      let result: unknown;
      try {
        result = await runCustomFunction(
          quickjsWasm,
          function_source,
          {
            event: { ...event_properties, __name: event_name },
            user: user_properties,
          },
          { timeoutMs: timeout_ms },
        );
      } catch (error) {
        const code = error instanceof SandboxError ? error.code : "THROWN";
        return ok({
          outcome: "error",
          error_code: `SANDBOX_${code}`,
          error_message: (error as Error).message,
        });
      }

      const validated = functionResultSchema.safeParse(result);
      if (!validated.success) {
        return ok({
          outcome: "error",
          error_code: "INVALID_FUNCTION_RESULT",
          error_message: validated.error.message,
          raw_return: result,
        });
      }
      if (isSkip(validated.data)) {
        return ok({ outcome: "skip", reason: validated.data.reason ?? null });
      }
      return ok({ outcome: "payload", payload: validated.data });
    },
  );

  server.registerTool(
    "send_test_event",
    {
      title: "Send a test event",
      description:
        "Ingest an event exactly as a customer app would (`POST /v1/ingest`): it is matched " +
        "against active notifications and, for each match, one message per user is enqueued for " +
        "delivery. Returns how many notifications matched and how many messages were enqueued. " +
        "Delivery itself is async (queue → consumer → provider) — check outcomes afterward with " +
        "get_send_analytics or get_notification_analytics. The user should already be identified " +
        "(with a device) for anything to actually be delivered.",
      inputSchema: {
        distinct_id: z.string().min(1).max(256).describe("Who the event is for."),
        event: z.string().min(1).max(128).describe("Event name (must be a notification trigger)."),
        properties: z
          .record(z.string(), z.unknown())
          .default({})
          .describe("Event properties, matched against builder conditions."),
        timestamp: z.number().int().optional().describe("Epoch ms. Defaults to now."),
      },
    },
    async ({ distinct_id, event, properties, timestamp }) => {
      const result = await ingestEvent(db, queue, {
        distinctId: distinct_id,
        event,
        properties,
        timestamp: timestamp ?? Date.now(),
      });
      if (!result.ok) {
        return fail(`event exceeds the ${result.maxBytes} byte queue message limit`);
      }
      return ok({ ok: true, matched: result.matched, enqueued: result.enqueued });
    },
  );

  server.registerTool(
    "identify_user",
    {
      title: "Identify a user / register a device",
      description:
        "Upsert a user by `distinct_id` and optionally register a push device (`POST " +
        "/v1/identify`). Properties merge (they don't replace). Use this to set up test users, " +
        "attach a device token, or update `{{user.y}}` properties. For webpush, pass " +
        "`device.subscription` instead of `device.token`.",
      inputSchema: {
        distinct_id: z.string().min(1).max(256).describe("The user's distinct_id."),
        properties: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Properties to merge into the user."),
        device: z
          .object({
            channel: z.enum(CHANNELS),
            token: z.string().min(1).max(1024).optional().describe("FCM/APNs token."),
            subscription: z
              .object({
                endpoint: z.url(),
                keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
              })
              .optional()
              .describe("Web Push subscription (webpush channel only)."),
          })
          .optional()
          .describe("Optional push device to register for this user."),
      },
    },
    async ({ distinct_id, properties, device }) => {
      const result = await identifyUser(db, { distinctId: distinct_id, properties, device });
      if (!result.ok) {
        return fail(
          device?.channel === "webpush"
            ? "webpush devices require `subscription`"
            : "`token` is required",
        );
      }
      return ok({ ok: true, distinct_id });
    },
  );
}
