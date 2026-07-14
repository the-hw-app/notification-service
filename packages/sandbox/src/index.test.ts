import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { runCustomFunction, SandboxError } from "./index.js";

/**
 * These run against the real QuickJS asyncify WASM, loaded the same way the
 * Worker loads it (a pre-instantiated `WebAssembly.Module` injected from
 * outside the package). Node can compile it from bytes; Workers gets it from
 * wrangler's `.wasm` import. Same module, same code path.
 */
let wasmModule: WebAssembly.Module;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve("@jitl/quickjs-wasmfile-release-asyncify/wasm");
  wasmModule = new WebAssembly.Module(await readFile(wasmPath));
}, 60_000);

const run = (source: string, event: unknown = {}, user: unknown = {}, options = {}) =>
  runCustomFunction(wasmModule, source, { event, user }, options);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runCustomFunction", () => {
  it("returns a payload from an async function", async () => {
    const result = await run(
      `async (event, user) => ({ title: user.name, body: event.product })`,
      { product: "Widget" },
      { name: "Ada" },
    );
    expect(result).toEqual({ title: "Ada", body: "Widget" });
  });

  it("supports a sync function too", async () => {
    expect(await run(`(event) => ({ title: "t", body: event.x })`, { x: "y" })).toEqual({
      title: "t",
      body: "y",
    });
  });

  it("returns a skip result verbatim", async () => {
    expect(await run(`async () => ({ skip: true, reason: "unsubscribed" })`)).toEqual({
      skip: true,
      reason: "unsubscribed",
    });
  });

  it("marshals undefined to null rather than losing the value", async () => {
    expect(await run(`async () => {}`)).toBeNull();
  });

  it("propagates a guest throw as a THROWN SandboxError", async () => {
    await expect(run(`async () => { throw new Error("boom") }`)).rejects.toMatchObject({
      code: "THROWN",
      message: expect.stringContaining("boom"),
    });
  });

  it("rejects source that is not a function", async () => {
    await expect(run(`42`)).rejects.toBeInstanceOf(SandboxError);
  });

  it("cannot reach host globals", async () => {
    // No fetch, no process, no crypto leaking in from the host isolate.
    expect(await run(`async () => typeof globalThis.fetch`)).toBe("undefined");
    expect(await run(`async () => typeof globalThis.process`)).toBe("undefined");
  });

  it("interrupts an infinite loop at the deadline", async () => {
    const started = Date.now();
    await expect(run(`async () => { while (true) {} }`, {}, {}, { timeoutMs: 300 })).rejects
      .toMatchObject({ code: "TIMEOUT" });
    // Bounded, and not by a huge margin.
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 20_000);

  it("awaits a host fetch and exposes status/json to the guest", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ plan: "pro" }), { status: 200 })),
    );

    const result = await run(`async (event, user, ctx) => {
      const res = ctx.fetch("https://api.example.com/u/1");
      const data = res.json();
      return { title: "hi", body: data.plan + ":" + res.status };
    }`);

    expect(result).toEqual({ title: "hi", body: "pro:200" });
  }, 20_000);

  it("blocks a fetch the allowlist rejects, surfacing it as a guest exception", async () => {
    const hostFetch = vi.fn();
    vi.stubGlobal("fetch", hostFetch);

    await expect(
      run(
        `async (event, user, ctx) => ctx.fetch("https://evil.example.com")`,
        {},
        {},
        { fetchAllowlist: (url: string) => url.startsWith("https://api.example.com") },
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining("fetch blocked") });

    expect(hostFetch).not.toHaveBeenCalled();
  }, 20_000);

  it("lets the guest catch a failed fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    expect(
      await run(`async (event, user, ctx) => {
        try { ctx.fetch("https://api.example.com"); return "unreachable" }
        catch (e) { return { caught: e.message } }
      }`),
    ).toEqual({ caught: "network down" });
  }, 20_000);

  it("isolates globals between runs", async () => {
    await run(`async () => { globalThis.leaked = "yes"; return 1 }`);
    expect(await run(`async () => typeof globalThis.leaked`)).toBe("undefined");
  });

  it("enforces the memory limit", async () => {
    await expect(
      run(
        `async () => { const a = []; while (true) a.push(new Array(10000).fill("x")); }`,
        {},
        {},
        { memoryBytes: 2 * 1024 * 1024, timeoutMs: 5_000 },
      ),
    ).rejects.toBeInstanceOf(SandboxError);
  }, 20_000);
});
