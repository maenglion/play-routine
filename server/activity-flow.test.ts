import { describe, expect, it } from "vitest";
import {
  familyBusinessDate,
  nextBusinessDate,
  summarizeActivityDay,
  type ActivityDayRow,
} from "../client/src/lib/activity-flow";

function row(overrides: Partial<ActivityDayRow> = {}): ActivityDayRow {
  return {
    occurrence_id: "occurrence-1",
    assignment_id: "assignment-1",
    policy_rule_id: "rule-1",
    business_date: "2026-03-08",
    activity_name: "문제 풀기",
    description: null,
    category_code: "DAILY_STUDY",
    metric_label: "정답률",
    reward_minutes: 30,
    penalty_minutes: 10,
    child_reported: false,
    verification_status: "MISSING",
    parent_score: null,
    outcome_code: null,
    confirmed_minutes: null,
    revision: 0,
    ...overrides,
  };
}

describe("familyBusinessDate", () => {
  it("uses the family IANA timezone rather than the UTC date", () => {
    const instant = new Date("2026-01-01T00:30:00.000Z");

    expect(familyBusinessDate("America/Los_Angeles", instant)).toBe("2025-12-31");
    expect(familyBusinessDate("Asia/Seoul", instant)).toBe("2026-01-01");
  });

  it("remains calendar-correct around a DST boundary", () => {
    // This instant is after spring-forward in Los Angeles; no offset arithmetic
    // is used by the helper, so the local business date is still unambiguous.
    expect(familyBusinessDate("America/Los_Angeles", new Date("2026-03-08T10:30:00.000Z"))).toBe("2026-03-08");
  });
});

describe("nextBusinessDate", () => {
  it("advances ISO calendar dates across month, year, and leap-day boundaries", () => {
    expect(nextBusinessDate("2026-01-31")).toBe("2026-02-01");
    expect(nextBusinessDate("2024-02-28")).toBe("2024-02-29");
    expect(nextBusinessDate("2024-02-29")).toBe("2024-03-01");
    expect(nextBusinessDate("2026-12-31")).toBe("2027-01-01");
  });

  it("rejects malformed or impossible calendar dates", () => {
    expect(() => nextBusinessDate("03/08/2026")).toThrow("YYYY-MM-DD");
    expect(() => nextBusinessDate("2026-02-29")).toThrow("real calendar date");
  });
});

describe("summarizeActivityDay", () => {
  it("counts state and only includes finite confirmed effects", () => {
    const result = summarizeActivityDay([
      row({ occurrence_id: "missing", verification_status: "MISSING" }),
      row({ occurrence_id: "held", verification_status: "HELD", child_reported: true, confirmed_minutes: 999 }),
      row({ occurrence_id: "positive", verification_status: "CONFIRMED", child_reported: true, confirmed_minutes: 30 }),
      row({ occurrence_id: "negative", verification_status: "CONFIRMED", confirmed_minutes: -10 }),
      row({ occurrence_id: "neutral", verification_status: "CONFIRMED", confirmed_minutes: 0 }),
      row({ occurrence_id: "invalid", verification_status: "CONFIRMED", confirmed_minutes: Number.NaN }),
    ]);

    expect(result).toEqual({
      total: 6,
      reported: 2,
      confirmed: 4,
      held: 1,
      missing: 1,
      positiveMinutes: 30,
      signedMinutes: 20,
    });
  });

  it("does not turn unknown statuses or non-finite values into effects", () => {
    const unknown = row({
      verification_status: "UNKNOWN" as ActivityDayRow["verification_status"],
      child_reported: true,
      confirmed_minutes: Number.POSITIVE_INFINITY,
    });

    expect(summarizeActivityDay([unknown])).toEqual({
      total: 1,
      reported: 1,
      confirmed: 0,
      held: 0,
      missing: 0,
      positiveMinutes: 0,
      signedMinutes: 0,
    });
  });
});
