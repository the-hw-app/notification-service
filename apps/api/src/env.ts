import type { SendMessage } from "@notification-service/core";

export interface Env {
  DB: D1Database;
  SEND_QUEUE: Queue<SendMessage>;
  /** Set with `wrangler secret put API_KEY` (scripts/setup.sh does this). */
  API_KEY: string;
}

export type HonoEnv = { Bindings: Env };
