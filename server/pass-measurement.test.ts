import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  PASS_METRIC_LABEL,
  isPassMeasurementKind,
  validatePassRule,
} from "../client/src/lib/rule-registry";
import { summarizeActivityDay, type ActivityDayRow } from "../client/src/lib/activity-flow";

function passRow(overrides: Partial<ActivityDayRow> = {}): ActivityDayRow {
  return {
    occurrence_id: "pass-occurrence",
    assignment_id: "pass-assignment",
    policy_rule_id: "pass-rule",
    business_date: "2026-10-12",
    activity_name: "숙제 약속",
    description: null,
    category_code: "DAILY_STUDY",
    metric_label: PASS_METRIC_LABEL,
    reward_minutes: 30,
    penalty_minutes: 0,
    child_reported: false,
    verification_status: "MISSING",
    parent_score: null,
    outcome_code: null,
    confirmed_minutes: null,
    revision: 0,
    measurement_kind: "PASS_FAIL",
    ...overrides,
  };
}

describe("PASS measurement client contract", () => {
  it("identifies only PASS_FAIL as the binary confirmation kind", () => {
    expect(isPassMeasurementKind("PASS_FAIL")).toBe(true);
    expect(isPassMeasurementKind("PERCENT")).toBe(false);
    expect(isPassMeasurementKind("QUANTITY")).toBe(false);
  });

  it("allows explicit no-time PASS while rejecting invalid minute values", () => {
    expect(validatePassRule({ rewardMinutes: 0 })).toEqual([]);
    expect(validatePassRule({ rewardMinutes: 30 })).toEqual([]);
    expect(validatePassRule({ rewardMinutes: -1 })).not.toEqual([]);
    expect(validatePassRule({ rewardMinutes: 1.5 })).not.toEqual([]);
    expect(validatePassRule({ rewardMinutes: Number.NaN })).not.toEqual([]);
    expect(validatePassRule({ rewardMinutes: 241 })).not.toEqual([]);
  });

  it("keeps a missing or child-reported PASS activity neutral until parent confirmation", () => {
    expect(summarizeActivityDay([
      passRow(),
      passRow({ occurrence_id: "held", child_reported: true, verification_status: "HELD" }),
    ])).toEqual({
      total: 2,
      reported: 1,
      confirmed: 0,
      held: 1,
      missing: 1,
      positiveMinutes: 0,
      signedMinutes: 0,
    });
  });

  it("counts only explicit parent PASS planned time, not a not-pass confirmation", () => {
    expect(summarizeActivityDay([
      passRow({
        occurrence_id: "not-pass",
        verification_status: "CONFIRMED",
        parent_score: 0,
        outcome_code: "NO_REWARD",
        confirmed_minutes: 0,
      }),
      passRow({
        occurrence_id: "pass",
        verification_status: "CONFIRMED",
        parent_score: 100,
        outcome_code: "REWARD",
        confirmed_minutes: 30,
      }),
    ])).toEqual({
      total: 2,
      reported: 0,
      confirmed: 2,
      held: 0,
      missing: 0,
      positiveMinutes: 30,
      signedMinutes: 30,
    });
  });
});

const runLive = process.env.RUN_LIVE_PASS_TESTS === "1";
(runLive ? describe : describe.skip)("실DB PASS 측정 계약", () => {
  it("rollback fixture로 자동 PASS 금지·이진 확인·revision·멱등을 검사한다", async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "scripts/verify-pass-flow-live.ts"],
      { cwd: process.cwd(), env: process.env, timeout: 90_000, maxBuffer: 1024 * 1024 },
    );
    expect(stdout).toContain("PASS_FLOW_LIVE_OK");
  }, 100_000);
});
