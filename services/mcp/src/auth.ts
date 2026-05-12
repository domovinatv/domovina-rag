// OAuth 2.1 + Dynamic Client Registration za MCP Custom Connectors.
//
// Implementira minimalan OAuth 2.1 authorization server koji zadovoljava Anthropic
// Claude.ai/Claude Desktop Custom Connector zahtjeve:
// - DCR (RFC 7591) — clients se sami registriraju
// - PKCE (RFC 7636) — code_challenge + S256
// - Authorization Code flow s auto-approve (single-tenant private MCP, mi smo
//   jedini admin pa nema UI consent screen-a)
//
// In-memory state: clients, authorization codes, access tokens. Restart server-a
// = sve zaboravljeno; Claude će ponovo registrirati klijenta. Za solo-dev je OK,
// za multi-user persistence preselit ćemo u PG (Faza 4 follow-up).
//
// Static `MCP_API_KEY` ostaje podržan paralelno preko `verifyAccessToken` —
// dopušta dev/CI test path bez OAuth dance-a (smoke-test.mjs, e2e/run.mjs).

import { randomBytes } from "node:crypto";
import type { Response } from "express";

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
const CODE_LIFETIME_SECONDS = 60 * 5;            // 5 min za code exchange


function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}


interface AuthCodeEntry {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: URL;
  expiresAt: number;
}

interface TokenEntry {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: URL;
}


/** In-memory clients store — Map keyed by client_id. */
export class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private readonly clients = new Map<string, OAuthClientInformationFull>();

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    const clientId = randomToken(16);
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    this.clients.set(clientId, full);
    return full;
  }
}


export interface LocalOAuthProviderOptions {
  /** Pre-shared static token (legacy `MCP_API_KEY`). Bypass-a OAuth — accept-a se
   *  direktno u `verifyAccessToken`. Optional; ako null, samo OAuth tokeni rade. */
  staticApiKey?: string | null;
  /** Default scope za pre-shared token. */
  staticScopes?: string[];
}


/** Auto-approve OAuth provider — sve clients odmah dobijaju code bez UI consent-a. */
export class LocalOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new InMemoryClientsStore();
  private readonly authCodes = new Map<string, AuthCodeEntry>();
  private readonly tokens = new Map<string, TokenEntry>();
  private readonly refreshTokens = new Map<string, { clientId: string; scopes: string[]; resource?: URL }>();
  private readonly staticApiKey: string | null;
  private readonly staticScopes: string[];

  constructor(opts: LocalOAuthProviderOptions = {}) {
    this.staticApiKey = opts.staticApiKey ?? null;
    this.staticScopes = opts.staticScopes ?? ["mcp"];
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    // Auto-approve: generiraj code, spremi PKCE challenge + scope, redirect-aj.
    const code = randomToken(24);
    this.authCodes.set(code, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes ?? [],
      resource: params.resource,
      expiresAt: Date.now() + CODE_LIFETIME_SECONDS * 1000,
    });

    const target = new URL(params.redirectUri);
    target.searchParams.set("code", code);
    if (params.state) target.searchParams.set("state", params.state);
    res.redirect(target.toString());
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const entry = this.authCodes.get(authorizationCode);
    if (!entry) throw new Error("Invalid or expired authorization code");
    return entry.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    _redirectUri?: string,
    _resource?: URL,
  ): Promise<OAuthTokens> {
    const entry = this.authCodes.get(authorizationCode);
    if (!entry) throw new Error("Invalid or expired authorization code");
    if (entry.expiresAt < Date.now()) {
      this.authCodes.delete(authorizationCode);
      throw new Error("Authorization code expired");
    }
    if (entry.clientId !== client.client_id) {
      throw new Error("Authorization code does not belong to client");
    }

    // One-shot use
    this.authCodes.delete(authorizationCode);

    return this.issueTokens(client.client_id, entry.scopes, entry.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    _resource?: URL,
  ): Promise<OAuthTokens> {
    const entry = this.refreshTokens.get(refreshToken);
    if (!entry) throw new Error("Invalid refresh token");
    if (entry.clientId !== client.client_id) {
      throw new Error("Refresh token does not belong to client");
    }
    // Rotate refresh token
    this.refreshTokens.delete(refreshToken);
    return this.issueTokens(client.client_id, entry.scopes, entry.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // Backwards-compat: static API key. Skip-a OAuth tablicu, bind-a se na
    // virtualni client "static-api-key". SDK Bearer middleware traži
    // `expiresAt` — postavljamo far-future timestamp (rok 1 year od now-a).
    if (this.staticApiKey && token === this.staticApiKey) {
      const oneYearFromNow = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
      return {
        token,
        clientId: "static-api-key",
        scopes: this.staticScopes,
        expiresAt: oneYearFromNow,
      };
    }

    const entry = this.tokens.get(token);
    if (!entry) throw new Error("Invalid access token");
    if (entry.expiresAt < Date.now()) {
      this.tokens.delete(token);
      throw new Error("Access token expired");
    }
    return {
      token,
      clientId: entry.clientId,
      scopes: entry.scopes,
      expiresAt: Math.floor(entry.expiresAt / 1000),
      resource: entry.resource,
    };
  }

  private issueTokens(
    clientId: string,
    scopes: string[],
    resource?: URL,
  ): OAuthTokens {
    const accessToken = randomToken(32);
    const refreshToken = randomToken(32);
    const expiresAt = Date.now() + TOKEN_LIFETIME_SECONDS * 1000;

    this.tokens.set(accessToken, { clientId, scopes, expiresAt, resource });
    this.refreshTokens.set(refreshToken, { clientId, scopes, resource });

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: TOKEN_LIFETIME_SECONDS,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }
}
