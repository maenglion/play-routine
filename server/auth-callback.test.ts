import { describe, expect, it, vi } from "vitest";
import type { Session } from "@supabase/supabase-js";
import { getAuthRedirectUrl, inspectAuthCallback, receiveAuthSession } from "../client/src/lib/auth-callback";

const origin = "https://playroutine-nkwde3yc.manus.space";
describe("SPA Supabase callback", () => {
  it("평범한 방문은 콜백으로 오인하지 않는다", () => {
    expect(inspectAuthCallback(`${origin}/?page=rules#section`).isCallback).toBe(false);
  });
  it("메일의 fragment를 감지하되 반환 상태에 토큰을 보존하지 않는다", () => {
    const result = inspectAuthCallback(`${origin}/#access_token=fake-test&refresh_token=fake-test&type=signup`);
    expect(result.isCallback).toBe(true);
    expect(result.cleanPath).toBe("/");
    expect(JSON.stringify(result)).not.toContain("fake-test");
  });
  it("전용 callback 경로를 홈으로 정리하고 외부 next 주소는 따라가지 않는다", () => {
    const result = inspectAuthCallback(`${origin}/auth/callback?next=https://attacker.example&code=fake`);
    expect(result.cleanPath).toBe("/?next=https%3A%2F%2Fattacker.example");
    expect(result.errorMessage).toContain("브라우저 세션 방식");
  });
  it("만료 링크는 한국어 안내를 표시하고 외부 error_description은 출력하지 않는다", () => {
    const result = inspectAuthCallback(`${origin}/#error=access_denied&error_code=otp_expired&error_description=UNTRUSTED_TEXT`);
    expect(result.errorMessage).toContain("만료");
    expect(JSON.stringify(result)).not.toContain("UNTRUSTED_TEXT");
    expect(result.cleanPath).toBe("/");
  });
  it("query의 인증 정보도 주소에서 제거한다", () => {
    expect(inspectAuthCallback(`${origin}/auth/callback?error=denied&error_description=fake&from=email`).cleanPath).toBe("/?from=email");
  });
  it("정상 콜백은 SDK의 세션 수신 완료를 기다린다", async () => {
    const session = { user: { id: "test" } } as Session;
    const auth = { getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }) };
    expect(await receiveAuthSession(auth, inspectAuthCallback(`${origin}/auth/callback`))).toBe(session);
    expect(auth.getSession).toHaveBeenCalledOnce();
  });
  it("일반 미로그인 방문은 정상이며 콜백의 빈 세션은 오류다", async () => {
    const auth = { getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }) };
    expect(await receiveAuthSession(auth, inspectAuthCallback(`${origin}/`))).toBeNull();
    await expect(receiveAuthSession(auth, inspectAuthCallback(`${origin}/auth/callback`))).rejects.toThrow("유효한 인증 세션");
  });
  it("SDK 오류는 그대로 로그나 화면에 노출하지 않는다", async () => {
    const auth = { getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: {message:"sensitive"} }) };
    await expect(receiveAuthSession(auth, inspectAuthCallback(`${origin}/`))).rejects.toThrow("인증 세션을 읽지 못했습니다");
  });
  it("인증 오류 URL에서는 기존 세션을 성공으로 오인하지 않는다", async () => {
    const auth = { getSession: vi.fn() };
    await expect(receiveAuthSession(auth, inspectAuthCallback(`${origin}/#error_code=otp_expired`))).rejects.toThrow("만료");
    expect(auth.getSession).not.toHaveBeenCalled();
  });
  it("메일 요청은 현재 루트 허용 주소를 유지한다", () => {
    expect(getAuthRedirectUrl(origin)).toBe(`${origin}/`);
    expect(getAuthRedirectUrl("http://localhost:3000")).toBe("http://localhost:3000/");
  });
});
