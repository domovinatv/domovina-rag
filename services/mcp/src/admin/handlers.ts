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
