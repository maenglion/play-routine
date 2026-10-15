import type {
  RoutineDayRow,
  RoutineRewardView,
  StickerIcon,
} from "@shared/routine-v2";

export function stickerLabel(icon: StickerIcon) {
  return { STAR: "별 도장", SMILE: "스마일 도장", STAMP: "참 잘했어요 도장" }[
    icon
  ];
}
export function rewardLabel(
  reward: Pick<
    RoutineRewardView,
    "name" | "unit" | "unit_label" | "amount" | "text"
  >
) {
  if (reward.unit === "STRING") return `${reward.name}: ${reward.text}`;
  const unit =
    reward.unit === "WON"
      ? "원"
      : reward.unit === "MIN"
        ? "분"
        : reward.unit_label || "포인트";
  return `${reward.name} ${reward.amount === null ? "미설정" : reward.amount.toLocaleString("ko-KR")}${unit}`;
}
export function routineDaySummary(rows: RoutineDayRow[]) {
  return {
    total: rows.length,
    confirmed: rows.filter(row => row.verification_status === "CONFIRMED")
      .length,
    missing: rows.filter(row => row.verification_status === "MISSING").length,
    held: rows.filter(row => row.verification_status === "HELD").length,
    // 서로 다른 활동의 기간 스티커를 하나의 보상용 합계로 섞지 않는다.
    todayStickers: rows.reduce(
      (sum, row) =>
        sum +
        (row.flow === "DAILY" && row.stickers !== null ? row.stickers : 0),
      0
    ),
  };
}
export function thresholdLabel(
  threshold: number,
  operator: "GT" | "GTE",
  flow: "DAILY" | "QUEST",
  measurement?: string
) {
  return `${threshold}${flow === "DAILY" ? "개" : measurement === "PERCENT" ? "%" : "점"} ${operator === "GT" ? "초과" : "이상"}`;
}
