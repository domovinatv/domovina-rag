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

console.log("\n--- callTool search_podcasts ---");
const result = await client.callTool({
  name: "search_podcasts",
  arguments: { query: "iskustvo kliničke smrti", limit: 3 },
});
console.log(JSON.stringify(result, null, 2));

await client.close();
process.exit(0);
