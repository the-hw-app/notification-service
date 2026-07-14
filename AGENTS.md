# AGENTS.md

Guidance for coding agents (and humans) working in this repo. Keep it current
when commands or structure change.

## What this is

A self-hostable **push-notification backend** on Cloudflare (Workers + D1 +
Queues), drivable over plain HTTP **or** via a built-in **MCP server**. It
registers device tokens, matches events to notifications, and delivers via
**FCM / APNs / Web Push** using only `fetch` + WebCrypto (no push-provider SDKs).
Single-tenant by design. See [README.md](README.md) for the full guide.

## Prerequisites

- **Node ≥ 18** (20 LTS+ recommended).
- **pnpm `10.14.0`** — pinned. Use `corepack enable` (reads the pin) or
  `npm i -g pnpm@10.14.0`. **pnpm 9.x fails** to link esbuild's platform binary.
- **Git**. Wrangler is bundled (invoked via `npx`) — no separate install.
- A **Cloudflare account** (free tier is enough) only for deploying a live instance.

## Setup (from zero to deployed)

```sh
pnpm install
pnpm run setup      # provisions D1 + queues, applies migrations, sets API_KEY,
                    # deploys the Worker, prints the MCP connect command.
                    # Requires `npx wrangler login` first. Idempotent.
pnpm run teardown   # destroys ALL Cloudflare resources + data for this instance.
```

`setup` writes the generated API key to `.api-key.local` (gitignored) and patches
`database_id` into `apps/api/wrangler.jsonc`.

## Commands

| Task | Command |
|------|---------|
| Install | `pnpm install` |
| Type-check (all) | `pnpm run check-types` |
| Test (all) | `pnpm test` |
| Build (dry-run bundle) | `pnpm run build` |
| Local dev server | `pnpm run dev` (runs `wrangler dev` in `apps/api`) |
| Deploy | `pnpm run deploy` |
| Generate D1 migrations | `pnpm run db:generate` (drizzle-kit, in `packages/db`) |
| Apply migrations (local) | `pnpm --filter @notification-service/api db:migrate:local` |
| Apply migrations (remote) | `pnpm --filter @notification-service/api db:migrate` |

Tests run under **vitest** in `packages/core` and `packages/sandbox`.
Type-checks are `tsc --noEmit` per package. Orchestrated by **Turborepo**.

Always run `pnpm run check-types && pnpm test` before proposing a change is done.

## Repo layout

```
apps/api/            Hono app on Cloudflare Workers — REST routes, queue consumer,
                     and the embedded MCP server (POST /mcp).
  src/routes/        /v1/identify, /v1/ingest, /v1/notifications, /v1/channels
  src/queue/         batch consumer: resolve payload → fan out → send → prune
  src/mcp/           MCP server + tools (reuse the @notification-service/core zod schemas)
  src/lib/           identify.ts / ingest.ts — shared domain logic (REST + MCP)
  wrangler.jsonc     Worker/D1/queue config (database_id is patched by setup.sh)
packages/core/       zod schemas, channel senders (fcm/apns/webpush), payload logic
packages/db/         drizzle schema + D1 migrations, shared types (CHANNELS, etc.)
packages/sandbox/    QuickJS-in-WASM sandbox for custom-function notifications
scripts/             setup.sh / teardown.sh
```

## Conventions & constraints — read before changing things

- **Single-tenant**: no `project_id` anywhere. A second project = a second
  deployed instance. Do not add tenancy/config complexity.
- **Free-plan safe by default**: the queue `max_batch_size` is kept small to stay
  under Cloudflare's 50-subrequests-per-invocation cap. Don't raise it without
  noting the Paid-plan requirement.
- **QuickJS wasm is vendored at build time** by `apps/api/scripts/copy-wasm.sh`
  (run automatically by `dev`/`build`/`deploy`). The 1 MB `apps/api/src/quickjs.wasm`
  is **gitignored** — never commit it.
- **esbuild is not hoisted** (see `.npmrc`) — each package resolves its own vendored
  esbuild; hoisting breaks wrangler. Don't "fix" this.
- **Provider senders** (`packages/core/src/channels/`) are hand-written WebCrypto /
  JWT. **APNs cannot be tested under `wrangler dev`** (needs HTTP/2) — deploy to test.
- **Queue messages are versioned** (`v: 1`) so a deploy can meet in-flight messages.
- **Shared domain logic** lives in `apps/api/src/lib/{identify,ingest}.ts` — REST
  routes and MCP tools must both go through it, not reimplement.
- **MCP tools reuse the core zod schemas** as their input contracts. When adding a
  tool, wire it in `src/mcp/tools/*` and reuse the existing schema.

## Security — never commit

- `.api-key.local` (the instance API key), `.dev.vars`, any `*.local`.
- Real provider credentials (FCM service accounts, APNs `.p8`, VAPID private keys)
  — those live only in D1 (set via `PUT /v1/channels/:channel`), never in the repo.

## Client examples

Ready-to-run demo apps (Swift, Kotlin, Expo, Flutter, Capacitor+Next.js, MAUI)
that integrate with an instance:
<https://github.com/the-hw-app/notification-service-examples>
