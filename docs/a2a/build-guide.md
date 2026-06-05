# Build guide — vlastiti A2A server nad domovina-rag podacima (Faza 1)

> Konkretni, implementacijski plan kako izložiti `domovina-rag` kao A2A *server* (peer
> agent) reuse-ajući postojeću MCP infrastrukturu. Tehnička podloga: [`protocol-reference.md`](protocol-reference.md).
> Blueprint: Magisterium A2A (vidi [`comparison-and-vision.md`](comparison-and-vision.md) §3).
>
> **Princip:** A2A je tanki JSON-RPC sloj povrh logike koju MCP alati već imaju.
> Nula novih baza, nula novih servisa. Dijelimo auth, rate-limit, embedder, CH/PG.

---

## 0. Što već imamo i reuse-amo (iz `services/mcp/src/`)

| Komponenta | Datoteka | A2A reuse |
|---|---|---|
| OAuth 2.1 + DCR provider | `auth.ts` | isti `verifyAccessToken` štiti A2A endpoint |
| OAuth metadata `/.well-known/oauth-authorization-server` | `auth.ts` (mcpAuthRouter) | Agent Card upućuje na isti issuer |
| Bearer middleware | `index.ts` (`requireBearerAuth`) | wrap A2A endpoint istim |
| Rate limiting | `rate-limit.ts` | per-client_id, isti pool |
| Audit log | `auth.ts` (`recordAccess`) | A2A pozivi loginju u `oauth_audit_log` |
| Embedder klijent | `embedder.ts` | skill `podcast_search` ga zove |
| CH/PG poolovi | `db.ts` | retrieval logika |
| Tool logika | `tools/*.ts` | **postaje skill core** (refactor → §2) |
| Dataset stats | `tools/server-info.ts` | Agent Card statistika |

---

## 1. Struktura (nove datoteke)

```
services/mcp/src/
  a2a/
    agent-card.ts     # gradi AgentCard JSON (reuse dataset stats)
    server.ts         # JSON-RPC handler: message/send + tasks/get
    skills.ts         # skillId → core funkcija mapping
    tasks.ts          # task store (in-memory TTL za MVP; PG kasnije)
    types.ts          # A2A tipovi (Task, Message, Part, Artifact, JSON-RPC envelope)
```

Plus izmjene u `index.ts` (montiranje ruta) i refactor u `tools/*.ts` (§2).

---

## 2. Refactor: odvoji skill core od MCP wrappera

Trenutno `tools/search-podcasts.ts` sadrži i Zod shemu, i CH logiku, i (u `server.ts`)
MCP `CallTool` wrapper. Izvuci **čistu funkciju** koju zovu i MCP i A2A:

```ts
// tools/search-podcasts.ts — već postoji searchPodcasts() core; samo osiguraj da je
// export-an kao čista funkcija (args) => Promise<SearchResult[]>, neovisna o MCP-u.
export async function searchPodcasts(
  args: SearchArgs,
  deps: { ch: ClickHouseClient; embedder: EmbedderClient }
): Promise<SearchResult[]> { /* postojeća logika */ }
```

Onda:
- **MCP** (`server.ts` CallTool): `searchPodcasts(args, deps)` → `JSON.stringify` u text content.
- **A2A** (`a2a/skills.ts`): `searchPodcasts(args, deps)` → Artifact s `text` + `data` part.

Isti pattern za `countMentions`, `getEpisode`, `listEpisodes`, `listChannels`.

---

## 3. `a2a/skills.ts` — skill registry

```ts
// Mapira A2A skillId na core funkciju + oblikuje Artifact.
export const A2A_SKILLS = {
  podcast_search: {
    name: "podcast_search_response",
    run: async (text, meta, deps) => {
      const results = await searchPodcasts({ query: text, ...meta }, deps);
      return artifact("podcast_search_response", [
        textPart(summarize(results)),          // ljudski sažetak hitova
        dataPart({ results }),                  // mašinski: SearchResult[] + deep_link
      ]);
    },
  },
  mention_analytics: {
    name: "mention_analytics_response",
    run: async (text, meta, deps) => {
      const counts = await countMentions({ query: text, group_by: meta.group_by ?? "month", ...meta }, deps);
      return artifact("mention_analytics_response", [textPart(summarize(counts)), dataPart({ counts })]);
    },
  },
  episode_lookup: {
    name: "episode_lookup_response",
    run: async (text, meta, deps) => {
      const ep = await getEpisode({ youtube_id: meta.youtube_id ?? extractId(text), ...meta }, deps);
      return artifact("episode_lookup_response", [textPart(ep.metadata.title), dataPart(ep)]);
    },
  },
} as const;
```

Mapiranje skill → postojeća funkcija:

| A2A skill | Core funkcija | Artifact |
|---|---|---|
| `podcast_search` | `searchPodcasts()` | `text` sažetak + `data` (SearchResult[]) |
| `mention_analytics` | `countMentions()` | `text` + `data` (MentionCount[]) |
| `episode_lookup` | `getEpisode()` | `text` (naslov) + `data` (transcript) |

---

## 4. `a2a/server.ts` — JSON-RPC handler

```ts
import { A2A_SKILLS } from "./skills.js";
import { createTask, getTask } from "./tasks.js";

export function handleA2A(deps) {
  return async (req, res) => {
    const { id, method, params } = req.body ?? {};
    try {
      if (method === "message/send") {
        const msg = params?.message;
        const skillId = msg?.metadata?.skillId;
        const skill = A2A_SKILLS[skillId];
        if (!skill) return res.json(rpcError(id, -32602, `Unknown skillId: ${skillId}`));
        const text = msg.parts?.find(p => p.kind === "text")?.text ?? "";
        const artifact = await skill.run(text, msg.metadata ?? {}, deps);
        const task = createTask({ artifacts: [artifact], state: "completed" }); // sinkrono
        return res.json(rpcResult(id, task));
      }
      if (method === "tasks/get") {
        const task = getTask(params?.id);
        if (!task) return res.json(rpcError(id, -32001, "Task not found"));
        return res.json(rpcResult(id, task));
      }
      return res.json(rpcError(id, -32601, "Method not found"));
    } catch (e) {
      return res.json(rpcError(id, -32603, e.message ?? "Internal error"));
    }
  };
}
```

Helperi (`rpcResult`, `rpcError`, `textPart`, `dataPart`, `artifact`, `createTask`)
prate sheme iz [`protocol-reference.md`](protocol-reference.md) §4, §5, §7 (0.2.x shape:
`kind` diskriminatori, lowercase `state`/`role`).

---

## 5. `a2a/agent-card.ts`

```ts
export async function buildAgentCard(deps, publicBaseUrl) {
  const stats = await datasetStats(deps.ch);   // reuse iz server-info.ts
  return {
    name: "Domovina Podcast Agent",
    description: `Hrvatski podcast korpus — ${stats.episodes} epizoda, ${stats.channels} kanala. Semantička pretraga, transkripti, analiza spominjanja.`,
    version: "0.5.0",
    provider: { organization: "DOMOVINA.ai", url: "https://domovina.ai" },
    url: `${publicBaseUrl}/api/v1/a2a`,                 // 0.2.x: jedan endpoint
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: true },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain", "application/json"],
    securitySchemes: { oauth2: { type: "oauth2", flows: { authorizationCode: {
      authorizationUrl: `${publicBaseUrl}/authorize`,
      tokenUrl: `${publicBaseUrl}/token`,
      scopes: {},
    }}}},
    security: [{ oauth2: [] }],
    skills: [
      { id: "podcast_search", name: "Semantička pretraga podcasta",
        description: "Vrati relevantne segmente s deep-linkovima i relevance scoreom.",
        tags: ["search","rag","croatian","podcast"],
        examples: ["Što je rečeno o inflaciji?","Pronađi rasprave o EU fondovima"] },
      { id: "mention_analytics", name: "Analiza spominjanja",
        description: "Agregira spominjanja teme po kanalu/govorniku/mjesecu.",
        tags: ["analytics","trends"],
        examples: ["Kako se mijenjalo spominjanje inflacije kroz 2025?"] },
      { id: "episode_lookup", name: "Dohvat epizode",
        description: "Puni metadata + transkript po youtube_id.",
        tags: ["lookup","transcript"], examples: ["Daj mi transkript epizode dQw4w9WgXcQ"] },
    ],
  };
}
```

---

## 6. Montiranje u `index.ts`

```ts
import { buildAgentCard } from "./a2a/agent-card.js";
import { handleA2A } from "./a2a/server.js";

// Agent Card — javno, bez autha, na OBA puta
const cardHandler = async (_req, res) => res.json(await buildAgentCard(deps, publicBaseUrl));
app.get("/.well-known/agent-card.json", cardHandler);   // novi standard
app.get("/.well-known/agent.json", cardHandler);        // Magisterium-style alias

// A2A JSON-RPC endpoint — iza istog Bearer middlewarea + rate limita kao MCP
app.post("/api/v1/a2a",
  requireBearerAuth({ verifier: oauthProvider }),
  rateLimitMiddleware,                 // reuse rate-limit.ts
  handleA2A(deps));
```

`/.well-known/oauth-authorization-server` već postoji (mcpAuthRouter) → Agent Card
samo upućuje na njega.

---

## 7. `a2a/tasks.ts` — task store

MVP: in-memory Map s TTL (sinkroni taskovi su odmah `completed`, `tasks/get` služi
samo za kratko-trajni polling/retry):

```ts
const tasks = new Map();  // id → Task
export function createTask({ artifacts, state }) {
  const id = `task_${randomId()}`, contextId = `ctx_${randomId()}`;
  const task = { id, contextId, kind: "task",
    status: { state, timestamp: new Date().toISOString() }, artifacts };
  tasks.set(id, task);
  setTimeout(() => tasks.delete(id), 15 * 60_000).unref();  // 15 min TTL
  return task;
}
export const getTask = (id) => tasks.get(id) ?? null;
```

**Kasnije (ako treba persist nakon restarta / audit):** PG tablica `a2a_tasks`
(`id`, `context_id`, `client_id`, `skill_id`, `state`, `artifacts jsonb`, `created_at`).
Migracija ide u `infra/postgres/migrations/` (vidi memory `lessons_pg_init_sql_not_rerun`).

---

## 8. Testiranje (kao Magisterium quick example)

```bash
# 1. Agent Card discovery
curl https://mcp.domovina.ai/.well-known/agent-card.json | jq .

# 2. Pozovi skill (treba OAuth token; static API key NE radi za A2A po Magisterium konvenciji —
#    ali kod nas static key dijeli isti verifier, pa MOŽE raditi — odluči svjesno)
curl -X POST https://mcp.domovina.ai/api/v1/a2a \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{
       "role":"user","messageId":"m1","kind":"message",
       "parts":[{"kind":"text","text":"Što je rečeno o inflaciji?"}],
       "metadata":{"skillId":"podcast_search"}}}}' | jq .

# 3. Polling
curl -X POST https://mcp.domovina.ai/api/v1/a2a \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tasks/get","params":{"id":"task_..."}}' | jq .
```

Dodaj e2e set u `services/mcp/test/e2e/` (postoji rig — vidi memory `project_e2e_test_set`),
i pokreni protiv prod-a prije push-a (memory `feedback_mcp_e2e_before_push`).

---

## 9. Deploy

- Bump `package.json` na **v0.5.0**.
- A2A je dio istog MCP servisa → ide kroz isti Coolify Application rolling deploy
  (memory `project_mcp_application_split`). Ne dira compose.
- Lokalni dev: `docker-compose.dev.yml` override + `npm run dev:http`.

---

## 10. Redoslijed implementacije (checklist)

- [ ] 1. Refactor `tools/*.ts` → čiste core funkcije (§2)
- [ ] 2. `a2a/types.ts` — Task/Message/Part/Artifact/JSON-RPC tipovi (§4 reference)
- [ ] 3. `a2a/tasks.ts` — in-memory store (§7)
- [ ] 4. `a2a/skills.ts` — 3 skilla (§3)
- [ ] 5. `a2a/agent-card.ts` (§5)
- [ ] 6. `a2a/server.ts` — handler (§4)
- [ ] 7. Montaža u `index.ts` (§6)
- [ ] 8. e2e test (§8)
- [ ] 9. Bump v0.5.0 + deploy (§9)

Procjena: S–M. Najveći dio je refactor (1) i sheme (2); ostalo je tanki glue.
Sve iza je **Faza B** (multi-agent orkestracija) — vidi [`comparison-and-vision.md`](comparison-and-vision.md) §4-B.
