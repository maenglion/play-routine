export type LoginAccountMode = "parent" | "child" | "guardian";

/**
 * URL은 로그인 화면의 첫 탭만 고를 수 있습니다. 실제 역할·접근 권한은
 * 인증된 세션 metadata와 family_memberships에서만 결정됩니다.
 */
export function initialLoginModeFromSearch(search: string): LoginAccountMode {
  return new URLSearchParams(search).get("role") === "child" ? "child" : "parent";
}

export function initialLoginSelectionFromSearch(search: string) {
  return {
    mode: initialLoginModeFromSearch(search),
    // Deep links must let a previously connected child sign in immediately.
    authMode: "login" as const,
  };
}
