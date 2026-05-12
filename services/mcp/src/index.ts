// MCP server entry point. Bira transport (stdio | http) iz env varijable.
//
//   stdio  → za Claude Desktop dev (proces se spawn-a kroz claude_desktop_config.json)
//   http   → za production deploy (Coolify), Express + Streamable HTTP transport + Bearer auth
//
// Streamable HTTP je trenutni MCP transport (spec 2025-03-26+) — single endpoint /mcp
// koji handluje POST (request → JSON ili SSE stream), GET (server-initiated notifications
// preko SSE), i DELETE (session termination). `Mcp-Session-Id` header tracka session.
// SSE legacy transport je uklonjen — `mcp-remote` bridge više nije potreban.

import { randomUUID } from "node:crypto";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response, type NextFunction } from "express";

import { loadConfig } from "./config.js";
import { createCh } from "./db.js";
import { EmbedderClient } from "./embedder.js";
import { createServer } from "./server.js";


async function main() {
  const config = loadConfig();
  const ch = createCh(config.clickhouseUrl);
  const embedder = new EmbedderClient(config.embedderUrl);

  if (config.transport === "stdio") {
    // Stdio: log na stderr (stdout je rezerviran za JSON-RPC frames).
    // Single Server instance jer postoji samo jedan stdio kanal.
    console.error(`[mcp] ${config.serviceName} v${config.serviceVersion} → stdio`);
    const server = createServer({ config, ch, embedder });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }

  // ─── HTTP + Streamable Transport ─────────────────────────────
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

  // Streamable HTTP transport — stateful mode s in-memory session tracking-om.
  // BITNO: svaki sessija dobiva svoj `Server` instance jer SDK Server može biti
  // spojen na samo jedan transport. Pohranjujemo `{ server, transport }` par.
  type Session = {
    server: ReturnType<typeof createServer>;
    transport: StreamableHTTPServerTransport;
  };
  const sessions = new Map<string, Session>();

  // Single endpoint hand-ling sve metode (POST, GET, DELETE).
  // POST = JSON-RPC request from client (initialize, tools/list, tools/call)
  // GET = open SSE stream za server-sent notifications
  // DELETE = explicit session termination
  app.all("/mcp", async (req, res) => {
    try {
      const incomingSessionId = req.header("mcp-session-id");
      let session: Session | undefined;

      if (incomingSessionId) {
        session = sessions.get(incomingSessionId);
        if (!session) {
          res.status(404).json({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Session not found" },
            id: null,
          });
          return;
        }
      } else if (req.method === "POST" && isInitializeRequest(req.body)) {
        // Nova sesija — fresh Server + fresh transport, connect, pa zatim
        // handleRequest. sessionId se materijalizira tijekom handleRequest-a;
        // registriramo session u map poslije.
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });
        const server = createServer({ config, ch, embedder });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await server.connect(transport);
        session = { server, transport };
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32600,
            message:
              "Bad Request: Mcp-Session-Id header missing (or initialize request expected)",
          },
          id: null,
        });
        return;
      }

      await session.transport.handleRequest(req, res, req.body);

      // Registriraj novokreirani session tek poslije prvog handleRequest-a
      // (kad je sessionId dodjeljen).
      if (session.transport.sessionId && !sessions.has(session.transport.sessionId)) {
        sessions.set(session.transport.sessionId, session);
      }
    } catch (err) {
      console.error("[mcp] /mcp handler error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal error" },
          id: null,
        });
      }
    }
  });

  const httpServer = app.listen(config.httpPort, () => {
    console.error(
      `[mcp] ${config.serviceName} v${config.serviceVersion} → http :${config.httpPort} (auth=${config.authMode}, transport=streamable-http)`,
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


// Detektira MCP `initialize` JSON-RPC request. Initialize je single ili batch
// (older clients), pa provjeravamo oba shape-a. Method ime je u spec-u
// fiksirano na "initialize".
function isInitializeRequest(body: unknown): boolean {
  if (!body) return false;
  if (Array.isArray(body)) return body.some(isInitializeRequest);
  if (typeof body === "object" && body !== null && "method" in body) {
    return (body as { method?: unknown }).method === "initialize";
  }
  return false;
}


main().catch((err) => {
  console.error("[mcp] fatal:", err);
  process.exit(1);
});
