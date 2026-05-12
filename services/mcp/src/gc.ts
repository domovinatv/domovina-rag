// OAuth GC — periodic cleanup expired tokens, codes, audit log retention.
//
// Zašto in-process setInterval umjesto pg_cron-a ili Coolify Scheduled Task-a:
// solo deploy, jedan MCP instance, ne dodajemo extension/orkestraciju. Cron tika
// dok god MCP server živi; restart preskoči jedan tik (acceptable — retention je
// 90-day window, jedan dan više/manje ne mijenja semantiku).
//
// Retention pravila (default 90 dana, override preko OAUTH_GC_RETENTION_DAYS):
//   - oauth_access_tokens:      DELETE WHERE expires_at < now()              (uvijek)
//   - oauth_refresh_tokens:     DELETE WHERE created_at < now() - retention  (90d)
//   - oauth_authorization_codes: DELETE WHERE expires_at < now() - 1 day     (mali grace)
//   - oauth_audit_log:          DELETE WHERE timestamp < now() - retention   (90d)
//
// Idempotentno (DELETE s WHERE), safe re-run.

import type { Pool } from "pg";

export interface OAuthGcConfig {
  intervalHours: number;
  retentionDays: number;
}

export interface OAuthGcResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  deletedAccessTokens: number;
  deletedRefreshTokens: number;
  deletedAuthCodes: number;
  deletedAuditEntries: number;
  error: string | null;
}

export async function runOAuthGc(pg: Pool, retentionDays: number): Promise<OAuthGcResult> {
  const startedAt = new Date();
  const result: OAuthGcResult = {
    startedAt: startedAt.toISOString(),
    finishedAt: "",
    durationMs: 0,
    deletedAccessTokens: 0,
    deletedRefreshTokens: 0,
    deletedAuthCodes: 0,
    deletedAuditEntries: 0,
    error: null,
  };

  try {
    const a = await pg.query("DELETE FROM oauth_access_tokens WHERE expires_at < now()");
    result.deletedAccessTokens = a.rowCount ?? 0;

    const r = await pg.query(
      `DELETE FROM oauth_refresh_tokens WHERE created_at < now() - ($1::int || ' days')::interval`,
      [retentionDays],
    );
    result.deletedRefreshTokens = r.rowCount ?? 0;

    const c = await pg.query(
      "DELETE FROM oauth_authorization_codes WHERE expires_at < now() - interval '1 day'",
    );
    result.deletedAuthCodes = c.rowCount ?? 0;

    const l = await pg.query(
      `DELETE FROM oauth_audit_log WHERE timestamp < now() - ($1::int || ' days')::interval`,
      [retentionDays],
    );
    result.deletedAuditEntries = l.rowCount ?? 0;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  const finishedAt = new Date();
  result.finishedAt = finishedAt.toISOString();
  result.durationMs = finishedAt.getTime() - startedAt.getTime();
  return result;
}


// In-memory "last run" status — admin endpoint čita ga. Survive-a samo dok proces
// živi (restart resetira na null). Sve relevant detail-e ima u stderr logu.
let lastResult: OAuthGcResult | null = null;
let nextRunAt: Date | null = null;

export function getLastGcResult(): OAuthGcResult | null {
  return lastResult;
}

export function getNextGcRunAt(): Date | null {
  return nextRunAt;
}

export function scheduleOAuthGc(pg: Pool, config: OAuthGcConfig): { stop: () => void } {
  const intervalMs = config.intervalHours * 3_600_000;
  // Prvi run nakon 60s od starta — daj serveru vremena da se podigne i prihvati
  // requeste prije nego što ide GC query (mala stvar, ali clean startup).
  const firstDelayMs = 60_000;

  const run = async () => {
    console.error(`[oauth-gc] starting (retention=${config.retentionDays}d)…`);
    const r = await runOAuthGc(pg, config.retentionDays);
    lastResult = r;
    nextRunAt = new Date(Date.now() + intervalMs);
    if (r.error) {
      console.error(`[oauth-gc] FAILED in ${r.durationMs}ms:`, r.error);
    } else {
      console.error(
        `[oauth-gc] done in ${r.durationMs}ms — ` +
          `access=${r.deletedAccessTokens} refresh=${r.deletedRefreshTokens} ` +
          `codes=${r.deletedAuthCodes} audit=${r.deletedAuditEntries}`,
      );
    }
  };

  const firstTimer = setTimeout(() => {
    void run();
    const interval = setInterval(() => void run(), intervalMs);
    interval.unref();
  }, firstDelayMs);
  firstTimer.unref();

  // setNextRunAt na prvi planirani run odmah, da /admin/api/gc/status nije null.
  nextRunAt = new Date(Date.now() + firstDelayMs);

  return {
    stop: () => {
      clearTimeout(firstTimer);
    },
  };
}
