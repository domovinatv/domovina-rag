// Public deterministic search REST API — GET/POST /api/search.
//
// Ovo je tanak, NE-MCP omotač oko iste `searchPodcasts()` funkcije koju zove
// MCP tool. Vraća čisti JSON (results[] s deep linkom, snippetom, scoreom) —
// nema LLM-a u putanji, nema OAuth-a. Namijenjen domovina.ai frontendu da
// koristi semantic retrieval kao običnu tražilicu.
//
// Zaštita: CORS allow-lista (PUBLIC_SEARCH_ALLOWED_ORIGINS) + per-IP rate
// limit (in-memory sliding window). Embedding je jeftin (self-hosted bge-m3),
// pa je glavni rizik samo abuse volumena → rate limit + kratki CDN cache.

import type { ClickHouseClient } from "@clickhouse/client";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import type { Pool } from "pg";
import { z } from "zod";

import type { Config } from "./config.js";
import type { EmbedderClient } from "./embedder.js";
import {
  SearchPodcastsInput,
  SearchMapInput,
  searchPodcasts,
  searchMapPoints,
} from "./tools/search-podcasts.js";
import { GetPersonInput, getPerson, PersonNotFoundError } from "./tools/get-person.js";
import { listPersons } from "./tools/list-persons.js";

// Prijava greške uz epizodu u virtualnom kanalu. `reason` je slobodan tekst
// korisnika — kratimo ga jer ide u bazu i čita ga čovjek, ne stroj.
const PersonReportInput = z.object({
  slug: z.string().min(1).max(120),
  youtube_id: z.string().min(1).max(32),
  reason: z.string().trim().max(500).optional(),
});

export interface PublicApiDeps {
  ch: ClickHouseClient;
  embedder: EmbedderClient;
  pg: Pool;
  config: Config;
}

// Per-IP sliding window. Odvojen od MCP per-client_id limitera jer public
// endpoint nema auth identitet — IP je jedini ključ koji imamo.
function makeIpRateLimit(perMinute: number) {
  const buckets = new Map<string, number[]>();

  // Periodic sweep da Map ne raste neograničeno (botovi s rotirajućim IP-em).
  const sweep = setInterval(() => {
    const minuteAgo = Date.now() - 60_000;
    for (const [ip, hits] of buckets.entries()) {
      while (hits.length > 0 && hits[0]! < minuteAgo) hits.shift();
      if (hits.length === 0) buckets.delete(ip);
    }
  }, 5 * 60 * 1000);
  sweep.unref();

  return function check(req: Request, res: Response): boolean {
    const ip = req.ip || "unknown";
    const now = Date.now();
    const minuteAgo = now - 60_000;

    let hits = buckets.get(ip);
    if (!hits) {
      hits = [];
      buckets.set(ip, hits);
    }
    while (hits.length > 0 && hits[0]! < minuteAgo) hits.shift();

    res.setHeader("X-RateLimit-Limit-Minute", String(perMinute));
    res.setHeader("X-RateLimit-Remaining-Minute", String(Math.max(0, perMinute - hits.length)));

    if (hits.length >= perMinute) {
      const retryAfterSec = Math.max(1, Math.ceil((hits[0]! + 60_000 - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      res.status(429).json({
        error: "rate_limit_exceeded",
        limit_per_minute: perMinute,
        retry_after_seconds: retryAfterSec,
      });
      return false;
    }
    hits.push(now);
    return true;
  };
}

// lexical_terms može doći kao ?lexical=a&lexical=b (array), "a,b" (csv) ili
// undefined. Normaliziraj na string[] ili undefined.
function normalizeLexical(raw: unknown): string[] | undefined {
  if (raw == null) return undefined;
  if (Array.isArray(raw)) {
    const arr = raw.map((x) => String(x).trim()).filter(Boolean);
    return arr.length > 0 ? arr : undefined;
  }
  const arr = String(raw)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return arr.length > 0 ? arr : undefined;
}

export function mountPublicApi(app: Express, deps: PublicApiDeps): void {
  const { config } = deps;
  const allowed = new Set(config.publicSearchAllowedOrigins);
  const rateLimit = makeIpRateLimit(config.publicSearchRatePerMinute);

  // CORS — reflektiraj samo origin-e s allow-liste; ostali dobiju response bez
  // ACAO headera (browser blokira). Preflight (OPTIONS) handla se ovdje.
  const cors = (req: Request, res: Response, next: NextFunction) => {
    const origin = req.header("origin");
    if (origin && allowed.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Max-Age", "86400");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };

  // Kompaktni odgovor za mapu: hits = [[youtube_id, t_sec, score]…]. Array-of-
  // arrays, ne objekti — pri 300-500 pogodaka ključevi bi bili većina payloada.
  const handleSearchMap = (src: Record<string, unknown>, res: Response) => {
    const parsed = SearchMapInput.safeParse({
      query: src.q ?? src.query,
      channel: src.channel,
      speaker: src.speaker,
      min_upload_date: src.min_upload_date ?? src.min_date,
      max_upload_date: src.max_upload_date ?? src.max_date,
      include_summaries: src.include_summaries,
      limit: src.limit,
      lexical_terms: normalizeLexical(src.lexical_terms ?? src.lexical),
    });

    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", detail: parsed.error.issues });
      return;
    }

    searchMapPoints(parsed.data, { ch: deps.ch, embedder: deps.embedder })
      .then((hits) => {
        res.setHeader("Cache-Control", "public, max-age=300");
        res.json({
          query: parsed.data.query,
          mode: "map",
          count: hits.length,
          limit: parsed.data.limit,
          hits: hits.map((h) => [h.youtube_id, h.t, Math.round(h.score * 1000) / 1000]),
        });
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[public-api] /api/search?mode=map failed:", msg);
        if (!res.headersSent) res.status(500).json({ error: "internal" });
      });
  };

  const handleSearch = (req: Request, res: Response) => {
    if (!rateLimit(req, res)) return; // 429 already sent

    const src: Record<string, unknown> =
      req.method === "POST" && req.body && typeof req.body === "object"
        ? (req.body as Record<string, unknown>)
        : (req.query as Record<string, unknown>);

    // `mode=map` (stats.domovina.ai/map): isti retrieval, ali odgovor nosi samo
    // koordinate pogodaka — vidi searchMapPoints.
    if (String(src.mode ?? "").toLowerCase() === "map") {
      handleSearchMap(src, res);
      return;
    }

    const parsed = SearchPodcastsInput.safeParse({
      query: src.q ?? src.query,
      channel: src.channel,
      speaker: src.speaker,
      min_upload_date: src.min_upload_date ?? src.min_date,
      max_upload_date: src.max_upload_date ?? src.max_date,
      include_summaries: src.include_summaries,
      limit: src.limit,
      lexical_terms: normalizeLexical(src.lexical_terms ?? src.lexical),
    });

    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", detail: parsed.error.issues });
      return;
    }

    searchPodcasts(parsed.data, { ch: deps.ch, embedder: deps.embedder })
      .then((results) => {
        // Deterministički rezultati → kratki CDN/browser cache smanjuje
        // ponovljene embeddinge za iste upite (npr. as-you-type repeat).
        res.setHeader("Cache-Control", "public, max-age=300");
        res.json({ query: parsed.data.query, count: results.length, results });
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[public-api] /api/search failed:", msg);
        if (!res.headersSent) res.status(500).json({ error: "internal" });
      });
  };

  app.options("/api/search", cors);
  app.get("/api/search", cors, handleSearch);
  app.post("/api/search", cors, handleSearch);

  // ─── Person hub: GET /api/person/:slug ──────────────────────────────
  // Read-only, javni, cross-channel agregat govornika. Isti CORS + rate-limit
  // wrapper kao /api/search. Resolve slug→osoba (PG), pa CH agregat epizoda.
  const handlePerson = (req: Request, res: Response) => {
    if (!rateLimit(req, res)) return; // 429 already sent

    const parsed = GetPersonInput.safeParse({ slug: req.params.slug });
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", detail: parsed.error.issues });
      return;
    }

    getPerson(parsed.data, { ch: deps.ch, pg: deps.pg })
      .then((hub) => {
        // Deterministički → kratki CDN/browser cache (person stranica je stabilna
        // do sljedećeg ingesta; 5 min je siguran kompromis svježine/tereta).
        res.setHeader("Cache-Control", "public, max-age=300");
        res.json(hub);
      })
      .catch((err: unknown) => {
        if (err instanceof PersonNotFoundError) {
          res.status(404).json({ error: "not_found", slug: err.slug });
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[public-api] /api/person failed:", msg);
        if (!res.headersSent) res.status(500).json({ error: "internal" });
      });
  };

  app.options("/api/person/:slug", cors);
  app.get("/api/person/:slug", cors, handlePerson);

  // ─── Indeks virtualnih kanala: GET /api/persons ─────────────────────────
  // Enumerabilan popis osoba koje su prešle prag (list-persons.ts). Troše ga
  // katalog /channels, home rail, pretraga i TV lane. Ruta je registrirana
  // ODVOJENO od /api/person/:slug — Express ih ne miješa jer je putanja
  // različita, ali redoslijed držimo eksplicitnim radi čitljivosti.
  const handlePersons = (req: Request, res: Response) => {
    if (!rateLimit(req, res)) return; // 429 already sent

    listPersons({ ch: deps.ch, pg: deps.pg })
      .then((index) => {
        // 15 min: indeks se mijenja tek s ingestom, a mijenja ga i ručna
        // kuracija (exclude/opt-out) — duže bi značilo da uklanjanje osobe
        // čeka predugo na rubu.
        res.setHeader("Cache-Control", "public, max-age=900");
        res.json(index);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[public-api] /api/persons failed:", msg);
        if (!res.headersSent) res.status(500).json({ error: "internal" });
      });
  };

  app.options("/api/persons", cors);
  app.get("/api/persons", cors, handlePersons);

  // ─── Prijava greške u virtualnom kanalu: POST /api/person-report ────────
  //
  // "Prijavi grešku" uz epizodu na profilu. Obrana od lažne atribucije
  // govornika (loša diarizacija, ASCII-fold mismatch) — tier prag tu ne pomaže
  // jer epizoda nije prekratka, nego TUĐA.
  //
  // Prijava se NE primjenjuje sama. Piše redak s `confirmed = false`, a
  // agregacija čita samo `confirmed = true`. Bez te podjele bi javni gumb bez
  // ikakve autentikacije bio brisač tuđih epizoda iz kataloga.
  const handlePersonReport = (req: Request, res: Response) => {
    if (!rateLimit(req, res)) return; // 429 already sent

    const body = (req.body ?? {}) as Record<string, unknown>;
    const parsed = PersonReportInput.safeParse({
      slug: body.slug,
      youtube_id: body.youtube_id,
      reason: body.reason,
    });
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", detail: parsed.error.issues });
      return;
    }
    const { slug, youtube_id, reason } = parsed.data;

    deps.pg
      .query(
        `INSERT INTO person_channel_overrides
           (slug, youtube_id, action, reason, confirmed, report_count)
         VALUES ($1, $2, 'exclude', $3, false, 1)
         ON CONFLICT (slug, youtube_id) DO UPDATE
           SET report_count = person_channel_overrides.report_count + 1,
               -- Prvi razlog se ČUVA: kasnije prijave ga ne prepisuju, da se
               -- izvorni opis greške ne izgubi pod nizom praznih prijava.
               reason = COALESCE(person_channel_overrides.reason, EXCLUDED.reason),
               updated_at = now()
         WHERE NOT person_channel_overrides.confirmed`,
        [slug, youtube_id, reason ?? null],
      )
      .then(() => {
        // 202, ne 200: prijava je zaprimljena, odluka nije donesena.
        res.status(202).json({ status: "received" });
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[public-api] /api/person-report failed:", msg);
        // Migracija 006 možda nije primijenjena. Korisniku ne serviramo 500 za
        // nešto što ne može popraviti; prijava je izgubljena, ali je zapisana
        // u log servisa.
        if (!res.headersSent) res.status(202).json({ status: "received" });
      });
  };

  app.options("/api/person-report", cors);
  app.post("/api/person-report", cors, express.json({ limit: "8kb" }), handlePersonReport);

  console.error(
    `[public-api] /api/search + /api/person + /api/persons enabled (origins=${config.publicSearchAllowedOrigins.join(",")}, ` +
      `rate=${config.publicSearchRatePerMinute}/min)`,
  );
}
