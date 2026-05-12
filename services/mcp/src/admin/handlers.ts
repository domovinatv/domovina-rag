// Admin REST handlers — read-only za clients/tokens/audit + revoke (DELETE).
//
// Sve query-je idu na postojeće tablice iz infra/postgres/init.sql. ON DELETE CASCADE
// na oauth_clients pokriva tokens + refresh tokens + auth codes automatski.
//
// static-api-key je zaštićen od DELETE-a — inače bi MCP smoke test pukao.

import type { Request, Response } from "express";
import type { Pool } from "pg";

const STATIC_KEY_CLIENT_ID = "static-api-key";

export interface AdminDeps {
  pg: Pool;
}

// ───────────────────── /admin/api/stats ─────────────────────

export async function getStats(deps: AdminDeps, _req: Request, res: Response): Promise<void> {
  // Jedan round-trip preko CTE-a. P95 latency preko percentile_cont jer audit
  // tablica ima index na (timestamp DESC) — full scan zadnjih 24h je OK do par
  // milijuna redova.
  const r = await deps.pg.query<{
    clients_total: string;
    clients_dcr: string;
    tokens_active: string;
    tokens_expired: string;
    requests_24h: string;
    requests_1h: string;
    errors_24h: string;
    p95_latency_ms_24h: string | null;
  }>(`
    WITH client_counts AS (
      SELECT
        COUNT(*) AS clients_total,
        COUNT(*) FILTER (WHERE client_id != $1) AS clients_dcr
      FROM oauth_clients
    ),
    token_counts AS (
      SELECT
        COUNT(*) FILTER (WHERE expires_at > now()) AS tokens_active,
        COUNT(*) FILTER (WHERE expires_at <= now()) AS tokens_expired
      FROM oauth_access_tokens
    ),
    audit_24h AS (
      SELECT
        COUNT(*) AS requests_24h,
        COUNT(*) FILTER (WHERE status_code >= 400) AS errors_24h,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_latency_ms_24h
      FROM oauth_audit_log
      WHERE timestamp > now() - interval '24 hours'
    ),
    audit_1h AS (
      SELECT COUNT(*) AS requests_1h
      FROM oauth_audit_log
      WHERE timestamp > now() - interval '1 hour'
    )
    SELECT
      c.clients_total, c.clients_dcr,
      t.tokens_active, t.tokens_expired,
      a24.requests_24h, a1.requests_1h, a24.errors_24h, a24.p95_latency_ms_24h
    FROM client_counts c, token_counts t, audit_24h a24, audit_1h a1
  `, [STATIC_KEY_CLIENT_ID]);

  const row = r.rows[0];
  if (!row) {
    res.status(500).json({ error: "no rows from stats CTE" });
    return;
  }
  res.json({
    clients_total: Number(row.clients_total),
    clients_dcr: Number(row.clients_dcr),
    tokens_active: Number(row.tokens_active),
    tokens_expired: Number(row.tokens_expired),
    requests_24h: Number(row.requests_24h),
    requests_1h: Number(row.requests_1h),
    errors_24h: Number(row.errors_24h),
    p95_latency_ms_24h: row.p95_latency_ms_24h !== null ? Math.round(Number(row.p95_latency_ms_24h)) : null,
  });
}

// ───────────────────── /admin/api/clients ─────────────────────

export async function listClients(deps: AdminDeps, req: Request, res: Response): Promise<void> {
  const includeStatic = req.query.include_static === "true";
  const limitRaw = parseInt((req.query.limit as string) ?? "100", 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 500 ? limitRaw : 100;

  const r = await deps.pg.query(`
    SELECT
      c.client_id,
      c.client_name,
      c.client_id_issued_at,
      c.redirect_uris,
      COUNT(t.token_hash) FILTER (WHERE t.expires_at > now()) AS active_tokens,
      COALESCE(SUM(t.request_count), 0) AS total_requests,
      MAX(t.last_used_at) AS last_used_at
    FROM oauth_clients c
    LEFT JOIN oauth_access_tokens t ON c.client_id = t.client_id
    WHERE ($1::boolean OR c.client_id != $2)
    GROUP BY c.client_id
    ORDER BY MAX(t.last_used_at) DESC NULLS LAST
    LIMIT $3
  `, [includeStatic, STATIC_KEY_CLIENT_ID, limit]);

  res.json({
    clients: r.rows.map((row) => ({
      client_id: row.client_id,
      client_name: row.client_name,
      client_id_issued_at: row.client_id_issued_at,
      redirect_uris: row.redirect_uris ?? [],
      active_tokens: Number(row.active_tokens),
      total_requests: Number(row.total_requests),
      last_used_at: row.last_used_at,
    })),
  });
}

export async function deleteClient(deps: AdminDeps, req: Request, res: Response): Promise<void> {
  const clientId = req.params.client_id;
  if (!clientId) {
    res.status(400).json({ error: "client_id required" });
    return;
  }
  if (clientId === STATIC_KEY_CLIENT_ID) {
    res.status(403).json({ error: "static-api-key is system-managed" });
    return;
  }
  // ON DELETE CASCADE briše tokens/codes/refresh_tokens. Audit log ostaje (nema FK).
  const r = await deps.pg.query("DELETE FROM oauth_clients WHERE client_id = $1", [clientId]);
  if (r.rowCount === 0) {
    res.status(404).json({ error: "client not found" });
    return;
  }
  res.json({ deleted: r.rowCount });
}

// ───────────────────── /admin/api/tokens ─────────────────────

export async function listTokens(deps: AdminDeps, req: Request, res: Response): Promise<void> {
  const clientId = (req.query.client_id as string) || null;
  const activeOnly = req.query.active === "true";
  const limitRaw = parseInt((req.query.limit as string) ?? "100", 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 500 ? limitRaw : 100;

  const r = await deps.pg.query(`
    SELECT
      token_hash,
      client_id,
      scopes,
      request_count,
      last_used_at,
      expires_at,
      (expires_at <= now()) AS is_expired
    FROM oauth_access_tokens
    WHERE ($1::text IS NULL OR client_id = $1)
      AND ($2::boolean = false OR expires_at > now())
    ORDER BY last_used_at DESC NULLS LAST
    LIMIT $3
  `, [clientId, activeOnly, limit]);

  res.json({
    tokens: r.rows.map((row) => ({
      // Raw hash NE vraćamo (dovoljno za replay ako leakne iz response-a).
      // Prefix je dovoljan kao UI identifikator + lookup za DELETE.
      token_hash_prefix: String(row.token_hash).slice(0, 16),
      client_id: row.client_id,
      scopes: row.scopes ?? [],
      request_count: Number(row.request_count),
      last_used_at: row.last_used_at,
      expires_at: row.expires_at,
      is_expired: row.is_expired,
    })),
  });
}

export async function revokeToken(deps: AdminDeps, req: Request, res: Response): Promise<void> {
  const prefix = req.params.prefix;
  if (!prefix || prefix.length < 8) {
    res.status(400).json({ error: "prefix must be at least 8 chars" });
    return;
  }

  // Lookup s LIKE prefix. Ako >1 match → ambiguous, ne briši (sigurnije).
  const found = await deps.pg.query<{ token_hash: string }>(
    "SELECT token_hash FROM oauth_access_tokens WHERE token_hash LIKE $1 LIMIT 2",
    [prefix + "%"],
  );
  if (found.rowCount === 0) {
    res.status(404).json({ error: "token not found" });
    return;
  }
  if (found.rowCount !== null && found.rowCount > 1) {
    res.status(409).json({ error: "ambiguous prefix (matches multiple tokens)" });
    return;
  }
  const firstRow = found.rows[0];
  if (!firstRow) {
    res.status(404).json({ error: "token not found" });
    return;
  }
  const tokenHash = firstRow.token_hash;
  const r = await deps.pg.query("DELETE FROM oauth_access_tokens WHERE token_hash = $1", [tokenHash]);
  res.json({ deleted: r.rowCount });
}

// ───────────────────── /admin/api/audit ─────────────────────

export async function getAuditLog(deps: AdminDeps, req: Request, res: Response): Promise<void> {
  const clientId = (req.query.client_id as string) || null;
  const since = (req.query.since as string) || null;
  const statusCodeGteRaw = parseInt((req.query.status_code_gte as string) ?? "", 10);
  const statusCodeGte = Number.isFinite(statusCodeGteRaw) ? statusCodeGteRaw : null;
  const limitRaw = parseInt((req.query.limit as string) ?? "100", 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 500 ? limitRaw : 100;
  const beforeIdRaw = parseInt((req.query.before_id as string) ?? "", 10);
  const beforeId = Number.isFinite(beforeIdRaw) ? beforeIdRaw : null;

  // Cursor pagination preko BIGSERIAL id-a (idx_audit_timestamp pokriva ORDER).
  const r = await deps.pg.query(`
    SELECT id, timestamp, client_id, method, path, status_code, latency_ms, ip, user_agent, error
    FROM oauth_audit_log
    WHERE ($1::text IS NULL OR client_id = $1)
      AND ($2::timestamptz IS NULL OR timestamp >= $2)
      AND ($3::int IS NULL OR status_code >= $3)
      AND ($4::bigint IS NULL OR id < $4)
    ORDER BY id DESC
    LIMIT $5
  `, [clientId, since, statusCodeGte, beforeId, limit]);

  const lastRow = r.rows[r.rows.length - 1];
  const nextBeforeId = lastRow ? Number(lastRow.id) : null;

  res.json({
    entries: r.rows.map((row) => ({
      id: Number(row.id),
      timestamp: row.timestamp,
      client_id: row.client_id,
      method: row.method,
      path: row.path,
      status_code: row.status_code,
      latency_ms: row.latency_ms,
      ip: row.ip,
      user_agent: row.user_agent,
      error: row.error,
    })),
    next_before_id: r.rowCount === limit ? nextBeforeId : null,
  });
}
