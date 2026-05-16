// list_episodes MCP tool — bulk pregled epizoda korpusa s metapodacima.
//
// Komplementarno search_podcasts (koji vraća chunkove) — vraća distinct
// epizode po youtube_id-u s aggregirаnim metricama (chunks count, speakers,
// duration). Use case: "tko sve gostuje u kanalu X", "najnovije epizode",
// "epizode iz svibnja 2026", browsing korpusa bez specifičnog upita.

import type { ClickHouseClient } from "@clickhouse/client";
import { z } from "zod";


export const ListEpisodesInput = z.object({
  channel: z
    .string()
    .optional()
    .describe("Filter na slug kanala (npr. 'ad_deum_podcast'). Ako nije zadan, sve epizode korpusa."),
  speaker: z
    .string()
    .min(2)
    .max(100)
    .optional()
    .describe(
      "Filter: samo epizode u kojima X stvarno govori. Case-insensitive partial match.",
    ),
  min_upload_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Format: YYYY-MM-DD")
    .optional()
    .describe("Filter: samo epizode objavljene >= ovom datumu (YYYY-MM-DD)."),
  max_upload_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Format: YYYY-MM-DD")
    .optional()
    .describe("Filter: samo epizode objavljene <= ovom datumu (YYYY-MM-DD)."),
  sort_by: z
    .enum(["upload_date_desc", "upload_date_asc", "chunks_desc", "duration_desc"])
    .default("upload_date_desc")
    .describe("Kriterij sortiranja (default: upload_date_desc = najnovije prvo)."),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Maks. broj epizoda (default 20, max 100)."),
});

export type ListEpisodesArgs = z.infer<typeof ListEpisodesInput>;


export const listEpisodesJsonSchema = {
  type: "object" as const,
  properties: {
    channel: {
      type: "string",
      description: "Filter na slug kanala (npr. 'ad_deum_podcast').",
    },
    speaker: {
      type: "string",
      minLength: 2,
      maxLength: 100,
      description: "Filter: epizode u kojima X stvarno govori. Case-insensitive partial match.",
    },
    min_upload_date: {
      type: "string",
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      description: "Filter: objavljeno >= YYYY-MM-DD.",
    },
    max_upload_date: {
      type: "string",
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      description: "Filter: objavljeno <= YYYY-MM-DD.",
    },
    sort_by: {
      type: "string",
      enum: ["upload_date_desc", "upload_date_asc", "chunks_desc", "duration_desc"],
      default: "upload_date_desc",
      description: "Kriterij sortiranja (default: upload_date_desc).",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      default: 20,
      description: "Maks. epizoda (default 20, max 100).",
    },
  },
};


export interface EpisodeSummary {
  youtube_id: string;
  channel: string;
  title: string | null;
  upload_date: string;
  duration_sec: number;
  speakers: string[];
  chunk_count: number;
  deep_link: string;
}


interface EpisodeRow {
  youtube_id: string;
  channel: string;
  upload_date: string;
  duration_sec: number;
  speakers: string[];
  chunk_count: string;
  sample_metadata: string;
}


function parseEpisodeTitle(raw: string): string | null {
  try {
    const m = JSON.parse(raw) as {
      episode_title?: string;
      metadata?: { title?: string };
    };
    return m.metadata?.title ?? m.episode_title ?? null;
  } catch {
    return null;
  }
}


export async function listEpisodes(
  args: ListEpisodesArgs,
  deps: { ch: ClickHouseClient },
): Promise<EpisodeSummary[]> {
  const params: Record<string, unknown> = {
    limit: args.limit,
  };
  const whereParts: string[] = [];
  if (args.channel) {
    whereParts.push("channel = {channel:String}");
    params.channel = args.channel;
  }
  if (args.speaker) {
    whereParts.push(
      "positionCaseInsensitiveUTF8(speaker, {speaker:String}) > 0",
    );
    params.speaker = args.speaker;
  }
  if (args.min_upload_date) {
    // Lexicographic comparison workaround — vidi search-podcasts.ts za detalje.
    whereParts.push("toString(upload_date) >= {min_date:String}");
    params.min_date = args.min_upload_date;
  }
  if (args.max_upload_date) {
    whereParts.push("toString(upload_date) <= {max_date:String}");
    params.max_date = args.max_upload_date;
  }
  const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";

  const orderBy =
    args.sort_by === "upload_date_asc"
      ? "upload_date ASC"
      : args.sort_by === "chunks_desc"
      ? "chunk_count DESC"
      : args.sort_by === "duration_desc"
      ? "duration_sec DESC"
      : "upload_date DESC";

  // Per-episode aggregat:
  //  - speakers: union svih speakera (split po comma, dedup, ne-prazni)
  //  - duration: max end_ts approximation
  //  - sample_metadata: any() za title parse — uzima random chunk metadata,
  //    bilo koji s episode_title će raditi
  const sql = `
    SELECT
      youtube_id,
      any(channel) AS channel,
      toString(any(upload_date)) AS upload_date,
      max(end_ts) AS duration_sec,
      arrayDistinct(arrayFilter(x -> x != '',
        arrayFlatten(groupArray(splitByChar(',', speaker))))) AS speakers,
      toString(count()) AS chunk_count,
      any(metadata) AS sample_metadata
    FROM rag_chunks
    ${whereClause}
    GROUP BY youtube_id
    ORDER BY ${orderBy}
    LIMIT {limit:UInt32}
  `;

  const resultSet = await deps.ch.query({
    query: sql,
    query_params: params,
    format: "JSONEachRow",
  });
  const rows = (await resultSet.json()) as EpisodeRow[];

  return rows.map((r) => ({
    youtube_id: r.youtube_id,
    channel: r.channel,
    title: parseEpisodeTitle(r.sample_metadata),
    upload_date: r.upload_date,
    duration_sec: r.duration_sec,
    speakers: r.speakers.map((s) => s.trim()).filter(Boolean).sort(),
    chunk_count: Number(r.chunk_count),
    deep_link: `https://domovina.ai/v/${r.youtube_id}`,
  }));
}
