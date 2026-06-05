# A2A protokol — destilirana referenca (za implementaciju)

> **Svrha:** samodostatna tehnička referenca da možeš sagraditi vlastiti A2A server
> **bez** vraćanja na online spec. Sve sheme, metode, error kodovi i envelope su ovdje.
>
> Izvor: <https://a2a-protocol.org/latest/specification/> (scrape u `.firecrawl/a2a-specification.md`).
> Verzija specifikacije s koje je destilirano: A2A "latest" (canonical model 0.3.x).
> **VAŽNO — vidi §0 o verzijama:** realni deployment-i (uklj. Magisterium i Claude.ai
> konektor) još govore **0.2.x JSON-RPC wire shape**. Mi gradimo na 0.2.x shape. Oba su ovdje.

---

## 0. Verzije i wire-shape — KRITIČNO prije koda

A2A ima dvije "živuće" reprezentacije iste logike. Lako je pomiješati ih:

| | **0.2.x JSON-RPC** (gradimo OVO) | **0.3.x canonical (ProtoJSON)** |
|---|---|---|
| Tko koristi | Magisterium, Claude.ai konektor, službeni JS/Python SDK-ovi | "latest" spec dokument, gRPC/REST binding |
| JSON-RPC metoda | `"method": "message/send"` | `SendMessage` / REST `POST /message:send` |
| `role` vrijednost | `"user"` / `"agent"` (lowercase) | `"ROLE_USER"` / `"ROLE_AGENT"` |
| Task state | `"completed"`, `"working"`… | `"TASK_STATE_COMPLETED"`… |
| Part diskriminator | `{ "kind": "text", "text": "…" }` | `{ "text": "…" }` (oneOf bez `kind`) |
| Message marker | `"kind": "message"` | n/a |
| Well-known put | `/.well-known/agent.json` | `/.well-known/agent-card.json` |
| Field naming | camelCase | camelCase (enumi SCREAMING_SNAKE) |

**Odluka za domovina-rag:** ciljamo **0.2.x JSON-RPC shape** (jer to govori Claude.ai
konektor i službeni SDK-ovi), ali izložimo Agent Card na **oba** well-known puta.
Dolje su sheme dane u canonical obliku (iz spec-a) uz 0.2.x ekvivalent gdje se razlikuje.

---

## 1. Aktori i transport

- **A2A Client (Client Agent):** inicira komunikaciju u ime usera.
- **A2A Server (Remote Agent):** izlaže HTTP endpoint; **opaque** prema klijentu.
- **Transport:** HTTP(S). Payload = **JSON-RPC 2.0** (binding koji koristimo).
- **Content-Type:** `application/json` (0.2.x) — canonical spec spominje `application/a2a+json`.
- **Auth:** Bearer token u HTTP `Authorization` headeru, **izvan** A2A poruke (kao MCP).

---

## 2. Discovery — Agent Card

Klijent otkriva agenta dohvatom **Agent Card** JSON-a. Tri strategije:

1. **Well-Known URI** (mi koristimo ovo): `GET https://{domena}/.well-known/agent-card.json`
   (RFC 8615). Stari put `/.well-known/agent.json` — izložiti **oba**. Javno, bez autha.
2. **Curated Registry:** centralni katalog, pretraga po skills/tags. (Spec ne propisuje API.)
3. **Direct Config:** hardcoded URL (dev/privatno).

### 2.1 AgentCard shema (§4.4.1)

| Polje | Tip | Req | Opis |
|---|---|---|---|
| `name` | string | ✅ | Čitljivo ime agenta |
| `description` | string | ✅ | Što agent radi |
| `version` | string | ✅ | Verzija agenta (npr. "0.5.0") |
| `capabilities` | AgentCapabilities | ✅ | streaming / pushNotifications / extensions |
| `skills` | AgentSkill[] | ✅ | Sposobnosti agenta |
| `defaultInputModes` | string[] | ✅ | MIME tipovi inputa (npr. `["text/plain"]`) |
| `defaultOutputModes` | string[] | ✅ | MIME tipovi outputa |
| `supportedInterfaces` | AgentInterface[] | ✅* | URL+binding+protocolVersion; prvi = preferiran |
| `provider` | AgentProvider | ❌ | `{ organization, url }` |
| `securitySchemes` | map<string,SecurityScheme> | ❌ | Kako se autenticirati |
| `securityRequirements` | SecurityRequirement[] | ❌ | Koji scheme je nužan |
| `documentationUrl` | string | ❌ | Docs link |
| `iconUrl` | string | ❌ | Ikona |
| `signatures` | AgentCardSignature[] | ❌ | JWS potpis kartice (RFC 7515) |

\* U 0.2.x praksi često je samo `url` na vrhu kartice (jedan endpoint) umjesto
`supportedInterfaces[]`. Magisterium ima jedan endpoint `url`.

**AgentCapabilities (§4.4.3):** `streaming` (bool), `pushNotifications` (bool),
`extensions` (AgentExtension[]), `extendedAgentCard` (bool).

**AgentSkill (§4.4.5):**

| Polje | Tip | Req | Opis |
|---|---|---|---|
| `id` | string | ✅ | Jedinstveni ID skilla (npr. `podcast_search`) |
| `name` | string | ✅ | Čitljivo ime |
| `description` | string | ✅ | Detaljan opis |
| `tags` | string[] | ✅ | Ključne riječi |
| `examples` | string[] | ❌ | Primjeri promptova |
| `inputModes` / `outputModes` | string[] | ❌ | Override default modesa po skillu |
| `securityRequirements` | SecurityRequirement[] | ❌ | Auth specifičan za skill |

**AgentInterface (§4.4.6):** `url` (✅), `protocolBinding` (✅, `JSONRPC`\|`GRPC`\|`HTTP+JSON`),
`protocolVersion` (✅, npr. "0.3"), `tenant` (❌, multi-tenant routing).

**AgentProvider (§4.4.2):** `url` (✅), `organization` (✅).

---

## 3. Operacije (JSON-RPC metode)

Mapiranje funkcionalnosti → wire metoda (§5.3):

| Funkcija | JSON-RPC (0.3 canonical) | 0.2.x JSON-RPC (mi) | REST |
|---|---|---|---|
| Pošalji poruku | `SendMessage` | `message/send` | `POST /message:send` |
| Streaming poruka | `SendStreamingMessage` | `message/stream` | `POST /message:stream` |
| Dohvati task | `GetTask` | `tasks/get` | `GET /tasks/{id}` |
| Listaj taskove | `ListTasks` | `tasks/list` | `GET /tasks` |
| Otkaži task | `CancelTask` | `tasks/cancel` | `POST /tasks/{id}:cancel` |
| Subscribe na task | `SubscribeToTask` | `tasks/resubscribe` | `POST /tasks/{id}:subscribe` |
| Push config (C/G/L/D) | `*TaskPushNotificationConfig` | `tasks/pushNotificationConfig/*` | `…/pushNotificationConfigs` |
| Extended Agent Card | `GetExtendedAgentCard` | `agent/getAuthenticatedExtendedCard` | `GET /extendedAgentCard` |

**Za MVP trebamo samo 2 metode:** `message/send` (+ `tasks/get` za polling).
Sve ostalo (streaming, push, list, cancel) je opcionalno — Magisterium ih ne podržava.

### 3.1 `message/send` (Send Message, §3.1.1)

- **Input:** `SendMessageRequest` = `{ message, configuration?, metadata? }`.
- **Output:** `Task` (kad treba praćenje) **ILI** direktan `Message` (za trivijalan odgovor).
- **Errors:** `ContentTypeNotSupportedError`, `UnsupportedOperationError`
  (poruka u terminal task), `TaskNotFoundError`.
- **Ponašanje:** MORA vratiti odmah s task info ili response porukom; obrada MOŽE teći
  async nakon odgovora (ako vraća Task). **Mi: sinkrono → odmah `completed` Task.**

### 3.2 `tasks/get` (Get Task, §3.1.3)

- **Input:** `{ id (✅), historyLength?, tenant? }`.
- **Output:** `Task` (trenutno stanje + artifacts + opc. history).
- **Errors:** `TaskNotFoundError`.
- Koristi se za **polling** taska pokrenutog s `message/send` (jer nemamo streaming/push).

### 3.3 `SendMessageConfiguration` (§3.2.2) — opcionalni `configuration`

Polja koja klijent može poslati: `historyLength` (int), `pushNotificationConfig`,
`blocking` (bool — čekaj da task završi prije odgovora). Za sinkroni MVP ignoriramo
osim `historyLength`.

---

## 4. Data model (core objekti)

### 4.1 Task (§4.1.1)

| Polje | Tip | Req | Opis |
|---|---|---|---|
| `id` | string | ✅ | Jedinstveni ID (UUID), generira **server** |
| `contextId` | string | ❌ | Grupira povezane taskove/poruke (server-generiran) |
| `status` | TaskStatus | ✅ | `{ state, message?, timestamp? }` |
| `artifacts` | Artifact[] | ❌ | Izlazni rezultati |
| `history` | Message[] | ❌ | Povijest poruka |
| `metadata` | object | ❌ | Custom k/v |

`kind: "task"` — u 0.2.x shape Task ima diskriminator `"kind": "task"`.

### 4.2 TaskStatus (§4.1.2) + TaskState (§4.1.3)

`TaskStatus = { state (✅), message? (Message), timestamp? (ISO 8601) }`.

| TaskState (canonical) | 0.2.x | Tip stanja |
|---|---|---|
| `TASK_STATE_SUBMITTED` | `submitted` | početno |
| `TASK_STATE_WORKING` | `working` | u obradi |
| `TASK_STATE_INPUT_REQUIRED` | `input-required` | prekinuto, treba input usera |
| `TASK_STATE_AUTH_REQUIRED` | `auth-required` | prekinuto, treba auth |
| `TASK_STATE_COMPLETED` | `completed` | **terminal** — uspjeh |
| `TASK_STATE_FAILED` | `failed` | **terminal** — greška |
| `TASK_STATE_CANCELED` | `canceled` | **terminal** — otkazano |
| `TASK_STATE_REJECTED` | `rejected` | **terminal** — agent odbio |

### 4.3 Message (§4.1.4)

| Polje | Tip | Req | Opis |
|---|---|---|---|
| `messageId` | string | ✅ | UUID, kreira pošiljatelj |
| `role` | Role | ✅ | `user` (klijent→server) ili `agent` (server→klijent) |
| `parts` | Part[] | ✅ | Sadržaj poruke |
| `contextId` | string | ❌ | Veže poruku uz kontekst |
| `taskId` | string | ❌ | Veže poruku uz task |
| `metadata` | object | ❌ | **Ovdje ide `skillId`** (vidi §6) |
| `extensions` | string[] | ❌ | URI-ji ekstenzija |
| `referenceTaskIds` | string[] | ❌ | Reference na druge taskove za kontekst |

`kind: "message"` u 0.2.x shape.

### 4.4 Part (§4.1.6) — `oneof` sadržaj

Part MORA sadržavati **točno jedan** od: `text` \| `raw` (bytes, base64) \| `url` \| `data` (JSON).

| Polje | Tip | Opis |
|---|---|---|
| `text` | string | tekstualni sadržaj |
| `raw` | bytes (base64 u JSON) | inline binarni file |
| `url` | string | URI na file |
| `data` | any (JSON) | strukturirani podaci (objekt/array/…) |
| `mediaType` | string | MIME (npr. `text/plain`, `application/json`) |
| `filename` | string | ime filea (opc.) |
| `metadata` | object | dodatni kontekst po partu |

**0.2.x shape** koristi diskriminator: `{ "kind": "text", "text": "…" }`,
`{ "kind": "data", "data": {…} }`, `{ "kind": "file", "file": {…} }`.

### 4.5 Artifact (§4.1.7) — izlaz taska

| Polje | Tip | Req | Opis |
|---|---|---|---|
| `artifactId` | string | ✅ | UUID, unikatan unutar taska |
| `parts` | Part[] | ✅ | Sadržaj (≥1 part) |
| `name` | string | ❌ | Čitljivo ime |
| `description` | string | ❌ | Opis |
| `metadata` | object | ❌ | Metapodaci |
| `extensions` | string[] | ❌ | URI-ji ekstenzija |

---

## 5. Greške (JSON-RPC error kodovi)

JSON-RPC standardne: `-32700` parse, `-32600` invalid request, `-32601` method not found,
`-32602` invalid params, `-32603` internal.

A2A-specifične (§5.4):

| A2A error | JSON-RPC kod | HTTP | Kad |
|---|---|---|---|
| `TaskNotFoundError` | `-32001` | 404 | task ID ne postoji/nedostupan |
| `TaskNotCancelableError` | `-32002` | 400 | task nije u cancelable stanju |
| `PushNotificationNotSupportedError` | `-32003` | 400 | push ne podržan |
| `UnsupportedOperationError` | `-32004` | 400 | operacija ne podržana |
| `ContentTypeNotSupportedError` | `-32005` | 400 | MIME parta ne podržan |
| `InvalidAgentResponseError` | `-32006` | 500 | nevaljan odgovor agenta |
| `ExtendedAgentCardNotConfiguredError` | `-32007` | 400 | nema extended card |
| `ExtensionSupportRequiredError` | `-32008` | 400 | tražena ekstenzija |
| `VersionNotSupportedError` | `-32009` | 400 | verzija protokola ne podržana |

> Magisterium koristi i custom kodove: `UNAUTHORIZED` (`-32004` kod njih) za loš token,
> `PLAN_REQUIRED` (`-32005`) za free plan. (Pažnja: oni su prenamijenili neke kodove —
> mi se držimo gornje kanonske tablice.)

JSON-RPC error envelope:
```json
{ "jsonrpc": "2.0", "id": 1, "error": { "code": -32001, "message": "Task not found", "data": {} } }
```

---

## 6. Kako se bira skill

A2A nema zaseban "skill call" — skill se signalizira u **`message.metadata.skillId`**.
Server čita `skillId`, rutira na odgovarajuću internu funkciju. (Magisterium pattern.)

```jsonc
"message": {
  "role": "user", "messageId": "msg-001", "kind": "message",
  "parts": [{ "kind": "text", "text": "korisnikov upit" }],
  "metadata": { "skillId": "podcast_search" }
}
```

Ako `skillId` nije zadan, server bira default skill ili LLM-om klasificira intent.

---

## 7. Kanonski primjeri (copy-paste shape)

### 7.1 Sinkroni request → completed Task (0.2.x, naš ciljni shape)

**Request:**
```jsonc
POST /api/v1/a2a
Authorization: Bearer $TOKEN
Content-Type: application/json
{
  "jsonrpc": "2.0", "id": 1, "method": "message/send",
  "params": {
    "message": {
      "role": "user", "messageId": "msg-001", "kind": "message",
      "parts": [{ "kind": "text", "text": "Što je rečeno o inflaciji?" }],
      "metadata": { "skillId": "podcast_search" }
    }
  }
}
```

**Response:**
```jsonc
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "id": "task_abc123", "contextId": "ctx_def456", "kind": "task",
    "status": { "state": "completed", "timestamp": "2026-06-05T12:00:00.000Z" },
    "artifacts": [{
      "artifactId": "art_ghi789", "name": "podcast_search_response",
      "parts": [
        { "kind": "text", "text": "Pronađeno 8 segmenata o inflaciji…" },
        { "kind": "data", "data": { "results": [ /* SearchResult[] s deep_link */ ] } }
      ]
    }]
  }
}
```

### 7.2 Canonical (0.3.x) ekvivalent — za usporedbu

Request: `POST /message:send`, `"role": "ROLE_USER"`, part `{"text": "…"}` (bez `kind`).
Response: `"state": "TASK_STATE_COMPLETED"`, parts `{"text": "…"}`.

### 7.3 Polling

```jsonc
{ "jsonrpc": "2.0", "id": 2, "method": "tasks/get", "params": { "id": "task_abc123" } }
```

### 7.4 Strukturirani podaci (§6.8)

Klijent može poslati `schema` u `part.metadata` da zatraži output u zadanom JSON
obliku; agent vraća `data` part koji odgovara shemi. Korisno za agent-to-agent gdje
orkestrator hoće mašinski-čitljiv rezultat (npr. naš `SearchResult[]`).

---

## 8. Sigurnosne sheme (§4.5)

SecurityScheme je discriminated union (OpenAPI 3.2 stil). Tipovi:

- **OAuth2** (`OAuth2SecurityScheme`): `flows` (authorizationCode / clientCredentials /
  deviceCode). **Mi koristimo ovo** — reuse postojećeg `auth.ts`.
- **HTTP** (`HTTPAuthSecurityScheme`): `scheme: "bearer"`, `bearerFormat`.
- **APIKey** (`APIKeySecurityScheme`): `in` (header/query/cookie), `name`.
- **OpenIdConnect**, **MutualTLS**.

Auth zahtjevi se **deklariraju u Agent Card** (`securitySchemes` + `securityRequirements`),
a kredencijali se šalju u HTTP headerima — **odvojeno** od A2A poruke (§2.4, §7).

OAuth metadata se objavljuje na `/.well-known/oauth-authorization-server` (već imamo
preko `mcpAuthRouter` u `auth.ts`). Klijent koji zna Authorization Code + PKCE flow
dobije token i šalje `Authorization: Bearer …`.

---

## 9. Konvencije serijalizacije (§5.5–5.6)

- **camelCase** za sva imena polja (`protocolVersion`, `contextId`, `defaultInputModes`).
- **Enumi** kao string (canonical: SCREAMING_SNAKE `TASK_STATE_COMPLETED`; 0.2.x: `completed`).
- **Timestamps:** ISO 8601 UTC (`"2026-06-05T12:00:00Z"`).
- **Idempotentnost (§3.3.1):** `tasks/get`, `tasks/cancel` su idempotentni; `message/send`
  nije (svaki poziv može stvoriti novi task).

---

## 10. Minimalni checklist za "vlastiti A2A server"

Da bi server bio A2A-compliant za sinkroni retrieval use-case (naš), treba:

- [ ] **Agent Card** JSON na `/.well-known/agent-card.json` (+ `/.well-known/agent.json`).
- [ ] **HTTP POST endpoint** koji prima JSON-RPC 2.0 envelope.
- [ ] **`message/send`** → kreiraj Task, izvrši skill, vrati `completed` Task s artifacts.
- [ ] **`tasks/get`** → vrati pohranjeni Task po `id` (polling).
- [ ] **Bearer auth** na endpointu (reuse OAuth iz `auth.ts`).
- [ ] **Skill routing** preko `message.metadata.skillId`.
- [ ] **Error mapping** na JSON-RPC kodove (§5).
- [ ] (opc.) Task store (in-memory TTL ili PG `a2a_tasks`) da `tasks/get` radi nakon restarta.
- [ ] (opc. kasnije) `message/stream` (SSE), push notifications, `tasks/list`/`cancel`.

Sve ostalo (gRPC binding, extended card, ekstenzije, JWS potpisi kartice) je izvan
MVP-a i Magisterium ih ne implementira.

---

## Dodatak: gdje u spec-u

| Tema | §spec | Lokalni izvor |
|---|---|---|
| Operacije (metode) | 3.1 | `.firecrawl/a2a-specification.md:144` |
| Data model (Task/Message/Part/Artifact) | 4.1 | `…:850` |
| Agent discovery objekti (AgentCard…) | 4.4 | `…:1035` |
| Security objekti | 4.5 | `…:1125` |
| Method mapping | 5.3 | `…:1395` |
| Error kodovi | 5.4 | `…:1411` |
| Serijalizacija/naming | 5.5 | `…:1437` |
| Primjeri (basic/streaming/structured) | 6.1–6.8 | `…:1544` |
| Auth & authz | 7 | `…:2107` |
| Life of a Task | — | `.firecrawl/a2a-life-of-a-task.md` |
