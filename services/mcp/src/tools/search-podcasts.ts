// search_podcasts MCP tool — semantic search nad rag_chunks.
//
// Tijek:
//  1. embed query string → 1024-d bge-m3 vektor
//  2. CH SELECT ORDER BY cosineDistance(...) LIMIT N (USearch index ubrzava)
//  3. format: deep link na domovina.ai frontend (`/v/{id}/t/{start_ts}`),
//     snippet teksta, score
//
// Cache-bust marker: hotfix-3 za Coolify build cache (commit 3ae6963 SQL
// changes nisu se reflektirali u cloud-u — sumnja na stale Docker layer).

import type { ClickHouseClient } from "@clickhouse/client";
import { z } from "zod";

import type { EmbedderClient } from "../embedder.js";


// Filteri su isti za tekstualnu pretragu (tool + /api/search) i za "map" način
// javnog API-ja (samo koordinate pogodaka). Držimo ih na jednom mjestu da se
// semantika filtriranja ne razdvoji između dva ulaza u istu tablicu.
const FILTERS = {
  channel: z.string().optional().describe("Filter na slug kanala (npr. 'podcast_cuspajz')"),
  speaker: z
    .string()
    .min(2)
    .max(100)
    .optional()
    .describe(
      "Filter: vrati samo chunkove gdje navedeni govornik stvarno govori. " +
        "Case-insensitive partial match (npr. 'Miletić' matcha 'Marin Miletić'). " +
        "Koristi za 'što je X rekao o Y' upite kako bi izbjegao chunkove gdje se osoba samo spominje.",
    ),
  min_upload_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Format: YYYY-MM-DD")
    .optional()
    .describe("Filter: samo chunkovi iz epizoda objavljenih >= ovom datumu (npr. '2025-01-01')."),
  max_upload_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Format: YYYY-MM-DD")
    .optional()
    .describe("Filter: samo chunkovi iz epizoda objavljenih <= ovom datumu."),
  include_summaries: z
    .preprocess(
      // z.coerce.boolean je Boolean(x) koji za string "false" vraća true.
      // Preprocess handluje "false"/"true" stringove pravilno + native bool.
      (v) => (v === "false" ? false : v === "true" ? true : v),
      z.boolean(),
    )
    .default(true)
    .describe(
      "Ako false, isključuje article_summary chunkove (start=end=0, bez govornika). " +
        "Korisno kad treba direktan citat iz dijaloga, ne AI sažetak.",
    ),
  lexical_terms: z
    .array(z.string().min(1).max(50))
    .max(10)
    .optional()
    .describe(
      "Hybrid retrieval: vrati samo chunkove koji sadrže SVE navedene tokene. " +
        "Koristi za proper nouns (npr. ['Hasanbegović']) ili specifične termine " +
        "gdje semantic embedding ima slabosti. AND semantika (svi tokeni moraju biti " +
        "prisutni); za OR pozovi tool više puta.",
    ),
};

export const SearchPodcastsInput = z.object({
  query: z.string().min(2).max(500).describe("Tekstualni upit na hrvatskom"),
  ...FILTERS,
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(25)
    .default(10)
    .describe(
      "Maks. broj rezultata (1-25, default 10). Cap je 25 jer veći broj " +
        "rezultata često prelazi token budget LLM klijenta. Za bulk operacije " +
        "koristi paginiranje preko više poziva.",
    ),
});

// "Map" način: isti retrieval, ali odgovor nosi SAMO ono čime se pogodak nacrta
// na semantičkoj mapi (stats.domovina.ai/map) — youtube_id, sekunda i score.
// Zato je cap 500, a ne 25: cap tekstualne pretrage brani token budget LLM
// klijenta, a ovdje teksta nema (500 pogodaka ≈ 12 kB JSON-a). Sazviježđe od
// 25 točaka na 143k oblaka ne bi reklo ništa o tome gdje tema živi.
//
// `include_summaries` je ovdje default **false**, obrnuto od tekstualne
// pretrage, i to nije ukus nego posljedica ključa spajanja. Frontend pogodak
// veže uz točku preko `(ep_idx, t_sec)`; `article_summary` chunkovi imaju
// `start_ts = 0`, pa svi sažeci jedne epizode dijele isti ključ (izmjereno nad
// snapshotom 04.08.2026: 46 % točaka sjedi na `t=0`, do 103 točke po epizodi).
// Uz sažetke bi jedan pogodak zapalio cijeli taj oblak. Bez njih je ključ
// **bijektivan** — 77 601 ključ na 77 601 točku, nula višeznačnosti.
// Klijent smije poslati `include_summaries=true` ako mu je važnija pokrivenost
// od preciznosti. Trajni popravak (ako zatreba): producer emitira
// `cityHash64(chunk_id)` po točki, pa se spaja po identitetu chunka.
export const SearchMapInput = z.object({
  query: z.string().min(2).max(500).describe("Tekstualni upit na hrvatskom"),
  ...FILTERS,
  include_summaries: FILTERS.include_summaries.default(false),
  limit: z.coerce.number().int().min(1).max(500).default(300),
});

export type SearchPodcastsArgs = z.infer<typeof SearchPodcastsInput>;
export type SearchMapArgs = z.infer<typeof SearchMapInput>;

export interface SearchResult {
  chunk_id: string;
  youtube_id: string;
  channel: string;
  upload_date: string;
  episode_title: string | null;
  speakers: string[];
  start_ts: number;
  end_ts: number;
  text: string;
  score: number;          // 1 - cosineDistance, viši = bolji
  deep_link: string;
}


// JSON Schema verzija (MCP `inputSchema`) — držimo manualno jer SDK još
// stabilno koristi raw JSON Schema, ne zod.
export const searchPodcastsJsonSchema = {
  type: "object" as const,
  properties: {
    query: { type: "string", minLength: 2, maxLength: 500, description: "Tekstualni upit na hrvatskom" },
    channel: { type: "string", description: "Filter na slug kanala (npr. 'podcast_cuspajz')" },
    speaker: {
      type: "string",
      minLength: 2,
      maxLength: 100,
      description:
        "Filter: samo chunkovi gdje X stvarno govori (NE spominjanje). " +
        "Case-insensitive partial match (npr. 'Miletić' → 'Marin Miletić').",
    },
    min_upload_date: {
      type: "string",
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      description: "Filter: epizode objavljene >= YYYY-MM-DD.",
    },
    max_upload_date: {
      type: "string",
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      description: "Filter: epizode objavljene <= YYYY-MM-DD.",
    },
    include_summaries: {
      type: "boolean",
      default: true,
      description:
        "Ako false, isključuje article_summary chunkove (bez govornika i timestamp-a). " +
        "Koristi za direktne citate iz dijaloga.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 25,
      default: 10,
      description:
        "Maks. broj rezultata (1-25, default 10). Cap je 25 jer veći broj prelazi tipičan tool budget LLM-a.",
    },
    lexical_terms: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 50 },
      maxItems: 10,
      description:
        "Hybrid: forsiraj da chunk sadrži SVE ove tokene (CH Bloom filter). " +
        "Korisno za proper nouns (npr. ['Hasanbegović']) ili specifične termine.",
    },
  },
  required: ["query"],
};


interface ChunkRow {
  chunk_id: string;
  youtube_id: string;
  channel: string;
  upload_date: string;
  speaker: string;
  start_ts: number;
  end_ts: number;
  text: string;
  metadata: string;
  distance: number;
}


/** Zajednički WHERE za oba načina pretrage (tekst i mapa). */
function buildFilters(args: SearchPodcastsArgs | SearchMapArgs): {
  whereParts: string[];
  params: Record<string, unknown>;
} {
  const params: Record<string, unknown> = {};
  const whereParts: string[] = [];
  if (args.channel) {
    whereParts.push("channel = {channel:String}");
    params.channel = args.channel;
  }
  if (args.speaker) {
    // Case-insensitive partial match nad comma-separated speaker kolonom.
    // `position` vraća poziciju substring-a ili 0; > 0 = match.
    // Bez lowerUTF8 na obje strane jer LowCardinality + position nije idealan;
    // koristimo lowerUTF8 + ilike pattern.
    whereParts.push(
      "positionCaseInsensitiveUTF8(speaker, {speaker:String}) > 0",
    );
    params.speaker = args.speaker;
  }
  if (args.min_upload_date) {
    // Robust workaround za @clickhouse/client param substitution issue:
    // toDate(<param>) i {param:Date} oba dali "no supertype for String, Date".
    // Lexicographic comparison na toString(upload_date) radi besprijekorno
    // jer YYYY-MM-DD format je sortable identično kao Date.
    whereParts.push("toString(upload_date) >= {min_date:String}");
    params.min_date = args.min_upload_date;
  }
  if (args.max_upload_date) {
    whereParts.push("toString(upload_date) <= {max_date:String}");
    params.max_date = args.max_upload_date;
  }
  if (!args.include_summaries) {
    // article_summary chunkovi nemaju timestamp i govornika — kad user
    // želi direktan citat, ovo isključi noise.
    whereParts.push("chunk_strategy NOT LIKE '%summary%'");
  }
  if (args.lexical_terms && args.lexical_terms.length > 0) {
    // hasToken koristi tokenbf_v1 INDEX idx_text_tokens (vidi infra/clickhouse/init.sql).
    // Bloom filter može imati false positive (vraća chunk koji možda nema token),
    // pa CH automatski dodaje exact check nakon indeksa — nema lažnih pozitivaca u rezultatu.
    args.lexical_terms.forEach((term, i) => {
      const key = `lex_${i}`;
      whereParts.push(`hasToken(text, {${key}:String})`);
      params[key] = term;
    });
  }
  return { whereParts, params };
}

export async function searchPodcasts(
  args: SearchPodcastsArgs,
  deps: { ch: ClickHouseClient; embedder: EmbedderClient },
): Promise<SearchResult[]> {
  const vector = await deps.embedder.embedOne(args.query);

  const { whereParts, params } = buildFilters(args);
  params.query_vec = vector;
  params.limit = args.limit;
  const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";

  const sql = `
    SELECT
      chunk_id,
      youtube_id,
      channel,
      toString(upload_date) AS upload_date,
      speaker,
      start_ts,
      end_ts,
      text,
      metadata,
      cosineDistance(embedding, {query_vec:Array(Float32)}) AS distance
    FROM rag_chunks
    ${whereClause}
    ORDER BY distance ASC
    LIMIT {limit:UInt32}
  `;

  const resultSet = await deps.ch.query({
    query: sql,
    query_params: params,
    format: "JSONEachRow",
  });
  const rows = (await resultSet.json()) as ChunkRow[];

  return rows.map((r) => {
    let episodeTitle: string | null = null;
    try {
      // ETL pohranjuje cijeli JSONL redak u `metadata`. Producer trenutno
      // koristi nested shape `{id, text, metadata: {title, ...}}`, ali stari
      // dokumentirani shape ima flat `episode_title` na top-levelu.
      const meta = JSON.parse(r.metadata) as {
        episode_title?: string;
        metadata?: { title?: string };
      };
      episodeTitle = meta.metadata?.title ?? meta.episode_title ?? null;
    } catch {
      // metadata nije validan JSON — proceed bez naslova
    }
    const speakers = r.speaker ? r.speaker.split(",").filter(Boolean) : [];
    const tSec = Math.max(0, Math.floor(r.start_ts));
    return {
      chunk_id: r.chunk_id,
      youtube_id: r.youtube_id,
      channel: r.channel,
      upload_date: r.upload_date,
      episode_title: episodeTitle,
      speakers,
      start_ts: r.start_ts,
      end_ts: r.end_ts,
      text: r.text,
      score: 1 - r.distance,
      deep_link: `https://domovina.ai/v/${r.youtube_id}/t/${tSec}`,
    };
  });
}


/** Jedan pogodak na mapi: epizoda, sekunda početka isječka, score. */
export interface MapHit {
  youtube_id: string;
  t: number;
  score: number;
}

/**
 * Retrieval za ucrtavanje upita u semantičku mapu korpusa.
 *
 * `t` MORA biti izračunat isto kao `t_sec` u `vector-map.bin`
 * (`domovina-rag/scripts/emit_vector_map.py`: `toUInt16(least(round(start_ts),
 * 65535))`), inače frontend ne može spojiti pogodak s točkom. Zato ovdje stoji
 * `round`, ne `floor` kao u `deep_link`-u tekstualne pretrage.
 *
 * `length(youtube_id) = 11` izbacuje junk orfane iz CH-a (isti filter kao
 * stats/vector-map producer) — takvi ionako nemaju točku na mapi.
 */
export async function searchMapPoints(
  args: SearchMapArgs,
  deps: { ch: ClickHouseClient; embedder: EmbedderClient },
): Promise<MapHit[]> {
  const vector = await deps.embedder.embedOne(args.query);

  const { whereParts, params } = buildFilters(args);
  whereParts.push("length(youtube_id) = 11");
  params.query_vec = vector;
  params.limit = args.limit;

  const sql = `
    SELECT
      youtube_id,
      least(toUInt32(round(start_ts)), 65535) AS t,
      cosineDistance(embedding, {query_vec:Array(Float32)}) AS distance
    FROM rag_chunks
    WHERE ${whereParts.join(" AND ")}
    ORDER BY distance ASC
    LIMIT {limit:UInt32}
  `;

  const resultSet = await deps.ch.query({
    query: sql,
    query_params: params,
    format: "JSONEachRow",
  });
  const rows = (await resultSet.json()) as { youtube_id: string; t: number; distance: number }[];

  return rows.map((r) => ({
    youtube_id: r.youtube_id,
    t: Number(r.t),
    score: 1 - r.distance,
  }));
}
