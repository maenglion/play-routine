import { describe, expect, it } from "vitest";
import { approvedOctoberRules, octoberRulesSeed } from "./october-seed-data";

describe("실제 10월 규칙 seed 계약", () => {
  const rules = approvedOctoberRules("PENDING");
  const byCode = (code: string) => rules.find(x => x.code === code)!;
  it("영구 번호 26개와 3/7/16 분류를 유지한다", () => {
    expect(rules).toHaveLength(26);
    expect(new Set(rules.map(x => x.code)).size).toBe(26);
    expect(
      ["QUEST", "TASK", "LIFESTYLE"].map(
        d => rules.filter(x => x.domain === d).length
      )
    ).toEqual([3, 7, 16]);
  });
  it("생활 보상 인정 최대는 195분이며 사건형을 제외한 점검 패널티 후보는 -240분이다", () => {
    const sum = (kind: string) =>
      rules
        .filter(
          x =>
            x.domain === "LIFESTYLE" &&
            x.effect_kind === kind &&
            x.daily_limit !== null
        )
        .reduce((n, x) => n + x.daily_limit! * x.effects[0].quantity!, 0);
    expect(sum("REWARD")).toBe(195);
    expect(sum("PENALTY")).toBe(-240);
    expect(byCode("L-001").daily_limit).toBe(3);
    expect(byCode("L-004").daily_limit).toBe(2);
  });
  it("Q001 두 독립 자산과 20문제·240초를 변형하지 않는다", () => {
    expect(byCode("Q-001").effects).toEqual([
      { asset: "MINUTES", quantity: 300 },
      { asset: "CASH_KRW", quantity: 50000 },
    ]);
    expect(byCode("Q-001").condition_spec).toMatchObject({
      problem_count: 20,
      max_seconds: 240,
      requires_parent_pass: true,
    });
  });
  it("학교 보상 자산과 바이올린 수량을 임의 확정하지 않는다", () => {
    expect(byCode("T-007").condition_spec.school_asset).toBe("PENDING");
    expect(byCode("T-007").effects).toEqual([]);
    expect(byCode("T-003").effects[0].quantity).toBeNull();
  });
  it("실제 학교 구간은 최종총액이며 옛 시간 후보와 분리된다", () => {
    expect(byCode("T-007").condition_spec).toMatchObject({
      mode: "HIGHEST_MATCH_FINAL_TOTAL",
      tiers: {
        COUPAY_KRW: [
          { min: 5, quantity: 10000 },
          { min: 8, quantity: 15000 },
        ],
        MINUTES: [
          { min: 5, quantity: 300 },
          { min: 8, quantity: 480 },
        ],
      },
    });
  });
  it("10월24일은 단발240분이며 T005에서는 제외하고 다른 토요일은 부모 확인을 요구한다", () => {
    expect(byCode("T-006")).toMatchObject({
      period: "EVENT",
      daily_limit: null,
      effects: [{ asset: "MINUTES", quantity: 240 }],
      condition_spec: { schedule: { eventDates: ["2026-10-24"] } },
    });
    expect(byCode("T-005").condition_spec).toMatchObject({
      saturday_requires_no_class: true,
      schedule: { supportDays: [2, 5, 6], excludedDates: ["2026-10-24"] },
    });
  });
  it("시험창과 최고 한 구간, 종이접기 월간 한 성취를 유지한다", () => {
    expect(byCode("Q-003").condition_spec).toMatchObject({
      mode: "HIGHEST_MATCH_FINAL_TOTAL",
      schedule: {
        eventDates: ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"],
        deadline: "2026-10-22",
      },
      tiers: [
        { min_subjects: 4, min_score: 90, quantity: 600 },
        { min_subjects: 3, min_score: 90, quantity: 480 },
        { min_subjects: 3, min_score: 80, quantity: 360 },
      ],
    });
    expect(byCode("Q-002").condition_spec.completion_once).toBe(true);
  });
  it("복약 공란과 의료 자료는 패널티 근거가 아니다", () => {
    expect(byCode("L-013")).toMatchObject({
      daily_limit: 1,
      effects: [{ asset: "MINUTES", quantity: -40 }],
      condition_spec: {
        requires_direct_verification: true,
        medication_record_dependency: false,
      },
    });
    expect(byCode("L-015").condition_spec.exclusive_incident_group).toBe(
      "PROPERTY_DAMAGE"
    );
    expect(byCode("L-016").condition_spec.exclusive_incident_group).toBe(
      "PROPERTY_DAMAGE"
    );
  });
  it("승인용 사본의 변경이 seed 정본에 번지지 않는다", () => {
    const copy = approvedOctoberRules("COUPAY_KRW");
    copy[0].effects[0].quantity = 1;
    expect(octoberRulesSeed[0].effects[0].quantity).toBe(300);
    expect(
      approvedOctoberRules("PENDING").find(x => x.code === "T-007")!
        .condition_spec.school_asset
    ).toBe("PENDING");
  });
});
