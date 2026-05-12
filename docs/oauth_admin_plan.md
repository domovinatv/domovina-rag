# OAuth admin endpoints + token revocation UI

> **Scope:** TODO #7 (admin REST endpoints) i #8 (token revocation web UI) iz
> [`status_snapshot.md`](../) → Faza 4.
> **Servis:** `services/mcp` (Node 22 + Express + PG, već ima sav OAuth state).
> **Verzija plana:** v1, 2026-05-12.
> **Pretpostavke:** [[project-oauth-dcr-implementation]] live u v0.3.0 — PG-backed
> `oauth_clients` / `oauth_access_tokens` / `oauth_refresh_tokens` /
> `oauth_authorization_codes` / `oauth_audit_log` već postoje
> (vidi `infra/postgres/init.sql` r. 81-170).

## TL;DR

Dodajemo `/admin` namespace u postojeći `services/mcp/src/index.ts`:

- **REST API** pod `/admin/api/*` — list clients, list tokens, revoke client/token, audit query.
- **HTML UI** pod `/admin` (server-rendered, Express HTML templates) — minimalni
  dashboard: lista DCR clients, gumb "Revoke", recent audit log.
- **Auth**: poseban `ADMIN_API_KEY` env var (Bearer header), **NE** OAuth flow.
  Admin operacije nisu protected resource pristup nego authorization-server
  management — drugi trust boundary. Solo deploy → jedan ključ, bez user
  account-a, bez sessions.

```
                      ADMIN_API_KEY (Bearer)
                              │
                              ▼
┌──────────────────────────────────────────┐
│ /admin                  → HTML dashboard │
│ /admin/api/clients      → GET, DELETE    │
│ /admin/api/tokens       → GET, DELETE    │
│ /admin/api/audit        → GET (paginated)│
│ /admin/api/stats        → GET (summary)  │
└──────────────────────────────────────────┘
       │
       ▼
PG: oauth_clients, oauth_access_tokens, oauth_refresh_tokens, oauth_audit_log
```

## Što NE radimo (out-of-scope za sad)

| Stavka | Zašto ne |
|---|---|
| Multi-user admin s rolama | Solo dev, jedan ADMIN_API_KEY je dovoljan |
| Login form / session cookies | Bearer header iz curl/browser DevTools je OK; HTML UI radi `Authorization` header preko `fetch()` + saved API key u localStorage (UI-side) |
| OAuth-protected admin (npr. scope `admin`) | Indirektnost koja kosi s razlogom — admin operacije ne traže audit log na sebi (postoji `oauth_audit_log` koji to već radi) |
| Bulk operacije (revoke all expired, prune all clients) | Defer-ano u cron job — admin UI ostaje human-only |
| Edit client metadata | Read+delete je dovoljno; Claude.ai DCR re-registrira po potrebi |
| Rate limiting po IP-u | Defer u Faza 4 #9 (zaseban issue) |

## Auth model

```ts
// services/mcp/src/admin-auth.ts
export function requireAdmin(req, res, next) {
  const expected = config.adminApiKey;
  if (!expected) {
    res.status(404).end();        // 404 ako admin nije configured (ne 401 → no fingerprint)
    return;
  }
  const auth = req.header("authorization") ?? "";
  if (auth !== `Bearer ${expected}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}
```

- `ADMIN_API_KEY` env var. Generiraj `openssl rand -base64 32 | tr -d '/=+' | cut -c1-32`.
- Ako env var nije set, `/admin*` vraća `404` — admin disabled (default; explicit opt-in).
- Constant-time compare je preferirano, ali za 32-byte key i jedan request stranica
  nije timing-attack viable; `===` je dovoljno za v1. (Upgrade na `crypto.timingSafeEqual`
  ako parano krene.)

**Coolify deploy**: dodaj `ADMIN_API_KEY` u Environment Variables tab, restart MCP container.

## REST endpoints

Sve pod `/admin/api/*`, prefix middleware `requireAdmin`, returns JSON.

### 1. `GET /admin/api/stats`

Summary dashboard counters.

```json
{
  "clients_total": 12,
  "clients_dcr": 11,            // excludes static-api-key
  "tokens_active": 8,           // expires_at > now()
  "tokens_expired": 4,
  "requests_24h": 1842,
  "requests_1h": 73,
  "errors_24h": 12,
  "p95_latency_ms_24h": 184
}
```

Jedna PG query (CTE ili UNION ALL), runs in <50ms na indeksima koji već postoje.

### 2. `GET /admin/api/clients`

```
GET /admin/api/clients?include_static=false&limit=100
```

```json
{
  "clients": [
    {
      "client_id": "kK8c...",
      "client_name": "Claude.ai",
      "client_id_issued_at": "2026-05-10T14:23:11Z",
      "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
      "active_tokens": 1,
      "total_requests": 421,
      "last_used_at": "2026-05-12T17:08:33Z"
    },
    …
  ],
  "next_cursor": null
}
```

SQL:
```sql
SELECT c.client_id, c.client_name, c.client_id_issued_at, c.redirect_uris,
       COUNT(t.token_hash) FILTER (WHERE t.expires_at > now()) AS active_tokens,
       COALESCE(SUM(t.request_count), 0) AS total_requests,
       MAX(t.last_used_at) AS last_used_at
FROM oauth_clients c
LEFT JOIN oauth_access_tokens t ON c.client_id = t.client_id
WHERE ($1::boolean OR c.client_id != 'static-api-key')
GROUP BY c.client_id
ORDER BY MAX(t.last_used_at) DESC NULLS LAST
LIMIT $2;
```

### 3. `DELETE /admin/api/clients/:client_id`

Full revocation per klijentu.

- ON DELETE CASCADE na `oauth_clients` → automatski briše `oauth_authorization_codes`,
  `oauth_access_tokens`, `oauth_refresh_tokens` (FK constraint već postoji).
- Audit log ostaje (nema FK, samo denormalizirani client_id) — historija se ne briše.
- `static-api-key` je **zaštićen**: 403 ako client_id == 'static-api-key' (ne briše se,
  inače cijeli MCP smoke test pada).

```ts
if (clientId === STATIC_KEY_CLIENT_ID) {
  res.status(403).json({ error: "static-api-key is system-managed" });
  return;
}
const r = await pg.query("DELETE FROM oauth_clients WHERE client_id = $1", [clientId]);
res.json({ deleted: r.rowCount });
```

### 4. `GET /admin/api/tokens`

```
GET /admin/api/tokens?client_id=kK8c...&active=true&limit=100
```

```json
{
  "tokens": [
    {
      "token_hash_prefix": "a3f8c1...",   // prvih 8 char hash-a za UI prikaz
      "client_id": "kK8c...",
      "scopes": ["mcp"],
      "request_count": 421,
      "last_used_at": "2026-05-12T17:08:33Z",
      "expires_at": "2026-05-19T17:08:33Z",
      "is_expired": false
    }
  ]
}
```

Raw `token_hash` ne vraćamo da bismo izbjegli replay ako leak iz admin response-a — prikazuje
se samo prvih 8 hex znakova kao identifikator.

### 5. `DELETE /admin/api/tokens/:token_hash_prefix`

Revoke specifični token po prefix-u.

- Body alternativa: `DELETE /admin/api/tokens` s `{"token_hash": "full-hash"}` ako želiš
  egzaktan match (sigurnije ako više tokena dijeli prefix).
- Implementiraj prefix lookup s `WHERE token_hash LIKE $1 || '%'` i return greška ako >1 match.
- Briše i pripadni refresh_token istog client_id-a? **Ne**: refresh_token je odvojen identifier
  (drugi hash). User pita zasebno preko `/admin/api/refresh-tokens` ako treba — defer u v2.

### 6. `GET /admin/api/audit`

Paginated audit log query (read-only).

```
GET /admin/api/audit?client_id=kK8c...&since=2026-05-12T00:00:00Z&status_code_gte=400&limit=100&before_id=12345
```

```json
{
  "entries": [
    {
      "id": 12344,
      "timestamp": "2026-05-12T17:08:33Z",
      "client_id": "kK8c...",
      "method": "POST",
      "path": "/mcp",
      "status_code": 200,
      "latency_ms": 184,
      "ip": "203.0.113.42",
      "user_agent": "Claude/1.0 ..."
    }
  ],
  "next_before_id": 12244
}
```

Pagination preko `before_id` cursor-a (efikasnije od OFFSET na BIGSERIAL PK).

## HTML UI

Server-rendered Express + plain HTML strings (bez React/Vue/template engine-a). Solo
dev project — minimalna komplikacija pobjeđuje. Sva interaktivnost preko `fetch()` +
nekoliko inline `<script>` blokova.

### `GET /admin` — dashboard

```
┌────────────────────────────────────────────────────────────────┐
│ Domovina MCP Admin                                  [Logout]  │
├────────────────────────────────────────────────────────────────┤
│ Stats (last 24h)                                               │
│   Clients: 12 (11 DCR + 1 static)                             │
│   Active tokens: 8     Expired: 4                              │
│   Requests: 1842       Errors: 12 (0.7%)                      │
│   P95 latency: 184 ms                                          │
│                                                                │
│ Clients ───────────────────────────────────────────────────── │
│ client_id        name        active  reqs   last_used         │
│ kK8c...          Claude.ai   1       421   2 min ago  [Revoke]│
│ jH3p...          mcp-remote  1       89    1 h ago    [Revoke]│
│ static-api-key   (system)    1       312   30 sec ago         │
│ …                                                              │
│                                                                │
│ Recent audit (last 50) ──────────────────────────────────────│
│ 17:08:33  kK8c...  POST /mcp        200  184ms  203.0.113.42 │
│ 17:08:12  kK8c...  POST /mcp        200  167ms                │
│ 17:07:55  jH3p...  POST /mcp        500   58ms  ⚠            │
│ …                                                              │
└────────────────────────────────────────────────────────────────┘
```

**Realizacija:**
- Single HTML page (`services/mcp/src/admin/index.html.ts` — TypeScript template literal).
- `<script>` na page-u: prompt za API key na first load → spremi u `localStorage`
  (`mcp_admin_api_key`). Sve `fetch()` calls dodaju Bearer header iz localStorage-a.
- Revoke gumb → `fetch('/admin/api/clients/' + id, {method:'DELETE'})` → reload table.
- Audit refresh poll opcionalan (defer); v1 = manual refresh.

### `GET /admin/login` (opcionalno, v1.5)

Ako user u localStorage nema key → preusmjeri na minimalan login form koji uzme API key,
spremi u localStorage, redirect na `/admin`. Bez server session-a. v1: skip — page sam
prompta `prompt("Admin API key:")` na first load.

## Implementacijski koraci

Redoslijed je prirodan flow; svaki korak je commit-able zasebno.

### Korak 1: config + auth middleware (15 min)

- `services/mcp/src/config.ts`: dodaj `adminApiKey: string | null` iz `process.env.ADMIN_API_KEY ?? null`.
- `services/mcp/src/admin-auth.ts`: novi file s `requireAdmin` middleware-om.
- Commit: `feat(mcp): admin auth middleware skeleton`

### Korak 2: stats + clients endpoints (45 min)

- `services/mcp/src/admin/handlers.ts`: `getStats`, `listClients`, `deleteClient`.
- `services/mcp/src/index.ts`: mount-aj `app.get('/admin/api/stats', requireAdmin, …)` itd.
- Test: curl s `Authorization: Bearer $ADMIN_API_KEY` → JSON.
- Test: bez header-a → 401; bez `ADMIN_API_KEY` env-a → 404.
- Commit: `feat(mcp): admin API for clients + stats`

### Korak 3: tokens + audit endpoints (30 min)

- `listTokens`, `revokeToken`, `getAuditLog` u handlers.ts.
- Prefix-based token lookup s ambiguity guard.
- Commit: `feat(mcp): admin API for tokens + audit log`

### Korak 4: HTML dashboard (60 min)

- `services/mcp/src/admin/index.html.ts`: HTML template literal.
- Mount `app.get('/admin', requireAdmin, (req,res) => res.type('html').send(renderAdminPage()))`.
- Inline JS: prompt API key, store in localStorage, render tables iz API-a.
- Style: minimal inline CSS, sistemski font, table + buttons. Bez bundler-a.
- Commit: `feat(mcp): admin HTML dashboard`

### Korak 5: docs + memory + env example (15 min)

- `README.md` (root): dodaj sekciju "Admin dashboard" s URL-om i kako se postavlja key.
- `.env.example`: dodaj `ADMIN_API_KEY=` placeholder s komentarom.
- `MEMORY.md` + new `memory/project_oauth_admin_dashboard.md`: što je, koje query-je
  podržava, kako se autorizira.
- Update `status_snapshot.md`: prebaci #7 i #8 iz ⏳ u ✅.
- Commit: `docs(mcp): document admin dashboard`

**Total estimirano vrijeme:** ~2.5h za solo dev.

## Acceptance kriteriji

- [ ] `curl -H "Authorization: Bearer $ADMIN_API_KEY" https://mcp.domovina.ai/admin/api/stats`
      vraća JSON s 8 brojeva.
- [ ] `curl -H "Authorization: Bearer wrong" https://mcp.domovina.ai/admin/api/stats`
      vraća 401.
- [ ] Bez `ADMIN_API_KEY` env-a, `/admin` i `/admin/api/*` vraćaju **404** (admin
      disabled, ne fingerprint-aj).
- [ ] `DELETE /admin/api/clients/{id}` cascade-briše tokens i refresh tokens (provjeri
      `SELECT COUNT(*) FROM oauth_access_tokens WHERE client_id=...` = 0).
- [ ] `DELETE /admin/api/clients/static-api-key` vraća **403**.
- [ ] Browser na `https://mcp.domovina.ai/admin` (nakon entry API key-a) prikazuje 4
      sekcije: stats, clients tabela, audit tabela, revoke buttons rade.
- [ ] Lighthouse a11y score > 80 za `/admin` (alt texts, semantic HTML, contrast OK).
- [ ] Postojeći e2e set (21 case) i smoke test i dalje prolaze — admin endpoints ne
      smiju utjecati na MCP path.

## Veza s ostalim TODO stavkama

- **#9 Rate limiting**: kad bude implementiran, dodaj `GET /admin/api/rate-limits`
  i `DELETE /admin/api/rate-limits/{ip}` za manual unblock.
- **#10 Token expiry cron**: admin može pokazati "next cleanup in: X h" kad cron postoji.
  Vidi cron skripta predloška ispod.
- **OAuth audit retention** (nije u TODO setu, ali povezano): postavi PG partitioning ili
  cron `DELETE FROM oauth_audit_log WHERE timestamp < now() - interval '90 days'` da
  tablica ne raste vječno.

## Pripadni cron za GC (predložak, NE u ovom plan-u)

Defer-ano u zaseban task (TODO #10), ali da bude na jednom mjestu:

```sql
-- pgcron ili Coolify scheduled task, daily
DELETE FROM oauth_access_tokens WHERE expires_at < now();
DELETE FROM oauth_refresh_tokens WHERE created_at < now() - interval '90 days';
DELETE FROM oauth_authorization_codes WHERE expires_at < now() - interval '1 day';
DELETE FROM oauth_audit_log WHERE timestamp < now() - interval '90 days';
```

## Sigurnosna razmatranja

- **Admin key u browseru (localStorage)**: XSS na `/admin` može ga ukrasti. Mitigacija:
  - Strict CSP header na `/admin` route (no inline-script ostavlja samo nonced ones).
  - Bez third-party JS-a → minimal XSS surface.
  - Alternativa za v2: HttpOnly cookie + CSRF token. Tada UI mora ići preko login form-a.
- **Audit log self-write**: admin GET-ovi se **NE logiraju** u `oauth_audit_log` jer
  nemaju OAuth token i nisu protected resource — to je dizajn. Ako želiš audit *na
  admin* operacijama, dodaj `admin_audit_log` zasebnu tablicu.
- **CORS**: `/admin` se NE smije serve-ati s `Access-Control-Allow-Origin: *`. Default
  Express ne dodaje CORS header → OK. Ako se kasnije doda CORS middleware globalno,
  isključi za `/admin*` path.
- **Rate limit na `/admin/api/*`**: trenutno bez. 30-day brute force na 32-byte ključ
  je 2^256 → niti vrijedi rate limit-ati u v1. Dodaj kad rate limiting framework dođe.
- **Static-api-key zaštita**: nikad ne dozvoli DELETE na njega; dodaj test koji prati.

## Otvorena pitanja prije start-a

- [ ] **Path namespace**: `/admin` ili `/oauth/admin`? Preporuka **`/admin`** — kraće,
      jasnije, samostalan namespace.
- [ ] **HTML UI ili samo REST u v1?** Preporuka **oba** (UI je 60 min više). User je
      eksplicitno tražio "revocation UI".
- [ ] **Hostiranje admin-a na zasebnoj subdomeni** (`admin.mcp.domovina.ai`)? Defer —
      Coolify već routa `mcp.domovina.ai` preko Traefik-a, dodavanje subdomeneа znači
      drugu rutu, nije nužno za v1. CSP + auth na istom host-u je OK.
- [ ] **Restartom MCP container-a admin postaje dostupan** — Coolify env update +
      restart je 30s downtime za MCP. Acceptable.

## Vezano

- [[project-oauth-dcr-implementation]] — što već postoji
- [[project-mcp-service]] — Express + transport setup u koji se ovo plugs-a
- [[status-snapshot]] — TODO #7, #8 reference
- [[project-cloud-deployment-plan]] — Coolify env var workflow za `ADMIN_API_KEY`
