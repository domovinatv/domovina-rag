// find_in_transcript MCP tool — doslovna pretraga sirovog transkripta s TOČNOM
// sekundom (Meili index `segments`, 1 dok = 1 SRT segment).
//
// Komplementarno search_podcasts: ondje je jedinica poglavlje (vektorski poredak,
// limit ≤ 25, hasToken = točan token bez padeža). Ovdje je jedinica segment od
// nekoliko sekundi, unutar epizode se vraćaju SVI pogoci poredani po vremenu, a
// Meili tolerira ASR tipfelere i prefiks („Matij" → „Matijom").
//
// Test slučaj (plan docs/plans/2026-10-06-meili-segments-pretraga-transkripta.md):
//   find_in_transcript("Matija", youtube_id="35Oq01CmGWE") → 117 s i 1396 s.

import type { ClickHouseClient } from "@clickhouse/client";
import { z } from "zod";

import { meiliQuote, type MeiliClient } from "../meili.js";

const INDEX = "segments";
const HL_PRE = "**";
const HL_POST = "**";

export const FindInTranscriptInput = z.object({
  query: z
    .string()
    .min(2)
    .max(200)
    .describe(
      "Riječ, ime ili fraza kako je izgovorena. Fraza u dvostrukim navodnicima " +
        "(\"za vrijeme rata\") traži točan slijed riječi.",
    ),
  youtube_id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{11}$/, "YouTube ID ima 11 znakova")
    .optional()
    .describe("Samo unutar ove epizode — vraća SVE pogotke poredane po vremenu."),
  channel: z.string().optional().describe("Samo unutar ovog kanala (slug)."),
  speaker: z
    .string()
    .optional()
    .describe("Samo segmenti koje izgovara ovaj govornik (točno ime kao u get_episode)."),
  word_forms: z
    .preprocess(
      // z.coerce.boolean je Boolean(x) koji za string "false" vraća true.
      (v) => (v === "false" ? false : v === "true" ? true : v),
      z.boolean(),
    )
    .default(true)
    .describe(
      "Hrvatski padeži: zadnjoj riječi upita skini završne samoglasnike pa je traži " +
        "kao prefiks („Matija\" → „Matij\" pogađa i „Matijom\"). Isključi za točan oblik.",
    ),
  context: z
    .preprocess((v) => (v === "false" ? false : v === "true" ? true : v), z.boolean())
    .default(true)
    .describe("Dodaj prethodni i sljedeći segment uz svaki pogodak."),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Maks. pogodaka (default 100 unutar epizode, 20 inače)."),
});

export type FindInTranscriptArgs = z.infer<typeof FindInTranscriptInput>;

export const findInTranscriptJsonSchema = {
  type: "object" as const,
  properties: {
    query: {
      type: "string",
      minLength: 2,
      maxLength: 200,
      description:
        "Riječ, ime ili fraza kako je izgovorena. Fraza u dvostrukim navodnicima traži točan slijed.",
    },
    youtube_id: {
      type: "string",
      pattern: "^[A-Za-z0-9_-]{11}$",
      description: "Samo unutar ove epizode — SVI pogoci poredani po vremenu.",
    },
    channel: { type: "string", description: "Samo unutar ovog kanala (slug)." },
    speaker: {
      type: "string",
      description: "Samo segmenti koje izgovara ovaj govornik (točno ime).",
    },
    word_forms: {
      type: "boolean",
      default: true,
      description:
        "Zadnja riječ kao prefiks bez završnih samoglasnika (padeži). false = točan oblik.",
    },
    context: {
      type: "boolean",
      default: true,
      description: "Dodaj prethodni i sljedeći segment uz svaki pogodak.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 200,
      description: "Maks. pogodaka (default 100 unutar epizode, 20 inače).",
    },
  },
  required: ["query"],
};

interface SegmentDoc {
  youtube_id: string;
  channel: string;
  upload_date: string | null;
  seq: number;
  start_sec: number;
  end_sec: number;
  speaker: string | null;
  text: string;
}

export interface ContextSegment {
  timestamp: string;
  speaker: string | null;
  text: string;
}

export interface TranscriptHit {
  start_sec: number;
  end_sec: number;
  timestamp: string;
  speaker: string | null;
  /**
   * exact = svaka riječ upita je u segmentu doslovno (zadnja i kao prefiks);
   * typo = barem jedna je pogođena samo preko tolerancije tipfelera (ASR greška
   * ILI druga riječ: „Matij" → „Mati", „Matija" → „Marija").
   */
  match: "exact" | "typo";
  /** Tekst segmenta; pogođene riječi su u **…**. */
  text: string;
  deep_link: string;
  context_before?: ContextSegment;
  context_after?: ContextSegment;
}

export interface EpisodeHits {
  youtube_id: string;
  title: string | null;
  channel: string;
  upload_date: string | null;
  /** Ukupno pogodaka u epizodi (može biti više od broja u `hits`). */
  hits_in_episode: number;
  hits: TranscriptHit[];
}

export interface FindInTranscriptResult {
  query: string;
  /** Upit kako je stvarno poslan Meiliju (nakon word_forms). */
  effective_query: string;
  total_hits: number;
  /** Koliko od vraćenih pogodaka je `match: "exact"`. */
  exact_hits: number;
  episodes: EpisodeHits[];
}

/**
 * Zadnjoj riječi skini do dva završna samoglasnika (ostaje ≥ 4 slova). Meili
 * zadnju riječ upita ionako traži kao prefiks, pa „Matij" pogađa Matija/Matiju/
 * Matijom. Fraza u navodnicima ostaje netaknuta.
 */
export function toWordFormsQuery(query: string): string {
  const q = query.trim();
  if (q.includes('"')) return q;
  const words = q.split(/\s+/);
  let last = words[words.length - 1] ?? "";
  for (let i = 0; i < 2 && last.length > 4 && /[aeiou]$/i.test(last); i++) {
    last = last.slice(0, -1);
  }
  words[words.length - 1] = last;
  return words.join(" ");
}

const fold = (s: string): string =>
  s.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/gi, "d").toLowerCase();

/**
 * Je li segment pogođen doslovno? Meili označi pogođeni dio riječi (**Matij**a),
 * pa se oznaka proširi do cijele riječi i usporedi s riječima upita (bez
 * dijakritike, kao što i Meili normalizira). Zadnja riječ upita smije biti
 * prefiks — tako je Meili i traži.
 */
export function classifyMatch(query: string, highlighted: string): "exact" | "typo" {
  const terms = fold(query).replace(/"/g, " ").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (terms.length === 0) return "exact";
  const words: string[] = [];
  const re = new RegExp(`${escapeRe(HL_PRE)}(.+?)${escapeRe(HL_POST)}([\\p{L}\\p{N}]*)`, "gu");
  for (const m of highlighted.matchAll(re)) words.push(fold(`${m[1]}${m[2]}`));
  const isPhrase = query.includes('"');
  return terms.every((t, i) => {
    const prefixOk = !isPhrase && i === terms.length - 1;
    return words.some((w) => w === t || (prefixOk && w.startsWith(t)));
  })
    ? "exact"
    : "typo";
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function formatTimestamp(sec: number): string {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export async function findInTranscript(
  args: FindInTranscriptArgs,
  deps: { meili: MeiliClient; ch: ClickHouseClient },
): Promise<FindInTranscriptResult> {
  const effectiveQuery = args.word_forms ? toWordFormsQuery(args.query) : args.query.trim();
  const inEpisode = Boolean(args.youtube_id);
  const limit = args.limit ?? (inEpisode ? 100 : 20);

  const filters: string[] = [];
  if (args.youtube_id) filters.push(`youtube_id = ${meiliQuote(args.youtube_id)}`);
  if (args.channel) filters.push(`channel = ${meiliQuote(args.channel)}`);
  if (args.speaker) filters.push(`speaker = ${meiliQuote(args.speaker)}`);

  const res = await deps.meili.search<SegmentDoc>(INDEX, {
    q: effectiveQuery,
    filter: filters.length ? filters.join(" AND ") : undefined,
    // Unutar epizode: kronološki i iscrpno (page/hitsPerPage daje TOČAN totalHits).
    // Inače: Meili relevantnost + broj pogodaka po epizodi iz faceta.
    ...(inEpisode
      ? { sort: ["start_sec:asc"], hitsPerPage: limit, page: 1 }
      : { limit, facets: ["youtube_id"] }),
    // Sve riječi upita moraju biti u segmentu; default "last" bi ih odbacivao
    // s kraja i vraćao segmente bez traženog imena.
    matchingStrategy: "all",
    attributesToRetrieve: [
      "youtube_id", "channel", "upload_date", "seq", "start_sec", "end_sec", "speaker", "text",
    ],
    attributesToHighlight: ["text"],
    highlightPreTag: HL_PRE,
    highlightPostTag: HL_POST,
  });

  const docs = res.hits;
  const context = args.context && docs.length > 0 ? await fetchContext(docs, deps.meili) : null;
  const titles = await fetchTitles([...new Set(docs.map((d) => d.youtube_id))], deps.ch);
  const facet = res.facetDistribution?.youtube_id ?? {};

  const byEpisode = new Map<string, EpisodeHits>();
  for (const d of docs) {
    let ep = byEpisode.get(d.youtube_id);
    if (!ep) {
      ep = {
        youtube_id: d.youtube_id,
        title: titles.get(d.youtube_id) ?? null,
        channel: d.channel,
        upload_date: d.upload_date,
        hits_in_episode: inEpisode ? (res.totalHits ?? docs.length) : (facet[d.youtube_id] ?? 0),
        hits: [],
      };
      byEpisode.set(d.youtube_id, ep);
    }
    const text = d._formatted?.text ?? d.text;
    const hit: TranscriptHit = {
      start_sec: d.start_sec,
      end_sec: d.end_sec,
      timestamp: formatTimestamp(d.start_sec),
      speaker: d.speaker,
      match: classifyMatch(effectiveQuery, text),
      text,
      deep_link: `https://domovina.ai/v/${d.youtube_id}/t/${Math.floor(d.start_sec)}`,
    };
    if (context) {
      const before = context.get(`${d.youtube_id}_${d.seq - 1}`);
      const after = context.get(`${d.youtube_id}_${d.seq + 1}`);
      if (before) hit.context_before = before;
      if (after) hit.context_after = after;
    }
    ep.hits.push(hit);
  }

  const episodes = [...byEpisode.values()];
  return {
    query: args.query,
    effective_query: effectiveQuery,
    total_hits: inEpisode ? (res.totalHits ?? docs.length) : (res.estimatedTotalHits ?? docs.length),
    exact_hits: episodes.reduce((n, e) => n + e.hits.filter((h) => h.match === "exact").length, 0),
    episodes,
  };
}

/** Susjedni segmenti (seq ± 1) svih pogodaka u JEDNOM Meili upitu. */
async function fetchContext(
  docs: SegmentDoc[],
  meili: MeiliClient,
): Promise<Map<string, ContextSegment>> {
  const wanted = new Map<string, Set<number>>();
  for (const d of docs) {
    const s = wanted.get(d.youtube_id) ?? new Set<number>();
    s.add(d.seq - 1);
    s.add(d.seq + 1);
    wanted.set(d.youtube_id, s);
  }
  const clauses = [...wanted].map(
    ([yt, seqs]) => `(youtube_id = ${meiliQuote(yt)} AND seq IN [${[...seqs].join(", ")}])`,
  );
  const res = await meili.search<SegmentDoc>(INDEX, {
    q: "",
    filter: clauses.join(" OR "),
    limit: docs.length * 2,
    attributesToRetrieve: ["youtube_id", "seq", "start_sec", "speaker", "text"],
  });
  const out = new Map<string, ContextSegment>();
  for (const d of res.hits) {
    out.set(`${d.youtube_id}_${d.seq}`, {
      timestamp: formatTimestamp(d.start_sec),
      speaker: d.speaker,
      text: d.text,
    });
  }
  return out;
}

async function fetchTitles(ids: string[], ch: ClickHouseClient): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  // Naslov nije stupac nego polje u `metadata` JSON-u (isto kao list_episodes).
  const rs = await ch.query({
    query:
      "SELECT youtube_id, any(JSONExtractString(metadata, 'metadata', 'title')) AS title " +
      "FROM rag_chunks WHERE youtube_id IN {ids:Array(String)} GROUP BY youtube_id",
    query_params: { ids },
    format: "JSONEachRow",
  });
  const rows = (await rs.json()) as { youtube_id: string; title: string }[];
  return new Map(rows.filter((r) => r.title).map((r) => [r.youtube_id, r.title]));
}
