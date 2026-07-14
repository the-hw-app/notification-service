import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

import type { HonoEnv } from "../env.js";

const encoder = new TextEncoder();

/**
 * Constant-time comparison via double hashing: SHA-256 both sides, then
 * compare digests. The digest lengths are always equal, so the byte-compare
 * leaks nothing about the secret's length or content.
 */
async function secretsMatch(presented: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const ua = new Uint8Array(a);
  const ub = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
}

/** Bearer auth against the single instance-wide API_KEY secret. */
export const apiKeyAuth: MiddlewareHandler<HonoEnv> = async (c, next) => {
  if (!c.env.API_KEY) {
    throw new HTTPException(500, { message: "API_KEY secret is not configured" });
  }

  const header = c.req.header("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!presented || !(await secretsMatch(presented, c.env.API_KEY))) {
    throw new HTTPException(401, { message: "invalid API key" });
  }

  await next();
};
