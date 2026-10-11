import { getAuthRedirectUrl } from "./auth-callback";

export const RECOVERY_NOTICE = "등록된 이메일이라면 비밀번호 재설정 링크가 발송됩니다. 메일함과 스팸함을 확인해 주세요.";
export const RECOVERY_SESSION_KEY = "play-routine-password-recovery-user";

export async function requestPasswordRecovery(
  auth: { resetPasswordForEmail: (email: string, options: { redirectTo: string }) => Promise<{ error: { code?: string; status?: number } | null }> },
  email: string,
  origin: string,
) {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error("가입한 이메일 주소를 입력해 주세요.");
  const { error } = await auth.resetPasswordForEmail(normalized, { redirectTo: getAuthRedirectUrl(origin) });
  if (error) {
    if (error.status === 429 || error.code?.includes("rate_limit")) throw new Error("요청이 너무 잦습니다. 잠시 후 다시 요청해 주세요.");
    throw new Error("재설정 메일을 요청하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  }
  return RECOVERY_NOTICE;
}

export function requiresRecoverySetup(activeUserId: string | undefined, recoveryLink: boolean, savedUserId: string | null) {
  return Boolean(activeUserId && (recoveryLink || savedUserId === activeUserId));
}

export function passwordsMatch(password: string, confirmation: string) {
  return password.length >= 8 && password === confirmation;
}
