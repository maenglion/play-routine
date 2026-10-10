import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildThreeRuleBands, isRuleOutcome, validateNumericRule } from "../client/src/lib/rule-registry";
describe("rule registry numeric helpers", () => {
  it("builds exhaustive, non-overlapping three bands including 100", () => {
    const bands = buildThreeRuleBands({
      penaltyLimit: 50,
      rewardLimit: 80,
      penaltyMinutes: 20,
      rewardMinutes: 30,
    });

    expect(bands).toEqual([
      expect.objectContaining({ lower: 0, upper: 50, upperInclusive: false, outcome: "PENALTY", effectMinutes: 20 }),
      expect.objectContaining({ lower: 50, upper: 80, upperInclusive: false, outcome: "NO_REWARD", effectMinutes: 0 }),
      expect.objectContaining({ lower: 80, upper: 100, upperInclusive: true, outcome: "REWARD", effectMinutes: 30 }),
    ]);
    expect(bands[0]?.upper).toBe(bands[1]?.lower);
    expect(bands[1]?.upper).toBe(bands[2]?.lower);
  });

  it("allows explicit zero-minute no-penalty and no-reward endpoints", () => {
    const bands = buildThreeRuleBands({
      penaltyLimit: 40,
      rewardLimit: 90,
      penaltyMinutes: 0,
      rewardMinutes: 0,
    });
    expect(bands.map(band => band.outcome)).toEqual(["NO_REWARD", "NO_REWARD", "NO_REWARD"]);
    expect(bands.map(band => band.effectMinutes)).toEqual([0, 0, 0]);
  });

  it("rejects non-finite, non-integer minutes and invalid threshold order", () => {
    expect(validateNumericRule({ penaltyLimit: Number.NaN, rewardLimit: 80, penaltyMinutes: 0, rewardMinutes: 10 })).not.toHaveLength(0);
    expect(validateNumericRule({ penaltyLimit: 50, rewardLimit: Infinity, penaltyMinutes: 0, rewardMinutes: 10 })).not.toHaveLength(0);
    expect(validateNumericRule({ penaltyLimit: 80, rewardLimit: 80, penaltyMinutes: 0, rewardMinutes: 10 })).not.toHaveLength(0);
    expect(validateNumericRule({ penaltyLimit: 50, rewardLimit: 80, penaltyMinutes: -1, rewardMinutes: 10 })).not.toHaveLength(0);
    expect(validateNumericRule({ penaltyLimit: 50, rewardLimit: 80, penaltyMinutes: 0, rewardMinutes: 1.5 })).not.toHaveLength(0);
  });

  it("accepts only the three registry outcomes", () => {
    expect(isRuleOutcome("PENALTY")).toBe(true);
    expect(isRuleOutcome("NO_REWARD")).toBe(true);
    expect(isRuleOutcome("REWARD")).toBe(true);
    expect(isRuleOutcome("NOOP")).toBe(false);
    expect(isRuleOutcome("UNKNOWN")).toBe(false);
  });
});


const runLive = process.env.RUN_LIVE_SUPABASE_TESTS === "1";
(runLive ? describe : describe.skip)("규칙 등록 실DB 계약", () => {
  it("초안·게시·최신 효력·읽기 전용 권한을 롤백 시험한다", async () => {
    const {stdout} = await promisify(execFile)("pnpm", ["exec", "tsx", "scripts/verify-rule-registry-live.ts"], {cwd:process.cwd(),env:process.env,timeout:90000});
    expect(stdout).toContain("RESULT 20 checks");
  }, 100000);
});
