// E2E test set za search_podcasts.
//
// Svaki test case ima:
//   - `id`              — stabilan slug za referencu
//   - `category`        — grupiranje (person | what-said | topic-discovery | moment | edge | filter)
//   - `requires`        — minimalni dataset (current_smoke = 1 epizoda ad_deum_podcast;
//                         multi_episode | multi_channel | multi_speaker = budući ingest)
//   - `user_prompt`     — što bi korisnik upisao u Claude Desktop (NL, hrvatski)
//   - `tool_call`       — što Claude/MCP klijent treba zvati (deterministički test current state-a)
//   - `must_have`       — assertion-i koji moraju proći nad MCP rezultatom
//   - `expected_answer` — kako LLM klijent treba sintetizirati odgovor korisniku
//                         (informativni — za buduće LLM-in-loop testove, ne validirano deterministički)
//
// Pokretanje: `node test/e2e/run.mjs` ili `npm run test:e2e`.
// Filter po requires:    `TEST_REQUIRES=current_smoke node test/e2e/run.mjs`
// Filter po category:    `TEST_CATEGORY=person node test/e2e/run.mjs`

const KNOWN_YT_ID = "2fiE6NsRz8M";
const KNOWN_CHANNEL = "ad_deum_podcast";

export default [
  // ───────────────────── PERSON → EPIZODE ────────────────────────

  {
    id: "person-fra-nikola-episodes",
    category: "person",
    requires: "current_smoke",
    user_prompt: "U kojim epizodama gostuje Fra Nikola Jurišić?",
    tool_call: {
      name: "search_podcasts",
      arguments: {
        query: "Fra Nikola Jurišić gost epizoda razgovor",
        lexical_terms: ["Jurišić"],
        limit: 10,
      },
    },
    must_have: {
      min_results: 1,
      any_result_has_youtube_id: KNOWN_YT_ID,
      any_result_speakers_include: "Fra Nikola Jurišić",
    },
    expected_answer:
      "Fra Nikola Jurišić gostuje u epizodi 'Doživio sam iskustvo kliničke smrti' " +
      "na Ad Deum Podcastu (10. svibnja 2025.). LLM treba dati YouTube link i " +
      "kratki sažetak teme epizode.",
  },

  {
    id: "person-mention-cross-channel",
    category: "person",
    requires: "multi_channel",
    user_prompt: "Gdje sve gostuje Zlatko Hasanbegović?",
    tool_call: {
      name: "search_podcasts",
      arguments: {
        query: "Zlatko Hasanbegović politika povijest intervju",
        lexical_terms: ["Hasanbegović"],
        limit: 20,
      },
    },
    must_have: {
      min_results: 3,
      distinct_youtube_ids_at_least: 3,
      any_result_speakers_include_substring: "Hasanbegović",
    },
    expected_answer:
      "Lista epizoda iz različitih kanala u kojima se Hasanbegović pojavljuje, " +
      "grupirana po kanalu, s deep linkovima.",
  },

  // ───────────────── ŠTO JE X REKAO O Y ──────────────────────────

  {
    id: "what-said-clinical-death",
    category: "what-said",
    requires: "current_smoke",
    user_prompt: "Što je Fra Nikola Jurišić rekao o iskustvu kliničke smrti?",
    tool_call: {
      name: "search_podcasts",
      arguments: {
        query: "iskustvo kliničke smrti susret s Isusom promjena perspektive",
        limit: 5,
      },
    },
    must_have: {
      min_results: 3,
      top_result_score_above: 0.5,
      any_result_text_includes: "klinič",
      any_result_text_includes_one_of: ["Isus", "Bog", "rodbinom"],
    },
    expected_answer:
      "Detaljan citat o iskustvu (treći razred srednje, 45°C, susret s preminulom rodbinom " +
      "i Isusom), kontekst da to nije bilo presudno za fratarski poziv ali je promijenilo " +
      "perspektivu, link na YouTube na ~34. minutu (t=2044s).",
  },

  {
    id: "what-said-family-resistance",
    category: "what-said",
    requires: "current_smoke",
    user_prompt: "Kako je Fra Nikolina obitelj reagirala na njegov odlazak u samostan?",
    tool_call: {
      name: "search_podcasts",
      arguments: {
        query: "roditelji obitelj prihvaćanje odlazak u samostan kušnje",
        limit: 5,
      },
    },
    must_have: {
      min_results: 2,
      any_result_text_includes_one_of: ["roditelj", "obitelj", "kušnj"],
    },
    expected_answer:
      "Teško prihvaćanje od roditelja, opisano kao kušnja. Fra Nikola koristi " +
      "biblijsko 'pusti da mrtve pokapaju mrtve' za udaljavanje, ali kasnije je " +
      "odnos duboko produbljen.",
  },

  {
    id: "what-said-discerning-vocation",
    category: "what-said",
    requires: "current_smoke",
    user_prompt: "Kako Fra Nikola opisuje razlučivanje Božjeg poziva?",
    tool_call: {
      name: "search_podcasts",
      arguments: {
        query: "razlučivanje Božji poziv kako prepoznati znak",
        limit: 5,
      },
    },
    must_have: {
      min_results: 2,
      any_result_text_includes_one_of: ["poziv", "razluč", "znak"],
    },
    expected_answer:
      "Stav da Bog govori različito svakoj osobi; nema univerzalne definicije. " +
      "Fra Nikolin osobni znak: nespavanje. Naglasak na unutrašnjem 'bode srce, " +
      "izgledaš od čežnje' — što je samo subjektivno prepoznatljivo.",
  },

  // ───────────── KOJI PODCASTI O KOJOJ TEMI ──────────────────────

  {
    id: "topic-vocation",
    category: "topic-discovery",
    requires: "current_smoke",
    user_prompt: "Gdje se govori o duhovnom pozivu i odluci za svećeništvo?",
    tool_call: {
      name: "search_podcasts",
      arguments: {
        query: "duhovni poziv svećeništvo fratarski poziv odluka",
        limit: 10,
      },
    },
    must_have: {
      min_results: 3,
      any_result_text_includes_one_of: ["poziv", "fratar", "svećen"],
    },
    expected_answer:
      "Pokazuje listu chunkova/momenata gdje se tema obrađuje, grupirano po " +
      "epizodi. Trenutno: jedna epizoda (Fra Nikola Jurišić).",
  },

  {
    id: "topic-prayer-conversion",
    category: "topic-discovery",
    requires: "current_smoke",
    user_prompt: "U kojim podcastima se govori o molitvi i obraćenju?",
    tool_call: {
      name: "search_podcasts",
      arguments: {
        query: "molitva obraćenje promjena duhovni život",
        limit: 10,
      },
    },
    must_have: {
      min_results: 2,
      any_result_text_includes_one_of: ["molitv", "obraćen", "duhovn"],
    },
    expected_answer:
      "Lista relevantnih chunkova s linkovima. Iz trenutnog korpusa: Fra " +
      "Nikolina priča o obraćenju nakon iskustva kliničke smrti.",
  },

  {
    id: "topic-pope-francis",
    category: "topic-discovery",
    requires: "multi_episode",
    user_prompt: "Gdje se spominje papa Franjo i njegov pontifikat?",
    tool_call: {
      name: "search_podcasts",
      arguments: {
        query: "papa Franjo pontifikat crkva reforme",
        lexical_terms: ["Franjo"],
        limit: 10,
      },
    },
    must_have: {
      min_results: 1,
      any_result_text_includes_one_of: ["papa", "pontifikat"],
    },
    expected_answer:
      "Lista epizoda i specifičnih chunkova gdje se papa spominje, s deep linkovima.",
  },

  {
    id: "topic-croatian-politics",
    category: "topic-discovery",
    requires: "multi_channel",
    user_prompt: "Pronađi razgovore o hrvatskoj politici i izborima",
    tool_call: {
      name: "search_podcasts",
      arguments: {
        query: "hrvatska politika izbori stranke vlada predsjednik",
        limit: 15,
      },
    },
    must_have: {
      min_results: 5,
      distinct_youtube_ids_at_least: 3,
    },
    expected_answer:
      "Cross-channel lista, grupirano po kanalu (Željka Markić, drugi politički " +
      "podcasti). Ne smije pomiješati katolicke/duhovne s političkim epizodama.",
  },

  // ──────────────── SPECIFIČNI TRENUTCI (MOMENTI) ────────────────

  {
    id: "moment-near-death-narrative",
    category: "moment",
    requires: "current_smoke",
    user_prompt: "Pronađi točan trenutak gdje Fra Nikola priča priču o kliničkoj smrti",
    tool_call: {
      name: "search_podcasts",
      arguments: {
        query: "treći razred srednje 45 stupnjeva temperatura susret pokojnu rodicu",
        limit: 5,
      },
    },
    must_have: {
      min_results: 2,
      // Naslov-chunk (`_summary_*`) često pobjeđuje semantic score jer koncentrira
      // ključne riječi. Stvarni transcript moment (`_topic_*`) mora bit u top-5,
      // s start_ts u intervalu priče.
      any_result_chunk_id: `${KNOWN_YT_ID}_topic_012`,
      any_result_has_start_ts_between: [1800, 2500],
      top_result_score_above: 0.45,
    },
    expected_answer:
      "Citat priče s točnim deep linkom (t=2044s). LLM treba dati timestamp " +
      "i kratki kontekst pred-citata. KNOWN ISSUE: summary chunks imaju " +
      "start_ts=0 — LLM bi trebao preferirati _topic_ chunkove za 'moment' upite.",
  },

  {
    id: "moment-jesus-conversation",
    category: "moment",
    requires: "current_smoke",
    user_prompt: "Trenutci kad se spominje razgovor s Isusom",
    tool_call: {
      name: "search_podcasts",
      arguments: {
        query: "razgovor sa Isusom susret nakon smrti",
        lexical_terms: ["Isusom"],
        limit: 3,
      },
    },
    must_have: {
      min_results: 1,
      all_results_text_include: "Isus",
    },
    expected_answer:
      "Citat dijela priče u kojem Fra Nikola spominje razgovor s 'gazdom', tj. " +
      "Isusom. Deep link na taj segment.",
  },

  // ──────────────── EDGE CASES & VALIDACIJA ──────────────────────

  {
    id: "edge-very-short-query",
    category: "edge",
    requires: "current_smoke",
    user_prompt: "smrt",
    tool_call: {
      name: "search_podcasts",
      arguments: { query: "smrt", limit: 5 },
    },
    must_have: {
      min_results: 1,
    },
    expected_answer:
      "Treba raditi — query > 2 char je validan. Vraća relevantne chunkove " +
      "(smrt/umiranje/clinical death).",
  },

  {
    id: "edge-query-too-short",
    category: "edge",
    requires: "current_smoke",
    user_prompt: "?",
    tool_call: {
      name: "search_podcasts",
      arguments: { query: "?", limit: 5 },
    },
    must_have: {
      tool_call_must_error: true,
      error_contains_one_of: ["Invalid arguments", "min", "2"],
    },
    expected_answer:
      "Tool treba vratiti validation error (query < 2 char). LLM klijent treba " +
      "tražiti od usera da preformulira pitanje.",
  },

  {
    id: "edge-mixed-language",
    category: "edge",
    requires: "current_smoke",
    user_prompt: "What did Fra Nikola say about clinical death?",
    tool_call: {
      name: "search_podcasts",
      arguments: {
        query: "clinical death near-death experience Fra Nikola",
        lexical_terms: ["Nikola"],
        limit: 5,
      },
    },
    must_have: {
      min_results: 1,
      any_result_speakers_include_substring: "Nikola",
    },
    expected_answer:
      "bge-m3 je multilingual — EN query mapira na HR content. Rezultati su HR " +
      "tekstovi, LLM treba prevesti sažetak na EN ako usera ostavi na EN.",
  },

  {
    id: "edge-diacritics-missing",
    category: "edge",
    requires: "current_smoke",
    user_prompt: "Sto je Fra Nikola Jurisic govorio o pozivu?",
    tool_call: {
      name: "search_podcasts",
      arguments: {
        query: "Što je Fra Nikola Jurišić govorio o pozivu",
        limit: 5,
      },
    },
    must_have: {
      min_results: 2,
    },
    expected_answer:
      "Semantic embedding tolerantan na missing diacritics (bge-m3 SentencePiece " +
      "tokenizer). Rezultati slični kao sa dijakriticima. LLM treba sintetizirati " +
      "s pravilnim hrvatskim pisanjem.",
  },

  // ──────────────── FILTERI ──────────────────────────────────────

  {
    id: "filter-valid-channel",
    category: "filter",
    requires: "current_smoke",
    user_prompt: "Što se priča o pozivu na Ad Deum podcastu?",
    tool_call: {
      name: "search_podcasts",
      arguments: {
        query: "duhovni poziv svećenički",
        channel: KNOWN_CHANNEL,
        limit: 5,
      },
    },
    must_have: {
      min_results: 1,
      all_results_have_channel: KNOWN_CHANNEL,
    },
    expected_answer:
      "Samo ad_deum_podcast rezultati. LLM kontekst: '… na Ad Deum podcastu …'",
  },

  {
    id: "filter-bogus-channel",
    category: "filter",
    requires: "current_smoke",
    user_prompt: "Pretraži kanal koji ne postoji",
    tool_call: {
      name: "search_podcasts",
      arguments: {
        query: "iskustvo",
        channel: "this_channel_does_not_exist_xyz",
        limit: 5,
      },
    },
    must_have: {
      exact_results: 0,
    },
    expected_answer:
      "0 rezultata, no error. LLM treba reći useru da kanal ne postoji ili " +
      "predložiti listu poznatih kanala.",
  },

  {
    id: "filter-lexical-bogus-token",
    category: "filter",
    requires: "current_smoke",
    user_prompt: "Pronađi gdje se spominje izmišljena riječ koja sigurno ne postoji",
    tool_call: {
      name: "search_podcasts",
      arguments: {
        query: "bilo što",
        lexical_terms: ["xyzzy123notarealword"],
        limit: 5,
      },
    },
    must_have: {
      exact_results: 0,
    },
    expected_answer:
      "Bloom filter odsijeca — 0 rezultata. LLM treba korisniku reći da pojam " +
      "nije pronađen i predložiti slične.",
  },

  {
    id: "filter-lexical-proper-noun",
    category: "filter",
    requires: "current_smoke",
    user_prompt: "Pronađi chunkove u kojima se eksplicitno spominje Isus",
    tool_call: {
      name: "search_podcasts",
      arguments: {
        query: "Isus Krist vjera",
        lexical_terms: ["Isusom"],
        limit: 10,
      },
    },
    must_have: {
      min_results: 1,
      all_results_text_include: "Isus",
    },
    expected_answer:
      "Hybrid mode: semantic similarity + obavezna pojava 'Isusom' tokena. " +
      "Rezultati eksplicitno spominju Isusa.",
  },

  // ──────────────── LIMIT BOUNDARIES ─────────────────────────────

  {
    id: "limit-default",
    category: "edge",
    requires: "current_smoke",
    user_prompt: "Pretraga sa standardnim limitom",
    tool_call: {
      name: "search_podcasts",
      arguments: { query: "iskustvo" },
    },
    must_have: {
      min_results: 1,
      max_results: 10, // default je 10
    },
    expected_answer: "Default limit = 10.",
  },

  {
    id: "limit-too-high",
    category: "edge",
    requires: "current_smoke",
    user_prompt: "Pretraga s previsokim limitom",
    tool_call: {
      name: "search_podcasts",
      arguments: { query: "iskustvo", limit: 9999 },
    },
    must_have: {
      tool_call_must_error: true,
      error_contains_one_of: ["Invalid arguments", "max", "50"],
    },
    expected_answer:
      "limit max=50 → validation error. LLM klijent treba refraziraii s manjim " +
      "limitom ili paginirati.",
  },
];
