export type FrontendBuildEnvironment = Record<string, string | undefined>;

/** Vite는 빌드 시 값을 번들에 고정한다. 빈 설정의 흰 화면을 배포하지 않는다. */
export function assertSupabaseBuildEnvironment(env: FrontendBuildEnvironment): void {
  const required = ["VITE_SUPABASE_URL", "VITE_SUPABASE_PUBLISHABLE_KEY"] as const;
  const missing = required.filter(key => !env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`Supabase build configuration missing: ${missing.join(", ")}. Set these variables in the deployment build environment before building.`);
  }
  const url = new URL(env.VITE_SUPABASE_URL!);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("VITE_SUPABASE_URL must be an HTTPS URL without credentials.");
  }
}

/** Netlify에는 미리보기 컨테이너가 없다. runtime의 unload 메시지도 필요하지 않다. */
export function includeManusPreviewRuntime(env: FrontendBuildEnvironment): boolean {
  return env.NETLIFY !== "true";
}
