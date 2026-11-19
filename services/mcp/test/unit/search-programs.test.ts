// search_programs: filtar stranke, limit, SQL s parametrima, formatiranje odgovora, ožičenje.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { staticChannelSettings, parseCatalogResponse } from "../../src/channel-settings.js";
import type { Config } from "../../src/config.js";
import { createServer } from "../../src/server.js";
import {
  SearchProgramsInput,
  buildPartyFilter,
  chunkBody,
  foldParty,
  formatProgramHits,
  pageLabel,
  searchPrograms,
  trimQuote,
} from "../../src/tools/search-programs.js";
import { fakeCh, fakeEmbedder } from "./helpers.js";

const HDZ_ROW = {
  chunk_id: "hdz-2024-program:12",
  doc_id: "hdz-2024-program",
  party_ids: [258, 31, 77],
  party_names: [
    "Hrvatska demokratska zajednica",
    "Hrvatska socijalno-liberalna stranka",
    "Hrvatski demokršćani",
  ],
  party_short: ["HDZ", "HSLS", ""],
  party_slugs: ["hdz", "hsls", "hrvatski-demokrscani"],
  naslov: "Program Vlade 2024.–2028.",
  section: "Mirovinski sustav",
  page_from: 12,
  page_to: 13,
  format: "pdf",
  izvor: "web",
  nesiguran: 0,
  nesiguran_razlog: "",
  url: "https://hdz.hr/program-2024.pdf",
  datum: "2024-03-20",
  text: "Mirovinski sustav\n\nPovećat ćemo najniže mirovine za 10 posto. Uvest ćemo   obiteljsku mirovinu.",
  distance: 0.18,
};

const WAYBACK_ROW = {
  ...HDZ_ROW,
  chunk_id: "mozemo-2024:3",
  doc_id: "mozemo-2024",
  party_ids: [512],
  party_names: ["Možemo! - politička platforma"],
  party_short: ["Možemo"],
  party_slugs: ["mozemo"],
  naslov: "Program za zeleni grad",
  section: "Stanovanje",
  page_from: 1,
  page_to: 1,
  format: "html",
  izvor: "wayback",
  nesiguran: 1,
  nesiguran_razlog: "stranica stranke više ne postoji, snimka iz travnja 2024.",
  url: "https://web.archive.org/web/20240401/https://mozemo.hr/program",
  datum: "",
  text: "Stanovanje\n\nUvest ćemo porez na prazne stanove.",
  distance: 0.25,
};

describe("search_programs: filtar stranke", () => {
  it("numerički ID → has(party_ids) s UInt32 parametrom", () => {
    const f = buildPartyFilter(" 258 ");
    assert.equal(f.clause, "has(party_ids, {party_id:UInt32})");
    assert.deepEqual(f.params, { party_id: 258 });
  });

  it("slug i kratica → jednakost nad party_slugs i party_short", () => {
    const f = buildPartyFilter("HDZ");
    assert.match(f.clause, /arrayExists\(x -> x = \{party_slug:String\}, party_slugs\)/);
    assert.match(f.clause, /translateUTF8\(lowerUTF8\(x\), 'čćžšđ', 'cczsd'\) = \{party_q:String\}, party_short/);
    assert.deepEqual(f.params, { party_q: "hdz", party_slug: "hdz" });
  });

  it("dio naziva s dijakriticima → fold u parametru, podniz nad party_names", () => {
    const f = buildPartyFilter("  Demokršćani ");
    assert.match(f.clause, /position\(translateUTF8\(lowerUTF8\(x\)[^)]*\), \{party_q:String\}\) > 0, party_names/);
    assert.equal(f.params.party_q, "demokrscani");
    assert.equal(buildPartyFilter("Domovinski pokret").params.party_slug, "domovinski-pokret");
  });

  it("kratica od 2 znaka ne traži podniz naziva (DP ne smije pogoditi SDP)", () => {
    const f = buildPartyFilter("DP");
    assert.ok(!f.clause.includes("party_names"));
    assert.ok(!f.clause.includes("position("));
  });

  it("foldParty: velika slova, čćžšđ, razmaci", () => {
    assert.equal(foldParty("  ĐAKOVAČKI   Žumberak Šć "), "dakovacki zumberak sc");
  });

  it("korisnički tekst nikad nije u SQL-u, samo u parametrima", async () => {
    const evil = "HDZ') OR 1=1 --";
    const { ch, calls } = fakeCh();
    await searchPrograms(SearchProgramsInput.parse({ query: "mirovine'; DROP TABLE x", party: evil }), {
      ch,
      embedder: fakeEmbedder(),
    });
    const sql = calls[0]!.query;
    assert.ok(!sql.includes("1=1"));
    assert.ok(!sql.includes("DROP"));
    assert.ok(!sql.toLowerCase().includes("mirovine"));
    assert.equal(calls[0]!.query_params!.party_q, "hdz') or 1=1 --");
    assert.match(sql, /cosineDistance\(embedding, \{query_vec:Array\(Float32\)\}\) AS distance/);
    assert.match(sql, /FROM program_chunks\s+WHERE \(/);
    assert.match(sql, /ORDER BY distance ASC\s+LIMIT \{limit:UInt32\}/);
    assert.deepEqual(calls[0]!.query_params!.query_vec, [0.1, 0.2, 0.3]);
  });

  it("bez stranke nema WHERE ni stranačkih parametara", async () => {
    const { ch, calls } = fakeCh();
    await searchPrograms(SearchProgramsInput.parse({ query: "mirovine", party: "  " }), {
      ch,
      embedder: fakeEmbedder(),
    });
    assert.ok(!calls[0]!.query.includes("WHERE"));
    assert.deepEqual(Object.keys(calls[0]!.query_params!).sort(), ["limit", "query_vec"]);
  });

  it("nepostojeća stranka → poruka na hrvatskom, filtar nije ispušten", async () => {
    const { ch, calls } = fakeCh(() => []);
    const args = SearchProgramsInput.parse({ query: "mirovine", party: "Stranka Mjeseca" });
    const hits = await searchPrograms(args, { ch, embedder: fakeEmbedder() });
    assert.match(calls[0]!.query, /WHERE/);
    assert.match(formatProgramHits(hits, args), /^Nije pronađen izborni program .* za stranku „Stranka Mjeseca”/);
  });
});

describe("search_programs: limit", () => {
  it("default 5, strop 20, pod 1", () => {
    assert.equal(SearchProgramsInput.parse({ query: "porez" }).limit, 5);
    assert.equal(SearchProgramsInput.parse({ query: "porez", limit: 100 }).limit, 20);
    assert.equal(SearchProgramsInput.parse({ query: "porez", limit: "7" }).limit, 7);
    assert.equal(SearchProgramsInput.parse({ query: "porez", limit: 0 }).limit, 1);
  });

  it("limit ide kao parametar upita", async () => {
    const { ch, calls } = fakeCh();
    await searchPrograms(SearchProgramsInput.parse({ query: "porez", limit: 50 }), { ch, embedder: fakeEmbedder() });
    assert.equal(calls[0]!.query_params!.limit, 20);
  });
});

describe("search_programs: formatiranje", () => {
  it("stranice: raspon, jedna, html, bez stranice", () => {
    assert.equal(pageLabel({ format: "pdf", page_from: 12, page_to: 13 }), "str. 12–13");
    assert.equal(pageLabel({ format: "pdf", page_from: 12, page_to: 12 }), "str. 12");
    assert.equal(pageLabel({ format: "pdf", page_from: 4, page_to: 0 }), "str. 4");
    assert.equal(pageLabel({ format: "html", page_from: 1, page_to: 1 }), "web stranica");
    assert.equal(pageLabel({ format: "docx", page_from: 0, page_to: 0 }), "");
  });

  it("citat je tijelo nakon prvog praznog retka, sažetih razmaka", () => {
    assert.equal(chunkBody("Naslov\n\nPrvi red\ndrugi  red\n\ntreći"), "Prvi red drugi red treći");
    assert.equal(chunkBody("bez poglavlja"), "bez poglavlja");
  });

  it("skraćivanje na granici rečenice, inače riječi, s „…”", () => {
    const s = "Prva rečenica je ovdje. Druga rečenica je malo dulja od prve i ide preko granice.";
    assert.equal(trimQuote(s, 40), "Prva rečenica je ovdje. …");
    assert.equal(trimQuote("abc defgh ijklmn opqrst uvwxyz", 20), "abc defgh ijklmn …");
    assert.equal(trimQuote("kratko", 20), "kratko");
  });

  it("koalicija, stranice, nesiguran izvor, chunk_id i sličnost", async () => {
    const { ch } = fakeCh(() => [HDZ_ROW, WAYBACK_ROW, HDZ_ROW]);
    const args = SearchProgramsInput.parse({ query: "mirovine" });
    const hits = await searchPrograms(args, { ch, embedder: fakeEmbedder() });
    assert.equal(hits.length, 2, "duplikat chunk_id-a (ReplacingMergeTree prije mergea) je izbačen");
    assert.deepEqual(hits[0]!.parties.map((p) => p.id), [258, 31, 77]);

    const out = formatProgramHits(hits, args);
    assert.match(out, /^Odlomci iz izbornih programa stranaka \(parlamentarni izbori 2024\.\) za upit „mirovine”: 2\./);
    assert.match(out, /1\. HDZ, HSLS, Hrvatski demokršćani — Program Vlade 2024\.–2028\./);
    assert.match(out, /poglavlje: Mirovinski sustav · str\. 12–13 · datum: 2024-03-20 · sličnost 0\.820/);
    assert.match(out, /„Povećat ćemo najniže mirovine za 10 posto\. Uvest ćemo obiteljsku mirovinu\.”/);
    assert.match(out, /URL: https:\/\/hdz\.hr\/program-2024\.pdf/);
    assert.match(out, /chunk_id: hdz-2024-program:12/);
    assert.match(out, /2\. Možemo — Program za zeleni grad\n {3}poglavlje: Stanovanje · web stranica · sličnost 0\.750/);
    assert.match(out, /⚠ izvor: Wayback snimka — stranica stranke više ne postoji, snimka iz travnja 2024\./);
    assert.equal(out.match(/⚠/g)?.length, 1, "siguran izvor nema napomenu");
  });
});

describe("search_programs: ožičenje u MCP serveru", () => {
  let client: Client;
  const { ch, calls } = fakeCh((sql) => (sql.includes("program_chunks") ? [WAYBACK_ROW] : []));
  const settings = parseCatalogResponse({
    version: "1",
    settings: { UCaaaaaaaaaaaaaaaaaaaaaa: { status: "active", off: ["ai_assistants"], slugs: ["domovina-tv"] } },
  });

  before(async () => {
    const server = createServer({
      config: {
        publicBaseUrl: "http://localhost:3000",
        serviceName: "domovina-podcast",
        serviceVersion: "test",
      } as unknown as Config,
      ch,
      embedder: fakeEmbedder(),
      channelSettings: staticChannelSettings(settings),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    client = new Client({ name: "test", version: "1" });
    await client.connect(ct);
  });
  after(async () => {
    await client.close();
  });

  it("alat je na popisu s opisom o obećanjima i citiranju", async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "search_programs");
    assert.ok(t, "search_programs nije registriran");
    assert.match(t.description ?? "", /OBEĆAVAJU/);
    assert.match(t.description ?? "", /citat/);
    assert.deepEqual(t.inputSchema.required, ["query"]);
  });

  it("poziv vraća formatiran tekst; postavke kanala se ne primjenjuju", async () => {
    calls.length = 0;
    const res = await client.callTool({ name: "search_programs", arguments: { query: "stanovanje", party: "možemo" } });
    assert.ok(!res.isError);
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    assert.match(text, /1\. Možemo — Program za zeleni grad/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.query_params!.hidden_channels, undefined);
    assert.ok(!calls[0]!.query.includes("NOT IN"));
  });

  it("neispravni argumenti → isError", async () => {
    const res = await client.callTool({ name: "search_programs", arguments: { query: "x" } });
    assert.equal(res.isError, true);
  });

  it("server_info navodi search_programs", async () => {
    const res = await client.callTool({ name: "server_info", arguments: {} });
    const info = JSON.parse((res.content as { text: string }[])[0]!.text) as { tools: string[] };
    assert.ok(info.tools.includes("search_programs"));
  });
});
