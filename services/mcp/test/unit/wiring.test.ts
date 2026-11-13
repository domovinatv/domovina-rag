// Ožičenje: svaki MCP alat i /api/search šalju skup isključenih kanala za SVOJ ključ.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import express from "express";

import { parseCatalogResponse, staticChannelSettings } from "../../src/channel-settings.js";
import type { Config } from "../../src/config.js";
import { mountPublicApi, parsePurpose } from "../../src/public-api.js";
import { createServer } from "../../src/server.js";
import { resetTrackedChannelsCache } from "../../src/tools/person-channel.js";
import { UC_A, UC_B, UC_C, fakeCh, fakeEmbedder, fakeMeili, fakePg, type ChCall } from "./helpers.js";

// A: AI asistenti off · B: osobe off · C: pretraga u aplikaciji off · D: vijesti off.
const UC_D = "UCdddddddddddddddddddddd";
const SETTINGS = parseCatalogResponse({
  version: "1",
  settings: {
    [UC_A]: { status: "active", off: ["ai_assistants"], slugs: ["domovina-tv"] },
    [UC_B]: { status: "active", off: ["persons_mentions"], slugs: ["kanal-b"] },
    [UC_C]: { status: "active", off: ["in_app_search"], slugs: ["kanal-c"] },
    [UC_D]: { status: "active", off: ["news_portal"], slugs: ["kanal-d"] },
  },
});

const CONFIG = {
  publicBaseUrl: "http://localhost:3000",
  serviceName: "domovina-podcast",
  serviceVersion: "test",
  publicSearchAllowedOrigins: ["https://domovina.ai"],
  publicSearchRatePerMinute: 1000,
} as unknown as Config;

/** Normalizirani skup iz zabilježenih CH parametara (oba oblika → crtica). */
function hiddenIn(calls: ChCall[]): string[] {
  const vals = new Set<string>();
  for (const c of calls) {
    for (const v of (c.query_params?.hidden_channels as string[] | undefined) ?? []) {
      vals.add(v.replace(/_/g, "-"));
    }
  }
  return [...vals].sort();
}

const realFetch = globalThis.fetch;
const quiet = console.error;
beforeEach(() => {
  console.error = () => {};
  resetTrackedChannelsCache();
});
afterEach(() => {
  console.error = quiet;
});

describe("MCP alati (ai_assistants + po alatu)", () => {
  let client: Client;
  const { ch, calls } = fakeCh();
  const m = fakeMeili();
  const pg = fakePg((sql) =>
    sql.includes("FROM speakers")
      ? [{ slug: "ana-horvat", canonical_name: "Ana Horvat", avatar_url: null, aliases: ["Ana Horvat"] }]
      : [],
  );

  before(async () => {
    globalThis.fetch = (async () => {
      throw new Error("mreža je u testovima isključena");
    }) as typeof fetch;
    const server = createServer({
      config: CONFIG,
      ch,
      embedder: fakeEmbedder(),
      pg,
      meili: m.meili,
      channelSettings: staticChannelSettings(SETTINGS),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    client = new Client({ name: "test", version: "1" });
    await client.connect(ct);
  });
  after(async () => {
    globalThis.fetch = realFetch;
    await client.close();
  });

  const cases: [string, Record<string, unknown>, string[]][] = [
    ["search_podcasts", { query: "molitva" }, ["domovina-tv"]],
    ["list_channels", {}, ["domovina-tv"]],
    ["list_episodes", {}, ["domovina-tv"]],
    ["get_episode", { youtube_id: "abcdefghijk" }, ["domovina-tv"]],
    ["count_mentions", { query: "molitva", group_by: "channel" }, ["domovina-tv"]],
    ["count_mentions", { query: "molitva", group_by: "speaker" }, ["domovina-tv", "kanal-b"]],
    ["get_person", { slug: "ana-horvat" }, ["domovina-tv", "kanal-b"]],
    ["server_info", {}, ["domovina-tv"]],
  ];
  for (const [name, args, expected] of cases) {
    it(`${name} ${JSON.stringify(args)} → ${expected.join(", ")}`, async () => {
      calls.length = 0;
      await client.callTool({ name, arguments: args });
      assert.ok(calls.length > 0, "alat nije pitao ClickHouse");
      assert.deepEqual(hiddenIn(calls), expected);
    });
  }

  it("find_in_transcript → Meili filtar s domovina-tv", async () => {
    m.calls.length = 0;
    await client.callTool({ name: "find_in_transcript", arguments: { query: "Matija" } });
    assert.equal(m.calls[0]!.params.filter, "channel NOT IN ['domovina-tv', 'domovina_tv']");
  });
});

describe("parsePurpose", () => {
  it("mapira svrhu na ključ; bez parametra = search", () => {
    assert.deepEqual(parsePurpose(undefined), { ok: true, purpose: "search", key: "in_app_search" });
    assert.deepEqual(parsePurpose(""), { ok: true, purpose: "search", key: "in_app_search" });
    assert.deepEqual(parsePurpose("assistant"), { ok: true, purpose: "assistant", key: "ai_assistants" });
    assert.deepEqual(parsePurpose(" News "), { ok: true, purpose: "news", key: "news_portal" });
  });
  it("nepoznata vrijednost i ponovljen parametar su greška", () => {
    assert.equal(parsePurpose("ai").ok, false);
    assert.equal(parsePurpose(["search", "news"]).ok, false);
    assert.equal(parsePurpose("toString").ok, false);
  });
});

describe("HTTP /api/search?purpose=", () => {
  let base = "";
  let close: () => void = () => {};
  const { ch, calls } = fakeCh();
  let settings: ReturnType<typeof parseCatalogResponse> = SETTINGS;

  before(async () => {
    const app = express();
    app.set("trust proxy", false);
    mountPublicApi(app, {
      ch,
      embedder: fakeEmbedder(),
      pg: fakePg(),
      config: CONFIG,
      channelSettings: { current: async () => settings, hidden: (k) => staticChannelSettings(settings).hidden(k) },
    });
    await new Promise<void>((resolve) => {
      const srv = app.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
        close = () => srv.close();
        resolve();
      });
    });
  });
  after(() => close());

  async function get(qs: string) {
    calls.length = 0;
    const res = await realFetch(`${base}/api/search?${qs}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it("bez purpose = search → kanal-c (in_app_search)", async () => {
    const r = await get("q=molitva");
    assert.equal(r.status, 200);
    assert.deepEqual(hiddenIn(calls), ["kanal-c"]);
  });
  it("purpose=assistant → domovina-tv (ai_assistants)", async () => {
    assert.equal((await get("q=molitva&purpose=assistant")).status, 200);
    assert.deepEqual(hiddenIn(calls), ["domovina-tv"]);
  });
  it("purpose=news → kanal-d (news_portal)", async () => {
    assert.equal((await get("q=molitva&purpose=news")).status, 200);
    assert.deepEqual(hiddenIn(calls), ["kanal-d"]);
  });
  it("mode=map poštuje purpose", async () => {
    assert.equal((await get("q=molitva&mode=map&purpose=search")).status, 200);
    assert.deepEqual(hiddenIn(calls), ["kanal-c"]);
  });
  it("nepoznat purpose → 400 s porukom, bez upita u bazu", async () => {
    const r = await get("q=molitva&purpose=vijesti");
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_purpose");
    assert.match(String(r.body.detail), /search, assistant, news/);
    assert.equal(calls.length, 0);
  });
  it("prazne postavke → nema NOT IN ni parametra", async () => {
    settings = parseCatalogResponse({ version: "1", settings: {} });
    await get("q=molitva");
    assert.equal(calls.length, 1);
    assert.ok(!calls[0]!.query.includes("NOT IN"));
    assert.equal(calls[0]!.query_params!.hidden_channels, undefined);
    settings = SETTINGS;
  });
});
