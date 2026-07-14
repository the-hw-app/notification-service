# Notification Service

A self-hostable **push-notification backend** on Cloudflare (Workers + D1 + Queues) that you can drive with plain HTTP **or** with an LLM through a built-in **MCP server**.

Register device tokens, define notifications (event triggers + conditions + a payload template, or a custom function), ingest events, and Notification Service filters, queues, batches, and delivers via **FCM**, **APNs**, and **Web Push** — no push-provider SDKs; everything is `fetch` + WebCrypto. It runs entirely on Cloudflare's free tier for typical hobby volumes.

This guide takes you from **nothing installed** to a **deployed instance you can manage from Claude**.

---

## Contents

1. [How it works](#how-it-works)
2. [Prerequisites (from scratch)](#prerequisites-from-scratch)
3. [Setup & deploy](#setup--deploy)
4. [Connect the MCP server to Claude](#connect-the-mcp-server-to-claude)
5. [Configure a push channel](#configure-a-push-channel)
6. [Send your first notification](#send-your-first-notification)
7. [REST API reference](#rest-api-reference)
8. [Custom functions](#custom-functions)
9. [Local development](#local-development)
10. [Updating & tearing down](#updating--tearing-down)
11. [Repo layout](#repo-layout)
12. [Troubleshooting](#troubleshooting)
13. [Design notes](#design-notes)

---

## How it works

```
POST /v1/identify ──► users + devices (D1)

POST /v1/ingest  ──► match active notifications (trigger event + conditions,
                     or trigger event only for function-mode)
                 └─► Cloudflare Queue (1 msg per user × notification)
                         └─► batch consumer: resolve the payload
                             (interpolate the template, OR run the custom
                              function in a QuickJS/WASM sandbox),
                             fan out to the user's devices,
                             send via FCM / APNs / Web Push,
                             prune dead tokens, record sends

POST /mcp        ──► remote MCP server: 19 tools to author notifications,
                     inspect analytics, and manage users/channels from an LLM
```

Raw events are **never stored** — matching happens inline at ingest. Everything is **single-tenant**: one instance, one API key. Need a second project? Deploy a second instance.

---

## Prerequisites (from scratch)

You need four things. If you already have some, skip ahead.

### 1. A Cloudflare account (free)

Notification Service deploys to your own Cloudflare account.

- **Create one:** <https://dash.cloudflare.com/sign-up> — email + password, no credit card required for the Workers free tier.
- Already have one? Sign in at <https://dash.cloudflare.com>.

The **Workers Free** plan covers Workers, D1, and Queues for hobby volumes — but a couple of Free-plan limits matter for Notification Service; see [Plan & limits](#plan--limits) below. If `pnpm run setup` reports a Queues error, enable Queues once in the [dashboard](https://dash.cloudflare.com/?to=/:account/workers/queues) and re-run.

### 2. Node.js ≥ 18 (use 20 LTS or newer)

- **Install:** download the LTS from <https://nodejs.org> (or use [nvm](https://github.com/nvm-sh/nvm)).
- **Verify:** `node --version` → should print `v18` or higher.

### 3. pnpm (this repo pins `10.14.0`)

The easiest way is **Corepack** (ships with Node), which reads the pinned version automatically:

```sh
corepack enable
```

Then `pnpm` inside this repo will use `10.14.0`. If you don't have Corepack:

```sh
npm install -g pnpm@10.14.0
```

> ⚠️ Use pnpm **10.14.0**. pnpm 9.x fails to link esbuild's platform binary in this repo.

### 4. Git

To clone the repo — <https://git-scm.com/downloads> if you don't have it. Verify with `git --version`.

You do **not** need to install Wrangler (Cloudflare's CLI) separately — it comes with the repo and is invoked via `npx`.

### Plan & limits

**Notification Service is tuned for the Workers Free plan out of the box — no paid plan needed.** A fresh deploy just works on Free: the shipped `apps/api/wrangler.jsonc` uses a small queue `max_batch_size` (6) that stays inside Free's **50-subrequests-per-invocation** cap. Free comfortably handles **~20,000–40,000 events/day** (the binding limit is D1 writes; it drops as device/notification fan-out grows) — plenty for hobby and small production use.

**Upgrade to the Workers Paid plan ($5/mo) only if you outgrow Free**, i.e. any of:

- **More than ~20–40k events/day**, or heavy device fan-out.
- **Heavy use of custom functions.** The QuickJS sandbox strains Free's **10 ms CPU** cap — occasional functions are fine, but many function-mode sends in one batch can exceed it. Paid raises queue-consumer CPU to 15 minutes.
- **Bigger batches / longer retention.** On Paid you can raise `max_batch_size` to 25 (fewer, larger invocations) and get 4–14 day queue retention instead of Free's 24 h.

Start on Free; switch the plan in the Cloudflare dashboard whenever you actually hit one of the above — no redeploy required for the plan change itself. Full numbers and math: [`docs/CAPACITY.md`](docs/CAPACITY.md).

---

## Setup & deploy

### Step 1 — Get the code

```sh
git clone <this-repo-url> notification-service
cd notification-service
```

### Step 2 — Install dependencies

```sh
pnpm install
```

### Step 3 — Sign in to Cloudflare

This opens your browser to authorize Wrangler against your Cloudflare account (one time). Wrangler lives in `apps/api`, so run it from there:

```sh
(cd apps/api && npx wrangler login)
```

Verify it worked:

```sh
(cd apps/api && npx wrangler whoami)
```

You should see your account email and ID.

### Step 4 — Provision & deploy

One command creates everything and deploys:

```sh
pnpm run setup
```

This is **idempotent** — safe to re-run any time. It will:

1. Create the **D1 database** (`notification-service`) and patch its ID into `apps/api/wrangler.jsonc`.
2. Create the **Queues** (`notification-service-sends` + `notification-service-sends-dlq`).
3. Apply **database migrations**.
4. Generate a random **`API_KEY`**, store it as a Worker secret, and save a copy to **`.api-key.local`** (gitignored).
   - Want to choose your own key? Set `NOTIFICATION_SERVICE_API_KEY=<your-key>` before running setup.
5. **Deploy** the Worker.
6. Print your Worker URL and a **ready-to-paste command to add the MCP server to Claude, with your token filled in.**

The tail of a successful run looks like:

```
==================================================================
 Notification Service is deployed.
==================================================================

   Worker:  https://notification-service.<you>.workers.dev
   Health:  curl https://notification-service.<you>.workers.dev/health
   MCP:     https://notification-service.<you>.workers.dev/mcp

-- Add the MCP server to Claude Code -----------------------------

   claude mcp add --transport http notification-service \
     https://notification-service.<you>.workers.dev/mcp \
     --header "Authorization: Bearer <your-api-key>"
   ...
```

### Step 5 — Verify

```sh
curl https://notification-service.<you>.workers.dev/health
# {"ok":true}
```

Your API key is in `.api-key.local` — retrieve it any time with `cat .api-key.local`. Cloudflare will not show a stored secret again, so keep this file (or your chosen key) safe.

---

## Connect the MCP server to Claude

Notification Service ships a **remote MCP server at `/mcp`** so you can manage everything in natural language. It's authenticated with the same `API_KEY` as a bearer token.

### What the MCP server can do (19 tools)

| Area | Tools |
|---|---|
| **Reference** | `describe_notification_service` (how the pieces fit together) |
| **Notifications** | `list_notifications`, `get_notification`, `create_notification`, `update_notification`, `set_notification_status`, `delete_notification` |
| **Authoring/testing** | `dry_run_function` (run a custom function against sample data, no send), `send_test_event`, `identify_user` |
| **Analytics** | `get_send_analytics` (totals by status/channel/error over a window), `list_failed_sends`, `get_notification_analytics` |
| **Users** | `list_users`, `get_user` |
| **Channels** | `list_channels`, `configure_channel`, `delete_channel`, `generate_webpush_keys` |

### Add it to Claude Code

Use the command that `pnpm run setup` printed. It looks like:

```sh
claude mcp add --transport http notification-service \
  https://notification-service.<you>.workers.dev/mcp \
  --header "Authorization: Bearer $(cat .api-key.local)"
```

Add `--scope user` to make it available in every project, not just this one.

Verify it's connected:

```sh
claude mcp list
# notification-service ... ✓ connected
```

Then just ask, e.g. *"Using notification-service, list my notifications and show send analytics for the last 24 hours."*

### Add it to other MCP clients

Clients that only speak stdio (some Claude Desktop setups, etc.) can use the [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) proxy — also printed by setup:

```sh
npx mcp-remote https://notification-service.<you>.workers.dev/mcp \
  --header "Authorization: Bearer <your-api-key>"
```

---

## Configure a push channel

Before anything can be delivered, configure at least one provider. Do it **from the MCP server** (ask Claude, which calls `configure_channel`) or via the REST API below. Each provider's credentials:

### FCM (Android / Firebase)

1. In the [Firebase Console](https://console.firebase.google.com/), open your project → **Project settings** → **Service accounts**.
2. Click **Generate new private key** → download the JSON.
3. Provide that JSON as `serviceAccount`:

```sh
curl -X PUT https://notification-service.<you>.workers.dev/v1/channels/fcm \
  -H "authorization: Bearer $(cat .api-key.local)" -H "content-type: application/json" \
  -d '{ "credentials": { "channel": "fcm", "serviceAccount": { ...contents of the JSON... } } }'
```

### APNs (iOS / Apple)

1. In the [Apple Developer account](https://developer.apple.com/account) → **Certificates, Identifiers & Profiles** → **Keys**, create a key with **APNs** enabled and download the `.p8` file.
2. You need: the `.p8` contents (`keyP8`), the **Key ID** (`keyId`), your **Team ID** (`teamId`), your app's **bundle ID** (`bundleId`), and whether to use Apple's production gateway (`production`).

```sh
curl -X PUT https://notification-service.<you>.workers.dev/v1/channels/apns \
  -H "authorization: Bearer $(cat .api-key.local)" -H "content-type: application/json" \
  -d '{ "credentials": { "channel": "apns",
        "keyP8": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----",
        "keyId": "ABC123DEFG", "teamId": "TEAM123456",
        "bundleId": "com.example.app", "production": true } }'
```

> APNs requires HTTP/2 and therefore **cannot be tested under `wrangler dev`** — exercise it against the deployed Worker.

### Web Push (browsers)

1. Mint a VAPID keypair (MCP tool `generate_webpush_keys`, or `POST /v1/channels/webpush/keys`).
2. Store it, with a `subject` (a `mailto:` or URL). Hand the **public key** to your web app as its `applicationServerKey`.

```sh
# 1) mint
curl -X POST https://notification-service.<you>.workers.dev/v1/channels/webpush/keys \
  -H "authorization: Bearer $(cat .api-key.local)"
# -> { "public_key": "...", "private_key": "..." }

# 2) store
curl -X PUT https://notification-service.<you>.workers.dev/v1/channels/webpush \
  -H "authorization: Bearer $(cat .api-key.local)" -H "content-type: application/json" \
  -d '{ "credentials": { "channel": "webpush",
        "publicKey": "<public>", "privateKey": "<private>",
        "subject": "mailto:you@example.com" } }'
```

Check what's configured (secrets are never returned):

```sh
curl https://notification-service.<you>.workers.dev/v1/channels -H "authorization: Bearer $(cat .api-key.local)"
```

---

## Send your first notification

An end-to-end walkthrough. Two ways to do each step:

### Option A — with the MCP server (natural language)

Once the MCP server is connected, ask Claude things like:

- *"Identify user `user-42` with properties firstName=Ada, plan=pro, and register their FCM device token `<token>`."*
- *"Create a notification named 'Order shipped' triggered by `order_shipped` when `total > 50`, title 'On its way, {{user.firstName}}!', body 'Order {{event.order_id}} has shipped', on fcm."*
- *"Send a test `order_shipped` event for `user-42` with order_id=A1, total=99."*
- *"Show me the send analytics and any failed sends."*

### Option B — with the REST API (curl)

```sh
BASE=https://notification-service.<you>.workers.dev
AUTH="authorization: Bearer $(cat .api-key.local)"

# 1) register a user + device
curl -X POST $BASE/v1/identify -H "$AUTH" -H "content-type: application/json" -d '{
  "distinct_id": "user-42",
  "properties": { "firstName": "Ada", "plan": "pro" },
  "device": { "channel": "fcm", "token": "<fcm-registration-token>" }
}'

# 2) define a notification
curl -X POST $BASE/v1/notifications -H "$AUTH" -H "content-type: application/json" -d '{
  "name": "Order shipped",
  "trigger_events": ["order_shipped"],
  "conditions": [{ "property": "total", "operator": ">", "value": 50 }],
  "payload": {
    "title": "On its way, {{user.firstName}}!",
    "body": "Order {{event.order_id}} has shipped.",
    "url": "myapp://orders/{{event.order_id}}"
  },
  "channels": ["fcm"]
}'

# 3) fire an event
curl -X POST $BASE/v1/ingest -H "$AUTH" -H "content-type: application/json" -d '{
  "distinct_id": "user-42", "event": "order_shipped",
  "properties": { "order_id": "A1", "total": 99 }
}'
# -> { "ok": true, "matched": 1, "enqueued": 1 }
```

Delivery is asynchronous (queue → consumer → provider). Check the result with `GET /v1/notifications/:id/sends`, or ask Claude for `get_send_analytics`.

---

## REST API reference

All `/v1/*` and `/mcp` require `Authorization: Bearer <API_KEY>`. `GET /health` is open.

| Method & path | What |
|---|---|
| `POST /v1/identify` | Upsert a user (properties **merge**) + optionally register a device |
| `POST /v1/ingest` | Ingest an event → match → enqueue |
| `GET /v1/notifications` | List notifications with stats |
| `POST /v1/notifications` | Create a notification |
| `GET/PATCH/DELETE /v1/notifications/:id` | Read / update / delete one |
| `GET /v1/notifications/:id/sends` | Recent delivery attempts |
| `GET /v1/channels` | List configured channels (no secrets) |
| `PUT/DELETE /v1/channels/:channel` | Set / remove provider credentials |
| `POST /v1/channels/webpush/keys` | Mint a VAPID keypair |
| `POST /mcp` | Remote MCP server (Streamable HTTP) |

**Conditions** are ANDed; operators: `=` `!=` `>` `<` `>=` `<=` `contains` `exists` `in`. **Template** placeholders `{{event.x}}` / `{{user.y}}` interpolate at send time. For Web Push devices, pass the browser's `subscription` (`{endpoint, keys}`) instead of `token`.

---

## Custom functions

Beyond the builder (conditions + template), a notification can be **`authoring_mode: "function"`** — a JS function that is both filter and payload builder, run in a sandboxed QuickJS/WASM interpreter in the queue consumer:

```js
async (event, user, ctx) => {
  if (user.plan !== "pro") return { skip: true, reason: "free plan" };
  const res = await ctx.fetch("https://api.example.com/x"); // outbound HTTP allowed
  const data = await res.json();
  return { title: `Hi ${user.firstName}`, body: data.message };
}
```

- `event` = the event's flattened properties + `event.__name` (the trigger name); `user` = the identified user's properties.
- `ctx.fetch(url, init)` performs outbound HTTP (10 s wall-clock, 64 MB memory cap).
- Return a payload `{title, body, image?, url?, data?}`, or `{ skip: true, reason? }` to deliberately not send.

**Author it safely** with the MCP tool `dry_run_function` — it runs your source against sample data and returns the resolved payload / skip / error **without sending or saving**. Iterate until it's right, then `create_notification` with `authoring_mode: "function"`.

---

## Local development

```sh
pnpm --filter @notification-service/api db:migrate:local   # apply migrations to a local D1
pnpm dev                                       # wrangler dev (local Worker + queue + D1)
pnpm test                                      # unit tests (@notification-service/core, @notification-service/sandbox)
pnpm check-types
pnpm build                                     # dry-run bundle of the Worker
```

Create `apps/api/.dev.vars` with `API_KEY=dev-key` for local runs. The MCP server is available locally at `http://127.0.0.1:8787/mcp`.

> APNs cannot be exercised under `wrangler dev` (local runtime is HTTP/1.1; Apple requires HTTP/2). Test APNs against a deployed Worker.

---

## Updating & tearing down

**Redeploy after code changes:**

```sh
pnpm run deploy       # or: pnpm run setup (idempotent — also prints the MCP command)
```

**Remove everything from Cloudflare** — Worker (+ its `API_KEY` secret), both queues, and the D1 database (⚠️ this permanently deletes all users, devices, notifications, and send history):

```sh
pnpm run teardown              # asks you to type the worker name to confirm
pnpm run teardown -- --yes     # non-interactive (or set NOTIFICATION_SERVICE_DESTROY_YES=1)
```

Teardown deletes resources in dependency order and tolerates already-missing ones, so a partial teardown can be finished by re-running.

---

## Repo layout

- `apps/api` — the one deployable Worker: Hono HTTP handler + queue consumer + the `/mcp` server. Vendors `src/quickjs.wasm` at build time.
  - `src/lib` — shared domain helpers (`identifyUser`, `ingestEvent`) used by both the REST routes and the MCP tools.
  - `src/mcp` — the remote MCP server (`buildMcpServer`) and its tools.
- `packages/core` — domain logic: condition matching, `{{…}}` interpolation, the versioned queue-message contract, zod payload/function contracts, and the three channel senders.
- `packages/sandbox` — the QuickJS/WASM runner for custom functions.
- `packages/db` — Drizzle schema, generated D1 migrations, shared types.
- `scripts/setup.sh` / `scripts/teardown.sh` — provision + deploy / destroy.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Not logged in to Cloudflare` | `cd apps/api && npx wrangler login` |
| pnpm errors about esbuild / platform binary | Use pnpm **10.14.0** (`corepack enable`, or `npm i -g pnpm@10.14.0`) |
| Queues creation fails during setup | Enable Queues once in the [dashboard](https://dash.cloudflare.com/?to=/:account/workers/queues), then re-run `pnpm run setup` |
| MCP client can't connect | Confirm the URL ends in `/mcp` and the `Authorization: Bearer <key>` header is set; test `curl $BASE/health` |
| Lost the API key | It's in `.api-key.local`. If that's gone, rotate: `cd apps/api && npx wrangler secret delete API_KEY`, then `pnpm run setup` |
| Notification "sent" but nothing arrives | Check `list_failed_sends` / `GET /v1/notifications/:id/sends` — likely an unconfigured channel or a bad/expired token (dead tokens are pruned automatically) |
| Testing APNs locally | Not possible under `wrangler dev` (HTTP/2). Deploy and test the live Worker |

---

## Design notes

- **One queue message per (user × matched notification)**; device fan-out happens in the consumer because device lists go stale while messages sit in the queue.
- **At-least-once, never double-counted**: the consumer writes nothing before deciding sent/retry. A transient provider error retries the whole message; rollup counters are only bumped on commit.
- **Dead tokens are pruned** on FCM `UNREGISTERED`, APNs 410, Web Push 404/410.
- The queue-message contract is **versioned** (`v: 1`) so a deploy can meet in-flight messages from the previous version.
- **Single-tenant by design** — no `project_id` anywhere. Run multiple projects by deploying multiple instances.

---

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for how
to set up the project, run the tests, and open a pull request.

---

## License

Released under the [MIT License](LICENSE).
