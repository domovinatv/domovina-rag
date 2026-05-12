// OAuth 2.1 + DCR za MCP Custom Connectors — PG-backed.
//
// Sve OAuth state žive u PostgreSQL-u (vidi infra/postgres/init.sql tablice
// oauth_clients/codes/access_tokens/refresh_tokens). Server restart NE briše
// sessione. Audit log se updejtuje preko `recordAccess()` koji
// auditMiddleware zove iz Express-a.
//
// Tokens se spremaju kao SHA-256 hash (security: ako baza leakne, raw bearers
// nisu reusable). Lookup ide preko hash-a.

import { randomBytes, createHash } from "node:crypto";
import type { Response } from "express";
import type { Pool } from "pg";

import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";


const TOKEN_LIFETIME_SECONDS = 60 * 60 * 24 * 7; // 7 dana
const CODE_LIFETIME_SECONDS = 60 * 5;            // 5 min
const STATIC_KEY_CLIENT_ID = "static-api-key";


function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}


// ───────────────────── Clients store ──────────────────────

export class PgClientsStore implements OAuthRegisteredClientsStore {
  constructor(private readonly pg: Pool) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const r = await this.pg.query(
      `SELECT client_id, client_secret, client_id_issued_at, client_secret_expires_at,
              redirect_uris, grant_types, response_types, scope,
              token_endpoint_auth_method, client_name, metadata
       FROM oauth_clients WHERE client_id = $1`,
      [clientId],
    );
    if (r.rowCount === 0) return undefined;
    return rowToClient(r.rows[0]);
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): Promise<OAuthClientInformationFull> {
    const clientId = randomToken(16);
    const issuedAt = new Date();
    await this.pg.query(
      `INSERT INTO oauth_clients (
         client_id, client_secret, client_id_issued_at, client_secret_expires_at,
         redirect_uris, grant_types, response_types, scope,
         token_endpoint_auth_method, client_name, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        clientId,
        client.client_secret ?? null,
        issuedAt,
        client.client_secret_expires_at
          ? new Date(client.client_secret_expires_at * 1000)
          : null,
        JSON.stringify(client.redirect_uris ?? []),
        JSON.stringify(client.grant_types ?? ["authorization_code", "refresh_token"]),
        JSON.stringify(client.response_types ?? ["code"]),
        client.scope ?? null,
        client.token_endpoint_auth_method ?? "none",
        client.client_name ?? null,
        JSON.stringify(client),
      ],
    );
    return {
      ...client,
      client_id: clientId,
      client_id_issued_at: Math.floor(issuedAt.getTime() / 1000),
    };
  }
}


function rowToClient(row: Record<string, unknown>): OAuthClientInformationFull {
  const meta = (row.metadata as Record<string, unknown> | null) ?? {};
  return {
    ...meta,
    client_id: row.client_id as string,
    client_secret: (row.client_secret as string | null) ?? undefined,
    client_id_issued_at: row.client_id_issued_at
      ? Math.floor(new Date(row.client_id_issued_at as string).getTime() / 1000)
      : undefined,
    client_secret_expires_at: row.client_secret_expires_at
      ? Math.floor(new Date(row.client_secret_expires_at as string).getTime() / 1000)
      : undefined,
    redirect_uris: (row.redirect_uris as string[]) ?? [],
    grant_types: (row.grant_types as string[]) ?? undefined,
    response_types: (row.response_types as string[]) ?? undefined,
    scope: (row.scope as string | null) ?? undefined,
    token_endpoint_auth_method: (row.token_endpoint_auth_method as string | null) ?? undefined,
    client_name: (row.client_name as string | null) ?? undefined,
  } as OAuthClientInformationFull;
}


// ───────────────────── OAuth provider ─────────────────────

export interface PgOAuthProviderOptions {
  pg: Pool;
  staticApiKey?: string | null;
  staticScopes?: string[];
}


export class PgOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: PgClientsStore;
  private readonly pg: Pool;
  private readonly staticApiKey: string | null;
  private readonly staticScopes: string[];

  constructor(opts: PgOAuthProviderOptions) {
    this.pg = opts.pg;
    this.clientsStore = new PgClientsStore(opts.pg);
    this.staticApiKey = opts.staticApiKey ?? null;
    this.staticScopes = opts.staticScopes ?? ["mcp"];
  }

  /** Seedaj static API key kao "internal" PG client + access token. Pokreni na startup-u. */
  async seedStaticApiKey(): Promise<void> {
    if (!this.staticApiKey) return;

    // Upsert client
    await this.pg.query(
      `INSERT INTO oauth_clients (
         client_id, client_secret, client_id_issued_at,
         redirect_uris, grant_types, response_types,
         token_endpoint_auth_method, client_name
       ) VALUES ($1, NULL, now(), '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'none', 'Internal static API key')
       ON CONFLICT (client_id) DO NOTHING`,
      [STATIC_KEY_CLIENT_ID],
    );

    // Upsert access token (far-future expiry)
    const farFuture = new Date();
    farFuture.setFullYear(farFuture.getFullYear() + 100);
    await this.pg.query(
      `INSERT INTO oauth_access_tokens (token_hash, client_id, scopes, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (token_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
      [hashToken(this.staticApiKey), STATIC_KEY_CLIENT_ID, JSON.stringify(this.staticScopes), farFuture],
    );
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const code = randomToken(24);
    const expiresAt = new Date(Date.now() + CODE_LIFETIME_SECONDS * 1000);
    await this.pg.query(
      `INSERT INTO oauth_authorization_codes (code, client_id, redirect_uri,
        code_challenge, scopes, resource, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        code,
        client.client_id,
        params.redirectUri,
        params.codeChallenge,
        JSON.stringify(params.scopes ?? []),
        params.resource?.toString() ?? null,
        expiresAt,
      ],
    );

    const target = new URL(params.redirectUri);
    target.searchParams.set("code", code);
    if (params.state) target.searchParams.set("state", params.state);
    res.redirect(target.toString());
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const r = await this.pg.query(
      `SELECT code_challenge FROM oauth_authorization_codes WHERE code = $1`,
      [authorizationCode],
    );
    if (r.rowCount === 0) throw new Error("Invalid or expired authorization code");
    return r.rows[0].code_challenge as string;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<OAuthTokens> {
    const r = await this.pg.query(
      `DELETE FROM oauth_authorization_codes
       WHERE code = $1
       RETURNING client_id, scopes, resource, expires_at`,
      [authorizationCode],
    );
    if (r.rowCount === 0) throw new Error("Invalid or expired authorization code");
    const row = r.rows[0];
    if (new Date(row.expires_at) < new Date()) {
      throw new Error("Authorization code expired");
    }
    if (row.client_id !== client.client_id) {
      throw new Error("Authorization code does not belong to client");
    }
    return this.issueTokens(client.client_id, row.scopes ?? [], row.resource ?? undefined);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
  ): Promise<OAuthTokens> {
    const r = await this.pg.query(
      `DELETE FROM oauth_refresh_tokens
       WHERE token_hash = $1
       RETURNING client_id, scopes, resource`,
      [hashToken(refreshToken)],
    );
    if (r.rowCount === 0) throw new Error("Invalid refresh token");
    const row = r.rows[0];
    if (row.client_id !== client.client_id) {
      throw new Error("Refresh token does not belong to client");
    }
    return this.issueTokens(client.client_id, row.scopes ?? [], row.resource ?? undefined);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const r = await this.pg.query(
      `SELECT client_id, scopes, resource, expires_at
       FROM oauth_access_tokens
       WHERE token_hash = $1`,
      [hashToken(token)],
    );
    if (r.rowCount === 0) throw new Error("Invalid access token");
    const row = r.rows[0];
    if (new Date(row.expires_at) < new Date()) {
      throw new Error("Access token expired");
    }
    return {
      token,
      clientId: row.client_id as string,
      scopes: (row.scopes as string[]) ?? [],
      expiresAt: Math.floor(new Date(row.expires_at).getTime() / 1000),
      resource: row.resource ? new URL(row.resource as string) : undefined,
    };
  }

  /** Audit hook — pozove auditMiddleware nakon response. Atomic increment per token. */
  async recordAccess(args: {
    token: string;
    clientId: string;
    method: string;
    path: string;
    statusCode: number;
    latencyMs: number;
    userAgent?: string;
    ip?: string;
    error?: string;
  }): Promise<void> {
    const tokenHash = hashToken(args.token);

    // Update per-token counter + last_used. Best-effort, ne throw-aj (audit ne smije srušiti request).
    try {
      await this.pg.query(
        `UPDATE oauth_access_tokens
         SET request_count = request_count + 1, last_used_at = now()
         WHERE token_hash = $1`,
        [tokenHash],
      );

      await this.pg.query(
        `INSERT INTO oauth_audit_log
           (token_hash, client_id, method, path, status_code, latency_ms, user_agent, ip, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          tokenHash,
          args.clientId,
          args.method,
          args.path,
          args.statusCode,
          args.latencyMs,
          args.userAgent ?? null,
          args.ip ?? null,
          args.error ?? null,
        ],
      );
    } catch (err) {
      console.error("[mcp:audit] failed to record access:", err);
    }
  }

  private async issueTokens(
    clientId: string,
    scopes: string[],
    resource?: string,
  ): Promise<OAuthTokens> {
    const accessToken = randomToken(32);
    const refreshToken = randomToken(32);
    const expiresAt = new Date(Date.now() + TOKEN_LIFETIME_SECONDS * 1000);

    await this.pg.query(
      `INSERT INTO oauth_access_tokens (token_hash, client_id, scopes, resource, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [hashToken(accessToken), clientId, JSON.stringify(scopes), resource ?? null, expiresAt],
    );
    await this.pg.query(
      `INSERT INTO oauth_refresh_tokens (token_hash, client_id, scopes, resource)
       VALUES ($1, $2, $3, $4)`,
      [hashToken(refreshToken), clientId, JSON.stringify(scopes), resource ?? null],
    );

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: TOKEN_LIFETIME_SECONDS,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }
}
