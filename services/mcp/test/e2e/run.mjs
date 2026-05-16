// E2E runner za search_podcasts test set.
//
// Učitava `cases.mjs`, filtrira po `TEST_REQUIRES` (default `current_smoke`)
// i `TEST_CATEGORY`, zove MCP server preko Streamable HTTP transporta i verificira
// `must_have` asercije.
//
// Run: `node test/e2e/run.mjs`  (iz services/mcp/)
//      `MCP_API_KEY=$(grep MCP_API_KEY ../../.env | cut -d= -f2) node test/e2e/run.mjs`
//      `TEST_REQUIRES=multi_channel node test/e2e/run.mjs` — skip current_smoke cases
//      `TEST_CATEGORY=person node test/e2e/run.mjs`
//      `MCP_URL=https://mcp.domovina.ai node test/e2e/run.mjs` — gađaj cloud
//
// Exit code: 0 ako svi prošli, 1 ako ima fail-ova.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import cases from "./cases.mjs";


const apiKey = process.env.MCP_API_KEY;
if (!apiKey) {
  console.error("ERROR: MCP_API_KEY env required");
  process.exit(2);
}
const mcpUrl = process.env.MCP_URL || "http://localhost:3000";
const requireFilter = process.env.TEST_REQUIRES || "current_smoke";
const categoryFilter = process.env.TEST_CATEGORY || null;


// ─────────────────────── Assertion helpers ─────────────────────────

const ASSERTIONS = {
  min_results: (rows, n) => rows.length >= n
    ? null
    : `expected ≥${n} results, got ${rows.length}`,

  max_results: (rows, n) => rows.length <= n
    ? null
    : `expected ≤${n} results, got ${rows.length}`,

  exact_results: (rows, n) => rows.length === n
    ? null
    : `expected exactly ${n} results, got ${rows.length}`,

  any_result_has_youtube_id: (rows, id) =>
    rows.some((r) => r.youtube_id === id)
      ? null
      : `no result has youtube_id=${id}`,

  any_result_speakers_include: (rows, name) =>
    rows.some((r) => Array.isArray(r.speakers) && r.speakers.includes(name))
      ? null
      : `no result has speaker exactly '${name}'`,

  any_result_speakers_include_substring: (rows, substr) =>
    rows.some(
      (r) => Array.isArray(r.speakers) && r.speakers.some((s) => s.includes(substr)),
    )
      ? null
      : `no result has speaker containing '${substr}'`,

  any_result_text_includes: (rows, substr) =>
    rows.some((r) => r.text.includes(substr))
      ? null
      : `no result text includes '${substr}'`,

  any_result_text_includes_one_of: (rows, arr) =>
    rows.some((r) => arr.some((s) => r.text.includes(s)))
      ? null
      : `no result text includes any of [${arr.join(", ")}]`,

  all_results_text_include: (rows, substr) =>
    rows.length === 0 || rows.every((r) => r.text.includes(substr))
      ? null
      : `not all results contain '${substr}'`,

  all_results_have_channel: (rows, ch) =>
    rows.length === 0 || rows.every((r) => r.channel === ch)
      ? null
      : `not all results have channel=${ch}`,

  top_result_score_above: (rows, n) =>
    rows.length > 0 && rows[0].score > n
      ? null
      : `top score ${rows[0]?.score} not > ${n}`,

  top_result_chunk_id: (rows, id) =>
    rows.length > 0 && rows[0].chunk_id === id
      ? null
      : `top chunk_id is '${rows[0]?.chunk_id}', expected '${id}'`,

  any_result_chunk_id: (rows, id) =>
    rows.some((r) => r.chunk_id === id)
      ? null
      : `no result has chunk_id '${id}'`,

  any_result_has_start_ts_between: (rows, [lo, hi]) =>
    rows.some((r) => r.start_ts >= lo && r.start_ts <= hi)
      ? null
      : `no result has start_ts in [${lo}, ${hi}]`,

  top_result_has_start_ts_between: (rows, [lo, hi]) =>
    rows.length > 0 && rows[0].start_ts >= lo && rows[0].start_ts <= hi
      ? null
      : `top start_ts ${rows[0]?.start_ts} not in [${lo}, ${hi}]`,

  distinct_youtube_ids_at_least: (rows, n) => {
    const distinct = new Set(rows.map((r) => r.youtube_id));
    return distinct.size >= n
      ? null
      : `only ${distinct.size} distinct youtube_ids, expected ≥${n}`;
  },

  // ─── get_episode asserteri (payload je objekt, ne array) ─────────────

  episode_metadata_youtube_id: (p, id) =>
    p.metadata?.youtube_id === id
      ? null
      : `metadata.youtube_id='${p.metadata?.youtube_id}', expected '${id}'`,

  episode_metadata_channel: (p, ch) =>
    p.metadata?.channel === ch
      ? null
      : `metadata.channel='${p.metadata?.channel}', expected '${ch}'`,

  episode_metadata_has_title: (p, want) => {
    const has = typeof p.metadata?.title === "string" && p.metadata.title.length > 0;
    return has === want
      ? null
      : `metadata.title presence=${has}, expected=${want}`;
  },

  episode_chunk_count_min: (p, n) =>
    (p.metadata?.chunk_count ?? 0) >= n
      ? null
      : `chunk_count=${p.metadata?.chunk_count}, expected ≥${n}`,

  episode_speakers_min: (p, n) =>
    Array.isArray(p.metadata?.speakers) && p.metadata.speakers.length >= n
      ? null
      : `speakers.length=${p.metadata?.speakers?.length}, expected ≥${n}`,

  episode_duration_sec_min: (p, n) =>
    (p.metadata?.duration_sec ?? 0) >= n
      ? null
      : `duration_sec=${p.metadata?.duration_sec}, expected ≥${n}`,

  episode_transcript_null: (p, want) => {
    const isNull = p.transcript === null;
    return isNull === want
      ? null
      : `transcript ${isNull ? "is" : "is not"} null, expected ${want ? "null" : "non-null"}`;
  },

  episode_transcript_chunks_min: (p, n) =>
    Array.isArray(p.transcript) && p.transcript.length >= n
      ? null
      : `transcript.length=${p.transcript?.length}, expected ≥${n}`,

  episode_all_transcript_chunks_overlap_range: (p, [lo, hi]) => {
    if (!Array.isArray(p.transcript)) return `transcript is not an array`;
    const outside = p.transcript.filter((c) => c.end_ts < lo || c.start_ts > hi);
    return outside.length === 0
      ? null
      : `${outside.length} chunks fall outside [${lo}, ${hi}]`;
  },

  episode_truncated_eq: (p, want) =>
    p.truncated === want
      ? null
      : `truncated=${p.truncated}, expected ${want}`,

  episode_truncation_reason_includes: (p, substr) =>
    typeof p.truncation_reason === "string" && p.truncation_reason.includes(substr)
      ? null
      : `truncation_reason='${p.truncation_reason}' doesn't include '${substr}'`,

  episode_stats_returned_chunks_eq: (p, n) =>
    p.stats?.returned_chunks === n
      ? null
      : `stats.returned_chunks=${p.stats?.returned_chunks}, expected ${n}`,

  episode_stats_time_range_eq: (p, [lo, hi]) =>
    Array.isArray(p.stats?.time_range) &&
    p.stats.time_range[0] === lo &&
    p.stats.time_range[1] === hi
      ? null
      : `stats.time_range=${JSON.stringify(p.stats?.time_range)}, expected [${lo}, ${hi}]`,

  episode_chapters_min: (p, n) =>
    Array.isArray(p.chapters) && p.chapters.length >= n
      ? null
      : `chapters.length=${p.chapters?.length}, expected ≥${n}`,

  episode_all_chapters_have_valid_timestamp: (p, want) => {
    if (!Array.isArray(p.chapters)) return `chapters is not an array`;
    const invalid = p.chapters.filter((c) => c.start_ts === 0 && c.end_ts === 0);
    const allValid = invalid.length === 0;
    return allValid === want
      ? null
      : `${invalid.length} chapters have start=end=0 (expected ${want ? "0" : "≥1"})`;
  },

  episode_no_untimestamped_chunks_in_transcript: (p, want) => {
    if (!Array.isArray(p.transcript)) return `transcript is not an array`;
    const zero = p.transcript.filter((c) => c.start_ts === 0 && c.end_ts === 0);
    const none = zero.length === 0;
    return none === want
      ? null
      : `${zero.length} transcript chunks have start=end=0 (expected ${want ? "0" : "≥1"})`;
  },
};


function runAssertions(rows, mustHave) {
  const errors = [];
  for (const [key, value] of Object.entries(mustHave)) {
    if (key === "tool_call_must_error" || key === "error_contains_one_of") continue;
    const fn = ASSERTIONS[key];
    if (!fn) {
      errors.push(`unknown assertion '${key}'`);
      continue;
    }
    const err = fn(rows, value);
    if (err) errors.push(`${key}: ${err}`);
  }
  return errors;
}


// ─────────────────────── Filter + connect ──────────────────────────

const selected = cases.filter((c) => {
  if (c.requires !== requireFilter) return false;
  if (categoryFilter && c.category !== categoryFilter) return false;
  return true;
});

const skipped = cases.length - selected.length;

console.log(`Test set: ${selected.length} cases selected (${skipped} skipped by filter)`);
console.log(`Filters: requires=${requireFilter}${categoryFilter ? ` category=${categoryFilter}` : ""}`);
console.log("");

// Root je canonical MCP endpoint. /mcp backward-compat path i dalje radi.
const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
  requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
});

const client = new Client({ name: "e2e-runner", version: "0.0.1" }, { capabilities: {} });
await client.connect(transport);


// ─────────────────────── Run cases ─────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

for (const c of selected) {
  const label = `[${c.category}] ${c.id}`;
  const expectError = c.must_have?.tool_call_must_error === true;
  let result;
  let toolErrorMsg = null;

  try {
    result = await client.callTool(c.tool_call);
    if (result.isError) {
      toolErrorMsg = result.content?.[0]?.text || "unknown tool error";
    }
  } catch (e) {
    toolErrorMsg = e instanceof Error ? e.message : String(e);
  }

  // ── Slučaj: očekujemo error ────────────────────────────────────
  if (expectError) {
    if (!toolErrorMsg) {
      failed++;
      failures.push({ id: c.id, errors: ["expected tool error, got success"] });
      console.log(`✗ ${label}`);
      continue;
    }
    const needles = c.must_have.error_contains_one_of || [];
    const hit = needles.length === 0 || needles.some((n) => toolErrorMsg.toLowerCase().includes(n.toLowerCase()));
    if (hit) {
      passed++;
      console.log(`✓ ${label}  (expected error: ${truncate(toolErrorMsg, 60)})`);
    } else {
      failed++;
      const err = `error '${truncate(toolErrorMsg, 80)}' doesn't match any of [${needles.join(", ")}]`;
      failures.push({ id: c.id, errors: [err] });
      console.log(`✗ ${label}`);
    }
    continue;
  }

  // ── Slučaj: očekujemo success ──────────────────────────────────
  if (toolErrorMsg) {
    failed++;
    failures.push({ id: c.id, errors: [`unexpected tool error: ${toolErrorMsg}`] });
    console.log(`✗ ${label}`);
    continue;
  }

  let rows;
  try {
    rows = JSON.parse(result.content[0].text);
  } catch (e) {
    failed++;
    failures.push({ id: c.id, errors: [`couldn't parse tool result: ${e.message}`] });
    console.log(`✗ ${label}`);
    continue;
  }

  const errors = runAssertions(rows, c.must_have || {});
  if (errors.length === 0) {
    passed++;
    const summary = Array.isArray(rows)
      ? `${rows.length} rezultata`
      : rows?.metadata?.youtube_id
      ? `episode=${rows.metadata.youtube_id}`
      : "ok";
    console.log(`✓ ${label}  (${summary})`);
  } else {
    failed++;
    failures.push({ id: c.id, errors });
    console.log(`✗ ${label}`);
  }
}


await client.close();


// ─────────────────────── Summary ───────────────────────────────────

console.log("");
console.log("─".repeat(60));
console.log(`Result: ${passed} passed, ${failed} failed (${selected.length} total)`);

if (failures.length > 0) {
  console.log("");
  console.log("Failures:");
  for (const f of failures) {
    console.log(`  ${f.id}:`);
    for (const err of f.errors) {
      console.log(`    - ${err}`);
    }
  }
}

process.exit(failed === 0 ? 0 : 1);


// ─────────────────────── Utils ─────────────────────────────────────

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
