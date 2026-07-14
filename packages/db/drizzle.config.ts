import { defineConfig } from "drizzle-kit";

/**
 * Generate-only. Migrations are applied with `wrangler d1 migrations apply`
 * (see scripts/setup.sh) so wrangler stays the single migration authority and
 * no D1 HTTP credentials are ever needed here.
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "./migrations",
});
