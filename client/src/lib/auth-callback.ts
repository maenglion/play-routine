import type { Session } from "@supabase/supabase-js";

export const AUTH_CALLBACK_PATH = "/auth/callback";
const AUTH_PARAMS = ["access_token", "refresh_token", "expires_in", "expires_at", "token_type", "type", "provider_token", "provider_refresh_token", "error", "error_code", "error_description", "code", "token_hash"];

export function inspectAuthCallback(href: string) {
  const url = new URL(href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const get = (name: string) => fragment.get(name) ?? url.searchParams.get(name);
  const isCallback = url.pathname === AUTH_CALLBACK_PATH || AUTH_PARAMS.some(key => fragment.has(key) || url.searchParams.has(key));
  const errorCode = get("error_code");
  // 외부에서 전달한 error_description은 화면·로그에 그대로 출력하지 않는다.
  const errorMessage = get("error") || errorCode
    ? errorCode === "otp_expired"
      ? "이메일 확인 링크가 만료되었거나 이미 사용되었습니다. 확인 메일을 다시 요청해 주세요."
      : "이메일 인증을 완료하지 못했습니다. 확인 메일을 다시 요청해 주세요."
    : get("code") || get("token_hash")
      ? "현재 앱은 이메일 확인 링크의 브라우저 세션 방식만 지원합니다. 새 확인 메일을 요청해 주세요."
      : null;
  const clean = new URL(url);
  for (const key of AUTH_PARAMS) clean.searchParams.delete(key);
  if (isCallback) clean.hash = "";
  if (clean.pathname === AUTH_CALLBACK_PATH) clean.pathname = "/";
  return { isCallback, isRecovery: get("type") === "recovery" && !errorMessage, errorMessage, cleanPath: `${clean.pathname}${clean.search}${clean.hash}` };
}

export async function receiveAuthSession(
  auth: { getSession: () => Promise<{ data: { session: Session | null }; error: unknown }> },
  callback: ReturnType<typeof inspectAuthCallback>,
) {
  if (callback.errorMessage) throw new Error(callback.errorMessage);
  let result: Awaited<ReturnType<typeof auth.getSession>>;
  try { result = await auth.getSession(); }
  catch { throw new Error("인증 세션을 읽지 못했습니다. 확인 메일을 다시 요청해 주세요."); }
  if (result.error) throw new Error("인증 세션을 읽지 못했습니다. 확인 메일을 다시 요청해 주세요.");
  if (callback.isCallback && !result.data.session) {
    throw new Error("유효한 인증 세션이 없습니다. 확인 메일의 새 링크를 사용해 주세요.");
  }
  return result.data.session;
}

// 기존 요청 계약인 루트 복귀 주소를 유지한다. 새 프로젝트의 허용목록은 별도 설정 필요.
// /auth/callback은 수신 가능 별칭이며, 미확인 설정을 전제로 요청 주소를 바꾸지 않는다.
export function getAuthRedirectUrl(origin: string) {
  return `${new URL(origin).origin}/`;
}
