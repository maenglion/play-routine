import { describe, expect, it } from "vitest";

describe("Supabase project connection", () => {
  it("reaches the Auth health endpoint with the configured publishable key", async () => {
    const url = process.env.SUPABASE_URL;
    const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;

    expect(url, "SUPABASE_URL must be configured").toBeTruthy();
    expect(
      publishableKey,
      "SUPABASE_PUBLISHABLE_KEY must be configured",
    ).toBeTruthy();

    const response = await fetch(`${url}/auth/v1/health`, {
      headers: {
        apikey: publishableKey!,
      },
      signal: AbortSignal.timeout(10_000),
    });

    const body = await response.text();
    expect(response.status, body).toBe(200);
  }, 15_000);
});
