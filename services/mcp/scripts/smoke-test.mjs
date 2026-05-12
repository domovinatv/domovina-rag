// Smoke test za search_podcasts. Spaja se preko SSE transporta na lokalni MCP
// server, lista tool-ove i zove search_podcasts.
//
// Run: MCP_API_KEY=$(grep MCP_API_KEY ../../.env | cut -d= -f2) node scripts/smoke-test.mjs

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const key = process.env.MCP_API_KEY;
if (!key) throw new Error("MCP_API_KEY env required");

const url = new URL("http://localhost:3000/sse");
const transport = new SSEClientTransport(url, {
  requestInit: { headers: { Authorization: `Bearer ${key}` } },
  eventSourceInit: {
    fetch: (u, init) =>
      fetch(u, { ...init, headers: { ...init?.headers, Authorization: `Bearer ${key}` } }),
  },
});

const client = new Client({ name: "smoke-test", version: "0.0.1" }, { capabilities: {} });
await client.connect(transport);

console.log("--- listTools ---");
const tools = await client.listTools();
console.log(JSON.stringify(tools, null, 2));

function summarize(label, result) {
  const text = result.content?.[0]?.text;
  if (!text) {
    console.log(`${label}: (empty)`);
    return;
  }
  const rows = JSON.parse(text);
  console.log(`\n${label}: ${rows.length} rezultata`);
  rows.forEach((r, i) => {
    const preview = r.text.replace(/\s+/g, " ").slice(0, 80);
    console.log(`  ${i + 1}. [${r.score.toFixed(3)}] ${r.chunk_id} — ${preview}…`);
  });
}

console.log("\n--- 1. Pure semantic (bez lexical_terms) ---");
const semanticOnly = await client.callTool({
  name: "search_podcasts",
  arguments: { query: "iskustvo kliničke smrti", limit: 3 },
});
summarize("semantic", semanticOnly);

console.log("\n--- 2. Hybrid (lexical_terms forsiraju token match) ---");
const hybrid = await client.callTool({
  name: "search_podcasts",
  arguments: {
    query: "iskustvo kliničke smrti",
    lexical_terms: ["Isusom"],  // mora sadržavati ovaj token
    limit: 3,
  },
});
summarize("hybrid (token=Isusom)", hybrid);

console.log("\n--- 3. Hybrid s nepostojećim tokenom (treba vratiti 0) ---");
const noMatch = await client.callTool({
  name: "search_podcasts",
  arguments: {
    query: "iskustvo kliničke smrti",
    lexical_terms: ["xyzzy123notarealword"],
    limit: 3,
  },
});
summarize("hybrid (bogus token)", noMatch);

await client.close();
process.exit(0);
