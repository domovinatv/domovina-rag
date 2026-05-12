# MCP search_podcasts e2e test set

Set test scenarija s tipičnim hrvatskim korisničkim promptovima za regresivno testiranje `search_podcasts` toola — i u development ciklusima i kad je servis spojen na Claude Desktop kao MCP.

## Filozofija

Svaki test slučaj rekonstruira **realan scenarij korisnika** koji bi pitanje uputio kroz Claude/ChatGPT/Cursor. Test ima dvije komponente:

1. **Deterministička validacija MCP retrievala** — što alat treba vratiti za zadani `tool_call`. Asercije nad chunkovima/scoreovima. Brzo, ne treba LLM.
2. **Informacija o očekivanom LLM odgovoru** — kako Claude treba sintetizirati final answer korisniku iz tog retrievala. Trenutno samo opisno u `expected_answer` polju; budući LLM-in-loop runner može to validirati.

Ovo razdvajanje znači da:
- Test runner ne treba Claude API key
- Test set vrijedi i kad ovaj servis spojiš na Claude Desktop — opisi LLM odgovora služe kao spec
- Ako tool retrieval pukne, Claude odgovor je nemoguć — fail-fast na pravom sloju

## Kategorije

| Kategorija | Što testira | Primjer |
|---|---|---|
| `person` | "Pronađi epizode s X" — gdje se osoba pojavila | "U kojim epizodama gostuje Fra Nikola Jurišić?" |
| `what-said` | "Što je X rekao o Y" — extraction iz transkripta | "Što Fra Nikola govori o kliničkoj smrti?" |
| `topic-discovery` | "Gdje se govori o Z" — topical pretraga | "Gdje se priča o duhovnom pozivu?" |
| `moment` | Specifični chunk u specifičnoj epizodi | "Pronađi točan trenutak priče o kliničkoj smrti" |
| `edge` | Mali/veliki/krnji input, mixed jezik, dijakritici | "What did Fra Nikola say...", "smrt" (1 riječ) |
| `filter` | Channel filter, lexical_terms filter | Filter na nepostojeći kanal → 0 rezultata |

## requires tag — postupna validacija s rastom korpusa

Trenutno (Faza 1 smoke) imamo **1 epizodu** (`ad_deum_podcast`, Fra Nikola Jurišić). Testovi su tagani po minimalnoj prerekviziti:

| tag | Što treba u DB-u |
|---|---|
| `current_smoke` | Samo Fra Nikolina epizoda — radi odmah |
| `multi_episode` | ≥2 epizode istog kanala (npr. cijeli ad_deum_podcast ingest) |
| `multi_channel` | ≥2 različita kanala ingestirana |
| `multi_speaker` | Različite osobe gostuju (npr. Hasanbegović pojavljuje se preko više epizoda) |

Default filter je `current_smoke` — pokreće samo cases koji rade s trenutnim stanjem.

## Pokretanje

```bash
# Iz services/mcp/ (treba running MCP stack: docker compose ... up mcp)
MCP_API_KEY=$(grep MCP_API_KEY ../../.env | cut -d= -f2) node test/e2e/run.mjs

# Filter na drugi minimum dataset (npr. nakon punog ingestnja)
TEST_REQUIRES=multi_channel MCP_API_KEY=... node test/e2e/run.mjs

# Samo jedna kategorija
TEST_CATEGORY=person MCP_API_KEY=... node test/e2e/run.mjs

# Drugi MCP URL (npr. staging)
MCP_URL=https://mcp.staging.example.com MCP_API_KEY=... node test/e2e/run.mjs
```

Exit code 0 ako svi prošli, 1 ako fail. CI-friendly.

## Dodavanje novog test slučaja

Edit `cases.mjs`, dodaj objekt u export array:

```js
{
  id: "kratki-stabilni-slug",
  category: "person | what-said | topic-discovery | moment | edge | filter",
  requires: "current_smoke",            // ili multi_episode, multi_channel, multi_speaker
  user_prompt: "Što bi korisnik napisao u Claude Desktop?",
  tool_call: {
    name: "search_podcasts",
    arguments: { query: "...", lexical_terms: ["..."], limit: 5 },
  },
  must_have: {
    // Bilo koja kombinacija — vidi run.mjs ASSERTIONS map za sve dostupne:
    min_results: 3,
    top_result_score_above: 0.5,
    any_result_text_includes_one_of: ["riječ1", "riječ2"],
    any_result_speakers_include: "Ime Prezime",
    distinct_youtube_ids_at_least: 2,
    // Za error cases:
    // tool_call_must_error: true,
    // error_contains_one_of: ["validation", "min"],
  },
  expected_answer: "Opis kako LLM klijent treba odgovor sintetizirati za usera.",
}
```

## Dostupne asercije

Vidi `ASSERTIONS` map u `run.mjs` — trenutno:

- `min_results`, `max_results`, `exact_results`
- `any_result_has_youtube_id`
- `any_result_speakers_include` (točan match), `any_result_speakers_include_substring`
- `any_result_text_includes`, `any_result_text_includes_one_of`
- `all_results_text_include`, `all_results_have_channel`
- `top_result_score_above`, `top_result_chunk_id`, `top_result_has_start_ts_between`
- `distinct_youtube_ids_at_least`
- Special: `tool_call_must_error` + `error_contains_one_of`

Dodaj nove asercije u istu mapu kad zatreba — keep them composable (každi vraća error string ili null).

## Kako koristit nakon spajanja na Claude Desktop

Sav `user_prompt` field je **paste-ready** — kopiraj u Claude Desktop chat (s MCP-om spojen kao `domovina-podcast`) i provjeri da:

1. Claude poziva `search_podcasts` tool (vidiš u Claude UI-u)
2. Argumenti su slični kao u `tool_call` (Claude ima slobodu drugačije formulirati)
3. Rezultat tool poziva matcha `must_have` asercije
4. Finalni answer od Claude-a matcha duh `expected_answer` opisa

Diskrepancije su signal:
- Tool description treba doraditi (Claude pogrešno tumači što tool radi)
- `must_have` asercija je previše stroga (legitimne varijacije Claude args-a)
- Embedding/retrieval ima realni recall gap
