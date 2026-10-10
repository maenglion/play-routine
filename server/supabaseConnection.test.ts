import { afterEach, describe, expect, it, vi } from "vitest";
import { getSupabaseConnectionString } from "./supabaseConnection";

afterEach(() => vi.unstubAllEnvs());
describe("DB 연결정보의 안전한 분리 입력", () => {
  it("별도 비밀번호가 없으면 등록된 URI를 그대로 사용한다", () => {
    vi.stubEnv("SUPABASE_DATABASE_URL", "postgresql://test:old@localhost:5432/postgres");
    vi.stubEnv("SUPABASE_DATABASE_PASSWORD", "");
    expect(getSupabaseConnectionString()).toBe("postgresql://test:old@localhost:5432/postgres");
  });
  it("별도 입력의 특수문자를 정확히 한 번 인코딩한다", () => {
    vi.stubEnv("SUPABASE_DATABASE_URL", "postgresql://test:old@localhost:5432/postgres");
    vi.stubEnv("SUPABASE_DATABASE_PASSWORD", "test@#%/]:pass");
    const url = new URL(getSupabaseConnectionString());
    expect(decodeURIComponent(url.password)).toBe("test@#%/]:pass");
    expect(url.hostname).toBe("localhost");
    expect(url.username).toBe("test");
  });
});
