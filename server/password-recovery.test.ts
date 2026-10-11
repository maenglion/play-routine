import { describe, expect, it, vi } from "vitest";
import { inspectAuthCallback } from "../client/src/lib/auth-callback";
import { RECOVERY_NOTICE, requestPasswordRecovery, requiresRecoverySetup, passwordsMatch } from "../client/src/lib/password-recovery";

describe("비밀번호 복구", () => {
  it("복구 링크를 가입과 구분하고 URL의 인증정보를 정리한다", () => {
    const state = inspectAuthCallback("https://example.test/#type=recovery&access_token=fake&refresh_token=fake");
    expect(state.isRecovery).toBe(true); expect(state.cleanPath).toBe("/");
    expect(inspectAuthCallback("https://example.test/#type=signup&access_token=fake").isRecovery).toBe(false);
  });
  it("만료 복구 링크는 재설정 성공 모드가 아니다", () => {
    const state = inspectAuthCallback("https://example.test/#type=recovery&error=access_denied&error_code=otp_expired");
    expect(state.isRecovery).toBe(false); expect(state.errorMessage).toContain("만료");
  });
  it("이메일을 정규화해 recovery API만 호출하고 공개 루트로 돌아온다", async () => {
    const resetPasswordForEmail=vi.fn().mockResolvedValue({error:null});
    expect(await requestPasswordRecovery({resetPasswordForEmail}," Test@Example.COM ","https://example.test")).toBe(RECOVERY_NOTICE);
    expect(resetPasswordForEmail).toHaveBeenCalledWith("test@example.com",{redirectTo:"https://example.test/"});
  });
  it("이메일이 잘못되면 요청하지 않는다", async () => {
    const resetPasswordForEmail=vi.fn(); await expect(requestPasswordRecovery({resetPasswordForEmail},"bad","https://example.test")).rejects.toThrow("이메일");expect(resetPasswordForEmail).not.toHaveBeenCalled();
  });
  it("rate limit과 실패는 비밀·서버 메시지 없이 안내한다", async () => {
    const resetPasswordForEmail=vi.fn().mockResolvedValue({error:{status:429}});await expect(requestPasswordRecovery({resetPasswordForEmail},"a@b.com","https://example.test")).rejects.toThrow("너무 잦");
    resetPasswordForEmail.mockResolvedValue({error:{status:500,message:'private-info'}});await expect(requestPasswordRecovery({resetPasswordForEmail},"a@b.com","https://example.test")).rejects.toThrow("요청하지 못");
  });
  it("복구 설정은 인증된 계정에만 표시하고 새로고침 후 같은 계정만 유지한다", () => {
    expect(requiresRecoverySetup(undefined,true,null)).toBe(false);expect(requiresRecoverySetup('one',true,null)).toBe(true);expect(requiresRecoverySetup('one',false,'one')).toBe(true);expect(requiresRecoverySetup('two',false,'one')).toBe(false);expect(requiresRecoverySetup('one',false,null)).toBe(false);
  });
  it("8자 이상 동일 비밀번호 두 개를 요구한다", () => {
    expect(passwordsMatch('12345678','12345678')).toBe(true);expect(passwordsMatch('1234567','1234567')).toBe(false);expect(passwordsMatch('12345678','87654321')).toBe(false);
  });
});
