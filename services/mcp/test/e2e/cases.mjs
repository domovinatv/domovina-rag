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

  // ───────────────── PERSON HUB (get_person) ─────────────────────
  // get_person agregira SVE epizode u kojima osoba GOVORI, iza stabilnog slug-a.
  // Ne treba embedder → radi i bez embedder servisa.

  {
    id: "person-hub-fra-nikola",
    category: "person",
    requires: "current_smoke",
    user_prompt: "Pokaži mi profil govornika Fra Nikole Jurišića.",
    tool_call: {
      name: "get_person",
      arguments: { slug: "fra-nikola-jurisic" },
    },
    must_have: {
      object_field_path_number_min: ["episode_count", 1],
      object_array_field_includes_object_with_field_value: ["episodes", "youtube_id", KNOWN_YT_ID],
      object_has_array_field: "channels",
      object_has_field_path: "timeline",
    },
    expected_answer:
      "Profil s brojem epizoda, raspodjelom po kanalima, timelineom i popisom " +
      "epizoda s deep linkovima na domovina.ai/v/{id}/t/{first_ts}.",
  },

  {
    id: "person-hub-not-found",
    category: "person",
    requires: "current_smoke",
    user_prompt: "Profil za nepostojeću osobu.",
    tool_call: {
      name: "get_person",
      arguments: { slug: "ova-osoba-sigurno-ne-postoji-9931" },
    },
    must_have: {
      tool_call_must_error: true,
      error_contains_one_of: ["NOT_FOUND", "nije pronađena"],
    },
    expected_answer: "Klijent javlja da osoba s tim slug-om ne postoji (404).",
  },

  {
    id: "person-hub-cross-channel",
    category: "person",
    requires: "multi_channel",
    user_prompt: "U kojim sve kanalima gostuje Željka Markić?",
    tool_call: {
      name: "get_person",
      arguments: { slug: "zeljka-markic" },
    },
    must_have: {
      object_field_path_number_min: ["channel_count", 2],
      object_array_field_includes_object_with_field_value: [
        "channels", "channel", "zeljka_markic_i_narod_hr",
      ],
    },
    expected_answer:
      "Cross-channel profil: Željka Markić govori u više kanala; raspodjela po " +
      "kanalima pokazuje njezin matični kanal + gostovanja.",
  },

  {
    id: "person-hub-mentions",
    category: "person",
    requires: "multi_channel",
    user_prompt:
      "U kojim se epizodama SPOMINJE Ante Čaljkušić (a da nije govornik)?",
    tool_call: {
      name: "get_person",
      arguments: { slug: "ante-caljkusic" },
    },
    must_have: {
      // Spomen u epizodi gdje NE govori (DR9rrCDpnTA: govore Voditelj + Vanessa Mioč).
      object_field_path_number_min: ["mention_episode_count", 1],
      object_array_field_includes_object_with_field_value: [
        "mentions", "youtube_id", "DR9rrCDpnTA",
      ],
      // Govori ima prednost: mention-epizoda NE smije biti i u episodes[].
      object_array_field_excludes_object_with_field_value: [
        "episodes", "youtube_id", "DR9rrCDpnTA",
      ],
    },
    expected_answer:
      "Sekcija 'Spominje se u' navodi DR9rrCDpnTA (koncert) gdje se Ante " +
      "Čaljkušić spominje ali ne govori; deep_link je /v/{id} bez /t/.",
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
      error_contains_one_of: ["Invalid arguments", "max", "25"],
    },
    expected_answer:
      "limit max=25 → validation error. LLM klijent treba refraziraii s manjim " +
      "limitom ili paginirati. (Cap snižen s 50 na 25 u Sprint 3 jer veći " +
      "broj prelazi tool budget LLM-a.)",
  },

  // ════════════════════════════════════════════════════════════════
  // get_episode test cases
  // ════════════════════════════════════════════════════════════════
  //
  // Payload je objekt (NE array kao search_podcasts), pa koristi
  // `episode_*` asserter helpere koji rade po object shape-u.

  {
    id: "get-episode-happy-path",
    category: "episode",
    requires: "current_smoke",
    user_prompt: "Daj mi cijelu epizodu Fra Nikole Jurišića (klinička smrt).",
    tool_call: {
      name: "get_episode",
      arguments: { youtube_id: KNOWN_YT_ID },
    },
    must_have: {
      episode_metadata_youtube_id: KNOWN_YT_ID,
      episode_metadata_channel: KNOWN_CHANNEL,
      episode_metadata_has_title: true,
      episode_chunk_count_min: 1,
      episode_speakers_min: 1,
      episode_duration_sec_min: 60,
      // Fix od 2026-05-16: chapters se izvode iz topic* + outline strategija,
      // ne samo `outline`. Smoke ep ima topic_transcript chunkove → chapters ≥ 1.
      episode_chapters_min: 1,
      episode_all_chapters_have_valid_timestamp: true,
    },
    expected_answer:
      "Cjeloviti pregled epizode: naslov, govornici, trajanje + chapters + " +
      "transkript po segmentima (ako stane u soft limit). LLM može sustavno " +
      "ekstraktirati tvrdnje iz cijele epizode.",
  },

  {
    id: "get-episode-metadata-only",
    category: "episode",
    requires: "current_smoke",
    user_prompt: "Tko gostuje u epizodi (samo pregled, bez transkripta)?",
    tool_call: {
      name: "get_episode",
      arguments: { youtube_id: KNOWN_YT_ID, include_transcript: false },
    },
    must_have: {
      episode_metadata_youtube_id: KNOWN_YT_ID,
      episode_transcript_null: true,
      episode_truncation_reason_includes: "include_transcript=false",
      episode_stats_returned_chunks_eq: 0,
    },
    expected_answer:
      "Bez transkripta — LLM prikazuje meta + chapters. Korisno za brzi pregled " +
      "ili kad korisnik samo želi popis gostiju.",
  },

  {
    id: "get-episode-view-range",
    category: "episode",
    requires: "current_smoke",
    user_prompt: "Daj mi prvih 10 minuta epizode.",
    tool_call: {
      name: "get_episode",
      arguments: { youtube_id: KNOWN_YT_ID, view_range: [0, 600] },
    },
    must_have: {
      episode_metadata_youtube_id: KNOWN_YT_ID,
      episode_transcript_chunks_min: 1,
      episode_all_transcript_chunks_overlap_range: [0, 600],
      episode_stats_time_range_eq: [0, 600],
      // Fix od 2026-05-16: untimestamped chunkovi (start=end=0, tipično
      // article_summary) NE smiju pasti u view_range bucket — semantički
      // nepripadaju time-slice upitu.
      episode_no_untimestamped_chunks_in_transcript: true,
    },
    expected_answer:
      "Samo chunkovi koji se preklapaju s [0, 600] — fokusirani pogled na " +
      "uvod epizode. Bypassira soft limit. Summary chunkovi bez timestamp-a " +
      "su isključeni.",
  },

  {
    id: "get-episode-not-found",
    category: "episode",
    requires: "current_smoke",
    user_prompt: "Daj mi epizodu s nepostojećim ID-om.",
    tool_call: {
      name: "get_episode",
      arguments: { youtube_id: "aaaaaaaaaaa" },
    },
    must_have: {
      tool_call_must_error: true,
      error_contains_one_of: ["EPISODE_NOT_FOUND"],
    },
    expected_answer:
      "Domain error EPISODE_NOT_FOUND (NE generic 500). LLM treba poručiti " +
      "korisniku da provjeri youtube_id.",
  },

  {
    id: "get-episode-invalid-id",
    category: "episode",
    requires: "current_smoke",
    user_prompt: "Daj mi epizodu s nevažećim ID-om.",
    tool_call: {
      name: "get_episode",
      arguments: { youtube_id: "invalid" },
    },
    must_have: {
      tool_call_must_error: true,
      error_contains_one_of: ["VALIDATION_ERROR", "11-znakovni"],
    },
    expected_answer:
      "VALIDATION_ERROR — youtube_id regex (^[A-Za-z0-9_-]{11}$) ne mečka. " +
      "LLM može zatražiti korisnika da provjeri URL.",
  },

  {
    id: "get-episode-inverted-range",
    category: "episode",
    requires: "current_smoke",
    user_prompt: "Daj mi epizodu s pogrešnim view_range-om (start > end).",
    tool_call: {
      name: "get_episode",
      arguments: { youtube_id: KNOWN_YT_ID, view_range: [600, 0] },
    },
    must_have: {
      tool_call_must_error: true,
      error_contains_one_of: ["VALIDATION_ERROR", "start mora biti < end"],
    },
    expected_answer:
      "VALIDATION_ERROR — view_range refine fails (start mora biti < end).",
  },

  {
    id: "get-episode-soft-limit-truncates",
    category: "episode",
    // Duga epizoda EnNn5o1RAfs (Matija Ricov, ~4250s) — postoji tek u multi_episode
    // datasetu. current_smoke = 1 ep nije dovoljna.
    requires: "multi_episode",
    user_prompt: "Daj mi cijelu Matijinu Ricovu epizodu (4250+ sec).",
    tool_call: {
      name: "get_episode",
      arguments: { youtube_id: "EnNn5o1RAfs" },
    },
    must_have: {
      episode_metadata_youtube_id: "EnNn5o1RAfs",
      episode_transcript_null: true,
      episode_truncated_eq: true,
      episode_truncation_reason_includes: "soft limit",
    },
    expected_answer:
      "Velika epizoda → transcript null, truncated=true s actionable porukom " +
      "koja upućuje na view_range. LLM treba pozvati opet po dijelovima.",
  },

  // ════════════════════════════════════════════════════════════════
  // server_info test cases (Sprint 1+)
  // ════════════════════════════════════════════════════════════════

  {
    id: "server-info-returns-version-and-dataset",
    category: "meta",
    requires: "current_smoke",
    user_prompt: "Koja je verzija MCP-a i koliko je svjež korpus?",
    tool_call: {
      name: "server_info",
      arguments: {},
    },
    must_have: {
      object_has_field: "version",
      object_has_field_path: "dataset.episodes",
      object_field_path_number_min: ["dataset.episodes", 1],
      object_has_array_field: "tools",
      object_array_field_includes: ["tools", "search_podcasts"],
    },
    expected_answer:
      "Service: domovina-podcast, version, dataset stats (channels/episodes/" +
      "chunks counts + dates), popis tool-ova. LLM može surfacati version " +
      "info u UI-u i koristi tools listu za capability negotiation.",
  },

  {
    id: "server-info-recommended-companions",
    category: "meta",
    requires: "current_smoke",
    user_prompt: "Postoje li komplementarni MCP serveri za ovu domenu?",
    tool_call: {
      name: "server_info",
      arguments: {},
    },
    must_have: {
      object_has_array_field: "recommended_companions",
      object_array_field_includes_object_with_field_value: [
        "recommended_companions",
        "name",
        "Magisterium AI",
      ],
    },
    expected_answer:
      "Lista recommended_companions[] s name/url/reason/trigger_topics. " +
      "Non-standard MCP konvencija (spec 2025-11-25 nema primitive za inter-" +
      "server preporuke). LLM bi trebao predložiti useru da poveže nedostajuće.",
  },

  // ════════════════════════════════════════════════════════════════
  // list_episodes test cases (Sprint 1)
  // ════════════════════════════════════════════════════════════════

  {
    id: "list-episodes-channel-filter",
    category: "discovery",
    requires: "current_smoke",
    user_prompt: "Daj mi epizode kanala ad_deum_podcast.",
    tool_call: {
      name: "list_episodes",
      arguments: { channel: KNOWN_CHANNEL, limit: 10 },
    },
    must_have: {
      min_results: 1,
      all_results_have_channel: KNOWN_CHANNEL,
      every_result_has_field: "youtube_id",
      every_result_has_field: "title",
      every_result_has_field: "speakers",
    },
    expected_answer:
      "Distinct epizode kanala s metapodacima (title, speakers, " +
      "duration_sec, chunk_count). LLM može prikazati kao listu za " +
      "browsing.",
  },

  {
    id: "list-episodes-recent-first",
    category: "discovery",
    requires: "current_smoke",
    user_prompt: "Daj mi 3 najnovije epizode bilo kojeg kanala.",
    tool_call: {
      name: "list_episodes",
      arguments: { limit: 3, sort_by: "upload_date_desc" },
    },
    must_have: {
      exact_results: 3,
      results_sorted_by_upload_date_desc: true,
    },
    expected_answer:
      "3 najnovije epizode korpusa, sortirane silazno po datumu objave. " +
      "Adresira gap iz dynamic e2e: 'najnovije X' upit više ne zahtijeva " +
      "ručno sortiranje na klijentu.",
  },

  // ════════════════════════════════════════════════════════════════
  // speaker filter (Sprint 1) + date filters / include_summaries (Sprint 2)
  // ════════════════════════════════════════════════════════════════

  {
    id: "search-podcasts-speaker-filter",
    category: "filter",
    requires: "current_smoke",
    user_prompt: "Što je rekao Fra Nikola Jurišić o kliničkoj smrti?",
    tool_call: {
      name: "search_podcasts",
      arguments: {
        query: "klinička smrt iskustvo",
        speaker: "Jurišić",
        limit: 5,
      },
    },
    must_have: {
      min_results: 1,
      every_result_speakers_includes_substring: "Jurišić",
    },
    expected_answer:
      "Samo chunkovi gdje Fra Nikola stvarno govori, ne i oni gdje se " +
      "spominje. Speaker filter koristi positionCaseInsensitiveUTF8.",
  },

  {
    id: "search-podcasts-include-summaries-false",
    category: "filter",
    requires: "current_smoke",
    user_prompt: "Daj mi direktne citate (bez AI sažetaka) o kliničkoj smrti.",
    tool_call: {
      name: "search_podcasts",
      arguments: {
        query: "iskustvo kliničke smrti",
        include_summaries: false,
        limit: 5,
      },
    },
    must_have: {
      min_results: 1,
      every_result_chunk_strategy_not_summary: true,
    },
    expected_answer:
      "Bez article_summary chunkova — samo topic_transcript s realnim " +
      "dijalogom i speakers/timestamps. Korisno za precizne citate.",
  },

  // ════════════════════════════════════════════════════════════════
  // chapter_index u get_episode (Sprint 2)
  // ════════════════════════════════════════════════════════════════

  {
    id: "get-episode-chapter-index",
    category: "episode",
    requires: "current_smoke",
    user_prompt: "Daj mi 12. poglavlje smoke epizode.",
    tool_call: {
      name: "get_episode",
      arguments: { youtube_id: KNOWN_YT_ID, chapter_index: 12 },
    },
    must_have: {
      episode_metadata_youtube_id: KNOWN_YT_ID,
      episode_transcript_chunks_min: 1,
      episode_no_untimestamped_chunks_in_transcript: true,
    },
    expected_answer:
      "Chunkovi unutar 12. chaptera (resolvirano interno u view_range). " +
      "Convenience nad view_range-om.",
  },

  {
    id: "get-episode-chapter-index-out-of-range",
    category: "episode",
    requires: "current_smoke",
    user_prompt: "Daj mi 999. poglavlje (ne postoji).",
    tool_call: {
      name: "get_episode",
      arguments: { youtube_id: KNOWN_YT_ID, chapter_index: 999 },
    },
    must_have: {
      tool_call_must_error: true,
      error_contains_one_of: ["EPISODE_TOO_LARGE", "izvan raspona"],
    },
    expected_answer:
      "Out-of-range index → domain error s validnim rasponom u poruci.",
  },

  {
    id: "get-episode-mutually-exclusive-range-and-chapter",
    category: "episode",
    requires: "current_smoke",
    user_prompt: "Daj mi view_range I chapter_index istovremeno (greška).",
    tool_call: {
      name: "get_episode",
      arguments: {
        youtube_id: KNOWN_YT_ID,
        view_range: [0, 600],
        chapter_index: 1,
      },
    },
    must_have: {
      tool_call_must_error: true,
      error_contains_one_of: ["VALIDATION_ERROR", "međusobno isključivi"],
    },
    expected_answer:
      "Zod refine na object razini odbacuje kombinaciju s clear porukom.",
  },

  // ════════════════════════════════════════════════════════════════
  // count_mentions agregator (Sprint 3)
  // ════════════════════════════════════════════════════════════════

  {
    id: "count-mentions-by-channel",
    category: "aggregation",
    requires: "current_smoke",
    user_prompt: "U kojem kanalu se najviše govori o kliničkoj smrti?",
    tool_call: {
      name: "count_mentions",
      arguments: {
        query: "klinička smrt iskustvo",
        group_by: "channel",
        limit: 10,
      },
    },
    must_have: {
      min_results: 1,
      every_result_has_field: "group_value",
      every_result_has_field: "mention_count",
      results_sorted_by_mention_count_desc: true,
    },
    expected_answer:
      "Lista kanala s brojem chunkova koji semantički matchaju upit. " +
      "Drastično manji payload od search_podcasts(limit=N) + LLM agregacija.",
  },

  {
    id: "count-mentions-by-speaker",
    category: "aggregation",
    requires: "current_smoke",
    user_prompt: "Tko najčešće govori o vjeri?",
    tool_call: {
      name: "count_mentions",
      arguments: { query: "vjera molitva", group_by: "speaker", limit: 10 },
    },
    must_have: {
      min_results: 1,
      every_result_has_field: "group_value",
      every_result_has_field: "mention_count",
    },
    expected_answer:
      "Lista govornika rangirana po broju mentions. Speaker kolona je " +
      "comma-separated pa CH arrayJoin razbije svaki red.",
  },

  {
    id: "count-mentions-by-month",
    category: "aggregation",
    requires: "current_smoke",
    user_prompt: "U kojem mjesecu je bilo najviše rasprava o pobačaju?",
    tool_call: {
      name: "count_mentions",
      arguments: { query: "pobačaj", group_by: "month", limit: 12 },
    },
    must_have: {
      min_results: 1,
      every_result_group_value_matches_pattern: "^\\d{4}-\\d{2}$",
    },
    expected_answer:
      "Lista mjeseci u YYYY-MM formatu, sortirana silazno po " +
      "mention_count. Otkriva trendove kroz vrijeme.",
  },
];
