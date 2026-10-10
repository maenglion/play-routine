export const RULE_CATEGORIES = [
  "DAILY_STUDY",
  "SPECIAL_SCHEDULE",
  "LIFE_HABIT",
  "OTHER",
] as const;

export const MEASUREMENT_KINDS = ["PERCENT", "QUANTITY"] as const;
export const RULE_OUTCOMES = ["PENALTY", "NO_REWARD", "REWARD"] as const;

export type RuleCategory = (typeof RULE_CATEGORIES)[number];
export type MeasurementKind = (typeof MEASUREMENT_KINDS)[number];
export type RuleOutcome = (typeof RULE_OUTCOMES)[number];
export type EffectDirection = "CREDIT" | "DEBIT";

export type RuleBand = {
  lower: number;
  upper: number;
  upperInclusive: boolean;
  outcome: RuleOutcome;
  effectMinutes: number;
  effectDirection: EffectDirection;
};

export type NumericRuleInput = {
  penaltyLimit: number;
  rewardLimit: number;
  penaltyMinutes: number;
  rewardMinutes: number;
};

export function isRuleOutcome(value: unknown): value is RuleOutcome {
  return typeof value === "string" && (RULE_OUTCOMES as readonly string[]).includes(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * 정책 저장 전, 입력 숫자가 [0, penalty), [penalty, reward), [reward, 100]의
 * 빈틈 없는 세 구간을 만들 수 있는지 판단한다. 0분은 명시적 무효과로만 허용된다.
 */
export function validateNumericRule(input: NumericRuleInput): string[] {
  const errors: string[] = [];
  const { penaltyLimit, rewardLimit, penaltyMinutes, rewardMinutes } = input;

  if (!isFiniteNumber(penaltyLimit) || !isFiniteNumber(rewardLimit)) {
    errors.push("기준 점수는 유한한 숫자여야 합니다.");
  } else if (!(0 < penaltyLimit && penaltyLimit < rewardLimit && rewardLimit < 100)) {
    errors.push("하한은 0보다 크고 보상 기준보다 작아야 하며, 보상 기준은 100보다 작아야 합니다.");
  }

  for (const [label, value] of [["보상", rewardMinutes], ["차감", penaltyMinutes]] as const) {
    if (!isFiniteNumber(value) || !Number.isInteger(value) || value < 0 || value > 240) {
      errors.push(`${label} 시간은 0~240 사이의 정수 분이어야 합니다.`);
    }
  }

  return errors;
}

/**
 * 양 끝 밴드의 0분은 각각 NO_REWARD로 명시한다. 패널티를 사용하지 않아도
 * 중간 NO_REWARD 밴드는 항상 남아 있으므로 측정값의 빈 구간이 생기지 않는다.
 */
export function buildThreeRuleBands(input: NumericRuleInput): RuleBand[] {
  const errors = validateNumericRule(input);
  if (errors.length > 0) throw new Error(errors.join(" "));

  return [
    {
      lower: 0,
      upper: input.penaltyLimit,
      upperInclusive: false,
      outcome: input.penaltyMinutes > 0 ? "PENALTY" : "NO_REWARD",
      effectMinutes: input.penaltyMinutes,
      effectDirection: "DEBIT",
    },
    {
      lower: input.penaltyLimit,
      upper: input.rewardLimit,
      upperInclusive: false,
      outcome: "NO_REWARD",
      effectMinutes: 0,
      effectDirection: "CREDIT",
    },
    {
      lower: input.rewardLimit,
      upper: 100,
      upperInclusive: true,
      outcome: input.rewardMinutes > 0 ? "REWARD" : "NO_REWARD",
      effectMinutes: input.rewardMinutes,
      effectDirection: "CREDIT",
    },
  ];
}

export function formatBand(range: Pick<RuleBand, "lower" | "upper" | "upperInclusive">) {
  return `${range.lower}점 이상 ~ ${range.upper}점${range.upperInclusive ? " 이하" : " 미만"}`;
}
