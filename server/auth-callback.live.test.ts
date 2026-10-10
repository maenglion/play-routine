import { describe, expect, it } from "vitest";

// 실제 사용자 토큰·이메일 발송 없이 invalid token의 redirect 정책을 진단한다.
// 설정 검증을 명시적으로 요청한 때만 실행한다.
describe.runIf(process.env.RUN_LIVE_AUTH_CALLBACK_TESTS === "1")("Supabase live redirect configuration", () => {
  const expected = "https://playroutine-nkwde3yc.manus.space/";
  async function redirect(redirectTo?: string) {
    const base = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_PUBLISHABLE_KEY;
    if (!base || !key) throw new Error("Supabase Auth configuration is missing");
    const url = new URL(`${base}/auth/v1/verify`);
    url.searchParams.set("token", "invalid-callback-configuration-test");
    url.searchParams.set("type", "magiclink");
    if (redirectTo) url.searchParams.set("redirect_to", redirectTo);
    const result = await fetch(url, { headers: { apikey: key }, redirect: "manual" });
    expect(result.status).toBe(303);
    const location = result.headers.get("location");
    if (!location) throw new Error("Missing authentication redirect");
    const destination = new URL(location);
    return destination.origin + destination.pathname;
  }
  it("default Site URL is the public app", async () => {
    expect(await redirect()).toBe(expected);
  });
  it("requested public root is accepted", async () => {
    expect(await redirect(expected)).toBe(expected);
  });
  it("dedicated callback is accepted", async () => {
    expect(await redirect(`${expected}auth/callback`)).toBe(`${expected}auth/callback`);
  });
  it("unrelated external URL falls back to public Site URL", async () => {
    expect(await redirect("https://example.invalid/callback")).toBe(expected);
  });
});
