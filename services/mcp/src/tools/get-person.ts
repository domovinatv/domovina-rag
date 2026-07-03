// get_person — "person hub": agregira SVE epizode u kojima jedna osoba GOVORI,
// cross-channel, iza stabilnog javnog slug-a (/p/don-tomislav-lukac).
//
// Identitet: PG `speakers` red (canonical_name + aliases[] sirovih CH tokena),
// popunjen `python -m etl speakers`. Granica: "govori" = diarizirani/imenovani
// speaker u rag_chunks.speaker — NE "spominje se u tekstu" (bez NER-a).
//
// Match je po CIJELIM tokenima (arrayExists … IN aliases), NE substring —
// kolona je comma-joined ("Ante Čaljkušić,Dijana Brozović"), pa naivni
// position() bi davao lažne substring pogotke.

import type { ClickHouseClient } from "@clickhouse/client";
import type { Pool } from "pg";
import { z } from "zod";


export const GetPersonInput = z.object({
  slug: z
    .string()
    .min(1)
    .max(120)
    .describe(
      "Javni slug osobe (ASCII-folded, npr. 'don-tomislav-lukac' ili " +
        "'zeljka-markic'). Isti slug koji koristi /p/{slug} ruta na frontendu.",
    ),
});

export type GetPersonArgs = z.infer<typeof GetPersonInput>;


export const getPersonJsonSchema = {
  type: "object" as const,
  properties: {
    slug: {
      type: "string",
      minLength: 1,
      maxLength: 120,
      description:
        "Javni slug osobe (ASCII-folded, npr. 'don-tomislav-lukac'). " +
        "Popis validnih slugova: list_episodes vraća imena govornika; " +
        "slug je ASCII-fold imena (č→c, ć→c, š→s, ž→z, đ→d, razmak→'-').",
    },
  },
  required: ["slug"],
};


// Bacamo je da CallTool/REST sloj mapiraju na 404 (a ne 500).
export class PersonNotFoundError extends Error {
  constructor(public readonly slug: string) {
    super(`Osoba sa slug-om '${slug}' nije pronađena`);
    this.name = "PersonNotFoundError";
  }
}


export interface PersonEpisode {
  youtube_id: string;
  title: string | null;
  channel: string;
  upload_date: string;
  first_ts: number; // najranija sekunda u kojoj osoba govori u epizodi
  deep_link: string;
}

// Epizoda u kojoj se osoba SPOMINJE (summary.mentioned_people) ali NE govori.
// `first_ts` = sekunda najranijeg spomena (article.json entity); 0 = nepoznato →
// deep_link pada na cijelu epizodu (/v/{id} bez /t/).
export interface PersonMention {
  youtube_id: string;
  title: string | null;
  channel: string;
  upload_date: string;
  first_ts: number;
  deep_link: string;
}

export interface PersonHub {
  name: string;
  slug: string;
  avatar_url: string | null;
  channel_count: number;
  episode_count: number;
  // count = broj epizoda u kojima osoba govori (na tom kanalu / u tom mjesecu)
  channels: { channel: string; count: number }[];
  episodes: PersonEpisode[];
  timeline: { month: string; count: number }[];
  // Epizode u kojima se osoba spominje ali ne govori (disjunktno od `episodes`).
  mentions: PersonMention[];
  mention_episode_count: number;
}


interface MentionRow {
  youtube_id: string;
  title: string | null;
  channel: string;
  upload_date: string;
  mention_ts: number | string; // pg vraća INT; može doći kao broj ili string
}


// Epizode u kojima se osoba SPOMINJE (person_mentions, izvedeno iz
// summary.mentioned_people). Isključi `excludeIds` (epizode u kojima GOVORI —
// govori ima prednost, ne dupliciramo). Sort: najnovije prvo, kao episodes[].
async function fetchMentions(
  pg: Pool,
  slug: string,
  excludeIds: Set<string>,
): Promise<PersonMention[]> {
  let rows: MentionRow[];
  try {
    const res = await pg.query<MentionRow>(
      `SELECT youtube_id, title, channel, to_char(upload_date, 'YYYY-MM-DD') AS upload_date,
              COALESCE(mention_ts, 0) AS mention_ts
       FROM person_mentions
       WHERE slug = $1
       ORDER BY upload_date DESC NULLS LAST, youtube_id`,
      [slug],
    );
    rows = res.rows;
  } catch {
    // person_mentions tablica možda još ne postoji (pre-migracija) → prazno,
    // ne ruši hub. Backward-compat.
    return [];
  }
  return rows
    .filter((r) => !excludeIds.has(r.youtube_id))
    .map((r) => {
      // mention_ts > 0 → seek na točan trenutak; inače cijela epizoda.
      const firstTs = Math.max(0, Math.round(Number(r.mention_ts) || 0));
      return {
        youtube_id: r.youtube_id,
        title: r.title,
        channel: r.channel,
        upload_date: r.upload_date,
        first_ts: firstTs,
        deep_link: firstTs > 0
          ? `https://domovina.ai/v/${r.youtube_id}/t/${firstTs}`
          : `https://domovina.ai/v/${r.youtube_id}`,
      };
    });
}


interface SpeakerRow {
  canonical_name: string;
  slug: string;
  avatar_url: string | null;
  aliases: string[];
}

interface EpisodeRow {
  youtube_id: string;
  channel: string;
  upload_date: string;
  first_ts: number;
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


export async function getPerson(
  args: GetPersonArgs,
  deps: { ch: ClickHouseClient; pg: Pool },
): Promise<PersonHub> {
  // 1. Slug → osoba (PG). Slug se lowercase-a jer je pohranjen lowercase.
  const { rows: speakerRows } = await deps.pg.query<SpeakerRow>(
    `SELECT canonical_name, slug, avatar_url, aliases
     FROM speakers
     WHERE slug = $1`,
    [args.slug.trim().toLowerCase()],
  );
  if (speakerRows.length === 0) {
    throw new PersonNotFoundError(args.slug);
  }
  const person = speakerRows[0]!;
  // aliases dolazi kao jsonb → već je JS array of string.
  const aliases = Array.isArray(person.aliases) ? person.aliases : [];
  if (aliases.length === 0) {
    // Osoba bez aliasa (ručni red bez CH povezivanja) → nema govora, ali može
    // imati spomene. Prazan govor-hub + eventualni mentions, ne crash.
    const mentions = await fetchMentions(deps.pg, person.slug, new Set());
    return {
      name: person.canonical_name,
      slug: person.slug,
      avatar_url: person.avatar_url,
      channel_count: 0,
      episode_count: 0,
      channels: [],
      episodes: [],
      timeline: [],
      mentions,
      mention_episode_count: mentions.length,
    };
  }

  // 2. CH: sve epizode u kojima je osoba JEDAN od comma-separated govornika.
  //    Whole-token match: split po zarezu, trim svaki, IN aliases[].
  const sql = `
    SELECT
      youtube_id,
      any(channel) AS channel,
      toString(any(upload_date)) AS upload_date,
      min(start_ts) AS first_ts,
      any(metadata) AS sample_metadata
    FROM rag_chunks
    WHERE arrayExists(
      x -> x IN {aliases:Array(String)},
      arrayMap(t -> trim(BOTH ' ' FROM t), splitByChar(',', speaker))
    )
    GROUP BY youtube_id
    ORDER BY upload_date DESC
    LIMIT 1000
  `;
  const resultSet = await deps.ch.query({
    query: sql,
    query_params: { aliases },
    format: "JSONEachRow",
  });
  const rows = (await resultSet.json()) as EpisodeRow[];

  const episodes: PersonEpisode[] = rows.map((r) => {
    const firstTs = Math.max(0, Math.round(Number(r.first_ts)));
    return {
      youtube_id: r.youtube_id,
      title: parseEpisodeTitle(r.sample_metadata),
      channel: r.channel,
      upload_date: r.upload_date,
      first_ts: firstTs,
      deep_link: `https://domovina.ai/v/${r.youtube_id}/t/${firstTs}`,
    };
  });

  // 3. channels[] + timeline[] agregirani u JS-u iz punog seta epizoda
  //    (max ~150 po osobi → jeftino, jedan CH round-trip).
  const channelCounts = new Map<string, number>();
  const monthCounts = new Map<string, number>();
  for (const ep of episodes) {
    channelCounts.set(ep.channel, (channelCounts.get(ep.channel) ?? 0) + 1);
    const month = ep.upload_date.slice(0, 7); // YYYY-MM
    if (/^\d{4}-\d{2}$/.test(month)) {
      monthCounts.set(month, (monthCounts.get(month) ?? 0) + 1);
    }
  }

  const channels = [...channelCounts.entries()]
    .map(([channel, count]) => ({ channel, count }))
    .sort((a, b) => b.count - a.count || a.channel.localeCompare(b.channel));

  const timeline = [...monthCounts.entries()]
    .map(([month, count]) => ({ month, count }))
    .sort((a, b) => a.month.localeCompare(b.month));

  // 4. Mentions: epizode gdje se osoba SPOMINJE ali NE govori. Izbaci sve
  //    youtube_id koji su već u episodes[] (govori ima prednost).
  const speakingIds = new Set(episodes.map((e) => e.youtube_id));
  const mentions = await fetchMentions(deps.pg, person.slug, speakingIds);

  return {
    name: person.canonical_name,
    slug: person.slug,
    avatar_url: person.avatar_url,
    channel_count: channels.length,
    episode_count: episodes.length,
    channels,
    episodes,
    timeline,
    mentions,
    mention_episode_count: mentions.length,
  };
}
