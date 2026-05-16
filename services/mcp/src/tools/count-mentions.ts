// count_mentions MCP tool — agregator za "u kojem kanalu / od kojeg govornika /
// u kojem mjesecu najviše X". Komplementarno search_podcasts (koji vraća pune
// chunkove): vraća samo brojeve, ne sadržaj — drastično manji payload.
//
// Use case-ovi koji prije zahtijevali search_podcasts(limit=50) + LLM-side
// brojanje (često prelazilo token budget):
//   - "U kojem kanalu se najviše govori o Međugorju?"
//   - "Tko najčešće spominje pobačaj?"
//   - "U kojem mjesecu je bilo najviše rasprava o EU?"

import type { ClickHouseClient } from "@clickhouse/client";
import { z } from "zod";

import type { EmbedderClient } from "../embedder.js";


export const CountMentionsInput = z.object({
  query: z
    .string()
    .min(2)
    .max(500)
    .describe("Semantic upit za pronalaženje relevantnih chunkova prije agregacije."),
  group_by: z
    .enum(["channel", "speaker", "month"])
    .describe(
      "Kriterij agregacije: channel (po kanalu), speaker (po govorniku), " +
        "month (po YYYY-MM mjesecu objave).",
    ),
  relevance_threshold: z
    .number()
    .min(0)
    .max(1)
    .default(0.4)
    .describe(
      "Cosine similarity prag (0-1, viši = stroži). Default 0.4 = relevantno. " +
        "Smanji za šira agregacija, povećaj za stroga match.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .describe("Maks. broj grupa u rezultatu (default 20)."),
  min_upload_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Format: YYYY-MM-DD")
    .optional()
    .describe("Filter: samo epizode objavljene >= datum."),
  max_upload_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Format: YYYY-MM-DD")
    .optional()
    .describe("Filter: samo epizode objavljene <= datum."),
  channel: z
    .string()
    .optional()
    .describe("Filter: samo unutar jednog kanala (korisno s group_by='speaker' ili 'month')."),
});

export type CountMentionsArgs = z.infer<typeof CountMentionsInput>;


export const countMentionsJsonSchema = {
  type: "object" as const,
  properties: {
    query: { type: "string", minLength: 2, maxLength: 500, description: "Semantic upit za relevantne chunkove." },
    group_by: {
      type: "string",
      enum: ["channel", "speaker", "month"],
      description: "Kriterij agregacije: channel, speaker, ili month (YYYY-MM).",
    },
    relevance_threshold: {
      type: "number",
      minimum: 0,
      maximum: 1,
      default: 0.4,
      description: "Cosine similarity prag (0-1). Default 0.4.",
    },
    limit: { type: "integer", minimum: 1, maximum: 50, default: 20, description: "Maks. grupa." },
    min_upload_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Objavljeno >= YYYY-MM-DD." },
    max_upload_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Objavljeno <= YYYY-MM-DD." },
    channel: { type: "string", description: "Filter na jedan kanal." },
  },
  required: ["query", "group_by"],
};


export interface MentionCount {
  group_value: string;
  mention_count: number;
  episode_count: number;
  earliest: string | null;
  latest: string | null;
  top_score: number;
}


interface AggregateRow {
  group_value: string;
  mention_count: string;
  episode_count: string;
  earliest: string;
  latest: string;
  top_score: number;
}


export async function countMentions(
  args: CountMentionsArgs,
  deps: { ch: ClickHouseClient; embedder: EmbedderClient },
): Promise<MentionCount[]> {
  const vector = await deps.embedder.embedOne(args.query);

  const params: Record<string, unknown> = {
    query_vec: vector,
    threshold: 1 - args.relevance_threshold, // CH koristi distance (manje = bolje); user threshold je similarity
    limit: args.limit,
  };

  const whereParts: string[] = [
    "cosineDistance(embedding, {query_vec:Array(Float32)}) <= {threshold:Float32}",
  ];
  if (args.channel) {
    whereParts.push("channel = {channel:String}");
    params.channel = args.channel;
  }
  if (args.min_upload_date) {
    whereParts.push("upload_date >= {min_date:Date}");
    params.min_date = args.min_upload_date;
  }
  if (args.max_upload_date) {
    whereParts.push("upload_date <= {max_date:Date}");
    params.max_date = args.max_upload_date;
  }

  // Group expression — speaker treba split jer kolona je comma-separated
  // ("Ante Čaljkušić,Dijana Brozović"). arrayJoin razbije svaki red u N redova,
  // po jedan po govorniku, pa se grupa radi po pojedincu.
  let groupExpr: string;
  let selectExtra: string;
  if (args.group_by === "speaker") {
    groupExpr = "arrayJoin(splitByChar(',', speaker))";
    selectExtra = `trim(BOTH ' ' FROM ${groupExpr}) AS group_value`;
  } else if (args.group_by === "month") {
    groupExpr = "formatDateTime(upload_date, '%Y-%m')";
    selectExtra = `${groupExpr} AS group_value`;
  } else {
    // channel
    groupExpr = "channel";
    selectExtra = "channel AS group_value";
  }

  const sql = `
    SELECT
      ${selectExtra},
      toString(count()) AS mention_count,
      toString(uniqExact(youtube_id)) AS episode_count,
      toString(min(upload_date)) AS earliest,
      toString(max(upload_date)) AS latest,
      1 - min(cosineDistance(embedding, {query_vec:Array(Float32)})) AS top_score
    FROM rag_chunks
    WHERE ${whereParts.join(" AND ")}
    GROUP BY group_value
    HAVING group_value != ''
    ORDER BY mention_count DESC
    LIMIT {limit:UInt32}
  `;

  const resultSet = await deps.ch.query({
    query: sql,
    query_params: params,
    format: "JSONEachRow",
  });
  const rows = (await resultSet.json()) as AggregateRow[];

  return rows.map((r) => ({
    group_value: r.group_value,
    mention_count: Number(r.mention_count),
    episode_count: Number(r.episode_count),
    earliest: r.earliest === "1970-01-01" ? null : r.earliest,
    latest: r.latest === "1970-01-01" ? null : r.latest,
    top_score: Number(r.top_score),
  }));
}
