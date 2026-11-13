// Vlasnikove postavke kanala (lanac „postavke kanala”, S8) — čitač za MCP server.
//
// Izvor stanja je katalog `GET https://domovina.ai/api/katalog/v1/settings`:
//   {"version":"1","settings":{"UC…":{"status":"active|withdrawn|deleted","off":[…],
//    "deleted_at"?:"…","slugs"?:["slug",…]}}}
// Navedeni su samo UC-ovi s barem jednim isključenim ključem ili tombstoneom; svi
// ostali kanali su „sve uključeno” (tvrdi uvjet: zadano uključeno, nepoznat ključ =
// uključen).
//
// U ovom repou kanal NEMA UC — identificiran je slugom (`rag_chunks.channel`, ime
// direktorija producera: `domovina_tv`). Katalog piše `domovina-tv`. Zato se slugovi
// uspoređuju NORMALIZIRANO (lowercase, `_` → `-`), a za upite nad bazom/Meilijem se
// iz normaliziranog sluga izvode sve varijante pisanja (`slugVariants`), da filtar
// ostane jednostavan `channel NOT IN [...]` nad sirovom kolonom.
//
// Čitač NIJE fail-closed (odluka 701 lanca): bez ijedne uspješne snimke ne filtrira
// ništa i glasno logira; nakon prve uspješne snimke pri grešci koristi zadnju dobru.
// Usporedi fetch.domovina.tv/lib/channel_settings.js — pipeline JEST fail-closed jer
// obrađuje, a ovo samo čita.

/** 20 ključeva, ugovor s ostalim potrošačima (odluka 1). Ne preimenovati. */
export const KEYS = [
  "channel_enabled", "processing", "home_featured", "in_app_search", "search_engines",
  "push_notifications", "cdn_playback", "share_clips", "ebook", "article_summary",
  "transcript_subtitles", "english_translation", "magisterium", "highlights_reels",
  "persons_mentions", "news_portal", "ai_assistants", "donations", "paid_sponsor_moments",
  "sponsors_in_video",
] as const;
export type SettingKey = (typeof KEYS)[number];

export const AI_KEYS: readonly SettingKey[] = [
  "article_summary", "transcript_subtitles", "english_translation", "magisterium",
  "highlights_reels", "persons_mentions", "news_portal", "ai_assistants",
];
/** Odluka 108/200: ovisni ključevi padaju s člankom. */
export const ARTICLE_DEPENDENTS: readonly SettingKey[] = [
  "ebook", "magisterium", "english_translation", "share_clips", "news_portal",
];

export const DEFAULT_SETTINGS_URL = "https://domovina.ai/api/katalog/v1/settings";

const KEY_SET: ReadonlySet<string> = new Set(KEYS);
const UC_RE = /^UC[A-Za-z0-9_-]{22}$/;

export type ChannelStatus = "active" | "withdrawn" | "deleted";

export interface ChannelEntry {
  status: ChannelStatus;
  off: string[];
  /** Svi katalog slugovi UC-a. Ne postoji u starijem odgovoru kataloga. */
  slugs?: string[];
  deleted_at?: string;
}

export type SettingsMap = Record<string, ChannelEntry>;

/**
 * Zatvori skup isključenih ključeva po ovisnostima — isto kao `closeOff` u
 * fetch.domovina.tv/lib/channel_settings.js: master/tombstone → svih 20;
 * transkript → svi AI ključevi; članak → ovisni o članku. Nepoznat ključ se ignorira.
 */
export function closeOff(off: readonly string[] | undefined, status?: string): Set<SettingKey> {
  const s = new Set<SettingKey>(
    (off ?? []).filter((k): k is SettingKey => KEY_SET.has(k)),
  );
  if (status === "withdrawn" || status === "deleted" || s.has("channel_enabled")) {
    return new Set(KEYS);
  }
  if (s.has("transcript_subtitles")) AI_KEYS.forEach((k) => s.add(k));
  if (s.has("article_summary")) ARTICLE_DEPENDENTS.forEach((k) => s.add(k));
  return s;
}

/** `Domovina_TV` → `domovina-tv`. Oblik u kojem se slugovi uspoređuju. */
export function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase().replace(/_/g, "-");
}

// 2^6 = 64 varijante je gornja granica; slug s više separatora (danas ih nema,
// najdulji je `na_kavi_sa_svetim_ignacijem` s 4) dobiva samo dva čista oblika.
const MAX_VARIANT_SEPARATORS = 6;

/**
 * Sva pisanja normaliziranog sluga koja se mogu naći u sirovoj koloni:
 * `domovina-tv` → [`domovina-tv`, `domovina_tv`]. Kombinira `-`/`_` na svakom
 * separatoru, pa pokriva i miješani oblik (`a_b-c`).
 */
export function slugVariants(normalized: string): string[] {
  const parts = normalized.split("-");
  const seps = parts.length - 1;
  if (seps === 0) return [normalized];
  if (seps > MAX_VARIANT_SEPARATORS) {
    return [...new Set([normalized, parts.join("_")])];
  }
  const out = new Set<string>();
  for (let mask = 0; mask < 1 << seps; mask++) {
    let s = parts[0]!;
    for (let i = 0; i < seps; i++) s += (mask & (1 << i) ? "_" : "-") + parts[i + 1]!;
    out.add(s);
  }
  return [...out];
}

/** Provjeri oblik odgovora kataloga; vrati normaliziranu mapu ili baci. */
export function parseCatalogResponse(body: unknown): SettingsMap {
  const j = typeof body === "string" ? (JSON.parse(body) as unknown) : body;
  if (!j || typeof j !== "object") throw new Error("neispravan odgovor kataloga (nije objekt)");
  const settings = (j as { settings?: unknown }).settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("neispravan odgovor kataloga (nema objekta settings)");
  }
  const out: SettingsMap = {};
  for (const [uc, raw] of Object.entries(settings as Record<string, unknown>)) {
    if (!UC_RE.test(uc) || !raw || typeof raw !== "object") continue;
    const v = raw as Record<string, unknown>;
    const status: ChannelStatus =
      v.status === "withdrawn" || v.status === "deleted" ? v.status : "active";
    const entry: ChannelEntry = {
      status,
      off: Array.isArray(v.off) ? v.off.filter((k): k is string => typeof k === "string") : [],
    };
    if (Array.isArray(v.slugs)) {
      entry.slugs = v.slugs.filter((s): s is string => typeof s === "string" && s.trim() !== "");
    }
    if (typeof v.deleted_at === "string") entry.deleted_at = v.deleted_at;
    out[uc] = entry;
  }
  return out;
}

/** Skup kanala koje treba izostaviti za neku svrhu. Prazan = ne filtriraj ništa. */
export class HiddenChannels {
  static readonly EMPTY = new HiddenChannels([]);

  private readonly set: ReadonlySet<string>;

  constructor(normalizedSlugs: Iterable<string>) {
    this.set = new Set([...normalizedSlugs].map(normalizeSlug));
  }

  get size(): number {
    return this.set.size;
  }

  /** Prima sirovi slug iz baze (`domovina_tv`) ili katalog slug (`domovina-tv`). */
  has(channel: string | null | undefined): boolean {
    return channel != null && this.set.has(normalizeSlug(channel));
  }

  /** Normalizirani slugovi, sortirani (stabilan ključ cachea). */
  slugs(): string[] {
    return [...this.set].sort();
  }

  /** Sve sirove varijante za `channel NOT IN [...]` nad bazom ili Meilijem. */
  rawValues(): string[] {
    return this.slugs().flatMap(slugVariants);
  }

  signature(): string {
    return this.slugs().join(",");
  }
}

/**
 * Kanali (normalizirani slugovi) kojima je barem jedan od `keys` isključen nakon
 * zatvaranja. UC bez `slugs` se ne može preslikati — preskače se uz `onMissingSlugs`.
 */
export function hiddenFor(
  settings: SettingsMap,
  keys: readonly SettingKey[],
  onMissingSlugs?: (uc: string) => void,
): HiddenChannels {
  const out: string[] = [];
  for (const [uc, entry] of Object.entries(settings)) {
    const off = closeOff(entry.off, entry.status);
    if (!keys.some((k) => off.has(k))) continue;
    if (!entry.slugs || entry.slugs.length === 0) {
      onMissingSlugs?.(uc);
      continue;
    }
    out.push(...entry.slugs);
  }
  return new HiddenChannels(out);
}

/**
 * ClickHouse uvjet `<column> NOT IN {param:Array(String)}` ili null kad nema
 * skrivenih kanala — tada upit ostaje bajt-identičan današnjem.
 */
export function hiddenChannelsSql(
  hidden: HiddenChannels,
  column = "channel",
  param = "hidden_channels",
): { clause: string; params: Record<string, string[]> } | null {
  if (hidden.size === 0) return null;
  return {
    clause: `${column} NOT IN {${param}:Array(String)}`,
    params: { [param]: hidden.rawValues() },
  };
}

type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface ChannelSettingsSourceOptions {
  url?: string;
  /** Koliko je snimka svježa (default 60 s). Nakon toga se osvježava u pozadini. */
  ttlMs?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  now?: () => number;
  log?: (msg: string) => void;
}

/**
 * Snimka postavki u memoriji s kratkim TTL-om.
 *
 * - Svježa snimka (< ttl) → vraća se odmah.
 * - Zastarjela, a postoji zadnja dobra → vraća se ta, osvježavanje ide u pozadini
 *   (upit ne čeka katalog).
 * - Nikad uspješna → upit čeka jedan dohvat (≤ timeout); ako padne, vraća null =
 *   ne filtriraj, uz glasan log.
 * - Neuspjeh ne briše zadnju dobru snimku; novi pokušaj tek nakon ttl-a, da pad
 *   kataloga ne pretvori svaki upit u čekanje na timeout.
 */
export class ChannelSettingsSource {
  readonly url: string;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  private lastGood: SettingsMap | null = null;
  private lastGoodAt = 0;
  private lastAttemptAt = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<void> | null = null;
  private readonly warnedNoSlugs = new Set<string>();

  constructor(opts: ChannelSettingsSourceOptions = {}) {
    this.url = opts.url ?? DEFAULT_SETTINGS_URL;
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.error(m));
  }

  /** Jedan dohvat (dijeljen među istovremenim pozivima). Nikad ne baca. */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.lastAttemptAt = this.now();
    this.inFlight = this.fetchOnce()
      .then((settings) => {
        this.lastGood = settings;
        this.lastGoodAt = this.now();
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (this.lastGood) {
          const ageS = Math.round((this.now() - this.lastGoodAt) / 1000);
          this.log(
            `[channel-settings] GREŠKA dohvata ${this.url}: ${msg} — koristim zadnju uspješnu snimku (stara ${ageS} s)`,
          );
        } else {
          this.log(
            `[channel-settings] GREŠKA dohvata ${this.url}: ${msg} — NEMA uspješne snimke, NE filtriram kanale`,
          );
        }
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async fetchOnce(): Promise<SettingsMap> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.url, {
        signal: ctrl.signal,
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseCatalogResponse(await res.text());
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`timeout ${this.timeoutMs} ms`);
      }
      throw err;
    } finally {
      clearTimeout(t);
    }
  }

  /** Trenutna snimka ili null kad nijedan dohvat još nije uspio. */
  async current(): Promise<SettingsMap | null> {
    const now = this.now();
    const fresh = this.lastGood !== null && now - this.lastGoodAt < this.ttlMs;
    const mayRetry = now - this.lastAttemptAt >= this.ttlMs;
    if (!fresh && mayRetry) {
      const p = this.refresh();
      if (this.lastGood === null) await p;
    } else if (this.lastGood === null && this.inFlight) {
      await this.inFlight;
    }
    return this.lastGood;
  }

  /** Kanali kojima je isključen barem jedan od `keys`. */
  async hidden(keys: readonly SettingKey[]): Promise<HiddenChannels> {
    const settings = await this.current();
    if (settings === null) return HiddenChannels.EMPTY;
    return hiddenFor(settings, keys, (uc) => {
      if (this.warnedNoSlugs.has(uc)) return;
      this.warnedNoSlugs.add(uc);
      this.log(
        `[channel-settings] UPOZORENJE: ${uc} ima isključene ključeve, ali katalog nije poslao \`slugs\` — kanal se NE filtrira`,
      );
    });
  }
}

/** Izvor bez dohvata (stdio dev, testovi): uvijek „sve uključeno”. */
export function staticChannelSettings(settings: SettingsMap | null): Pick<
  ChannelSettingsSource,
  "hidden" | "current"
> {
  return {
    current: async () => settings,
    hidden: async (keys) => (settings ? hiddenFor(settings, keys) : HiddenChannels.EMPTY),
  };
}

export type ChannelSettingsReader = Pick<ChannelSettingsSource, "hidden" | "current">;
