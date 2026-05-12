// MCP server entry point. Bira transport (stdio | http) iz env varijable.
//
//   stdio  → za Claude Desktop dev (proces se spawn-a kroz claude_desktop_config.json)
//   http   → za production deploy (Coolify), Express + SSE transport + Bearer auth

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express, { type Request, type Response, type NextFunction } from "express";

import { loadConfig } from "./config.js";
import { createCh } from "./db.js";
import { EmbedderClient } from "./embedder.js";
import { createServer } from "./server.js";


async function main() {
  const config = loadConfig();
  const ch = createCh(config.clickhouseUrl);
  const embedder = new EmbedderClient(config.embedderUrl);

  const server = createServer({ config, ch, embedder });

  if (config.transport === "stdio") {
    // Stdio: log na stderr (stdout je rezerviran za JSON-RPC frames).
    console.error(`[mcp] ${config.serviceName} v${config.serviceVersion} → stdio`);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }

  // ─── HTTP + SSE transport ─────────────────────────────────────
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Health check — Docker HEALTHCHECK gađa ovo. NE traži auth.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: config.serviceName, version: config.serviceVersion });
  });

  // API key middleware za sve ostale rute.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (config.authMode === "none") return next();
    const auth = req.header("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token || token !== config.apiKey) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  });

  // SSE transport drži per-connection state. Mapa session_id → transport.
  // SSE je legacy MCP transport ali stabilan i podržan u Claude Desktop remote MCP-u.
  // Streamable HTTP upgrade je Faza 2.
  const transports = new Map<string, SSEServerTransport>();

  app.get("/sse", async (_req, res) => {
    const transport = new SSEServerTransport("/messages", res);
    transports.set(transport.sessionId, transport);
    res.on("close", () => {
      transports.delete(transport.sessionId);
    });
    await server.connect(transport);
  });

  app.post("/messages", async (req, res) => {
    const sessionId = (req.query.sessionId as string) || "";
    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(404).json({ error: "session not found" });
      return;
    }
    await transport.handlePostMessage(req, res, req.body);
  });

  const httpServer = app.listen(config.httpPort, () => {
    console.error(
      `[mcp] ${config.serviceName} v${config.serviceVersion} → http :${config.httpPort} (auth=${config.authMode})`,
    );
  });

  const shutdown = (sig: string) => {
    console.error(`[mcp] ${sig} → shutting down`);
    httpServer.close();
    void ch.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}


main().catch((err) => {
  console.error("[mcp] fatal:", err);
  process.exit(1);
});
