// Smoke test za search_podcasts. Spaja se preko Streamable HTTP transporta na lokalni
// MCP server, lista tool-ove i zove search_podcasts s tri scenarija (semantic,
// hybrid, no-match).
//
// Run: MCP_API_KEY=$(grep MCP_API_KEY ../../.env | cut -d= -f2) node scripts/smoke-test.mjs
// Default endpoint: http://localhost:3000/ (root, canonical)
// Override: MCP_URL=https://mcp.domovina.ai/ node scripts/smoke-test.mjs
// /mcp i dalje radi za backward-compat klijente.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const key = process.env.MCP_API_KEY;
if (!key) throw new Error("MCP_API_KEY env required");

const url = new URL(process.env.MCP_URL || "http://localhost:3000/");
const transport = new StreamableHTTPClientTransport(url, {
  requestInit: {
    headers: { Authorization: `Bearer ${key}` },
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
  let rows = JSON.parse(text);
  if (rows && typeof rows === "object" && !Array.isArray(rows) && Array.isArray(rows.results)) {
    rows = rows.results;
  }
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
