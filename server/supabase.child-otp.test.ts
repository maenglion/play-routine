import { describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";
vi.mock("./supabaseDb", async importOriginal => {
  const original = await importOriginal<typeof import("./supabaseDb")>();
  return { ...original, findActiveChildInvitation: vi.fn().mockResolvedValue(null) };
});
import { appRouter } from "./routers";
import { normalizeAuthRedirectUrl } from "./routers/supabaseAuth";
import { normalizeEmail } from "./supabaseDb";

describe("Supabase child OTP request", () => {
  it("normalizes email without provider-specific guessing", () => {
    expect(normalizeEmail("  Child.Name+tag@Example.COM ")).toBe(
      "child.name+tag@example.com",
    );
  });

  it("accepts the public app callback and rejects an unrelated production origin", () => {
    expect(
      normalizeAuthRedirectUrl("https://playroutine-nkwde3yc.manus.space/account?from=otp", true),
    ).toBe("https://playroutine-nkwde3yc.manus.space/");
    expect(() => normalizeAuthRedirectUrl("https://attacker.example/callback", true)).toThrow(
      "Unsupported authentication redirect origin",
    );
  });

  it("returns a generic response for an email without an active invitation", async () => {
    const ctx: TrpcContext = {
      user: null,
      req: {} as TrpcContext["req"],
      res: {} as TrpcContext["res"],
    };

    const caller = appRouter.createCaller(ctx);
    const result = await caller.supabaseAuth.requestChildOtp({
      email: `no-invite-${Date.now()}@example.invalid`,
      redirectTo: "https://playroutine-nkwde3yc.manus.space/",
    });

    expect(result.accepted).toBe(true);
    expect(result.message).toContain("초대가 유효하면");
  }, 15_000);
});
