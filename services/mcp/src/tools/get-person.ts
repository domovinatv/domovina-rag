// get_person — "person hub": agregira SVE epizode u kojima se jedna osoba
// pojavljuje, cross-channel, iza stabilnog javnog slug-a (/p/don-tomislav-lukac).
//
// DVA IZVORA IDENTITETA (osoba postoji ako je bar jedan zadovoljen):
//   1. GOVORI — PG `speakers` red (canonical_name + aliases[] sirovih CH
//      tokena), popunjen `python -m etl speakers`; epizode iz CH rag_chunks.
//   2. SPOMINJE SE — PG `person_mentions` (derivat summary.mentioned_people).
//      Osoba koja nikad nije bila gost (povijesna, pokojna, javna figura o
//      kojoj se priča) ima SAMO ovo. Prije je takav slug vraćao 404 iako je
//      korpus pun spomena — vidi migrations/005 i docs/person-hub.md.
//
// Match govora je po CIJELIM tokenima (arrayExists … IN aliases), NE substring —
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
        "Javni slug osobe (ASCII-folded, npr. 'don-tomislav-lukac' ili " +
        "'ivan-merz'). Vrijedi i za osobe koje se samo SPOMINJU (nikad gost). " +
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

export interface CountBucket {
  channel: string;
  count: number;
}

export interface MonthBucket {
  month: string;
  count: number;
}

export interface PersonHub {
  name: string;
  slug: string;
  avatar_url: string | null;
  channel_count: number;
  episode_count: number;
  // count = broj epizoda u kojima osoba govori (na tom kanalu / u tom mjesecu)
  channels: CountBucket[];
  episodes: PersonEpisode[];
  timeline: MonthBucket[];
  // Epizode u kojima se osoba spominje ali ne govori (disjunktno od `episodes`).
  mentions: PersonMention[];
  mention_episode_count: number;
  // Iste agregacije, ali nad `mentions` — profil osobe koja NIKAD ne govori
  // (samo se spominje) inače nema ni raspodjelu po kanalima ni timeline.
  mention_channels: CountBucket[];
  mention_timeline: MonthBucket[];
}


interface MentionRow {
  youtube_id: string;
  title: string | null;
  channel: string;
  upload_date: string;
  mention_ts: number | string; // pg vraća INT; može doći kao broj ili string
  person_name: string | null; // migr. 005; NULL na bazi prije sljedećeg synca
}


// Sirovi person_mentions redovi za slug. Graceful degradation na dvije razine:
// bez `person_name` kolone (pre-005) → retry bez nje; bez tablice (pre-003) → [].
async function fetchMentionRows(pg: Pool, slug: string): Promise<MentionRow[]> {
  const base =
    `SELECT youtube_id, title, channel, to_char(upload_date, 'YYYY-MM-DD') AS upload_date,
            COALESCE(mention_ts, 0) AS mention_ts`;
  const tail =
    ` FROM person_mentions WHERE slug = $1 ORDER BY upload_date DESC NULLS LAST, youtube_id`;
  try {
    const res = await pg.query<MentionRow>(
      `${base}, person_name${tail}`,
      [slug],
    );
    return res.rows;
  } catch {
    // person_name kolona još ne postoji (migracija 005 nije primijenjena).
  }
  try {
    const res = await pg.query<Omit<MentionRow, "person_name">>(base + tail, [
      slug,
    ]);
    return res.rows.map((r) => ({ ...r, person_name: null }));
  } catch {
    // person_mentions tablica možda još ne postoji (pre-migracija) → prazno,
    // ne ruši hub. Backward-compat.
    return [];
  }
}


// Isključi `excludeIds` (epizode u kojima GOVORI — govori ima prednost, ne
// dupliciramo). Sort dolazi iz SQL-a: najnovije prvo, kao episodes[].
function toMentions(rows: MentionRow[], excludeIds: Set<string>): PersonMention[] {
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


// Display ime za osobu koja NEMA speakers red: najčešća `person_name` varijanta
// iz spomena (tie-break leksikografski, za determinizam — isti princip kao
// Person.recompute_canonical u etl/speakers.py).
function pickMentionName(rows: MentionRow[]): string | null {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const n = (r.person_name ?? "").trim();
    if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0]![0];
}


// Zadnji fallback za ime: "ivan-merz" → "Ivan Merz". Dijakritika je izgubljena
// u ASCII foldu, ali je bolje nego prazan naslov profila.
function titleizeSlug(slug: string): string {
  return slug
    .split("-")
    .filter((w) => w.length > 0)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}


// channels[] + timeline[] iz liste epizoda (govor ili spomen — ista agregacija).
function aggregate(
  items: { channel: string; upload_date: string }[],
): { channels: CountBucket[]; timeline: MonthBucket[] } {
  const channelCounts = new Map<string, number>();
  const monthCounts = new Map<string, number>();
  for (const it of items) {
    channelCounts.set(it.channel, (channelCounts.get(it.channel) ?? 0) + 1);
    const month = (it.upload_date ?? "").slice(0, 7); // YYYY-MM
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
  return { channels, timeline };
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
  const slug = args.slug.trim().toLowerCase();

  // 1. Slug → osoba (PG). Slug se lowercase-a jer je pohranjen lowercase.
  //    Spomene dohvaćamo UVIJEK i paralelno — oni su drugi izvor identiteta,
  //    pa i osoba bez speakers reda može imati profil.
  const [{ rows: speakerRows }, mentionRows] = await Promise.all([
    deps.pg.query<SpeakerRow>(
      `SELECT canonical_name, slug, avatar_url, aliases
       FROM speakers
       WHERE slug = $1`,
      [slug],
    ),
    fetchMentionRows(deps.pg, slug),
  ]);

  const person = speakerRows[0] ?? null;
  if (person === null && mentionRows.length === 0) {
    // Ni govori ni spominje se — tek tada je osoba stvarno nepoznata.
    throw new PersonNotFoundError(args.slug);
  }

  // aliases dolazi kao jsonb → već je JS array of string.
  const aliases = Array.isArray(person?.aliases) ? person!.aliases : [];
  if (aliases.length === 0) {
    // Nema diariziranog govora: ili osoba bez speakers reda (spominje se, nikad
    // nije bila gost), ili ručni speakers red bez CH povezivanja. U oba slučaja
    // hub se gradi SAMO iz spomena — prazan govor-dio, ne 404.
    const mentions = toMentions(mentionRows, new Set());
    const agg = aggregate(mentions);
    return {
      name: person?.canonical_name ||
        pickMentionName(mentionRows) ||
        titleizeSlug(slug),
      slug: person?.slug ?? slug,
      avatar_url: person?.avatar_url ?? null,
      channel_count: 0,
      episode_count: 0,
      channels: [],
      episodes: [],
      timeline: [],
      mentions,
      mention_episode_count: mentions.length,
      mention_channels: agg.channels,
      mention_timeline: agg.timeline,
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
  const { channels, timeline } = aggregate(episodes);

  // 4. Mentions: epizode gdje se osoba SPOMINJE ali NE govori. Izbaci sve
  //    youtube_id koji su već u episodes[] (govori ima prednost).
  const speakingIds = new Set(episodes.map((e) => e.youtube_id));
  const mentions = toMentions(mentionRows, speakingIds);
  const mentionAgg = aggregate(mentions);

  return {
    name: person!.canonical_name,
    slug: person!.slug,
    avatar_url: person!.avatar_url,
    channel_count: channels.length,
    episode_count: episodes.length,
    channels,
    episodes,
    timeline,
    mentions,
    mention_episode_count: mentions.length,
    mention_channels: mentionAgg.channels,
    mention_timeline: mentionAgg.timeline,
  };
}
