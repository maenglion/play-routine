import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const live =
  process.env.RUN_LIVE_ROUTINE_V2_TESTS === "1" ? describe : describe.skip;

live("실DB Routine v2 계약", () => {
  it("권한·초안·게시·기간 스티커·정정 review·독립 이행을 rollback fixture로 검증한다", async () => {
    const { stdout } = await run(
      process.execPath,
      ["--import", "tsx", "scripts/verify-routine-v2-live.ts"],
      {
        cwd: process.cwd(),
        env: process.env,
        timeout: 240_000,
        maxBuffer: 1024 * 1024,
      }
    );
    expect(stdout).toContain("ROUTINE_V2_LIVE_OK");
  }, 300_000);
});
