// Filtar postavki kanala u alatima: SQL/Meili uvjet, person agregacija, prazne postavke.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { HiddenChannels } from "../../src/channel-settings.js";
import { findInTranscript } from "../../src/tools/find-in-transcript.js";
import { getEpisode } from "../../src/tools/get-episode.js";
import { getPerson } from "../../src/tools/get-person.js";
import { listEpisodes, ListEpisodesInput } from "../../src/tools/list-episodes.js";
import { listPersons, resetPersonIndexCache } from "../../src/tools/list-persons.js";
import { resetTrackedChannelsCache } from "../../src/tools/person-channel.js";
import {
  SearchPodcastsInput,
  buildFilters,
  searchPodcasts,
} from "../../src/tools/search-podcasts.js";
import { fakeCh, fakeEmbedder, fakeMeili, fakePg } from "./helpers.js";

const HIDE_DTV = new HiddenChannels(["domovina-tv"]);

// person-channel.ts dohvaća CDN indeks kanala — u testu mreže nema.
const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async () => {
    throw new Error("mreža je u testovima isključena");
  }) as typeof fetch;
  resetTrackedChannelsCache();
  resetPersonIndexCache();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
const quiet = console.error;
beforeEach(() => {
  console.error = () => {};
});
afterEach(() => {
  console.error = quiet;
});

describe("search_podcasts / /api/search", () => {
  it("prazne postavke: WHERE i parametri identični današnjima", () => {
    const args = SearchPodcastsInput.parse({ query: "molitva", channel: "sabor", include_summaries: false });
    assert.deepEqual(buildFilters(args, HiddenChannels.EMPTY), buildFilters(args));
    assert.ok(!buildFilters(args).whereParts.some((w) => w.includes("NOT IN")));
  });

  it("isključeni kanal ide u WHERE prije LIMIT-a, s oba oblika sluga", async () => {
    const { ch, calls } = fakeCh();
    await searchPodcasts(SearchPodcastsInput.parse({ query: "molitva", limit: 10 }), {
      ch,
      embedder: fakeEmbedder(),
      hidden: HIDE_DTV,
    });
    const sql = calls[0]!.query;
    assert.match(sql, /WHERE channel NOT IN \{hidden_channels:Array\(String\)\}/);
    assert.ok(sql.indexOf("NOT IN") < sql.indexOf("LIMIT"));
    assert.deepEqual((calls[0]!.query_params!.hidden_channels as string[]).sort(), ["domovina-tv", "domovina_tv"]);
    assert.equal(calls[0]!.query_params!.limit, 10);
  });
});

describe("list_episodes / get_episode / find_in_transcript", () => {
  it("list_episodes kvalificira kolonu (alias any(channel))", async () => {
    const { ch, calls } = fakeCh();
    await listEpisodes(ListEpisodesInput.parse({}), { ch, hidden: HIDE_DTV });
    assert.match(calls[0]!.query, /WHERE rag_chunks\.channel NOT IN/);
  });

  it("get_episode isključenog kanala = EPISODE_NOT_FOUND", async () => {
    const { ch, calls } = fakeCh(); // pravi CH bi uz uvjet vratio 0 redaka
    await assert.rejects(
      getEpisode({ youtube_id: "abcdefghijk", include_transcript: false } as never, { ch, hidden: HIDE_DTV }),
      /ne postoji u korpusu/,
    );
    assert.match(calls[0]!.query, /youtube_id = \{yt:String\} AND channel NOT IN/);
  });

  it("find_in_transcript: Meili filtar s obje varijante; bez postavki filtar nepromijenjen", async () => {
    const { ch } = fakeCh();
    const m1 = fakeMeili();
    await findInTranscript({ query: "Matija", channel: "sabor" } as never, { meili: m1.meili, ch, hidden: HIDE_DTV });
    assert.equal(
      m1.calls[0]!.params.filter,
      "channel = 'sabor' AND channel NOT IN ['domovina-tv', 'domovina_tv']",
    );
    const m2 = fakeMeili();
    await findInTranscript({ query: "Matija", channel: "sabor" } as never, { meili: m2.meili, ch });
    assert.equal(m2.calls[0]!.params.filter, "channel = 'sabor'");
  });
});

// ─── Person hub ──────────────────────────────────────────────────────────────
//
// Osoba „Ana Horvat” govori u tri kanala (po jedna duga epizoda) → virtualni kanal.
// Kad vlasnik kanala `kanal_c` isključi persons_mentions, ostaju dva kanala i
// pravilo (≥ 3 kanala) je više ne pušta — i na /api/person i na /api/persons.

const EPISODES = [
  { youtube_id: "aaaaaaaaaaa", channel: "kanal_a", upload_date: "2026-01-03" },
  { youtube_id: "bbbbbbbbbbb", channel: "kanal_b", upload_date: "2026-01-02" },
  { youtube_id: "ccccccccccc", channel: "kanal_c", upload_date: "2026-01-01" },
];

function personCh() {
  return fakeCh((sql) => {
    if (sql.includes("first_ts")) {
      // get-person agregat po epizodi
      return EPISODES.map((e) => ({
        ...e,
        first_ts: 10,
        duration_seconds: 3600,
        speaking_seconds: 1800,
        sample_metadata: JSON.stringify({ metadata: { title: `Epizoda ${e.youtube_id}` } }),
      }));
    }
    if (sql.includes("AS tok")) {
      return EPISODES.map((e) => ({ tok: "Ana Horvat", youtube_id: e.youtube_id, speaking_seconds: 1800 }));
    }
    if (sql.includes("round(max(end_ts)) AS duration_seconds")) {
      return EPISODES.map((e) => ({ ...e, duration_seconds: 3600 }));
    }
    if (sql.includes("sample_metadata")) {
      return EPISODES.map((e) => ({ youtube_id: e.youtube_id, sample_metadata: "{}" }));
    }
    return [];
  });
}

function personPg() {
  return fakePg((sql) => {
    if (sql.includes("FROM speakers")) {
      return [{ slug: "ana-horvat", canonical_name: "Ana Horvat", avatar_url: null, aliases: ["Ana Horvat"] }];
    }
    if (sql.includes("FROM person_mentions")) {
      return [
        { youtube_id: "mmmmmmmmmm1", title: "Spomen A", channel: "kanal_a", upload_date: "2026-02-01", mention_ts: 5, person_name: "Ana Horvat" },
        { youtube_id: "mmmmmmmmmm3", title: "Spomen C", channel: "kanal-c", upload_date: "2026-02-02", mention_ts: 7, person_name: "Ana Horvat" },
      ];
    }
    return [];
  });
}

describe("get_person / /api/person/:slug", () => {
  it("bez postavki: tri kanala, virtualni kanal, oba spomena", async () => {
    const { ch } = personCh();
    const hub = await getPerson({ slug: "ana-horvat" }, { ch, pg: personPg() });
    assert.equal(hub.episode_count, 3);
    assert.equal(hub.channel_count, 3);
    assert.equal(hub.is_virtual_channel, true);
    assert.equal(hub.mentions.length, 2);
  });

  it("persons_mentions off na kanal_c: izostaje iz epizoda i spomena, pravilo se preračuna", async () => {
    const { ch, calls } = personCh();
    const hidden = new HiddenChannels(["kanal-c"]);
    const hub = await getPerson({ slug: "ana-horvat" }, { ch, pg: personPg(), hidden });
    assert.deepEqual(hub.episodes.map((e) => e.channel).sort(), ["kanal_a", "kanal_b"]);
    assert.equal(hub.cameo_episodes.length, 0);
    assert.equal(hub.channel_count, 2);
    assert.equal(hub.is_virtual_channel, false);
    assert.deepEqual(hub.mentions.map((m) => m.youtube_id), ["mmmmmmmmmm1"]);
    assert.ok(!hub.mention_channels.some((c) => c.channel === "kanal-c"));
    // U SQL-u, ne samo u JS-u (LIMIT 1000 se ne smije trošiti na skrivene epizode).
    assert.match(calls[0]!.query, /WHERE rag_chunks\.channel NOT IN \{hidden_channels:Array\(String\)\} AND youtube_id IN/);
  });

  it("osoba poznata samo iz skrivenog kanala dobiva prazan profil, ne 404", async () => {
    const { ch } = fakeCh();
    const pg = fakePg((sql) =>
      sql.includes("FROM person_mentions")
        ? [{ youtube_id: "mmmmmmmmmm3", title: "Spomen C", channel: "kanal_c", upload_date: "2026-02-02", mention_ts: 7, person_name: "Bl. Netko Netković" }]
        : [],
    );
    const hub = await getPerson({ slug: "netko-netkovic" }, { ch, pg, hidden: new HiddenChannels(["kanal-c"]) });
    assert.equal(hub.mentions.length, 0);
    assert.equal(hub.name, "Netko Netkovic");
  });
});

describe("/api/persons (list_persons)", () => {
  it("bez postavki osoba je u indeksu; s kanal_c skrivenim ispada (2 kanala < 3)", async () => {
    const pg = personPg();
    const a = await listPersons({ ch: personCh().ch, pg });
    assert.deepEqual(a.persons.map((p) => p.slug), ["ana-horvat"]);
    assert.equal(a.persons[0]!.channel_count, 3);

    // Isti proces, unutar 15-min cachea: promjena postavki NE čeka istek.
    const b = await listPersons({ ch: personCh().ch, pg, hidden: new HiddenChannels(["kanal-c"]) });
    assert.equal(b.person_count, 0);

    const c = await listPersons({ ch: personCh().ch, pg, hidden: HiddenChannels.EMPTY });
    assert.equal(c.person_count, 1);
  });
});
