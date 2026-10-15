import { defineConfig } from "vitest/config";
import path from "path";

const templateRoot = path.resolve(import.meta.dirname);
// 동일 DB의 롤백 fixture들은 잠금을 공유하므로 실제 연결시험에서만 파일을 직렬 실행한다.
// 기본 단위시험은 기존 병렬 실행을 유지한다.
const sharedLiveDatabase = [
  "RUN_LIVE_ROUTINE_V2_TESTS", "RUN_LIVE_ACTIVITY_TESTS", "RUN_LIVE_SUPABASE_TESTS",
  "RUN_LIVE_GUARDIAN_TESTS", "RUN_LIVE_PASS_TESTS",
].some(name => process.env[name] === "1");

export default defineConfig({
  root: templateRoot,
  resolve: {
    alias: {
      "@": path.resolve(templateRoot, "client", "src"),
      "@shared": path.resolve(templateRoot, "shared"),
      "@assets": path.resolve(templateRoot, "attached_assets"),
    },
  },
  test: {
    environment: "node",
    include: ["server/**/*.test.ts", "server/**/*.spec.ts"],
    fileParallelism: !sharedLiveDatabase,
  },
});
