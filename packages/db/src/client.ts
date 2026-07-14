import { drizzle } from "drizzle-orm/d1";

import * as schema from "./schema.js";

/**
 * Always created inside a handler from the request's `env.DB` — never at
 * module scope, because Workers bindings are per-invocation.
 */
export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type Database = ReturnType<typeof createDb>;
