import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const live = process.env.RUN_LIVE_ACTIVITY_TESTS === "1" ? describe : describe.skip;
live("실DB 활동 배정·자녀 보고·부모 확인", () => {
  it("가족별 권한·불변 기록·구간·소급·중복을 검사하고 전체 fixture를 롤백한다", async () => {
    const { stdout } = await run(process.execPath, ["--import", "tsx", "scripts/verify-activity-flow-live.ts"], { timeout: 90000, maxBuffer: 1024 * 1024 });
    expect(stdout).toContain("ACTIVITY_FLOW_LIVE_OK");
  }, 100000);
});
