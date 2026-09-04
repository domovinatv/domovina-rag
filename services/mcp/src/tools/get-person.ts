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

import {
  classifyTier,
  judgeVirtualChannel,
  loadTrackedChannels,
} from "./person-channel.js";


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
  // ─── Virtualni kanali (aditivno; stari klijenti ova polja ignoriraju) ───
  // Ime i UC id izvornog kanala + je li praćen. Praćen kanal ima /c/<slug>
  // stranicu pa chip smije biti klikabilan; ad-hoc izvor (N1, Lider) nema.
  channel_name: string;
  channel_youtube_id: string | null;
  channel_tracked: boolean;
  duration_seconds: number | null;
  speaking_seconds: number | null;
  speaking_share: number | null;
  tier: "primary" | "cameo";
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
  // ─── Virtualni kanali (aditivno) ────────────────────────────────────────
  // Smije li se profil prikazati u kanal-formi. Frontend uz ovo traži i svoj
  // PersonChannelFlag, pa `true` ovdje ne znači da je korisnik nešto vidio.
  is_virtual_channel: boolean;
  // Jedan slug pokriva više različitih osoba (preklapajući aliasi) — kanal-forma
  // se tada NE aktivira, jer bi tuđi nastupi bili pripisani jednoj osobi.
  ambiguous: boolean;
  // Osoba je tražila uklanjanje (O8). Frontend crta minimalni profil.
  optout: boolean;
  // `cameo` nastupi žive odvojeno da hero brojka ostane poštena.
  cameo_episodes: PersonEpisode[];
  cameo_episode_count: number;
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


// ─── Kuracija: overrides + opt-out (migracija 006) ──────────────────────────
//
// Obje tablice su tombstone i obje su OPCIONALNE: dok migracija 006 nije
// primijenjena, upiti padnu i vraćamo prazno stanje umjesto 500. Isti obrazac
// kao fetchMentionRows za pre-003 baze — endpoint mora raditi na svakoj bazi
// koja je ikad bila u produkciji.

interface PersonCuration {
  excluded: Set<string>;      // youtube_id koje je čovjek maknuo iz kanala
  forcedPrimary: Set<string>; // youtube_id koje je čovjek vratio u primary
  optedOut: boolean;
}

const EMPTY_CURATION: PersonCuration = {
  excluded: new Set(),
  forcedPrimary: new Set(),
  optedOut: false,
};

async function fetchCuration(pg: Pool, slug: string): Promise<PersonCuration> {
  const [overrides, optouts] = await Promise.all([
    pg
      .query<{ youtube_id: string; action: string }>(
        `SELECT youtube_id, action FROM person_channel_overrides
         WHERE slug = $1 AND confirmed`,
        [slug],
      )
      .then((r) => r.rows)
      .catch(() => []),
    pg
      .query<{ slug: string }>(`SELECT slug FROM person_optouts WHERE slug = $1`, [slug])
      .then((r) => r.rows)
      .catch(() => []),
  ]);

  const excluded = new Set<string>();
  const forcedPrimary = new Set<string>();
  for (const o of overrides) {
    if (o.action === "exclude") excluded.add(o.youtube_id);
    else if (o.action === "force_primary") forcedPrimary.add(o.youtube_id);
  }
  return { excluded, forcedPrimary, optedOut: optouts.length > 0 };
}


// Dijeli li ijedan alias ove osobe s nekom DRUGOM osobom? Ako da, CH upit
// (koji matcha po aliasima) skuplja nastupe više ljudi pod jedan slug i
// kanal-forma se ne smije aktivirati — brojka „6 epizoda" bila bi zbroj dvoje
// ljudi. Danas ne postoji nijedno preklapanje; provjera je ograda za budući
// `python -m etl speakers` koji ga stvori.
async function isAmbiguous(pg: Pool, slug: string, aliases: string[]): Promise<boolean> {
  if (aliases.length === 0) return false;
  try {
    const res = await pg.query<{ n: string }>(
      `SELECT count(*) AS n
         FROM speakers s, jsonb_array_elements_text(s.aliases) AS a
        WHERE s.slug <> $1 AND a = ANY($2::text[])`,
      [slug, aliases],
    );
    return Number(res.rows[0]?.n ?? 0) > 0;
  } catch {
    return false;
  }
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
  duration_seconds: number | string;
  speaking_seconds: number | string;
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
  const [{ rows: speakerRows }, mentionRows, curation] = await Promise.all([
    deps.pg.query<SpeakerRow>(
      `SELECT canonical_name, slug, avatar_url, aliases
       FROM speakers
       WHERE slug = $1`,
      [slug],
    ),
    fetchMentionRows(deps.pg, slug),
    // Opt-out se čita UVIJEK, i za osobu koja se samo spominje: pravo na
    // uklanjanje ne ovisi o tome je li osoba ikad govorila.
    fetchCuration(deps.pg, slug).catch(() => EMPTY_CURATION),
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
      // Bez ijedne epizode u kojoj GOVORI nema kanala: kanal je sadržaj OD
      // osobe, spomen je sadržaj O osobi (O3). Profil ostaje, kanal-forma ne.
      is_virtual_channel: false,
      ambiguous: false,
      optout: curation.optedOut,
      cameo_episodes: [],
      cameo_episode_count: 0,
    };
  }

  // 2. CH: sve epizode u kojima je osoba JEDAN od comma-separated govornika.
  //    Whole-token match: split po zarezu, trim svaki, IN aliases[].
  // `duration_seconds` = max(end_ts): epizoda traje barem do kraja zadnjeg
  // chunka. PG `episodes.duration_sec` je 0 za većinu redaka, a cloud PG tu
  // tablicu uopće nema — chunkovi su jedini izvor koji postoji svugdje.
  //
  // `speaking_seconds` dijeli trajanje chunka s BROJEM govornika u njemu.
  // `speaker` je comma-joined ("Ante Čaljkušić,Dijana Brozović"), pa bi naivni
  // sum(end_ts - start_ts) pripisao svakom govorniku puno trajanje zajedničkog
  // chunka i napuhao udio u panelima — točno ono na što je tier prag od 15 %
  // najosjetljiviji. Podjela nije egzaktna kao per-cue diarizirani SRT, ali je
  // nepristrana i ne traži novi ingest.
  const sql = `
    SELECT
      youtube_id,
      any(channel) AS channel,
      toString(any(upload_date)) AS upload_date,
      -- minIf, NE min: WHERE sada hvata SVE chunkove epizode (treba za
      -- max(end_ts)), pa bi goli min() vratio početak epizode umjesto trenutka
      -- u kojem osoba prvi put progovori — i deep link bi vodio na tuđi uvod.
      minIf(start_ts, arrayExists(
        x -> x IN {aliases:Array(String)},
        arrayMap(t -> trim(BOTH ' ' FROM t), splitByChar(',', speaker))
      )) AS first_ts,
      round(max(end_ts)) AS duration_seconds,
      round(sumIf(
        (end_ts - start_ts) / length(splitByChar(',', speaker)),
        arrayExists(
          x -> x IN {aliases:Array(String)},
          arrayMap(t -> trim(BOTH ' ' FROM t), splitByChar(',', speaker))
        )
      )) AS speaking_seconds,
      any(metadata) AS sample_metadata
    FROM rag_chunks
    WHERE youtube_id IN (
      SELECT youtube_id FROM rag_chunks
      WHERE arrayExists(
        x -> x IN {aliases:Array(String)},
        arrayMap(t -> trim(BOTH ' ' FROM t), splitByChar(',', speaker))
      )
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

  const [tracked, ambiguous] = await Promise.all([
    loadTrackedChannels(),
    isAmbiguous(deps.pg, slug, aliases),
  ]);

  const allEpisodes: PersonEpisode[] = rows
    // `exclude` override je ručna ispravka lažne atribucije — epizoda ispada iz
    // kanala potpuno, i iz brojki. /v/{id} ostaje, to je javni YouTube video.
    .filter((r) => !curation.excluded.has(r.youtube_id))
    .map((r) => {
      const firstTs = Math.max(0, Math.round(Number(r.first_ts)));
      const durationSeconds = Math.max(0, Math.round(Number(r.duration_seconds) || 0)) || null;
      const speakingSeconds = Math.max(0, Math.round(Number(r.speaking_seconds) || 0)) || null;
      const ch = tracked.get(r.channel);
      const tier = curation.forcedPrimary.has(r.youtube_id)
        ? ("primary" as const)
        : classifyTier(speakingSeconds, durationSeconds);
      return {
        youtube_id: r.youtube_id,
        title: parseEpisodeTitle(r.sample_metadata),
        channel: r.channel,
        upload_date: r.upload_date,
        first_ts: firstTs,
        deep_link: `https://domovina.ai/v/${r.youtube_id}/t/${firstTs}`,
        channel_name: ch?.name ?? r.channel,
        channel_youtube_id: ch?.youtubeChannelId ?? null,
        channel_tracked: ch !== undefined,
        duration_seconds: durationSeconds,
        speaking_seconds: speakingSeconds,
        speaking_share:
          durationSeconds !== null && speakingSeconds !== null && durationSeconds > 0
            ? Math.round((speakingSeconds / durationSeconds) * 1000) / 1000
            : null,
        tier,
      };
    });

  // `episodes[]` ostaje ono što je i bilo — glavni nastupi. Cameo ide u zaseban
  // popis da `episode_count` (hero brojka, kartica u katalogu) ne tvrdi nastup
  // ondje gdje je osoba rekla dvije rečenice u panelu od dva sata.
  const episodes = allEpisodes.filter((e) => e.tier === "primary");
  const cameoEpisodes = allEpisodes.filter((e) => e.tier === "cameo");

  // 3. channels[] + timeline[] agregirani u JS-u iz punog seta epizoda
  //    (max ~150 po osobi → jeftino, jedan CH round-trip).
  const { channels, timeline } = aggregate(episodes);

  const verdict = judgeVirtualChannel(slug, episodes, curation.optedOut);

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
    is_virtual_channel: verdict.isVirtualChannel && !ambiguous,
    ambiguous,
    optout: curation.optedOut,
    cameo_episodes: cameoEpisodes,
    cameo_episode_count: cameoEpisodes.length,
  };
}
