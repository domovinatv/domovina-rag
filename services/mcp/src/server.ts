// MCP Server factory — registrira tool-ove, mapira CallTool requeste, vraća Server instancu.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ClickHouseClient } from "@clickhouse/client";

import type { Config } from "./config.js";
import type { EmbedderClient } from "./embedder.js";
import {
  searchPodcasts,
  SearchPodcastsInput,
  searchPodcastsJsonSchema,
} from "./tools/search-podcasts.js";
import {
  listChannels,
  ListChannelsInput,
  listChannelsJsonSchema,
} from "./tools/list-channels.js";
import {
  getEpisode,
  GetEpisodeError,
  GetEpisodeInput,
  getEpisodeJsonSchema,
} from "./tools/get-episode.js";
import {
  listEpisodes,
  ListEpisodesInput,
  listEpisodesJsonSchema,
} from "./tools/list-episodes.js";


export interface ServerDeps {
  config: Config;
  ch: ClickHouseClient;
  embedder: EmbedderClient;
}


export function createServer(deps: ServerDeps): Server {
  // `icons` + `title` + `websiteUrl` su standardna polja Implementation-a iz MCP
  // schema 2025-11-25 — claude.ai i druge UI klijente čitaju ih iz initialize
  // response-a i prikazuju brand logo (umjesto default globe ikone).
  //
  // Base URL se izvodi iz `MCP_PUBLIC_BASE_URL` (npr. https://mcp.domovina.ai
  // ili https://mcp.domovina.link) — isti kod servira oba deploy targeta.
  const baseUrl = deps.config.publicBaseUrl.replace(/\/$/, "");
  const server = new Server(
    {
      name: deps.config.serviceName,
      version: deps.config.serviceVersion,
      title: "DOMOVINA.ai Podcast MCP",
      websiteUrl: `${baseUrl}/`,
      icons: [
        { src: `${baseUrl}/icon.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
        { src: `${baseUrl}/icon-512.png`, mimeType: "image/png", sizes: ["512x512"] },
        { src: `${baseUrl}/icon-192.png`, mimeType: "image/png", sizes: ["192x192"] },
      ],
    },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "search_podcasts",
        description:
          "Semantic search hrvatskog katoličkog/političkog podcast korpusa. " +
          "Vraća chunkove transkripta s deep linkovima na YouTube vrijeme. " +
          "Koristi za pitanja tipa 'što je X rekao o Y' ili 'gdje se spominje Z'. " +
          "Za upite o specifičnim osobama/terminima koristi `lexical_terms` " +
          "argument za hybrid retrieval (semantic + token filter).",
        inputSchema: searchPodcastsJsonSchema,
      },
      {
        name: "list_channels",
        description:
          "Vrati listu svih dostupnih kanala u korpusu sa statistikama (broj " +
          "epizoda, broj chunkova, prvi/zadnji upload). Koristi za pregled " +
          "korpusa i za biranje validnog `channel` slug-a u search_podcasts " +
          "filteru.",
        inputSchema: listChannelsJsonSchema,
      },
      {
        name: "list_episodes",
        description:
          "Vrati listu epizoda korpusa (distinct po youtube_id-u) s metapodacima " +
          "(naslov, kanal, datum, trajanje, govornici, broj chunkova). Podržava " +
          "filter po kanalu, govorniku, datumu objave i sortiranje po datumu, " +
          "trajanju ili veličini. Use case: 'tko gostuje u kanalu X', 'najnovije " +
          "epizode iz svibnja', 'browse korpusa bez specifičnog upita'.",
        inputSchema: listEpisodesJsonSchema,
      },
      {
        name: "get_episode",
        description:
          "Dohvati metapodatke, poglavlja i (po želji) cijeli transkript za jednu " +
          "epizodu prema YouTube ID-u. Vraća naslov, govornike, trajanje, popis " +
          "poglavlja (outline chunkovi) i transkript po segmentima s timestamp-ima. " +
          "Za duge epizode (>80K char) bez `view_range`-a, transkript je izostavljen " +
          "uz upit da se dohvati po dijelovima. Koristi za doktrinarnu/temeljnu " +
          "analizu cijele epizode kad search_podcasts vraća premali coverage.",
        inputSchema: getEpisodeJsonSchema,
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === "search_podcasts") {
      const parsed = SearchPodcastsInput.safeParse(req.params.arguments);
      if (!parsed.success) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Invalid arguments: ${parsed.error.message}` },
          ],
        };
      }
      try {
        const results = await searchPodcasts(parsed.data, {
          ch: deps.ch,
          embedder: deps.embedder,
        });
        return {
          content: [
            { type: "text", text: JSON.stringify(results, null, 2) },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text", text: `search_podcasts failed: ${msg}` }],
        };
      }
    }

    if (req.params.name === "list_episodes") {
      const parsed = ListEpisodesInput.safeParse(req.params.arguments ?? {});
      if (!parsed.success) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Invalid arguments: ${parsed.error.message}` },
          ],
        };
      }
      try {
        const results = await listEpisodes(parsed.data, { ch: deps.ch });
        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text", text: `list_episodes failed: ${msg}` }],
        };
      }
    }

    if (req.params.name === "get_episode") {
      const parsed = GetEpisodeInput.safeParse(req.params.arguments ?? {});
      if (!parsed.success) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `VALIDATION_ERROR: ${parsed.error.issues
                .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
                .join("; ")}`,
            },
          ],
        };
      }
      try {
        const result = await getEpisode(parsed.data, { ch: deps.ch });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        if (err instanceof GetEpisodeError) {
          return {
            isError: true,
            content: [{ type: "text", text: `${err.code}: ${err.message}` }],
          };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text", text: `STORAGE_ERROR: ${msg}` }],
        };
      }
    }

    if (req.params.name === "list_channels") {
      const parsed = ListChannelsInput.safeParse(req.params.arguments ?? {});
      if (!parsed.success) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Invalid arguments: ${parsed.error.message}` },
          ],
        };
      }
      try {
        const results = await listChannels(parsed.data, { ch: deps.ch });
        return {
          content: [
            { type: "text", text: JSON.stringify(results, null, 2) },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text", text: `list_channels failed: ${msg}` }],
        };
      }
    }

    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
    };
  });

  return server;
}
