// MCP server entry point. Bira transport (stdio | http) iz env varijable.
//
//   stdio  → Claude Desktop dev (spawn-an kroz claude_desktop_config.json)
//   http   → Production Coolify deploy, Express + Streamable HTTP + OAuth 2.1 + DCR
//
// Auth: OAuth 2.1 + DCR (PG-backed) + static MCP_API_KEY (također seeded u PG-u
// kao pre-issued token za client_id='static-api-key'). Sav auth state u PG-u →
// restart-perzistencija + audit log po request-u.

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import express, { type Request, type Response, type NextFunction } from "express";

import { PgOAuthProvider } from "./auth.js";
import { makeRequireAdmin } from "./admin-auth.js";
import {
  deleteClient,
  getAuditLog,
  getStats,
  listClients,
  listTokens,
  revokeToken,
} from "./admin/handlers.js";
import { renderAdminPage } from "./admin/index.html.js";
import { loadConfig } from "./config.js";
import { createCh, createPg } from "./db.js";
import { EmbedderClient } from "./embedder.js";
import { createServer } from "./server.js";


async function main() {
  const config = loadConfig();
  const ch = createCh(config.clickhouseUrl);
  const embedder = new EmbedderClient(config.embedderUrl);

  if (config.transport === "stdio") {
    console.error(`[mcp] ${config.serviceName} v${config.serviceVersion} → stdio`);
    const server = createServer({ config, ch, embedder });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }

  // ─── HTTP + Streamable Transport + OAuth ─────────────────────
  const pg = createPg(config.postgresUrl);
  const oauthProvider = new PgOAuthProvider({
    pg,
    staticApiKey: config.authMode === "apikey" ? config.apiKey : null,
    staticScopes: ["mcp"],
  });

  // Seedaj static API key kao PG record (idempotent) — audit log radi za njega isto.
  await oauthProvider.seedStaticApiKey();

  const app = express();

  // Static public assets (favicon, icons, manifest) — public, bez auth-a.
  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
  app.use(express.static(publicDir, { index: false, maxAge: "1h" }));

  app.use(express.json({ limit: "1mb" }));

  // Health check — NE traži auth.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: config.serviceName, version: config.serviceVersion });
  });

  // Browser landing — GET / s Accept: text/html (NE application/json ili SSE)
  // vraća HTML stranicu umjesto OAuth challenge-a.
  app.get("/", (req: Request, res: Response, next: NextFunction) => {
    const accept = req.header("accept") || "";
    const wantsHtml = accept.includes("text/html");
    const wantsMcp = accept.includes("application/json") || accept.includes("text/event-stream");
    if (wantsHtml && !wantsMcp) {
      res.sendFile(path.join(publicDir, "index.html"));
      return;
    }
    next();
  });

  // OAuth endpoints (SDK auto-mounta: /authorize, /token, /register, /.well-known/*)
  const issuerUrl = new URL(config.publicBaseUrl);
  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl,
      scopesSupported: ["mcp"],
      resourceName: config.serviceName,
    }),
  );

  // ─── Admin REST API + HTML ──────────────────────────────────
  // Vlastiti auth (ADMIN_API_KEY Bearer), NE OAuth. Ako ADMIN_API_KEY nije set,
  // middleware vraća 404 za sve /admin* → admin disabled.
  //
  // HTML /admin sam po sebi NIJE Bearer-protected — browser GET ne nosi header.
  // Sve data-fetch radi inline <script> preko Bearer-a iz localStorage-a, što
  // svaki /admin/api/* call zaštićuje. HTML 404-a se kad admin nije configured.
  const requireAdmin = makeRequireAdmin(config.adminApiKey);
  const adminDeps = { pg };
  app.get("/admin", (req: Request, res: Response) => {
    if (!config.adminApiKey) {
      res.status(404).end();
      return;
    }
    const nonce = randomUUID().replace(/-/g, "");
    res.set(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        `script-src 'nonce-${nonce}'`,
        "style-src 'self' 'unsafe-inline'",
        "connect-src 'self'",
        "img-src 'self' data:",
        "frame-ancestors 'none'",
        "base-uri 'self'",
      ].join("; "),
    );
    res.type("html").send(renderAdminPage(nonce));
  });
  // Wrapper koji loga error u stderr + vraća stvarnu poruku u response body.
  // Admin endpoint je gated ADMIN_API_KEY-om → leak detalja je OK (i nužan za debug).
  type AdminHandler = (deps: typeof adminDeps, req: Request, res: Response) => Promise<void>;
  const wrap = (name: string, handler: AdminHandler) => (req: Request, res: Response) => {
    void handler(adminDeps, req, res).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      console.error(`[admin] ${name} failed:`, msg, stack);
      if (!res.headersSent) res.status(500).json({ error: "internal", detail: msg });
    });
  };
  app.get("/admin/api/stats", requireAdmin, wrap("stats", getStats));
  app.get("/admin/api/clients", requireAdmin, wrap("listClients", listClients));
  app.delete("/admin/api/clients/:client_id", requireAdmin, wrap("deleteClient", deleteClient));
  app.get("/admin/api/tokens", requireAdmin, wrap("listTokens", listTokens));
  app.delete("/admin/api/tokens/:prefix", requireAdmin, wrap("revokeToken", revokeToken));
  app.get("/admin/api/audit", requireAdmin, wrap("getAuditLog", getAuditLog));

  const bearer = requireBearerAuth({ verifier: oauthProvider });

  // Streamable HTTP transport — stateful, per-sessija novi Server instance.
  type Session = {
    server: ReturnType<typeof createServer>;
    transport: StreamableHTTPServerTransport;
  };
  const sessions = new Map<string, Session>();

  // Audit middleware — logira u oauth_audit_log nakon response-a preko `finish` event-a.
  // Auth info iz req.auth se očita TEK kad je bearer middleware uspješno provjerio.
  // Za fail (401) ne logiramo jer ne znamo client_id (token je invalid).
  const audit = (req: Request, res: Response, next: NextFunction) => {
    const startedAt = Date.now();
    res.on("finish", () => {
      const authInfo = (req as Request & { auth?: { token: string; clientId: string } }).auth;
      if (!authInfo?.token) return; // 401 fail-ovi se ne logiraju (no client identity)
      void oauthProvider.recordAccess({
        token: authInfo.token,
        clientId: authInfo.clientId,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        latencyMs: Date.now() - startedAt,
        userAgent: req.header("user-agent"),
        ip: req.ip,
        error: res.statusCode >= 400 ? `HTTP ${res.statusCode}` : undefined,
      });
    });
    next();
  };

  // /mcp + / (root canonical) — Streamable HTTP + auth + audit.
  app.all(["/", "/mcp"], bearer, audit, async (req: Request, res: Response) => {
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

      if (session.transport.sessionId && !sessions.has(session.transport.sessionId)) {
        sessions.set(session.transport.sessionId, session);
      }
    } catch (err) {
      console.error("[mcp] handler error:", err);
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
      `[mcp] ${config.serviceName} v${config.serviceVersion} → http :${config.httpPort} (issuer=${issuerUrl}, auth=oauth+apikey+pg, audit=on)`,
    );
  });

  const shutdown = (sig: string) => {
    console.error(`[mcp] ${sig} → shutting down`);
    httpServer.close();
    void ch.close();
    void pg.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}


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
