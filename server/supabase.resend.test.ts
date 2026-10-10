import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(), signInWithOtp: vi.fn(), lookup: vi.fn(),
  childLookup: vi.fn(), reserve: vi.fn(), record: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { getUser: mocks.getUser, signInWithOtp: mocks.signInWithOtp } }),
}));
vi.mock("./supabaseDb", () => ({
  normalizeEmail: (email: string) => email.trim().toLowerCase(),
  findActiveParentOwnedInvitation: mocks.lookup,
  findActiveChildInvitation: mocks.childLookup,
  reserveOtpRequest: mocks.reserve,
  recordInvitationDeliveryEvent: mocks.record,
}));
import { supabaseAuthRouter } from "./routers/supabaseAuth";

const input = {
  accessToken: "unit-test-placeholder",
  familyId: "11111111-1111-4111-8111-111111111111",
  invitationId: "22222222-2222-4222-8222-222222222222",
  email: "Child@Example.com",
  redirectTo: "https://playroutine-nkwde3yc.manus.space/",
};
const invitation = { id: input.invitationId, familyId: input.familyId, childProfileId: "child-profile" };
const ctx = { user: null, req: {}, res: {} } as TrpcContext;
const caller = () => supabaseAuthRouter.createCaller(ctx);

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "unit-test-placeholder");
  mocks.getUser.mockResolvedValue({ data: { user: { id: "verified-parent" } }, error: null });
  mocks.lookup.mockResolvedValue(invitation);
  mocks.childLookup.mockResolvedValue(invitation);
  mocks.reserve.mockResolvedValue({ allowed: true, recentCount: 0, dailyCount: 0 });
  mocks.signInWithOtp.mockResolvedValue({ error: null });
  mocks.record.mockResolvedValue(undefined);
});

describe("부모 승인 메일 재전송", () => {
  it("부모 세션 없는 호출은 발송이나 소유권 조회 없이 일반 응답을 반환한다", async () => {
    const result = await caller().resendChildInvitationEmail({ ...input, accessToken: undefined });
    expect(result.message).toContain("초대가 유효하면");
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.signInWithOtp).not.toHaveBeenCalled();
  });
  it("잘못된 부모 세션은 정보 노출 없이 발송을 차단한다", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { code: "INVALID" } });
    await caller().resendChildInvitationEmail(input);
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.signInWithOtp).not.toHaveBeenCalled();
  });
  it("인증 서버 예외도 초대 존재 여부를 노출하지 않는다", async () => {
    mocks.getUser.mockRejectedValue(new Error("network"));
    const result = await caller().resendChildInvitationEmail(input);
    expect(result.accepted).toBe(true);
    expect(mocks.signInWithOtp).not.toHaveBeenCalled();
  });
  it.each(["다른 부모", "다른 가족", "다른 이메일", "만료/수락된 초대"])("%s 조회 불일치 시 발송하지 않는다", async () => {
    mocks.lookup.mockResolvedValue(null);
    const result = await caller().resendChildInvitationEmail(input);
    expect(mocks.lookup).toHaveBeenCalledWith({ authUserId: "verified-parent", familyId: input.familyId, invitationId: input.invitationId, email: "child@example.com" });
    expect(result.message).toContain("초대가 유효하면");
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.signInWithOtp).not.toHaveBeenCalled();
  });
  it("일치하는 부모 초대는 공유 제한 확인 후 공개 주소로 발송한다", async () => {
    await caller().resendChildInvitationEmail(input);
    expect(mocks.reserve).toHaveBeenCalledWith(input.invitationId, expect.any(String));
    expect(mocks.signInWithOtp).toHaveBeenCalledWith({ email: "child@example.com", options: { shouldCreateUser: true, emailRedirectTo: input.redirectTo, data: { account_type: "child" } } });
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ eventType: "OTP_SENT", detail: { sourceRequestId: expect.any(String) } }));
  });
  it.each([{ recentCount: 1, dailyCount: 1 }, { recentCount: 0, dailyCount: 5 }])("60초/24시간 제한이면 발송하지 않는다: %j", async counts => {
    mocks.reserve.mockResolvedValue({ allowed: false, ...counts });
    await caller().resendChildInvitationEmail(input);
    expect(mocks.signInWithOtp).not.toHaveBeenCalled();
  });
  it("발송 오류에는 코드/상태만 감사 기록하고 이메일/토큰은 기록하지 않는다", async () => {
    mocks.signInWithOtp.mockResolvedValue({ error: { code: "over_email_send_rate_limit", status: 429, message: "private details" } });
    await caller().resendChildInvitationEmail(input);
    const event = mocks.record.mock.calls[0][0];
    expect(event.eventType).toBe("OTP_FAILED");
    expect(event.detail).toEqual({ sourceRequestId: expect.any(String), code: "over_email_send_rate_limit", status: 429 });
    expect(JSON.stringify(event)).not.toContain(input.accessToken);
    expect(JSON.stringify(event)).not.toContain("private details");
  });
  it("전송 예외에도 실패 감사를 기록한다", async () => {
    mocks.signInWithOtp.mockRejectedValue(new Error("network"));
    await caller().resendChildInvitationEmail(input);
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ eventType: "OTP_FAILED", detail: { sourceRequestId: expect.any(String), code: "AUTH_REQUEST_FAILED", status: null } }));
  });
  it("외부 callback은 발송 전에 거절한다", async () => {
    await expect(caller().resendChildInvitationEmail({ ...input, redirectTo: "https://attacker.example/" })).rejects.toThrow();
    expect(mocks.getUser).not.toHaveBeenCalled();
  });
  it("자녀 첫 연결 요청도 부모와 같은 제한·발송 함수를 사용한다", async () => {
    await caller().requestChildOtp({ email: input.email, redirectTo: input.redirectTo });
    expect(mocks.reserve).toHaveBeenCalledWith(input.invitationId, expect.any(String));
    expect(mocks.signInWithOtp).toHaveBeenCalledTimes(1);
  });
});
