# services/landing/

Apex landing site za `domovina.link` — minimalna statična stranica deployana na
Cloudflare Pages. Glavni razlog postojanja: claude.ai Connectors UI dohvaća
favicon konektora preko Google `faviconV2` servisa s **apex domene**, a ne s MCP
subdomene. Bez ovog site-a, MCP konektor u claude.ai prikazuje generičnu globe
ikonu umjesto DOMOVINA loga. Detalji u
`/Users/ms/.claude/projects/-Users-ms-git-domovinatv-domovina-rag/memory/lessons_claude_ai_favicon_apex.md`.

## Struktura

```
services/landing/
├── public/              # CF Pages output dir (sve što se servira)
│   ├── index.html       # hero, opis projekta, CTA na mcp.domovina.link
│   ├── styles.css       # DOMOVINA brand pattern
│   ├── favicon.ico      # copy iz services/mcp/public/ (radi faviconV2)
│   ├── icon.svg
│   ├── icon-192.png
│   ├── icon-512.png
│   ├── apple-touch-icon.png
│   ├── manifest.json
│   └── _headers         # CF Pages: cache + CORS na ikone
├── wrangler.toml        # CF Pages projekt config
└── README.md
```

Brand assete (favicon + ikone) **kopiramo** iz `services/mcp/public/` umjesto
symlinkanja jer git ne čuva symlink-ove na Windows klonovima, a CF Pages build
ih jednako ne prati. Ako se MCP brand mijenja, ručno reciproc-iraj.

## Deploy

Prvi deploy (kreira CF Pages projekt):

```bash
cd services/landing
wrangler pages project create domovina-link \
  --production-branch=main \
  --compatibility-date=2026-05-14
wrangler pages deploy public --project-name=domovina-link --branch=main
```

Naknadni deployevi:

```bash
cd services/landing
wrangler pages deploy public --project-name=domovina-link --branch=main
```

Nakon prvog deploya site je na `https://domovina-link.pages.dev`. Custom domain
(`domovina.link` apex + `www.domovina.link`) se dodaje **ručno u CF dashboardu**:
Pages → `domovina-link` → Custom domains → Add. CF automatski podiže DNS records
i Universal SSL cert.

## Verifikacija

Nakon što je custom domain aktivan:

```bash
curl -I https://domovina.link/favicon.ico   # → 200, image/x-icon
curl -I https://domovina.link/              # → 200, text/html

# Točan URL koji claude.ai zove za favicon konektora:
open "https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://domovina.link&size=96"
```

faviconV2 ima cache (sati do par dana). Kada se ažurira, re-add MCP konektor u
claude.ai i provjeri da brand logo zamjenjuje generic globe ikonu u Connectors
listi.
