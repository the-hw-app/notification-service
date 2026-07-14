import { CHANNELS, CONDITION_OPERATORS } from "@notification-service/db/types";
import { z } from "zod";

/**
 * The zod contract every payload passes through. The stored template is
 * validated against this at save time, and the interpolated result again at
 * send time — nothing reaches a channel sender without passing through here.
 */

export const notificationPayloadSchema = z.object({
  title: z.string().min(1).max(256),
  body: z.string().min(1).max(2048),
  image: z.url().max(2048).optional(),
  /** Deeplink. Not necessarily http(s) — `myapp://product/42` is valid. */
  url: z.url().max(2048).optional(),
  /** Providers only carry string values in their data dictionaries. */
  data: z.record(z.string(), z.string()).optional(),
});

export type NotificationPayload = z.infer<typeof notificationPayloadSchema>;

export const channelOverridesSchema = z.object({
  fcm: z
    .object({
      collapseKey: z.string().max(64).optional(),
      ttlSeconds: z.number().int().min(0).max(2_419_200).optional(),
    })
    .optional(),
  apns: z
    .object({
      sound: z.string().max(128).optional(),
      badge: z.number().int().min(0).optional(),
      collapseId: z.string().max(64).optional(),
      ttlSeconds: z.number().int().min(0).optional(),
    })
    .optional(),
  webpush: z
    .object({
      ttlSeconds: z.number().int().min(0).optional(),
      urgency: z.enum(["very-low", "low", "normal", "high"]).optional(),
    })
    .optional(),
});

export const conditionSchema = z
  .object({
    property: z.string().min(1).max(128),
    operator: z.enum(CONDITION_OPERATORS),
    value: z
      .union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))])
      .optional(),
  })
  .refine((c) => c.operator === "exists" || c.value !== undefined, {
    message: "value is required for every operator except `exists`",
    path: ["value"],
  })
  .refine((c) => c.operator !== "in" || Array.isArray(c.value), {
    message: "the `in` operator requires an array value",
    path: ["value"],
  });

export const channelSchema = z.enum(CHANNELS);

/**
 * What a custom function is allowed to return. `{ skip: true }` is a first-class
 * outcome — it records a `skipped` send row with the given reason rather than
 * an error, which is how a function expresses "this user shouldn't get this".
 * The custom function's return value is validated against this at run time,
 * right after it leaves the QuickJS sandbox and before any provider sees it.
 */
export const skipResultSchema = z.object({
  skip: z.literal(true),
  reason: z.string().max(256).optional(),
});

export const functionResultSchema = z.union([skipResultSchema, notificationPayloadSchema]);

export type SkipResult = z.infer<typeof skipResultSchema>;
export type FunctionResult = z.infer<typeof functionResultSchema>;

export function isSkip(result: FunctionResult): result is SkipResult {
  return "skip" in result && result.skip === true;
}

export const channelCredentialsSchema = z.discriminatedUnion("channel", [
  z.object({
    channel: z.literal("fcm"),
    serviceAccount: z
      .object({
        project_id: z.string().min(1),
        client_email: z.string().min(1),
        private_key: z.string().min(1),
      })
      .loose(),
  }),
  z.object({
    channel: z.literal("apns"),
    keyP8: z.string().min(1),
    keyId: z.string().min(1),
    teamId: z.string().min(1),
    bundleId: z.string().min(1),
    production: z.boolean(),
  }),
  z.object({
    channel: z.literal("webpush"),
    publicKey: z.string().min(1),
    privateKey: z.string().min(1),
    subject: z.string().min(1),
  }),
]);
