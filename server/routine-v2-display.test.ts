import { describe, expect, it } from "vitest";
import {
  rewardLabel,
  routineDaySummary,
  stickerLabel,
  thresholdLabel,
} from "../client/src/lib/routine-v2-display";
import type { RoutineDayRow } from "../shared/routine-v2";

const row = (overrides: Partial<RoutineDayRow>): RoutineDayRow =>
  ({
    flow: "DAILY",
    stickers: null,
    verification_status: "MISSING",
    ...overrides,
  }) as RoutineDayRow;
describe("새 룰의 자녀 표시", () => {
  it("부모 미확인과 실패 0개를 서로 다른 상태로 유지한다", () => {
    const result = routineDaySummary([
      row({ verification_status: "HELD" }),
      row({ verification_status: "CONFIRMED", stickers: 0 }),
    ]);
    expect(result.held).toBe(1);
    expect(result.confirmed).toBe(1);
    expect(result.todayStickers).toBe(0);
  });
  it("Quest 수치와 기간 누적 합계를 오늘 스티커로 더하지 않는다", () => {
    expect(
      routineDaySummary([
        row({ stickers: 1, sticker_total: 8 }),
        row({ flow: "QUEST", score: 99, stickers: null }),
      ]).todayStickers
    ).toBe(1);
  });
  it("칭찬 포함 오늘 기록은 두 개이지만 다른 기간의 보상용 합계는 만들지 않는다", () => {
    const value = routineDaySummary([
      row({ stickers: 2, sticker_total: 8 }),
      row({ stickers: 1, sticker_total: 5 }),
    ]);
    expect(value.todayStickers).toBe(3);
    expect(value).not.toHaveProperty("periodRewardTotal");
  });
  it("원화와 분을 서로 다른 단위로 표시한다", () => {
    expect(
      rewardLabel({
        name: "약속",
        unit: "WON",
        unit_label: "",
        amount: 10000,
        text: "",
      })
    ).toBe("약속 10,000원");
    expect(
      rewardLabel({
        name: "자유시간",
        unit: "MIN",
        unit_label: "",
        amount: 120,
        text: "",
      })
    ).toBe("자유시간 120분");
  });
  it("서비스 포인트는 등록한 단위를 유지하고 소원은 숫자로 바꾸지 않는다", () => {
    expect(
      rewardLabel({
        name: "게임",
        unit: "POINT",
        unit_label: "코인",
        amount: 30,
        text: "",
      })
    ).toBe("게임 30코인");
    expect(
      rewardLabel({
        name: "체험",
        unit: "STRING",
        unit_label: "소원",
        amount: null,
        text: "놀이공원 가기",
      })
    ).toBe("체험: 놀이공원 가기");
  });
  it("미설정 금액을 지급액 0원으로 오해시키지 않는다", () => {
    expect(
      rewardLabel({
        name: "용돈",
        unit: "WON",
        unit_label: "원",
        amount: null,
        text: "",
      })
    ).toContain("미설정");
  });
  it("GT와 GTE 및 스티커·퍼센트 단위를 구별한다", () => {
    expect(thresholdLabel(90, "GT", "QUEST", "PERCENT")).toBe("90% 초과");
    expect(thresholdLabel(90, "GTE", "QUEST", "QUANTITY")).toBe("90점 이상");
    expect(thresholdLabel(8, "GTE", "DAILY")).toBe("8개 이상");
  });
  it("세 도장 종류 모두 텍스트 이름을 갖는다", () => {
    expect(stickerLabel("STAR")).toBe("별 도장");
    expect(stickerLabel("SMILE")).toContain("스마일");
    expect(stickerLabel("STAMP")).toContain("도장");
  });
});
