// Env config loader. Bacaj eksplicitno na startupu ako required varijabla fali —
// fail-fast je bolje od misteriozne ECONNREFUSED u tool execution-u.

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export interface Config {
  transport: "stdio" | "http";
  httpPort: number;
  authMode: "apikey" | "none";
  apiKey: string | null;
  postgresUrl: string;
  clickhouseUrl: string;
  embedderUrl: string;
  serviceName: string;
  serviceVersion: string;
}

export function loadConfig(): Config {
  const transport = (optional("MCP_TRANSPORT", "stdio") as "stdio" | "http");
  if (transport !== "stdio" && transport !== "http") {
    throw new Error(`MCP_TRANSPORT must be 'stdio' or 'http', got '${transport}'`);
  }

  const authMode = (optional("MCP_AUTH_MODE", "apikey") as "apikey" | "none");
  const apiKey = process.env.MCP_API_KEY || null;
  if (transport === "http" && authMode === "apikey" && !apiKey) {
    throw new Error("MCP_API_KEY required when transport=http and auth=apikey");
  }

  return {
    transport,
    httpPort: parseInt(optional("MCP_PORT", "3000"), 10),
    authMode,
    apiKey,
    postgresUrl: required("POSTGRES_URL"),
    clickhouseUrl: required("CLICKHOUSE_URL"),
    embedderUrl: optional("EMBEDDER_URL", "http://embedder:8000"),
    serviceName: "domovina-podcast",
    serviceVersion: "0.2.0",
  };
}
