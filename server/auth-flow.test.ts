import { describe, expect, it } from "vitest";
import {
  defaultAuthModeForAccount,
  isActiveInvitationExistsError,
  needsPasswordSetup,
} from "../client/src/lib/auth-flow";

describe("email-link signup flow", () => {
  it("requires a password after a new email-link session", () => {
    expect(needsPasswordSetup({ account_type: "parent" })).toBe(true);
    expect(needsPasswordSetup({ account_type: "child" })).toBe(true);
  });

  it("does not repeat password setup after completion", () => {
    expect(needsPasswordSetup({ password_configured: true })).toBe(false);
  });

  it("opens a child's first connection flow instead of password login", () => {
    expect(defaultAuthModeForAccount("child")).toBe("signup");
    expect(defaultAuthModeForAccount("parent")).toBe("login");
  });

  it("recognizes an already active child invitation", () => {
    expect(isActiveInvitationExistsError({ code: "23505" })).toBe(true);
    expect(isActiveInvitationExistsError({ message: "ACTIVE_INVITATION_EXISTS" })).toBe(true);
    expect(isActiveInvitationExistsError({ code: "42501" })).toBe(false);
  });
});
