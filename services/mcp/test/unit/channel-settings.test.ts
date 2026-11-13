// Unit testovi čitača postavki kanala: zatvaranje ovisnosti, slugovi, snimka s TTL-om.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AI_KEYS,
  ARTICLE_DEPENDENTS,
  ChannelSettingsSource,
  HiddenChannels,
  KEYS,
  closeOff,
  hiddenChannelsSql,
  hiddenFor,
  normalizeSlug,
  parseCatalogResponse,
  slugVariants,
} from "../../src/channel-settings.js";
import { UC_A, UC_B, UC_C, fakeFetch } from "./helpers.js";

describe("closeOff (isto kao fetch.domovina.tv/lib/channel_settings.js)", () => {
  it("prazno i nepoznati ključevi = ništa isključeno", () => {
    assert.deepEqual([...closeOff([], "active")], []);
    assert.deepEqual([...closeOff(undefined)], []);
    assert.deepEqual([...closeOff(["nepostojeci_kljuc", "x"], "active")], []);
  });

  it("master, withdrawn i deleted gase svih 20", () => {
    assert.equal(KEYS.length, 20);
    assert.equal(closeOff(["channel_enabled"], "active").size, 20);
    assert.equal(closeOff([], "withdrawn").size, 20);
    assert.equal(closeOff([], "deleted").size, 20);
  });

  it("transcript_subtitles gasi sve AI ključeve (pa preko članka i njegove ovisne)", () => {
    const s = closeOff(["transcript_subtitles"], "active");
    for (const k of AI_KEYS) assert.ok(s.has(k), k);
    // article_summary je AI ključ, pa zatvaranje (kao u pipelineu) povuče i ebook/share_clips.
    assert.ok(s.has("ebook") && s.has("share_clips"));
    assert.ok(!s.has("in_app_search"));
    assert.equal(s.size, AI_KEYS.length + 2);
  });

  it("article_summary gasi ovisne o članku, ali ne i AI asistente", () => {
    const s = closeOff(["article_summary"], "active");
    for (const k of ARTICLE_DEPENDENTS) assert.ok(s.has(k), k);
    assert.ok(s.has("article_summary"));
    assert.ok(!s.has("ai_assistants"));
    assert.ok(!s.has("persons_mentions"));
    assert.ok(!s.has("transcript_subtitles"));
  });
});

describe("slugovi", () => {
  it("normalizeSlug: podvlaka ↔ crtica i velika slova", () => {
    assert.equal(normalizeSlug("domovina_tv"), "domovina-tv");
    assert.equal(normalizeSlug(" Domovina-TV "), "domovina-tv");
  });

  it("HiddenChannels.has prepoznaje oba oblika", () => {
    const h = new HiddenChannels(["domovina-tv"]);
    assert.ok(h.has("domovina_tv"));
    assert.ok(h.has("domovina-tv"));
    assert.ok(h.has("DOMOVINA_TV"));
    assert.ok(!h.has("domovina_tv_2"));
    assert.ok(!h.has(null));
    const fromDir = new HiddenChannels(["podcast_cuspajz"]);
    assert.ok(fromDir.has("podcast-cuspajz"));
  });

  it("slugVariants daje sve kombinacije separatora", () => {
    assert.deepEqual(slugVariants("sabor"), ["sabor"]);
    assert.deepEqual(slugVariants("domovina-tv").sort(), ["domovina-tv", "domovina_tv"]);
    const v = slugVariants("na-kavi-sa-svetim-ignacijem");
    assert.equal(v.length, 16);
    assert.ok(v.includes("na_kavi_sa_svetim_ignacijem"));
    assert.ok(v.includes("na-kavi_sa-svetim_ignacijem"));
  });

  it("rawValues i SQL uvjet nose obje varijante; prazan skup = nema uvjeta", () => {
    const h = new HiddenChannels(["domovina-tv"]);
    const sql = hiddenChannelsSql(h, "rag_chunks.channel");
    assert.ok(sql);
    assert.equal(sql.clause, "rag_chunks.channel NOT IN {hidden_channels:Array(String)}");
    assert.deepEqual(sql.params.hidden_channels!.sort(), ["domovina-tv", "domovina_tv"]);
    assert.equal(hiddenChannelsSql(HiddenChannels.EMPTY), null);
  });
});

describe("parseCatalogResponse + hiddenFor", () => {
  const body = {
    version: "1",
    catalog: "x",
    settings: {
      [UC_A]: { status: "active", off: ["in_app_search"], slugs: ["domovina-tv"] },
      [UC_B]: { status: "active", off: ["transcript_subtitles"], slugs: ["kanal-b", "kanal-b-stari"] },
      [UC_C]: { status: "withdrawn", off: [] }, // bez `slugs` (stari katalog)
      nije_uc: { status: "deleted", off: [], slugs: ["ne-smije"] },
    },
  };

  it("preskače ne-UC ključeve, nepoznat status = active, slugs su opcionalni", () => {
    const m = parseCatalogResponse(JSON.stringify(body));
    assert.deepEqual(Object.keys(m).sort(), [UC_A, UC_B, UC_C].sort());
    assert.equal(m[UC_C]!.status, "withdrawn");
    assert.equal(m[UC_C]!.slugs, undefined);
    const odd = parseCatalogResponse({ settings: { [UC_A]: { status: "čudno", off: [1, "ebook"] } } });
    assert.equal(odd[UC_A]!.status, "active");
    assert.deepEqual(odd[UC_A]!.off, ["ebook"]);
  });

  it("baca na odgovor bez objekta settings", () => {
    assert.throws(() => parseCatalogResponse({ version: "1" }));
    assert.throws(() => parseCatalogResponse({ settings: [] }));
    assert.throws(() => parseCatalogResponse("nije json"));
  });

  it("hiddenFor bira kanale po ključu nakon zatvaranja, UC bez slugova javlja", () => {
    const m = parseCatalogResponse(body);
    const missing: string[] = [];
    const search = hiddenFor(m, ["in_app_search"], (uc) => missing.push(uc));
    assert.deepEqual(search.slugs(), ["domovina-tv"]);
    assert.deepEqual(missing, [UC_C]);

    const ai = hiddenFor(m, ["ai_assistants"]);
    // UC_B: transcript_subtitles → zatvaranje gasi ai_assistants; oba sluga.
    assert.deepEqual(ai.slugs(), ["kanal-b", "kanal-b-stari"]);
    assert.ok(!ai.has("domovina_tv"));
  });

  it("prazne postavke = prazan skup", () => {
    const m = parseCatalogResponse({ version: "1", settings: {} });
    assert.equal(hiddenFor(m, [...KEYS]).size, 0);
  });
});

describe("ChannelSettingsSource (snimka u memoriji)", () => {
  const ok = {
    version: "1",
    settings: { [UC_A]: { status: "active", off: ["ai_assistants"], slugs: ["domovina-tv"] } },
  };

  function clock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  }

  it("prvi poziv čeka dohvat; unutar TTL-a nema novog dohvata", async () => {
    const c = clock();
    const f = fakeFetch(() => ({ body: ok }));
    const src = new ChannelSettingsSource({ fetchImpl: f.fetchImpl, now: c.now, ttlMs: 60_000, log: () => {} });
    assert.deepEqual((await src.hidden(["ai_assistants"])).slugs(), ["domovina-tv"]);
    c.advance(30_000);
    await src.hidden(["ai_assistants"]);
    assert.equal(f.count(), 1);
  });

  it("greška nakon uspjeha → zadnja uspješna snimka + glasan log", async () => {
    const c = clock();
    let fail = false;
    const f = fakeFetch(() => (fail ? { status: 503 } : { body: ok }));
    const logs: string[] = [];
    const src = new ChannelSettingsSource({ fetchImpl: f.fetchImpl, now: c.now, ttlMs: 60_000, log: (m) => logs.push(m) });
    await src.refresh();
    fail = true;
    c.advance(61_000);
    // Zastarjela snimka se vraća odmah; osvježavanje ide u pozadini.
    assert.deepEqual((await src.hidden(["ai_assistants"])).slugs(), ["domovina-tv"]);
    await src.refresh(); // pričekaj pozadinski pokušaj (dijeli isti in-flight)
    assert.deepEqual((await src.hidden(["ai_assistants"])).slugs(), ["domovina-tv"]);
    assert.ok(logs.some((l) => l.includes("HTTP 503") && l.includes("zadnju uspješnu snimku")), logs.join("\n"));
  });

  it("nikad uspješan dohvat → ne filtrira, logira, i ne pokušava na svakom upitu", async () => {
    const c = clock();
    const f = fakeFetch(() => ({ throws: "ECONNREFUSED" }));
    const logs: string[] = [];
    const src = new ChannelSettingsSource({ fetchImpl: f.fetchImpl, now: c.now, ttlMs: 60_000, log: (m) => logs.push(m) });
    assert.equal((await src.hidden(["ai_assistants"])).size, 0);
    assert.equal((await src.hidden(["ai_assistants"])).size, 0);
    assert.equal(f.count(), 1);
    assert.ok(logs.some((l) => l.includes("NEMA uspješne snimke")));
    c.advance(60_000);
    await src.hidden(["ai_assistants"]);
    assert.equal(f.count(), 2);
  });

  it("neispravan JSON se tretira kao greška, ne kao prazne postavke", async () => {
    const c = clock();
    let body: unknown = ok;
    const f = fakeFetch(() => ({ body }));
    const src = new ChannelSettingsSource({ fetchImpl: f.fetchImpl, now: c.now, ttlMs: 1, log: () => {} });
    await src.refresh();
    body = { nesto: "drugo" };
    c.advance(10);
    await src.refresh();
    assert.deepEqual((await src.hidden(["ai_assistants"])).slugs(), ["domovina-tv"]);
  });

  it("UC bez `slugs` se ne filtrira i upozorenje ide samo jednom", async () => {
    const logs: string[] = [];
    const f = fakeFetch(() => ({ body: { settings: { [UC_B]: { status: "withdrawn", off: [] } } } }));
    const src = new ChannelSettingsSource({ fetchImpl: f.fetchImpl, log: (m) => logs.push(m) });
    assert.equal((await src.hidden(["ai_assistants"])).size, 0);
    assert.equal((await src.hidden(["in_app_search"])).size, 0);
    assert.equal(logs.filter((l) => l.includes(UC_B)).length, 1);
  });
});
