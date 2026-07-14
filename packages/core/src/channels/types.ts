/**
 * The single result shape every channel sender returns.
 *
 * The consumer needs exactly three decisions out of a provider response, and
 * conflating them is how push pipelines rot:
 *
 * - `ok`         → write a `sent` row.
 * - `deadToken`  → the destination is permanently gone; prune the device.
 *                  Never retry, never resurrect.
 * - `retryable`  → transient (5xx, 429, network). `msg.retry()` and let Queues
 *                  redeliver; after `max_retries` it lands in the DLQ.
 *
 * A response that is neither ok, dead, nor retryable is a permanent rejection
 * (bad payload, bad credentials) — record `failed` and move on, because
 * retrying it would burn the queue budget forever.
 */
export interface SendResult {
  ok: boolean;
  /** Provider HTTP status, or 0 for a network-level failure. */
  status: number;
  errorCode?: string;
  errorMessage?: string;
  deadToken: boolean;
  retryable: boolean;
}

export function sent(status = 200): SendResult {
  return { ok: true, status, deadToken: false, retryable: false };
}

export function dead(status: number, errorCode: string, errorMessage?: string): SendResult {
  return { ok: false, status, errorCode, errorMessage, deadToken: true, retryable: false };
}

export function transient(status: number, errorCode: string, errorMessage?: string): SendResult {
  return { ok: false, status, errorCode, errorMessage, deadToken: false, retryable: true };
}

export function permanent(status: number, errorCode: string, errorMessage?: string): SendResult {
  return { ok: false, status, errorCode, errorMessage, deadToken: false, retryable: false };
}

/** 429 and 5xx are worth another attempt; everything else is the caller's fault. */
export function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}
