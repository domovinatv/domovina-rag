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


export const SearchPodcastsInput = z.object({
  query: z.string().min(2).max(500).describe("Tekstualni upit na hrvatskom"),
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
});

export type SearchPodcastsArgs = z.infer<typeof SearchPodcastsInput>;

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


export async function searchPodcasts(
  args: SearchPodcastsArgs,
  deps: { ch: ClickHouseClient; embedder: EmbedderClient },
): Promise<SearchResult[]> {
  const vector = await deps.embedder.embedOne(args.query);

  const params: Record<string, unknown> = {
    query_vec: vector,
    limit: args.limit,
  };
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
    // @clickhouse/client interpretira {param:Date} kao native Date type-mismatch
    // s upload_date kolonom u CH ("no supertype for String, Date"). Workaround:
    // šaljemo kao String i eksplicitno cast-amo toDate() u SQL-u.
    whereParts.push("upload_date >= toDate({min_date:String})");
    params.min_date = args.min_upload_date;
  }
  if (args.max_upload_date) {
    whereParts.push("upload_date <= toDate({max_date:String})");
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
