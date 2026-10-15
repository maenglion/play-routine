import { describe, expect, it } from "vitest";
import type { ReinforcerRow, RoutineDraftPayload } from "../shared/routine-v2";
import {
  canCloseRoutinePeriod,
  createEmptyRoutinePayload,
  dailyAccumulatedThreshold,
  dailyAdditionalLabel,
  isDraftPayloadDirty,
  isRealIsoDate,
  isoWeekdayForDate,
  newRoutineFormId,
  utf8ByteLength,
  validateRoutineAssignmentDates,
  validateRoutineForPublish,
  visibleGraphemeLength,
} from "../client/src/lib/routine-v2-form";

const reinforcers: ReinforcerRow[] = [
  { id: "min", name: "자유 시간", unit: "MIN", unit_label: "분" },
  { id: "wish", name: "함께 할 약속", unit: "STRING", unit_label: "내용" },
];

function dailyPayload(): RoutineDraftPayload {
  const payload = createEmptyRoutinePayload("DAILY");
  return {
    ...payload,
    name: "책 읽기",
    childLabel: "책 읽기",
    criteria: "읽은 내용을 부모에게 설명합니다.",
    tiers: [
      {
        id: "base",
        label: "주간 기본",
        threshold: 5,
        operator: "GTE",
        rewards: [{ id: "first", reinforcerId: "min", amount: 30, text: "" }],
      },
    ],
  };
}

describe("routine v2 form helpers", () => {
  it("allows a single reward and permits a removed second reward", () => {
    expect(validateRoutineForPublish(dailyPayload(), reinforcers)).toEqual([]);
  });

  it("rejects more than two rewards and more than five tiers", () => {
    const payload = dailyPayload();
    payload.tiers[0]!.rewards.push(
      { id: "second", reinforcerId: "min", amount: 10, text: "" },
      { id: "third", reinforcerId: "wish", amount: null, text: "공원 가기" }
    );
    payload.tiers = Array.from({ length: 6 }, (_, index) => ({
      ...payload.tiers[0]!,
      id: `tier-${index}`,
      threshold: index + 1,
    }));
    const errors = validateRoutineForPublish(payload, reinforcers);
    expect(errors.some(error => error.includes("1~2개"))).toBe(true);
    expect(errors.some(error => error.includes("1~5개"))).toBe(true);
  });

  it("distinguishes Quest GT/GTE while enforcing threshold boundaries and order", () => {
    const payload = createEmptyRoutinePayload("QUEST");
    Object.assign(payload, {
      name: "시험",
      childLabel: "시험",
      criteria: "채점 점수를 확인합니다.",
      penaltyLimit: 40,
      penaltyMinutes: 15,
    });
    payload.tiers = [
      {
        id: "gte",
        label: "80 이상",
        threshold: 80,
        operator: "GTE",
        rewards: [{ id: "a", reinforcerId: "min", amount: 20, text: "" }],
      },
      {
        id: "gt",
        label: "90 초과",
        threshold: 90,
        operator: "GT",
        rewards: [
          {
            id: "b",
            reinforcerId: "wish",
            amount: null,
            text: "원하는 책 고르기",
          },
        ],
      },
    ];
    expect(validateRoutineForPublish(payload, reinforcers)).toEqual([]);
    payload.tiers[1]!.threshold = 80;
    expect(validateRoutineForPublish(payload, reinforcers)).toContain(
      "달성 조건/구간은 낮은 값부터 오름차순으로 입력해 주세요."
    );
    payload.tiers[1]!.threshold = 101;
    expect(
      validateRoutineForPublish(payload, reinforcers).some(error =>
        error.includes("0~100")
      )
    ).toBe(true);
  });

  it("calculates Daily additional stickers as an accumulated threshold", () => {
    expect(dailyAccumulatedThreshold(5, 3)).toBe(8);
    expect(dailyAdditionalLabel(5, 3)).toBe("기본 5개 + 추가 3개 = 총 8개");
    expect(dailyAccumulatedThreshold(5, 0)).toBeNull();
  });

  it("counts visible graphemes rather than UTF-8 byte length", () => {
    const text = "선생님 지적없는 하루";
    expect(visibleGraphemeLength(text)).toBe(11);
    expect(utf8ByteLength(text)).toBeGreaterThan(20);
    const payload = dailyPayload();
    payload.childLabel = "가".repeat(21);
    expect(validateRoutineForPublish(payload, reinforcers)).toContain(
      "아이 표시 키워드는 보이는 글자 20자 이하여야 합니다."
    );
  });

  it("recognizes edited state only when the stored draft snapshot differs", () => {
    const stored = dailyPayload();
    expect(isDraftPayloadDirty({ ...stored }, stored)).toBe(false);
    expect(
      isDraftPayloadDirty({ ...stored, name: "수정한 책 읽기" }, stored)
    ).toBe(true);
    expect(isDraftPayloadDirty(stored, null)).toBe(true);
  });

  it("accepts only real ISO calendar dates and gives a safe weekday", () => {
    expect(isRealIsoDate("2026-02-28")).toBe(true);
    expect(isRealIsoDate("2026-02-29")).toBe(false);
    expect(isRealIsoDate("2026-2-28")).toBe(false);
    expect(isRealIsoDate("")).toBe(false);
    expect(isoWeekdayForDate("2026-10-19")).toBe(1);
    expect(isoWeekdayForDate("2026-02-29")).toBeNull();
    expect(newRoutineFormId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it("does not permit blank, impossible, or too-early assignment RPC dates", () => {
    expect(validateRoutineAssignmentDates("", "", "2026-10-20")).toContain(
      "시작일은 실제 달력 날짜로 입력해 주세요."
    );
    expect(
      validateRoutineAssignmentDates("2026-02-29", "", "2026-02-28")
    ).toContain("시작일은 실제 달력 날짜로 입력해 주세요.");
    expect(
      validateRoutineAssignmentDates("2026-10-19", "", "2026-10-20")
    ).toContain("시작일은 룰 효력일과 가족 시간대 기준 내일 이후여야 합니다.");
    expect(
      validateRoutineAssignmentDates("2026-10-20", "2026-10-19", "2026-10-20")
    ).toContain("종료일은 시작일보다 빠를 수 없습니다.");
    expect(
      validateRoutineAssignmentDates("2026-10-20", "", "2026-10-20")
    ).toEqual([]);
  });

  it("allows period confirmation only after a DAILY calendar period ends, independent of settled projection", () => {
    expect(canCloseRoutinePeriod("DAILY", "2026-10-18", "2026-10-19")).toBe(
      true
    );
    expect(canCloseRoutinePeriod("DAILY", "2026-10-19", "2026-10-19")).toBe(
      false
    );
    expect(canCloseRoutinePeriod("QUEST", "2026-10-18", "2026-10-19")).toBe(
      false
    );
    expect(canCloseRoutinePeriod("DAILY", "", "2026-10-19")).toBe(false);
  });
});
