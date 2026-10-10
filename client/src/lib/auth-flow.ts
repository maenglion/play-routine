export function needsPasswordSetup(userMetadata: Record<string, unknown> | null | undefined) {
  return userMetadata?.password_configured !== true;
}

export function defaultAuthModeForAccount(accountMode: "parent" | "child") {
  return accountMode === "child" ? "signup" : "login";
}

export function isActiveInvitationExistsError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === "23505" ||
    (typeof candidate.message === "string" &&
      candidate.message.includes("ACTIVE_INVITATION_EXISTS"))
  );
}
