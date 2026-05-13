// list_channels MCP tool — pregled svih kanala u korpusu.
//
// Agregat preko CH `rag_chunks`: vrati listu sortiranu po broju epizoda DESC.
// Korisno za LLM klijenta da zna koji slug-ovi su validni za `search_podcasts`
// `channel` filter argument.

import type { ClickHouseClient } from "@clickhouse/client";
import { z } from "zod";


export const ListChannelsInput = z.object({
  sort_by: z
    .enum(["episodes", "chunks", "channel"])
    .default("episodes")
    .describe("Kriterij sortiranja: episodes (default), chunks, channel (abecedno)"),
});

export type ListChannelsArgs = z.infer<typeof ListChannelsInput>;

export interface ChannelStats {
  channel: string;
  episodes: number;
  chunks: number;
  first_upload: string | null;
  latest_upload: string | null;
}


export const listChannelsJsonSchema = {
  type: "object" as const,
  properties: {
    sort_by: {
      type: "string",
      enum: ["episodes", "chunks", "channel"],
      default: "episodes",
      description: "Kriterij sortiranja (default: episodes)",
    },
  },
};


interface ChannelRow {
  channel: string;
  episodes: string;
  chunks: string;
  first_upload: string;
  latest_upload: string;
}


export async function listChannels(
  args: ListChannelsArgs,
  deps: { ch: ClickHouseClient },
): Promise<ChannelStats[]> {
  const orderBy =
    args.sort_by === "channel"
      ? "channel ASC"
      : args.sort_by === "chunks"
      ? "chunks DESC"
      : "episodes DESC";

  const sql = `
    SELECT
      channel,
      uniqExact(youtube_id) AS episodes,
      count() AS chunks,
      toString(min(upload_date)) AS first_upload,
      toString(max(upload_date)) AS latest_upload
    FROM rag_chunks
    GROUP BY channel
    ORDER BY ${orderBy}
  `;

  const resultSet = await deps.ch.query({
    query: sql,
    format: "JSONEachRow",
  });
  const rows = (await resultSet.json()) as ChannelRow[];

  return rows.map((r) => ({
    channel: r.channel,
    episodes: Number(r.episodes),
    chunks: Number(r.chunks),
    first_upload: r.first_upload === "1970-01-01" ? null : r.first_upload,
    latest_upload: r.latest_upload === "1970-01-01" ? null : r.latest_upload,
  }));
}
