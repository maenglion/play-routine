import { describe, expect, it } from "vitest";

const enabled = process.env.RUN_LIVE_NETLIFY_TESTS === "1";
describe.skipIf(!enabled)("Netlify deployment credential", () => {
  it("can read the existing Play Routine site without exposing credentials", async () => {
    const token = process.env.NETLIFY_AUTH_TOKEN;
    expect(Boolean(token)).toBe(true);
    const response = await fetch("https://api.netlify.com/api/v1/sites/8398c432-44d5-4c46-b7c0-218d2e574cc4", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    expect(response.status).toBe(200);
    const site = await response.json() as { id: string; name: string };
    expect(site.id).toBe("8398c432-44d5-4c46-b7c0-218d2e574cc4");
    expect(site.name).toBe("play-routine");
  }, 20000);
});
