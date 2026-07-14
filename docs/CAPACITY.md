# Notification Service — Queuing & Capacity

> Reference notes for the eventual README. Cloudflare limits below were pulled
> from the official docs on **2026-07-13**; re-verify before publishing, as
> Cloudflare revises these periodically. Sources are linked per number.

## How the queue works

The pipeline is **batched**, not one-worker-per-event, and batches run in
parallel across many auto-scaled invocations. Two distinct stages:

**Producer — ingest** (`apps/api/src/routes/public.ts`).
`POST /v1/ingest` matches active notifications and enqueues **one message per
(user × matched notification)** via `SEND_QUEUE.sendBatch(...)`, chunked at 100
messages/call (the `sendBatch` cap). It does not spawn a worker per event — it
writes messages and returns. Device fan-out is deferred to the consumer on
purpose (device lists go stale while a message sits in the queue).

**Consumer — batch processor** (`apps/api/src/queue/consumer.ts`,
`apps/api/wrangler.jsonc`). Cloudflare delivers messages in **batches** and
invokes the consumer Worker **once per batch**:

```jsonc
"max_batch_size": 6,       // Free-plan safe (≤50 subrequests/invocation); raise to 25 on Paid
"max_batch_timeout": 10,   // …or whatever accumulated within 10s, whichever comes first
"max_retries": 3,
"dead_letter_queue": "notification-service-sends-dlq"
```

Inside one invocation, `handleQueue` processes the batch's messages (up to
`max_batch_size`, **6** by default) **concurrently**
(`Promise.all`), each `ack()`/`retry()`'d independently so one poison message
can't sink the batch. Per message: load notification + user → resolve payload
(interpolate template, or run the custom function in the QuickJS/WASM sandbox) →
fan out to that user's devices → record `sends`. Cloudflare autoscales up to
**250 concurrent consumer invocations**, so many batches run at once.

Only *transient provider* errors (FCM/APNs 5xx) trigger `message.retry()`, which
re-pushes the whole message (and re-runs the function). Sandbox/validation
failures are terminal: they record a `failed`/`skipped` row and `ack()`.

## Verified Cloudflare limits (2026-07-13)

| | Workers **Free** | Workers **Paid** ($5/mo) |
|---|---|---|
| Worker requests | **100,000 / day** | 10 M/mo included, then $0.30/M |
| CPU per invocation | **10 ms** | 30 s default → up to **15 min for queue consumers** |
| Subrequests / D1 queries per invocation | **50** | 1,000 (D1) / 10,000 (subrequests) |
| Queues throughput | 5,000 msg/s per queue, 250 concurrent consumers | same |
| Queues batch | max 100/consumer batch, 100 (or 256 KB) per `sendBatch`, 128 KB/msg | same |
| Queues retention | **24 h** (fixed) | 4 days default, up to 14 days |
| D1 rows written | **100,000 / day** | 50 M/mo included, then $1.00/M |
| D1 rows read | 5 M / day | 25 B/mo included |
| D1 storage | 5 GB | 5 GB included, then $0.75/GB-mo |

Sources: [Queues limits](https://developers.cloudflare.com/queues/platform/limits) ·
[Queues pricing](https://developers.cloudflare.com/queues/platform/pricing) ·
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing) ·
[Workers limits](https://developers.cloudflare.com/workers/platform/limits) ·
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing)

> Doc inconsistency to flag in the README: the Queues limits/pricing pages say a
> "limited version" of Queues runs on the Free plan (24 h retention, per-day
> operation cap), but one Queues tutorial says Queues "require a Workers Paid
> plan." Queues works on the current deployment, so the account has it enabled.

## How many events/day on the Free plan

At 5,000 msg/s you'd exhaust the daily budget in ~20 seconds, so Free is a
**daily-volume** story, not a rate story. Two ceilings bind first:

1. **D1 rows written: 100,000/day — the tightest.** A simple event writes ~3
   rows: ingest bumps a counter (1) + the consumer inserts a `sends` row and
   bumps a counter (2). → `100k ÷ 3 ≈ 33k events/day`. More devices or matched
   notifications per event write more `sends` rows and lower this.
2. **Worker requests: 100,000/day.** Both ingest calls and consumer invocations
   count. With batching that's ~1.1 requests/event → ~90k/day in the ideal case.

**Realistic range: ~20,000–40,000 events/day on Free** (D1-write-bound),
dropping as fan-out grows. Absolute ceiling ~90k/day only for the minimal
1-notification / 1-device case.

### Two Free-plan constraints specific to Notification Service

- **The 50-subrequests/invocation cap bounds batch size.** Each message does
  ~5–7 D1 queries + provider fetches, so the config ships with
  **`max_batch_size: 6`** (~36–42 subrequests/batch) to stay under the Free cap.
  A 25-message batch would need ~150 subrequests — 3× over — so raise it to 25
  **only on Paid**.
- **Custom functions strain the 10 ms CPU cap.** On Free a whole batch shares
  10 ms of *CPU* (I/O waits like `ctx.fetch`/D1 don't count), but spinning up the
  QuickJS interpreter costs several ms — a couple of function-mode messages in
  one batch can blow it. Paid raises queue-consumer CPU to 15 min.

## Recommendation

**Default to Free.** It's fine for hobby/dev and small production
(**~20–40k events/day**), and the shipped config (`max_batch_size: 6`) already
stays within Free's limits — nothing to tune. Upgrade to the **Workers Paid plan
($5/mo)** only once you actually outgrow Free: heavy custom-function use, or more
than ~20–40k events/day. Paid then lets you raise `max_batch_size` back to 25 and
adds 15-min consumer CPU, 1,000+ subrequests, longer queue retention, and
D1/request limits ~500× higher.
