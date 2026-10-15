import { describe, expect, it } from "vitest";
import {
  createEmptyRoutinePayload,
  normalizeRoutinePayload,
  stableRoutineJson,
  validateRoutineForPublish,
} from "../client/src/lib/routine-v2-form";
import { routineErrorMessage } from "../client/src/lib/routine-v2-errors";
import type { ReinforcerRow } from "../shared/routine-v2";

const catalogue: ReinforcerRow[] = [
  { id: "min", name: "미디어 쿠폰", unit: "MIN", unit_label: "분" },
];
function screenshotPayload() {
  const payload = createEmptyRoutinePayload("QUEST");
  Object.assign(payload, {
    name: "학습 확인",
    childLabel: "학습",
    criteria: "부모가 점수를 확인합니다.",
    measurement: "QUANTITY",
    penaltyLimit: 60,
    penaltyMinutes: 80,
  });
  payload.tiers[0]!.threshold = 80;
  payload.tiers[0]!.rewards = [
    { id: "reward", reinforcerId: "min", amount: 120, text: "" },
  ];
  return payload;
}

describe("Quest 실제 등록 오류 회귀", () => {
  it("Quest 기본 기간은 수행 건별이고 데일리 기본은 주간 누적이다", () => {
    expect(createEmptyRoutinePayload("QUEST").period).toBe("DAILY");
    expect(createEmptyRoutinePayload("QUEST").measurement).toBe("PERCENT");
    expect(createEmptyRoutinePayload("DAILY").period).toBe("WEEKLY");
  });
  it("캡처의 60·80·80·120 값과 첫 보상 하나는 게시 가능한 구성이다", () => {
    expect(validateRoutineForPublish(screenshotPayload(), catalogue)).toEqual(
      []
    );
  });
  it("잘못 저장된 주간 Quest는 클라이언트에서도 구체적으로 안내한다", () => {
    expect(
      validateRoutineForPublish(
        { ...screenshotPayload(), period: "WEEKLY" },
        catalogue
      ).some(e => e.includes("내부 기간값"))
    ).toBe(true);
  });
  it.each(["PERCENT", "QUANTITY"] as const)(
    "%s Quest 복원은 숨겨진 기간만 바꾸고 입력·ID·첫 보상을 보존한다",
    measurement => {
      const old = {
        ...screenshotPayload(),
        period: "WEEKLY" as const,
        measurement,
      };
      const before = stableRoutineJson(old);
      const restored = normalizeRoutinePayload(old);
      expect(restored.period).toBe("DAILY");
      expect(stableRoutineJson({ ...restored, period: "WEEKLY" })).toBe(before);
      expect(stableRoutineJson(old)).toBe(before);
    }
  );
  it.each(["DAILY", "WEEKLY", "MONTHLY", "SPECIAL_EVENT"] as const)(
    "데일리 %s 보상 기간은 바꾸지 않는다",
    period => {
      expect(
        normalizeRoutinePayload({
          ...createEmptyRoutinePayload("DAILY"),
          period,
        }).period
      ).toBe(period);
    }
  );
  it("Quest 초기화·복원·저장용 정규화 모두 일간을 유지한다", () => {
    const payload = normalizeRoutinePayload(
      normalizeRoutinePayload(screenshotPayload())
    );
    expect(payload.period).toBe("DAILY");
    expect(payload.tiers[0]!.rewards).toHaveLength(1);
  });
  it("Error가 아닌 PostgREST 객체에서도 실제 기간 불일치를 한국어로 안내한다", () => {
    const e = {
      code: "22023",
      message: "ROUTINE_FLOW_MEASUREMENT_PERIOD_MISMATCH",
      details: null,
      hint: null,
    };
    expect(e).not.toBeInstanceOf(Error);
    expect(routineErrorMessage(e, "게시 실패")).toContain("내부 기간값");
  });
  it("동시 수정과 접근 거절은 원인별 안내를 제공한다", () => {
    expect(
      routineErrorMessage({ code: "40001", message: "stale" }, "실패")
    ).toContain("갱신");
    expect(
      routineErrorMessage({ code: "42501", message: "denied" }, "실패")
    ).toContain("부모 로그인");
  });
  it("알 수 없는 SQL·이메일·details·원문은 노출하지 않는다", () => {
    expect(
      routineErrorMessage(
        {
          code: "23514",
          message: "SQL secret@example.invalid",
          details: "private-query",
        },
        "게시 실패"
      )
    ).toBe("게시 실패 (오류 코드: 23514)");
    expect(
      routineErrorMessage(new Error("secret@example.invalid"), "실패")
    ).toBe("실패");
    expect(routineErrorMessage(null, "실패")).toBe("실패");
  });
});
