import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
const run = promisify(execFile);
const live = process.env.RUN_LIVE_OCTOBER_TESTS === "1";
describe.runIf(live)("실제 10월 운영 DB 롤백 반례", () => {
  it("회차·복수 효과·시험 최고구간·학교 재마감·권한을 검사한다", async () => {
    const { stdout } = await run(
      "pnpm",
      ["exec", "tsx", "scripts/verify-october-runtime-live.ts"],
      {
        cwd: process.cwd(),
        env: process.env,
        timeout: 300000,
        maxBuffer: 1024 * 1024,
      }
    );
    expect(stdout).toContain('"rollback": true');
    expect(stdout).toContain('"fixtureCommitted": false');
  }, 310000);
  it("신규 감사의 행위자·원문 제외·권한·불변성을 검사한다", async () => {
    const { stdout } = await run(
      "pnpm",
      ["exec", "tsx", "scripts/verify-october-audit-live.ts"],
      {
        cwd: process.cwd(),
        env: process.env,
        timeout: 180000,
        maxBuffer: 1024 * 1024,
      }
    );
    expect(stdout).toContain('"rollback": true');
    expect(stdout).toContain('"seedOrFactsCommitted": false');
  }, 190000);
});
