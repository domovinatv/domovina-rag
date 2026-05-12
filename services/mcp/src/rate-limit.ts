// Rate limiting middleware — per client_id sliding window, in-memory.
//
// Zašto in-memory umjesto Redis-a: solo deploy, jedan MCP instance, jednostavnost
// pobjeđuje. Restart resetira counters (acceptable — Coolify deploy je 30s downtime,
// novi requesti starta od nule). Ako jednog dana ide horizontal scale, swap-aj
// implementaciju Map-a za Redis client uz isto sučelje.
//
// Algoritam: dva ring-buffera (minute + hour) timestamp-ova po client_id-u. Na
// request: trim entrije starije od prozora, count, if-over-limit 429. Memory
// footprint per aktivni client: ~ (limitMinute + limitHour) × 8B. Cleanup mrtvih
// klijenata: opportunistic — kad oba buffera padnu na 0, brišemo entry.
//
// static-api-key client je exempt (sistemski identitet, ne pravi klijent).

import type { Request, Response, NextFunction } from "express";

const STATIC_KEY_CLIENT_ID = "static-api-key";

interface Bucket {
  minute: number[]; // timestamps (ms epoch)
  hour: number[];
}

export interface RateLimitConfig {
  perMinute: number;
  perHour: number;
}

export interface RateLimit {
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  sweep: () => void;
  activeClients: () => number;
}

export function makeRateLimit(config: RateLimitConfig): RateLimit {
  const buckets = new Map<string, Bucket>();

  const middleware = function rateLimit(req: Request, res: Response, next: NextFunction): void {
    const authInfo = (req as Request & { auth?: { clientId?: string } }).auth;
    const clientId = authInfo?.clientId;

    // Bez auth-info-a (npr. ne-OAuth route) ili static-api-key → propusti.
    if (!clientId || clientId === STATIC_KEY_CLIENT_ID) {
      next();
      return;
    }

    const now = Date.now();
    const minuteAgo = now - 60_000;
    const hourAgo = now - 3_600_000;

    let bucket = buckets.get(clientId);
    if (!bucket) {
      bucket = { minute: [], hour: [] };
      buckets.set(clientId, bucket);
    }

    // Trim u-mjestu (array start je najstariji).
    while (bucket.minute.length > 0 && bucket.minute[0]! < minuteAgo) bucket.minute.shift();
    while (bucket.hour.length > 0 && bucket.hour[0]! < hourAgo) bucket.hour.shift();

    const minuteUsed = bucket.minute.length;
    const hourUsed = bucket.hour.length;
    const minuteRemaining = Math.max(0, config.perMinute - minuteUsed);
    const hourRemaining = Math.max(0, config.perHour - hourUsed);

    res.setHeader("X-RateLimit-Limit-Minute", String(config.perMinute));
    res.setHeader("X-RateLimit-Remaining-Minute", String(minuteRemaining));
    res.setHeader("X-RateLimit-Limit-Hour", String(config.perHour));
    res.setHeader("X-RateLimit-Remaining-Hour", String(hourRemaining));

    if (minuteUsed >= config.perMinute) {
      // Najstariji u minute prozoru istječe za (oldest + 60s - now) ms.
      const retryAfterMs = bucket.minute[0]! + 60_000 - now;
      const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      res.status(429).json({
        error: "rate_limit_exceeded",
        scope: "per_minute",
        limit: config.perMinute,
        retry_after_seconds: retryAfterSec,
      });
      return;
    }
    if (hourUsed >= config.perHour) {
      const retryAfterMs = bucket.hour[0]! + 3_600_000 - now;
      const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      res.status(429).json({
        error: "rate_limit_exceeded",
        scope: "per_hour",
        limit: config.perHour,
        retry_after_seconds: retryAfterSec,
      });
      return;
    }

    bucket.minute.push(now);
    bucket.hour.push(now);
    next();
  };

  // Periodic sweep dead clients (oba buffera prazna) da Map ne raste neograničeno
  // kad DCR registrira pa zaboravi klijente.
  const sweep = () => {
    const now = Date.now();
    const minuteAgo = now - 60_000;
    const hourAgo = now - 3_600_000;
    for (const [clientId, b] of buckets.entries()) {
      while (b.minute.length > 0 && b.minute[0]! < minuteAgo) b.minute.shift();
      while (b.hour.length > 0 && b.hour[0]! < hourAgo) b.hour.shift();
      if (b.minute.length === 0 && b.hour.length === 0) buckets.delete(clientId);
    }
  };

  return { middleware, sweep, activeClients: () => buckets.size };
}
