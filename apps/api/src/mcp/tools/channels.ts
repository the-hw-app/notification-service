import { channelCredentialsSchema, channelSchema, generateVapidKeys } from "@notification-service/core";
import { type Database, schema } from "@notification-service/db";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { fail, ok } from "../shared.js";

export function registerChannelTools(server: McpServer, db: Database): void {
  server.registerTool(
    "list_channels",
    {
      title: "List channels",
      description:
        "List configured push channels and whether each is enabled. Credentials are write-only — " +
        "this never returns secrets. A channel must be configured before a notification can " +
        "deliver on it.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const rows = await db.query.channelCredentials.findMany();
      return ok({
        channels: rows.map((row) => ({
          channel: row.channel,
          enabled: row.enabled,
          created_at: row.createdAt,
          updated_at: row.updatedAt,
        })),
      });
    },
  );

  server.registerTool(
    "configure_channel",
    {
      title: "Configure channel credentials",
      description:
        "Set (upsert) the provider credentials for a push channel. Shapes by channel:\n" +
        "• fcm — { channel:'fcm', serviceAccount: <Firebase service-account JSON> }\n" +
        "• apns — { channel:'apns', keyP8, keyId, teamId, bundleId, production }\n" +
        "• webpush — { channel:'webpush', publicKey, privateKey, subject } " +
        "(mint keys with generate_webpush_keys first).\n" +
        "`credentials.channel` must match the `channel` argument.",
      inputSchema: {
        channel: channelSchema.describe("fcm | apns | webpush."),
        credentials: channelCredentialsSchema.describe(
          "The provider credentials, discriminated by `channel`.",
        ),
        enabled: z.boolean().default(true).describe("Whether the channel is active. Default true."),
      },
    },
    async ({ channel, credentials, enabled }) => {
      if (credentials.channel !== channel) {
        return fail("credentials.channel does not match the `channel` argument", {
          channel,
          credentials_channel: credentials.channel,
        });
      }

      await db
        .insert(schema.channelCredentials)
        .values({ channel, credentials, enabled })
        .onConflictDoUpdate({
          target: schema.channelCredentials.channel,
          set: { credentials, enabled },
        });

      return ok({ ok: true, channel, enabled });
    },
  );

  server.registerTool(
    "delete_channel",
    {
      title: "Delete channel credentials",
      description:
        "Remove a channel's credentials. Notifications targeting it then record " +
        "`CHANNEL_NOT_CONFIGURED` failures until it is configured again.",
      inputSchema: { channel: channelSchema.describe("fcm | apns | webpush.") },
      annotations: { destructiveHint: true },
    },
    async ({ channel }) => {
      await db
        .delete(schema.channelCredentials)
        .where(eq(schema.channelCredentials.channel, channel));
      return ok({ ok: true, channel });
    },
  );

  server.registerTool(
    "generate_webpush_keys",
    {
      title: "Generate Web Push VAPID keys",
      description:
        "Mint a fresh VAPID keypair for Web Push. Store the result via configure_channel " +
        "(channel 'webpush'); hand `public_key` to the web app as its `applicationServerKey`. " +
        "The private key is only shown here once.",
      inputSchema: {},
    },
    async () => {
      const keys = await generateVapidKeys();
      return ok({ public_key: keys.publicKey, private_key: keys.privateKey });
    },
  );
}
