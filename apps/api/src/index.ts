import type { SendMessage } from "@notification-service/core";

import { app } from "./app.js";
import type { Env } from "./env.js";
import { handleQueue } from "./queue/consumer.js";

export default {
  fetch: app.fetch,
  queue: (batch: MessageBatch<SendMessage>, env: Env) => handleQueue(batch, env),
} satisfies ExportedHandler<Env, SendMessage>;
