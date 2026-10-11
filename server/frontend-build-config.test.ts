import { describe, expect, it } from "vitest";
import { assertSupabaseBuildEnvironment, includeManusPreviewRuntime } from "../shared/frontend-build-config";

const configured = {
  VITE_SUPABASE_URL: "https://test-project.supabase.co",
  VITE_SUPABASE_PUBLISHABLE_KEY: "test-public-value-not-a-credential",
};

describe("frontend build configuration", () => {
  it("rejects missing variables before producing an unusable bundle", () => {
    expect(() => assertSupabaseBuildEnvironment({})).toThrow("VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY");
  });
  it("rejects an empty key without exposing its value in errors", () => {
    expect(() => assertSupabaseBuildEnvironment({ ...configured, VITE_SUPABASE_PUBLISHABLE_KEY: " " })).toThrow("VITE_SUPABASE_PUBLISHABLE_KEY");
  });
  it("accepts a configured HTTPS project", () => {
    expect(() => assertSupabaseBuildEnvironment(configured)).not.toThrow();
  });
  it("rejects insecure URLs and embedded credentials", () => {
    expect(() => assertSupabaseBuildEnvironment({ ...configured, VITE_SUPABASE_URL: "http://test-project.supabase.co" })).toThrow("HTTPS");
    expect(() => assertSupabaseBuildEnvironment({ ...configured, VITE_SUPABASE_URL: "https://user:secret@test-project.supabase.co" })).toThrow("without credentials");
  });
  it("excludes preview container runtime in Netlify only", () => {
    expect(includeManusPreviewRuntime({ NETLIFY: "true" })).toBe(false);
    expect(includeManusPreviewRuntime({})).toBe(true);
  });
});
