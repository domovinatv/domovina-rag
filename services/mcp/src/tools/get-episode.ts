// get_episode MCP tool — vrati metapodatke + (po želji) transkript za 1 epizodu.
//
// Izvor: samo ClickHouse `rag_chunks`. Episode-level metadata (title, channel,
// upload_date, speakers) izvodi se iz chunk redaka. Title se parsa iz `metadata`
// JSON kolone (jednako kao u search_podcasts). Duration = MAX(end_ts).
//
// Truncation: za zaštitu LLM context window-a (Claude.ai default ~25k tokena =
// ~80K char), velike epizode bez `view_range`-a vrate metadata+chapters samo,
// transcript=null, truncated=true. Hard limit (200K char) raise-a domain grešku.
//
// Error mapping:
//   EPISODE_NOT_FOUND    — CH ne vraća chunkove za youtube_id
//   EPISODE_TOO_LARGE    — total char_count > hard limit (čak i s view_range)
//   VALIDATION_ERROR     — zod safeParse failuje (handled u server.ts)
//   STORAGE_ERROR        — CH query throwsa (handled u server.ts wrapper-u)

import type { ClickHouseClient } from "@clickhouse/client";
import { z } from "zod";


// Char-based limits; ~3-4 char/token za HR tekst, pa 80K ≈ 20-25K tokena.
// Tighter od brief-a (200K/500K) jer claude.ai default tool budget je ~25k tokena
// i veće responseve klijent silently truncira (gubitak metadata).
export const DEFAULT_SOFT_CHAR_LIMIT = 80_000;
export const DEFAULT_HARD_CHAR_LIMIT = 200_000;


export const GetEpisodeInput = z
  .object({
    youtube_id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{11}$/, "youtube_id mora biti 11-znakovni YouTube video ID")
      .describe("11-znakovni YouTube video ID (npr. '5J9GQ0sFe3M')"),
    include_transcript: z.coerce
      .boolean()
      .default(true)
      .describe(
        "Ako false, vrati samo metadata + chapters bez chunkova teksta. " +
          "Korisno kad treba samo pregled epizode (govornici, trajanje, naslov).",
      ),
    view_range: z
      .tuple([z.coerce.number().min(0), z.coerce.number().min(0)])
      .optional()
      .refine((r) => !r || r[0] < r[1], {
        message: "view_range: start mora biti < end (npr. [0, 600])",
      })
      .describe(
        "Filtriraj chunkove na [start_sec, end_sec] vremenski raspon. " +
          "Koristi za fokusirani pregled dijela duge epizode (npr. [0, 600] = " +
          "prvih 10 minuta). Bypassira soft limit, ali ne i hard.",
      ),
    chapter_index: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "1-based indeks u chapters[] (1 = prvo poglavlje). Konvenijencija nad " +
          "view_range — interno se resolvira na [chapter.start_ts, chapter.end_ts]. " +
          "Mutually exclusive s view_range. Workflow: prvo pozvati include_transcript=false " +
          "da vidiš chapters, pa pozvati opet s chapter_index=N.",
      ),
  })
  .refine((d) => !(d.view_range && d.chapter_index !== undefined), {
    message: "view_range i chapter_index su međusobno isključivi",
  });

export type GetEpisodeArgs = z.infer<typeof GetEpisodeInput>;


export const getEpisodeJsonSchema = {
  type: "object" as const,
  properties: {
    youtube_id: {
      type: "string",
      pattern: "^[A-Za-z0-9_-]{11}$",
      description: "11-znakovni YouTube video ID (npr. '5J9GQ0sFe3M')",
    },
    include_transcript: {
      type: "boolean",
      default: true,
      description:
        "Ako false, vrati samo metadata + chapters bez teksta chunkova.",
    },
    view_range: {
      type: "array",
      items: { type: "number", minimum: 0 },
      minItems: 2,
      maxItems: 2,
      description:
        "Filtriraj chunkove na [start_sec, end_sec] raspon. Bypassira soft limit. " +
        "Mutually exclusive s chapter_index.",
    },
    chapter_index: {
      type: "integer",
      minimum: 1,
      description:
        "1-based indeks u chapters[] (npr. 1 = prvo poglavlje). Interno se resolvira " +
        "u view_range. Mutually exclusive s view_range. Workflow: prvo include_transcript=false " +
        "da dohvatiš chapters listu, pa pozovi opet s chapter_index=N.",
    },
  },
  required: ["youtube_id"],
};


export interface ChapterInfo {
  outline_iteration: number | null;
  theme: string | null;
  start_ts: number;
  end_ts: number;
  summary_snippet: string | null;
  char_count: number;
}

export interface TranscriptChunk {
  chunk_id: string;
  chunk_index: number;
  chunk_strategy: string;
  speakers: string[];
  start_ts: number;
  end_ts: number;
  text: string;
}

export interface EpisodeMetadata {
  youtube_id: string;
  channel: string;
  title: string | null;
  upload_date: string;
  duration_sec: number;
  speakers: string[];
  chunk_count: number;
  total_char_count: number;
  deep_link: string;
}

export interface GetEpisodeResult {
  metadata: EpisodeMetadata;
  chapters: ChapterInfo[];
  transcript: TranscriptChunk[] | null;
  truncated: boolean;
  truncation_reason: string | null;
  stats: {
    returned_chunks: number;
    total_chunks: number;
    returned_chars: number;
    total_chars: number;
    time_range: [number, number] | null;
  };
}


// Domain greška — server.ts wrapper je hvata i pretvara u MCP isError response.
export class GetEpisodeError extends Error {
  constructor(
    public code: "EPISODE_NOT_FOUND" | "EPISODE_TOO_LARGE" | "STORAGE_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "GetEpisodeError";
  }
}


interface ChunkRow {
  chunk_id: string;
  chunk_index: number;
  chunk_strategy: string;
  youtube_id: string;
  channel: string;
  upload_date: string;
  speaker: string;
  start_ts: number;
  end_ts: number;
  text: string;
  text_summary: string;
  metadata: string;
}


function parseChunkMetadata(raw: string): {
  episodeTitle: string | null;
  outlineIteration: number | null;
  outlineTheme: string | null;
  summarySnippet: string | null;
} {
  try {
    // ETL pohranjuje cijeli JSONL redak. Nested shape: {id, text, metadata:{...}}.
    // Stari flat shape je dokumentiran u data_contract-u ali producer ga ne emit-a.
    const m = JSON.parse(raw) as {
      episode_title?: string;
      outline_iteration?: number;
      outline_theme?: string;
      summary_snippet?: string;
      metadata?: {
        title?: string;
        outline_iteration?: number;
        outline_theme?: string;
        summary_snippet?: string;
      };
    };
    const inner = m.metadata ?? {};
    return {
      episodeTitle: inner.title ?? m.episode_title ?? null,
      outlineIteration: inner.outline_iteration ?? m.outline_iteration ?? null,
      outlineTheme: inner.outline_theme ?? m.outline_theme ?? null,
      summarySnippet: inner.summary_snippet ?? m.summary_snippet ?? null,
    };
  } catch {
    return {
      episodeTitle: null,
      outlineIteration: null,
      outlineTheme: null,
      summarySnippet: null,
    };
  }
}


export async function getEpisode(
  args: GetEpisodeArgs,
  deps: {
    ch: ClickHouseClient;
    softCharLimit?: number;
    hardCharLimit?: number;
  },
): Promise<GetEpisodeResult> {
  const softLimit = deps.softCharLimit ?? DEFAULT_SOFT_CHAR_LIMIT;
  const hardLimit = deps.hardCharLimit ?? DEFAULT_HARD_CHAR_LIMIT;

  let rows: ChunkRow[];
  try {
    const resultSet = await deps.ch.query({
      query: `
        SELECT
          chunk_id,
          chunk_index,
          chunk_strategy,
          youtube_id,
          channel,
          toString(upload_date) AS upload_date,
          speaker,
          start_ts,
          end_ts,
          text,
          text_summary,
          metadata
        FROM rag_chunks
        WHERE youtube_id = {yt:String}
        ORDER BY chunk_index ASC
      `,
      query_params: { yt: args.youtube_id },
      format: "JSONEachRow",
    });
    rows = (await resultSet.json()) as ChunkRow[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new GetEpisodeError("STORAGE_ERROR", `ClickHouse query failed: ${msg}`);
  }

  if (rows.length === 0) {
    throw new GetEpisodeError(
      "EPISODE_NOT_FOUND",
      `Epizoda s youtube_id='${args.youtube_id}' ne postoji u korpusu.`,
    );
  }

  // ─── Episode-level metadata iz prvog ne-praznog title parse-a ─────────
  let episodeTitle: string | null = null;
  for (const row of rows) {
    const parsed = parseChunkMetadata(row.metadata);
    if (parsed.episodeTitle) {
      episodeTitle = parsed.episodeTitle;
      break;
    }
  }

  const firstRow = rows[0]!;
  const speakersSet = new Set<string>();
  for (const row of rows) {
    if (!row.speaker) continue;
    for (const s of row.speaker.split(",")) {
      const trimmed = s.trim();
      if (trimmed) speakersSet.add(trimmed);
    }
  }

  const totalChars = rows.reduce((sum, r) => sum + r.text.length, 0);
  // Duration = max end_ts across chunks (summary chunks s start_ts=0 ne kvare ovo).
  const durationSec = rows.reduce((max, r) => Math.max(max, r.end_ts), 0);

  // ─── Chapters (topic/outline chunks s validnim timestamp-om) ──────────
  // Producer u produkciji emit-a `topic_transcript` chunkove (svaki = jedna
  // tema u epizodi), ne uvijek `outline`. Oba služe kao chapter marker.
  // Summary chunkovi (start=end=0) NISU chapters — to su AI-generirani
  // article summary-ji bez vremenske pozicije.
  const isChapterStrategy = (s: string): boolean =>
    s === "outline" || s.startsWith("topic");
  const hasValidTimestamp = (r: ChunkRow): boolean =>
    !(r.start_ts === 0 && r.end_ts === 0);
  const chapters: ChapterInfo[] = rows
    .filter((r) => isChapterStrategy(r.chunk_strategy) && hasValidTimestamp(r))
    .map((r) => {
      const meta = parseChunkMetadata(r.metadata);
      // Theme fallback: ako metadata nema outline_theme, parse "Tema: <X>"
      // prefix iz text-a (standardni format topic_transcript chunkova).
      let theme = meta.outlineTheme;
      if (!theme) {
        const match = /^Tema:\s*([^\n]+)/.exec(r.text);
        theme = match?.[1]?.trim() ?? null;
      }
      return {
        outline_iteration: meta.outlineIteration,
        theme,
        start_ts: r.start_ts,
        end_ts: r.end_ts,
        summary_snippet: meta.summarySnippet ?? (r.text_summary || null),
        char_count: r.text.length,
      };
    })
    .sort((a, b) => a.start_ts - b.start_ts);

  // ─── Resolve chapter_index → view_range (Sprint 2) ──────────────────
  // chapter_index je conveniance — interno se mapira na [chapter.start_ts,
  // chapter.end_ts]. Zod refine je već garantirao mutual exclusion s view_range.
  let effectiveViewRange: [number, number] | undefined = args.view_range;
  if (args.chapter_index !== undefined) {
    if (chapters.length === 0) {
      throw new GetEpisodeError(
        "EPISODE_TOO_LARGE",  // reuse — nije strict TOO_LARGE ali je client-friendly
        `Epizoda nema chapters (možda samo article_summary chunkovi). chapter_index ne može se resolvirati.`,
      );
    }
    if (args.chapter_index > chapters.length) {
      throw new GetEpisodeError(
        "EPISODE_TOO_LARGE",
        `chapter_index ${args.chapter_index} je izvan raspona (epizoda ima ${chapters.length} chapters; valid: 1-${chapters.length}).`,
      );
    }
    const ch = chapters[args.chapter_index - 1]!;
    effectiveViewRange = [ch.start_ts, ch.end_ts];
  }

  // ─── Filter za view_range ────────────────────────────────────────────
  // Overlap test: chunk je u rasponu ako se njegov [start, end] presijeca s
  // [view_start, view_end]. Strikni "fully inside" bi bio pre-restriktivan jer
  // outline chunkovi često pokrivaju cijelu epizodu.
  //
  // Untimestamped chunkovi (start=end=0, tipično `article_summary`) NE prolaze
  // view_range filter — oni su episode-level summary bez vremenske pozicije,
  // pa "spadaju u svaki view_range koji uključuje 0" čisto matematički, ali
  // semantički ne — user koji traži [0, 600] ne želi summary cijele epizode.
  let filteredRows = rows;
  let timeRange: [number, number] | null = null;
  if (effectiveViewRange) {
    const [viewStart, viewEnd] = effectiveViewRange;
    filteredRows = rows.filter(
      (r) =>
        hasValidTimestamp(r) &&
        r.end_ts >= viewStart &&
        r.start_ts <= viewEnd,
    );
    timeRange = [viewStart, viewEnd];
  }

  const filteredChars = filteredRows.reduce((sum, r) => sum + r.text.length, 0);

  // ─── Hard limit check — vrijedi UVIJEK, čak i s view_range ───────────
  if (filteredChars > hardLimit) {
    const hint = effectiveViewRange
      ? `suzi view_range (trenutni: [${effectiveViewRange[0]}, ${effectiveViewRange[1]}], chars: ${filteredChars})`
      : `koristi view_range=[start_sec, end_sec] ili chapter_index da dohvatiš samo dio epizode (ukupno ${filteredChars} char preko hard limita ${hardLimit})`;
    throw new GetEpisodeError(
      "EPISODE_TOO_LARGE",
      `Transkript prelazi hard limit ${hardLimit} char (filtrirano: ${filteredChars}). ${hint}`,
    );
  }

  // ─── Soft limit — vrati metadata+chapters, transcript=null ───────────
  // Soft vrijedi SAMO kad nema view_range-a (view_range = eksplicitna namjera).
  // chapter_index → effectiveViewRange == eksplicitna namjera isto.
  const includeTranscript = args.include_transcript;
  let transcript: TranscriptChunk[] | null = null;
  let truncated = false;
  let truncationReason: string | null = null;

  if (!includeTranscript) {
    transcript = null;
    truncationReason = "include_transcript=false";
  } else if (!effectiveViewRange && filteredChars > softLimit) {
    transcript = null;
    truncated = true;
    truncationReason =
      `Transkript prelazi soft limit ${softLimit} char (ukupno: ${filteredChars}). ` +
      `Pozovi opet s view_range=[start_sec, end_sec] ili chapter_index=N da dohvatiš ` +
      `dio epizode (npr. [0, 600] = prvih 10 min, ili chapter_index=1 za prvo poglavlje). ` +
      `Trajanje epizode: ${Math.round(durationSec)}s. Dostupno chapters: ${chapters.length}.`;
  } else {
    transcript = filteredRows.map((r) => ({
      chunk_id: r.chunk_id,
      chunk_index: r.chunk_index,
      chunk_strategy: r.chunk_strategy,
      speakers: r.speaker ? r.speaker.split(",").filter(Boolean) : [],
      start_ts: r.start_ts,
      end_ts: r.end_ts,
      text: r.text,
    }));
  }

  return {
    metadata: {
      youtube_id: args.youtube_id,
      channel: firstRow.channel,
      title: episodeTitle,
      upload_date: firstRow.upload_date,
      duration_sec: durationSec,
      speakers: Array.from(speakersSet).sort(),
      chunk_count: rows.length,
      total_char_count: totalChars,
      deep_link: `https://domovina.ai/v/${args.youtube_id}`,
    },
    chapters,
    transcript,
    truncated,
    truncation_reason: truncationReason,
    stats: {
      returned_chunks: transcript?.length ?? 0,
      total_chunks: rows.length,
      returned_chars: transcript
        ? transcript.reduce((sum, c) => sum + c.text.length, 0)
        : 0,
      total_chars: totalChars,
      time_range: timeRange,
    },
  };
}
