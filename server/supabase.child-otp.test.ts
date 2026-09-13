import { describe, expect, it } from "vitest";
import type { TrpcContext } from "./_core/context";
import { appRouter } from "./routers";
import { normalizeEmail } from "./supabaseDb";

describe("Supabase child OTP request", () => {
  it("normalizes email without provider-specific guessing", () => {
    expect(normalizeEmail("  Child.Name+tag@Example.COM ")).toBe(
      "child.name+tag@example.com",
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
    });

    expect(result.accepted).toBe(true);
    expect(result.message).toContain("초대가 유효하면");
  }, 15_000);
});
