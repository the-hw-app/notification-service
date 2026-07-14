import { AUTHORING_MODES, CHANNELS, CONDITION_OPERATORS, NOTIFICATION_STATUSES } from "@notification-service/db";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ok } from "../shared.js";

export function registerReferenceTool(server: McpServer): void {
  server.registerTool(
    "describe_notification_service",
    {
      title: "How Notification Service works",
      description:
        "Return a concise reference for driving Notification Service: the pipeline, the notification model, " +
        "condition operators, template syntax, the custom-function contract, and channel setup. " +
        "Call this first when unsure how the pieces fit together.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      ok({
        overview:
          "Notification Service is a single-tenant push-notification backend. Apps identify users (+devices) " +
          "and send events; notifications whose trigger + filter match an event are enqueued and " +
          "delivered to the user's devices via FCM / APNs / Web Push.",
        pipeline: [
          "identify_user → users + devices",
          "send_test_event (ingest) → match active notifications → enqueue one message per (user × notification)",
          "queue consumer → resolve payload (interpolate template OR run custom function) → fan out to devices → send → record a `sends` row + bump rollup counters",
        ],
        notification: {
          statuses: NOTIFICATION_STATUSES,
          authoring_modes: AUTHORING_MODES,
          builder:
            "conditions (AND-filter on event properties, evaluated at ingest) + payload template. Requires `payload`.",
          function:
            "function_source runs in a QuickJS sandbox in the consumer; it is both filter and payload builder. Requires `function_source`; conditions/payload are ignored.",
        },
        condition_operators: {
          list: CONDITION_OPERATORS,
          notes:
            "Each condition is {property, operator, value?}. `exists` takes no value; `in` takes an array; others take a scalar. All conditions are ANDed.",
        },
        template_syntax:
          "Builder payloads interpolate `{{event.x}}` (from the triggering event's properties) and " +
          "`{{user.y}}` (from the identified user's merged properties) at send time.",
        payload_shape: {
          title: "string (required)",
          body: "string (required)",
          image: "url (optional)",
          url: "deeplink (optional, e.g. myapp://product/42)",
          data: "object of string→string (optional)",
        },
        custom_function: {
          signature: "async (event, user, ctx) => payload | { skip: true, reason? }",
          event: "flattened event properties, plus `event.__name` = the trigger event name",
          user: "the identified user's merged properties",
          ctx: "`ctx.fetch(url, init)` for outbound HTTP (10s wall-clock, 64MB memory cap)",
          tip: "Author and verify with dry_run_function before create_notification.",
        },
        channels: {
          list: CHANNELS,
          setup:
            "Configure each channel with configure_channel before notifications can deliver on it. " +
            "For webpush, mint keys with generate_webpush_keys first.",
        },
        analytics:
          "Per-notification rollup counters live on the notification (matched/enqueued/sent/failed/skipped). " +
          "get_send_analytics aggregates the `sends` table across notifications; list_failed_sends shows individual failures.",
      }),
  );
}
