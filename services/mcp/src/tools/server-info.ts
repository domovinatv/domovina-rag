// server_info MCP tool — rich metadata o MCP servisu i stanju korpusa.
//
// Komplementarno standardnom `serverInfo` Implementation objektu koji emitiramo
// kroz MCP `initialize` handshake. Ovo daje LIVE dataset statistiku i build
// info-e koji nisu u static Implementation-u.
//
// Use case-ovi:
//   - "Koja je verzija MCP-a?" — version + build info
//   - "Koliko je svjež korpus?" — earliest/latest_upload + chunk counts
//   - "Koji tool-ovi postoje?" — runtime introspection (umjesto handshake-a)
//   - Debug i troubleshooting — git SHA, build date

import type { ClickHouseClient } from "@clickhouse/client";
import { z } from "zod";


export const ServerInfoInput = z.object({});

export type ServerInfoArgs = z.infer<typeof ServerInfoInput>;


export const serverInfoJsonSchema = {
  type: "object" as const,
  properties: {},
};


export interface DatasetStats {
  channels: number;
  episodes: number;
  chunks: number;
  earliest_upload: string | null;
  latest_upload: string | null;
}

export interface ServerInfo {
  service: string;
  version: string;
  build_sha: string | null;
  build_date: string | null;
  public_base_url: string;
  dataset: DatasetStats;
  tools: string[];
}


interface StatsRow {
  channels: string;
  episodes: string;
  chunks: string;
  earliest_upload: string;
  latest_upload: string;
}


export async function getServerInfo(
  _args: ServerInfoArgs,
  deps: {
    ch: ClickHouseClient;
    serviceName: string;
    serviceVersion: string;
    publicBaseUrl: string;
    toolNames: string[];
  },
): Promise<ServerInfo> {
  // Dataset stats — single aggregat query nad rag_chunks. Korpus se ne mijenja
  // često (ingest je batch), pa potencijalno cache-iranje je za buduće
  // sprintove — trenutno full query je jeftin (~ms na 121K redova).
  let dataset: DatasetStats = {
    channels: 0,
    episodes: 0,
    chunks: 0,
    earliest_upload: null,
    latest_upload: null,
  };
  try {
    const resultSet = await deps.ch.query({
      query: `
        SELECT
          toString(uniqExact(channel)) AS channels,
          toString(uniqExact(youtube_id)) AS episodes,
          toString(count()) AS chunks,
          toString(min(upload_date)) AS earliest_upload,
          toString(max(upload_date)) AS latest_upload
        FROM rag_chunks
      `,
      format: "JSONEachRow",
    });
    const rows = (await resultSet.json()) as StatsRow[];
    if (rows.length > 0) {
      const r = rows[0]!;
      dataset = {
        channels: Number(r.channels),
        episodes: Number(r.episodes),
        chunks: Number(r.chunks),
        // CH vrati '1970-01-01' za empty table — translate u null
        earliest_upload: r.earliest_upload === "1970-01-01" ? null : r.earliest_upload,
        latest_upload: r.latest_upload === "1970-01-01" ? null : r.latest_upload,
      };
    }
  } catch {
    // Graceful degrade: ako CH nije dostupan, vrati ostatak info-a sa zero dataset.
  }

  return {
    service: deps.serviceName,
    version: deps.serviceVersion,
    // Build metadata se injectiraju kao env vars u Dockerfile/Coolify. Ako
    // nisu set, null — nije strict requirement.
    build_sha: process.env.BUILD_SHA || null,
    build_date: process.env.BUILD_DATE || null,
    public_base_url: deps.publicBaseUrl,
    dataset,
    tools: deps.toolNames,
  };
}
