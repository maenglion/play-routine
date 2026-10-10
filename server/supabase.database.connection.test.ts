import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { getSupabaseConnectionString } from "./supabaseConnection";

describe.runIf(process.env.RUN_LIVE_SUPABASE_TESTS === "1")("Supabase PostgreSQL connection", () => {
  it("authenticates with the configured transaction pooler URL", async () => {
    const databaseUrl = getSupabaseConnectionString();
    expect(databaseUrl, "SUPABASE_DATABASE_URL must be configured").toBeTruthy();
    const client = new Client({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 10_000,
      ssl: { rejectUnauthorized: false },
    });
    try {
      await client.connect();
      const result = await client.query("select 1 as ok");
      expect(result.rows[0]?.ok).toBe(1);
    } finally {
      await client.end();
    }
  }, 20_000);
});
