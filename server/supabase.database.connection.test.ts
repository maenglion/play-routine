import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("Supabase PostgreSQL connection", () => {
  it("authenticates with the configured transaction pooler URL", () => {
    const databaseUrl = process.env.SUPABASE_DATABASE_URL;
    expect(databaseUrl, "SUPABASE_DATABASE_URL must be configured").toBeTruthy();

    const output = execFileSync(
      "psql",
      [databaseUrl!, "-X", "-tA", "-c", "select 1"],
      {
        encoding: "utf8",
        timeout: 15_000,
        env: {
          ...process.env,
          PGCONNECT_TIMEOUT: "10",
          PGSSLMODE: "require",
        },
      },
    );

    expect(output.trim()).toBe("1");
  }, 20_000);
});
