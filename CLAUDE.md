# CLAUDE.md

Project guidance for Claude Code. The canonical setup, commands, structure, and
conventions live in **@AGENTS.md** — read that first and follow it.

## Quick reminders

- Package manager is **pnpm `10.14.0`** (`corepack enable`). pnpm 9.x is broken here.
- Before calling a change done: `pnpm run check-types && pnpm test`.
- Deploy/manage a live instance with `pnpm run setup` / `pnpm run teardown`
  (needs `npx wrangler login`).
- **Never commit** `.api-key.local`, `*.local`, `.dev.vars`, `apps/api/src/quickjs.wasm`,
  or any provider credentials.
- Single-tenant, free-plan-safe by design — don't add tenancy or raise queue batch
  sizes without noting the Paid-plan requirement. See @AGENTS.md for the rest.
