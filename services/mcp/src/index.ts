// MCP server entry point. Bira transport (stdio | http) iz env varijable.
//
//   stdio  → za Claude Desktop dev (proces se spawn-a kroz claude_desktop_config.json)
//   http   → za production deploy (Coolify), Express + Streamable HTTP + OAuth 2.1
//
// Streamable HTTP je trenutni MCP transport (spec 2025-03-26+) — single endpoint
// /mcp koji handluje POST (request → JSON ili SSE stream), GET (server-initiated
// notifications preko SSE), i DELETE (session termination). `Mcp-Session-Id`
// header tracka session.
//
// Auth podržava dva mode-a paralelno:
// - **OAuth 2.1 + DCR** (Claude.ai Custom Connectors): /authorize, /token,
//   /register, metadata na .well-known/*. Implementirano preko SDK mcpAuthRouter.
//   Klijenti se dynamic-registriraju (RFC 7591) i prolaze PKCE Authorization Code
//   flow s auto-approve-om.
// - **Static API key** (CI smoke test, e2e, legacy klijenti): `Authorization: Bearer
//   $MCP_API_KEY`. Bypass-a OAuth dance, direktno se prepoznaje u verifyAccessToken.

import { randomUUID } from "node:crypto";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import express, { type Request, type Response } from "express";

import { LocalOAuthProvider } from "./auth.js";
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

  // ─── HTTP + Streamable Transport + OAuth ─────────────────────
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Health check — Docker HEALTHCHECK gađa ovo. NE traži auth.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: config.serviceName, version: config.serviceVersion });
  });

  // OAuth provider — in-memory clients/tokens. Static API key (legacy) je
  // prepoznat side-by-side s issued OAuth tokenima.
  const oauthProvider = new LocalOAuthProvider({
    staticApiKey: config.authMode === "apikey" ? config.apiKey : null,
    staticScopes: ["mcp"],
  });

  // OAuth metadata + endpoints (RFC 8414, RFC 7591, RFC 6749/9700, RFC 7636).
  // SDK auto-mountira: /.well-known/oauth-authorization-server, /.well-known/
  // oauth-protected-resource, /authorize, /token, /register, /revoke.
  //
  // issuerUrl mora biti public URL servisa (s https i bez query/fragment).
  // U devu se setupira preko PUBLIC_BASE_URL env-a (npr. ngrok), u produkciji
  // preko Coolify-ja postavljeno na cloud hostname.
  const issuerUrl = new URL(config.publicBaseUrl);
  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl,
      scopesSupported: ["mcp"],
      resourceName: config.serviceName,
    }),
  );

  // SDK Bearer auth middleware — provjerava `Authorization: Bearer <token>`,
  // delegira na `oauthProvider.verifyAccessToken(token)`. Static API key
  // prolazi isti path jer ga provider prepoznaje.
  const bearer = requireBearerAuth({ verifier: oauthProvider });

  // Streamable HTTP transport — stateful mode. Svaki sessija dobiva svoj
  // `Server` instance jer SDK Server može biti spojen na samo jedan transport.
  type Session = {
    server: ReturnType<typeof createServer>;
    transport: StreamableHTTPServerTransport;
  };
  const sessions = new Map<string, Session>();

  // Single endpoint hand-ling sve metode (POST, GET, DELETE).
  // Root "/" je canonical — `mcp.domovina.ai` subdomena već encode-a "MCP" semantic.
  // "/mcp" ostaje za backward-compat (klijenti koji su konfigurirali stari URL).
  app.all(["/", "/mcp"], bearer, async (req: Request, res: Response) => {
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
        // Nova sesija — fresh Server + fresh transport.
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
      `[mcp] ${config.serviceName} v${config.serviceVersion} → http :${config.httpPort} (issuer=${issuerUrl}, auth=oauth+apikey, transport=streamable-http)`,
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
