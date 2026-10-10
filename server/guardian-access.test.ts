import { describe, expect, it } from "vitest";
import { verifyGuardianLiveAccess } from "../scripts/verify-guardian-live";

describe.runIf(process.env.RUN_LIVE_GUARDIAN_TESTS === "1")("guardian view-only access (live Supabase RLS)", () => {
  it("allows only exact-email guardian acceptance and status projection", async () => {
    await expect(verifyGuardianLiveAccess()).resolves.toBeUndefined();
  }, 45_000);
});
