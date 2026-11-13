// Testni dvojnici za ClickHouse, PG, Meili i embedder — bez mreže i bez živih servisa.

import type { ClickHouseClient } from "@clickhouse/client";
import type { Pool } from "pg";

import type { EmbedderClient } from "../../src/embedder.js";
import type { MeiliClient } from "../../src/meili.js";

export interface ChCall {
  query: string;
  query_params?: Record<string, unknown>;
}

/** CH dvojnik: bilježi upite, odgovor bira `respond` po tekstu SQL-a. */
export function fakeCh(respond: (sql: string) => unknown[] = () => []): {
  ch: ClickHouseClient;
  calls: ChCall[];
} {
  const calls: ChCall[] = [];
  const ch = {
    query: async (opts: ChCall) => {
      calls.push(opts);
      const rows = respond(opts.query);
      return { json: async () => rows };
    },
  } as unknown as ClickHouseClient;
  return { ch, calls };
}

/** PG dvojnik: odgovor bira `respond` po tekstu SQL-a. */
export function fakePg(respond: (sql: string) => unknown[] = () => []): Pool {
  return {
    query: async (sql: string) => ({ rows: respond(sql) }),
  } as unknown as Pool;
}

export function fakeEmbedder(): EmbedderClient {
  return { embedOne: async () => [0.1, 0.2, 0.3] } as unknown as EmbedderClient;
}

export function fakeMeili(): { meili: MeiliClient; calls: { index: string; params: Record<string, unknown> }[] } {
  const calls: { index: string; params: Record<string, unknown> }[] = [];
  const meili = {
    search: async (index: string, params: Record<string, unknown>) => {
      calls.push({ index, params });
      return { hits: [], facetDistribution: {}, totalHits: 0, estimatedTotalHits: 0 };
    },
  } as unknown as MeiliClient;
  return { meili, calls };
}

export const UC_A = "UCaaaaaaaaaaaaaaaaaaaaaa";
export const UC_B = "UCbbbbbbbbbbbbbbbbbbbbbb";
export const UC_C = "UCcccccccccccccccccccccc";

/** Lažni `fetch` koji vraća zadani JSON (ili baca/vraća status). */
export function fakeFetch(
  plan: () => { status?: number; body?: unknown; throws?: string },
): { fetchImpl: (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>; count: () => number } {
  let n = 0;
  return {
    fetchImpl: async () => {
      n++;
      const p = plan();
      if (p.throws) throw new Error(p.throws);
      const status = p.status ?? 200;
      return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(p.body) };
    },
    count: () => n,
  };
}
