import type { RoutineDraftRow, RoutineRewardInput } from "@shared/routine-v2";

// 같은 강화물을 다시 클릭했다고 작성 중인 금액·소원 내용을 지우지 않는다.
export function selectExistingReinforcer(
  reward: RoutineRewardInput,
  reinforcerId: string
): RoutineRewardInput {
  return reward.reinforcerId === reinforcerId
    ? reward
    : { ...reward, reinforcerId, amount: null, text: "" };
}

export function resumedRoutineStep(
  draft: Pick<RoutineDraftRow, "step" | "payload">
): number {
  const stored = draft.step >= 1 && draft.step <= 3 ? draft.step : 1;
  return stored === 1 && draft.payload.name.trim() ? 2 : stored;
}
