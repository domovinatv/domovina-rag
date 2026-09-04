// Virtualni kanali — dijeljena pravila i izvori za `get_person` i `list_persons`.
//
// Feature: osoba čiji su nastupi razasuti po tuđim kanalima dobiva kanal-oblik
// (../../../../domovina.ai/docs/plans/virtualni-kanali.md). Ovaj modul drži ono
// što OBA endpointa moraju vidjeti identično — ako se pravilo razidje, osoba
// bude u katalogu a njezina stranica ne bude kanal, ili obrnuto.
//
// ─── Zašto pravilo nije samo „≥ 3 epizode" ────────────────────────────────
//
// Izvorni plan (O3) je tražio prag od 3 epizode. Mjereno 3.9.2026. nad lokalnim
// korpusom (150 085 chunkova / 3157 epizoda) to daje 311 osoba uz 49 kanala —
// šest puta preko granice na kojoj §5 istog plana traži da katalog padne na
// „samo kanali". Gore od brojke je tko ulazi:
//
//   fra Stjepan Brčina  178 ep / 97 % na jednom kanalu  → domaćin, ima /c/
//   Željka Markić       160 ep / 97 %                    → domaćin, ima /c/
//   Vinko Mihaljević    109 ep / 100 %                   → domaćin
//   Pjevač, Svećenik, Ana, Marija, Ante                  → rolne oznake i
//                                                          jednočlana imena
//
// Domaćin praćenog kanala NE smije postati virtualni kanal: on već ima svoju
// /c/ stranicu, pa bi ga katalog nosio dvaput. Feature cilja GOSTA — osobu
// razasutu po tuđim kanalima. Ta se razlika mjeri raspršenošću, ne brojem
// epizoda. Uz tri dodatna uvjeta katalog padne na 76 osoba, a referentni slučaj
// (Tomislav Belavić, 6 ep / 6 kanala / 17 % na najvećem) ostaje unutra.
//
// Reprodukcija mjerenja: ../domovina.ai/docs/plans/2026-09-03-virtualni-kanal-belavic.md §6

export const VC_MIN_EPISODES = 3;
export const VC_MIN_CHANNELS = 3;
// Udio epizoda na najzastupljenijem kanalu. Iznad ovoga je osoba domaćin tog
// kanala, ne gost koji ga posjećuje.
export const VC_MAX_CHANNEL_SHARE = 0.6;

// Tier prag iz O3: `primary` je nastup koji nosi epizodu, `cameo` je usputni
// upad. Frontend isto izvodi sam kad `tier` izostane (person_hub.dart), pa ove
// dvije vrijednosti moraju ostati u koraku s `_classifyTier` ondje.
export const TIER_MIN_SHARE = 0.15;
export const TIER_MIN_SECONDS = 300;

// Rolne oznake koje diarizacija ostavlja kao „ime". One prođu svaki brojčani
// prag (Pjevač: 15 epizoda na 9 kanala) jer ih ima u svakoj drugoj emisiji, a
// nisu osoba. Popis je namjerno kratak i doslovan — ovo je crna lista, ne
// heuristika; nepoznata rolna oznaka pada na pravilo „≥ 2 tokena u slugu".
const ROLE_SLUGS = new Set([
  "voditelj", "voditeljica", "gost", "gosca", "gost-iz-publike",
  "sugovornik", "sugovornica", "pjevac", "pjevacica", "svecenik", "propovjednik",
  "molitelj", "najavljivac", "novinar", "novinarka", "profesor", "profesorica",
  "doktor", "glumac", "glumica", "misionar", "publika", "nepoznato", "unknown",
]);

export interface PersonEpisodeStat {
  youtube_id: string;
  channel: string;
  upload_date: string;
  duration_seconds: number;
  speaking_seconds: number;
}

export interface VirtualChannelVerdict {
  isVirtualChannel: boolean;
  episodeCount: number;
  channelCount: number;
  maxChannelShare: number;
}

// Slug mora imati barem dva tokena („ana" ne, „ana-maric" da) i ne smije biti
// rolna oznaka. Bez ovoga u katalog uđu „Marija", „Luka", „Ivan" — imena koja
// diarizacija dodijeli kad prezime nikad nije izgovoreno, pa jedan slug skupi
// nastupe više različitih ljudi.
export function isPersonLikeSlug(slug: string): boolean {
  const tokens = slug.split("-").filter((t) => t.length > 0);
  if (tokens.length < 2) return false;
  return !ROLE_SLUGS.has(slug);
}

export function classifyTier(
  speakingSeconds: number | null,
  durationSeconds: number | null,
): "primary" | "cameo" {
  if (speakingSeconds === null || speakingSeconds <= 0) return "primary";
  if (speakingSeconds >= TIER_MIN_SECONDS) return "primary";
  if (durationSeconds !== null && durationSeconds > 0) {
    return speakingSeconds / durationSeconds >= TIER_MIN_SHARE ? "primary" : "cameo";
  }
  // Bez trajanja se udio ne može izračunati; ne izmišljamo cameo iz nepoznatog.
  return "primary";
}

// Presuda o virtualnom kanalu iz `primary` epizoda osobe. `cameo` se NE broji —
// hero brojka bi inače tvrdila nastup ondje gdje je osoba rekla dvije rečenice.
export function judgeVirtualChannel(
  slug: string,
  primaryEpisodes: { channel: string }[],
  optedOut: boolean,
): VirtualChannelVerdict {
  const perChannel = new Map<string, number>();
  for (const e of primaryEpisodes) {
    perChannel.set(e.channel, (perChannel.get(e.channel) ?? 0) + 1);
  }
  const episodeCount = primaryEpisodes.length;
  const channelCount = perChannel.size;
  const maxOnOne = perChannel.size === 0 ? 0 : Math.max(...perChannel.values());
  const maxChannelShare = episodeCount === 0 ? 0 : maxOnOne / episodeCount;

  const isVirtualChannel =
    !optedOut &&
    isPersonLikeSlug(slug) &&
    episodeCount >= VC_MIN_EPISODES &&
    channelCount >= VC_MIN_CHANNELS &&
    maxChannelShare <= VC_MAX_CHANNEL_SHARE;

  return { isVirtualChannel, episodeCount, channelCount, maxChannelShare };
}


// ─── Praćeni kanali s CDN-a ────────────────────────────────────────────────
//
// `channel_tracked` odlučuje smije li chip izvornog kanala na profilu biti
// KLIKABILAN: praćeni kanal ima /c/<slug> stranicu, ad-hoc izvor (N1, Lider,
// TEDx) nema i klik bi vodio u 404. Izvor istine je isti fajl koji frontend
// već troši za katalog kanala, pa se dvije strane ne mogu razići.

export interface TrackedChannel {
  id: string;
  name: string;
  youtubeChannelId: string | null;
}

const CHANNELS_INDEX_URL = "https://cdn.domovina.ai/channels/data/index.json";
const CHANNELS_TTL_MS = 15 * 60 * 1000;

let channelsCache: { at: number; byId: Map<string, TrackedChannel> } | null = null;

function parseYoutubeChannelId(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /\/channel\/(UC[\w-]+)/.exec(url);
  return m ? m[1]! : null;
}

// Nikad ne baca: ako CDN padne, `channel_tracked` postaje false za sve, chipovi
// se prikažu kao neklikabilan tekst i profil i dalje radi. Suprotno (tvrditi da
// je kanal praćen pa poslati korisnika u 404) je gore od izostanka linka.
export async function loadTrackedChannels(): Promise<Map<string, TrackedChannel>> {
  const now = Date.now();
  if (channelsCache !== null && now - channelsCache.at < CHANNELS_TTL_MS) {
    return channelsCache.byId;
  }
  const byId = new Map<string, TrackedChannel>();
  try {
    const res = await fetch(CHANNELS_INDEX_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const body = (await res.json()) as {
        channels?: { id?: string; name?: string; youtube_channel_url?: string }[];
      };
      for (const c of body.channels ?? []) {
        if (!c.id) continue;
        byId.set(c.id, {
          id: c.id,
          name: c.name ?? c.id,
          youtubeChannelId: parseYoutubeChannelId(c.youtube_channel_url),
        });
      }
    } else {
      console.error(`[person-channel] channels index HTTP ${res.status}`);
    }
  } catch (err) {
    console.error(
      `[person-channel] channels index nedostupan: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // Prazan rezultat se NE kešira kao valjan — inače jedan mrežni prekid gasi
  // linkove na kanale idućih 15 minuta.
  if (byId.size > 0) channelsCache = { at: now, byId };
  return byId;
}

export function resetTrackedChannelsCache(): void {
  channelsCache = null;
}
