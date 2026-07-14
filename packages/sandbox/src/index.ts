import baseVariant from "@jitl/quickjs-wasmfile-release-asyncify";
import {
  newQuickJSAsyncWASMModuleFromVariant,
  newVariant,
  type QuickJSAsyncContext,
  type QuickJSAsyncWASMModule,
  type QuickJSHandle,
} from "quickjs-emscripten-core";

/**
 * QuickJS-in-WASM sandbox for notification custom functions.
 *
 * Workers ban `eval` and `new Function`, so user-authored code runs in a real
 * interpreter compiled to WASM. We use the **asyncify** variant (2× the size,
 * ~40% the speed of the sync build) purely so guest code can `await` a host
 * `fetch` — without it the escape hatch could not call an external API, which
 * is most of the point.
 *
 * The `.wasm` is injected rather than imported here: Cloudflare only bundles
 * `.wasm` imported by a **relative path from your own source tree**, never from
 * `node_modules` (workers-sdk#1672). `apps/api` keeps the copied file and hands
 * us the pre-instantiated module.
 */

export interface SandboxOptions {
  /** Wall-clock ceiling enforced by an interrupt handler. */
  timeoutMs?: number;
  memoryBytes?: number;
  maxStackBytes?: number;
  /** Return false to block a URL before the host `fetch` is issued. */
  fetchAllowlist?: (url: string) => boolean;
}

export interface SandboxContext {
  event: unknown;
  user: unknown;
}

export class SandboxError extends Error {
  constructor(
    message: string,
    readonly code:
      | "TIMEOUT"
      | "MEMORY"
      | "THROWN"
      | "INVALID_RETURN"
      | "FETCH_BLOCKED"
      | "COMPILE",
  ) {
    super(message);
    this.name = "SandboxError";
  }
}

const DEFAULTS = {
  timeoutMs: 10_000,
  memoryBytes: 64 * 1024 * 1024,
  maxStackBytes: 1024 * 1024,
} as const;

/**
 * Instantiating the WASM module is the expensive part, so it is cached per
 * isolate. Runtimes and contexts, which hold the *guest's* state, are created
 * and disposed per invocation — one notification's function must never observe
 * another's globals.
 */
let modulePromise: Promise<QuickJSAsyncWASMModule> | undefined;

export function loadQuickJs(wasmModule: WebAssembly.Module): Promise<QuickJSAsyncWASMModule> {
  modulePromise ??= newQuickJSAsyncWASMModuleFromVariant(newVariant(baseVariant, { wasmModule })).then(
    (module) => {
      patchRuntimeDisposeOrdering(module);
      return module;
    },
  );
  return modulePromise;
}

/**
 * Work around an ordering bug in `quickjs-emscripten-core@0.32.0`.
 *
 * `QuickJSAsyncWASMModule.newRuntime` disposes with
 * `callbacks.deleteRuntime(rt); ffi.QTS_FreeRuntime(rt)`. The sync module does
 * the same two calls in the opposite order — and the opposite order is the
 * correct one, because `QTS_FreeRuntime` synchronously frees the runtime's
 * host refs, which calls back into `freeHostRef`, which looks the runtime up in
 * the very map `deleteRuntime` just emptied. Result: disposing any asyncify
 * runtime that ever registered a host function (i.e. every one of ours, since
 * `ctx.fetch` is a host function) throws
 * `QuickJSRuntime(rt = …) not found when trying to free HostRef(…)` and leaves
 * the teardown half-finished.
 *
 * We defer the map deletion until `QTS_FreeRuntime` has returned, restoring the
 * sync module's semantics. `deleteRuntime` is a bare `Map.delete`, and
 * `dispose()` is synchronous, so nothing can interleave between capture and
 * replay.
 */
interface PatchableCallbacks {
  deleteRuntime(rt: number): void;
  __notificationServiceDeferred?: number[];
  __notificationServiceOriginalDelete?: (rt: number) => void;
}

function moduleCallbacks(module: QuickJSAsyncWASMModule): PatchableCallbacks {
  return (module as unknown as { callbacks: PatchableCallbacks }).callbacks;
}

function patchRuntimeDisposeOrdering(module: QuickJSAsyncWASMModule): void {
  const callbacks = moduleCallbacks(module);
  if (callbacks.__notificationServiceOriginalDelete) return;

  const original = callbacks.deleteRuntime.bind(callbacks);
  const deferred: number[] = [];
  callbacks.__notificationServiceOriginalDelete = original;
  callbacks.__notificationServiceDeferred = deferred;
  callbacks.deleteRuntime = (rt: number) => {
    deferred.push(rt);
  };
}

/** `runtime.dispose()`, with the deferred map deletions replayed afterwards. */
function disposeRuntime(module: QuickJSAsyncWASMModule, runtime: { dispose(): void }): void {
  const callbacks = moduleCallbacks(module);
  const deferred = callbacks.__notificationServiceDeferred;
  const original = callbacks.__notificationServiceOriginalDelete;
  if (!deferred || !original) {
    runtime.dispose();
    return;
  }

  const mark = deferred.length;
  try {
    runtime.dispose();
  } finally {
    for (const rt of deferred.splice(mark)) original(rt);
  }
}

/**
 * The guest-side shim. `__host_fetch` is asyncified: it looks synchronous
 * inside the VM but suspends the whole WASM module until the host promise
 * settles.
 *
 * Note the asyncify constraint — the module can only suspend for **one**
 * async call at a time, so `Promise.all([ctx.fetch(a), ctx.fetch(b)])` would
 * crash it. The shim is written to make that shape awkward rather than to
 * pretend it works.
 */
const GUEST_PRELUDE = `
  const ctx = {
    fetch(url, init) {
      const raw = __host_fetch(String(url), init ? JSON.stringify(init) : undefined);
      const res = JSON.parse(raw);
      if (res.__error) throw new Error(res.__error);
      return {
        status: res.status,
        ok: res.status >= 200 && res.status < 300,
        text: () => res.body,
        json: () => JSON.parse(res.body),
      };
    },
  };
`;

function dumpError(context: QuickJSAsyncContext, handle: QuickJSHandle): string {
  try {
    const value = context.dump(handle) as unknown;
    if (value && typeof value === "object") {
      const record = value as { name?: string; message?: string; stack?: string };
      if (record.message) return `${record.name ?? "Error"}: ${record.message}`;
    }
    return String(value);
  } catch {
    return "unknown guest error";
  }
}

/**
 * Run `async (event, user, ctx) => …` and return whatever it resolved to,
 * marshalled through JSON.
 *
 * The result is intentionally `unknown`: validating it against the payload
 * schema is the caller's job (`functionResultSchema` in `@notification-service/core`), so the
 * sandbox stays agnostic about what it is being used for.
 */
export async function runCustomFunction(
  wasmModule: WebAssembly.Module,
  source: string,
  { event, user }: SandboxContext,
  options: SandboxOptions = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const quickjs = await loadQuickJs(wasmModule);

  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(options.memoryBytes ?? DEFAULTS.memoryBytes);
  runtime.setMaxStackSize(options.maxStackBytes ?? DEFAULTS.maxStackBytes);

  // Bounds infinite loops. It does NOT bound a hung host fetch — that is what
  // the AbortController below is for.
  const deadline = Date.now() + timeoutMs;
  let timedOut = false;
  runtime.setInterruptHandler(() => {
    if (Date.now() > deadline) {
      timedOut = true;
      return true;
    }
    return false;
  });

  const context = runtime.newContext();
  try {
    const hostFetch = context.newAsyncifiedFunction(
      "__host_fetch",
      async (urlHandle, initHandle) => {
        const url = context.getString(urlHandle);
        if (options.fetchAllowlist && !options.fetchAllowlist(url)) {
          return context.newString(JSON.stringify({ __error: `fetch blocked: ${url}` }));
        }

        const init: RequestInit =
          initHandle && context.typeof(initHandle) === "string"
            ? (JSON.parse(context.getString(initHandle)) as RequestInit)
            : {};

        // The interrupt handler cannot fire while the module is suspended, so a
        // slow endpoint would otherwise hang past `timeoutMs`.
        const remaining = Math.max(0, deadline - Date.now());
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), remaining);
        try {
          const response = await fetch(url, { ...init, signal: abort.signal });
          const body = await response.text();
          return context.newString(JSON.stringify({ status: response.status, body }));
        } catch (error) {
          return context.newString(JSON.stringify({ __error: (error as Error).message }));
        } finally {
          clearTimeout(timer);
        }
      },
    );
    hostFetch.consume((handle) => context.setProp(context.global, "__host_fetch", handle));

    for (const [name, value] of [
      ["__event", event],
      ["__user", user],
    ] as const) {
      const handle = context.newString(JSON.stringify(value ?? null));
      handle.consume((h) => context.setProp(context.global, name, h));
    }

    const code = `
      ${GUEST_PRELUDE}
      (async () => {
        const event = JSON.parse(__event);
        const user = JSON.parse(__user);
        const fn = (${source});
        if (typeof fn !== "function") throw new Error("custom function source is not a function");
        const out = await fn(event, user, ctx);
        return JSON.stringify(out === undefined ? null : out);
      })()
    `;

    const evalResult = await context.evalCodeAsync(code);
    if (evalResult.error) {
      const message = dumpError(context, evalResult.error);
      evalResult.error.dispose();
      throw new SandboxError(message, timedOut ? "TIMEOUT" : "THROWN");
    }

    // `evalCodeAsync` returns the *pending* VM promise; settle it while pumping
    // the VM's job queue so microtasks (and asyncify resumptions) actually run.
    const promiseHandle = evalResult.value;
    const settled = context.resolvePromise(promiseHandle);
    promiseHandle.dispose();
    runtime.executePendingJobs();

    const outcome = await settled;
    if (outcome.error) {
      const message = dumpError(context, outcome.error);
      outcome.error.dispose();
      throw new SandboxError(message, timedOut ? "TIMEOUT" : "THROWN");
    }

    const json = context.getString(outcome.value);
    outcome.value.dispose();
    return JSON.parse(json) as unknown;
  } catch (error) {
    if (error instanceof SandboxError) throw error;
    if (timedOut) throw new SandboxError(`custom function exceeded ${timeoutMs}ms`, "TIMEOUT");
    const message = (error as Error).message ?? String(error);
    // QuickJS surfaces an OOM as a plain thrown error from the allocator.
    throw new SandboxError(message, /out of memory/i.test(message) ? "MEMORY" : "THROWN");
  } finally {
    context.dispose();
    disposeRuntime(quickjs, runtime);
  }
}
