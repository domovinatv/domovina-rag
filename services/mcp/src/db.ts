// Tanki layeri oko @clickhouse/client i pg. PG drži OLTP truth (episode meta),
// CH drži chunkove + vector search. Faza 1 koristi samo CH u tool putu.

import { createClient as createClickHouseClient, type ClickHouseClient } from "@clickhouse/client";
import { Pool } from "pg";

export function createCh(url: string): ClickHouseClient {
  const u = new URL(url);
  return createClickHouseClient({
    url: `${u.protocol}//${u.host}`,
    username: decodeURIComponent(u.username || "default"),
    password: decodeURIComponent(u.password || ""),
    database: u.pathname.replace(/^\//, "") || "default",
    request_timeout: 30000,
  });
}

export function createPg(url: string): Pool {
  return new Pool({ connectionString: url, max: 5 });
}
