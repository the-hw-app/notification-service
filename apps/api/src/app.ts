import { createMcpHandler } from "agents/mcp";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import type { HonoEnv } from "./env.js";
import { buildMcpServer } from "./mcp/server.js";
import { apiKeyAuth } from "./middleware/auth.js";
import { channelRoutes } from "./routes/channels.js";
import { notificationRoutes } from "./routes/notifications.js";
import { publicRoutes } from "./routes/public.js";

export const app = new Hono<HonoEnv>();

app.get("/health", (c) => c.json({ ok: true }));

// Everything under /v1 requires the instance API key.
app.use("/v1/*", apiKeyAuth);
app.route("/v1", publicRoutes);
app.route("/v1/notifications", notificationRoutes);
app.route("/v1/channels", channelRoutes);

// Remote MCP server (stateless Streamable HTTP, no Durable Object), behind the
// same instance API key as a bearer token. A fresh server is built per request
// because Workers bindings are per-invocation.
app.use("/mcp", apiKeyAuth);
app.all("/mcp", (c) => {
  const handler = createMcpHandler(buildMcpServer(c.env), { route: "/mcp" });
  // Hono's ExecutionContext type differs from the workers-types one the handler
  // expects; the runtime value is the same object.
  return handler(c.req.raw, c.env, c.executionCtx as unknown as ExecutionContext);
});

app.notFound((c) => c.json({ error: "not found" }, 404));

app.onError((error, c) => {
  if (error instanceof HTTPException) {
    return c.json({ error: error.message }, error.status);
  }
  console.error("unhandled error", error);
  return c.json({ error: "internal error" }, 500);
});
