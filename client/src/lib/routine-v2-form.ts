import type {
  ReinforcerRow,
  ReinforcerUnit,
  RoutineDraftPayload,
  RoutineFlow,
  RoutinePeriod,
  RoutineRewardInput,
  RoutineTierInput,
  StickerIcon,
} from "@shared/routine-v2";

export const ROUTINE_CATEGORIES = [
  "DAILY_STUDY",
  "SPECIAL_SCHEDULE",
  "LIFE_HABIT",
  "OTHER",
] as const;
export const ROUTINE_PERIODS = [
  "DAILY",
  "WEEKLY",
  "MONTHLY",
  "SPECIAL_EVENT",
] as const;
export const STICKER_ICONS: StickerIcon[] = ["STAR", "SMILE", "STAMP"];
export const REINFORCER_UNITS: ReinforcerUnit[] = [
  "WON",
  "MIN",
  "POINT",
  "STRING",
];

export const categoryLabel: Record<RoutineDraftPayload["category"], string> = {
  DAILY_STUDY: "매일 공부",
  SPECIAL_SCHEDULE: "특별 일정",
  LIFE_HABIT: "생활 습관",
  OTHER: "기타",
};

export const periodLabel: Record<RoutinePeriod, string> = {
  DAILY: "매일",
  WEEKLY: "매주",
  MONTHLY: "매월",
  SPECIAL_EVENT: "특별 이벤트",
};

export const iconLabel: Record<StickerIcon, string> = {
  STAR: "별",
  SMILE: "웃는 얼굴",
  STAMP: "도장",
};

export const unitLabel: Record<ReinforcerUnit, string> = {
  WON: "원",
  MIN: "분",
  POINT: "포인트",
  STRING: "문구/소원",
};

let fallbackSequence = 0;

/**
 * JSON payload의 tier/reward id와 RPC 멱등 키는 UUID여야 한다. 최신
 * 브라우저에서는 crypto.randomUUID를 쓰고, SSR/구형 테스트 환경에서도 UUID
 * 모양을 유지하는 안전한 fallback을 제공한다.
 */
export function newRoutineUuid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  fallbackSequence += 1;
  const tail = `${Date.now().toString(16)}${fallbackSequence.toString(16)}`
    .slice(-12)
    .padStart(12, "0");
  return `00000000-0000-4000-8000-${tail}`;
}

/** 브라우저와 SSR 모두에서 안정적으로 UUID 폼 행 식별자를 만든다. */
export function newRoutineFormId(_prefix = "row") {
  return newRoutineUuid();
}

export function emptyReward(): RoutineRewardInput {
  return {
    id: newRoutineFormId("reward"),
    reinforcerId: "",
    amount: null,
    text: "",
  };
}

export function emptyTier(label = "기본 달성"): RoutineTierInput {
  return {
    id: newRoutineFormId("tier"),
    label,
    threshold: null,
    operator: "GTE",
    rewards: [],
  };
}

/** 새 초안은 보상·이름 없이도 안전하게 임시 저장할 수 있다. */
export function createEmptyRoutinePayload(
  flow: RoutineFlow = "DAILY"
): RoutineDraftPayload {
  return {
    schemaVersion: 1,
    flow,
    name: "",
    category: "DAILY_STUDY",
    childLabel: "",
    criteria: "",
    stickerIcon: "STAMP",
    measurement: flow === "DAILY" ? "STICKER" : "PERCENT",
    period: "WEEKLY",
    penaltyLimit: flow === "QUEST" ? null : null,
    penaltyMinutes: 0,
    tiers: [emptyTier("기본 달성")],
  };
}

/** Intl.Segmenter 기준의 사용자에게 보이는 글자 수다. */
export function visibleGraphemeLength(value: string): number {
  const Segmenter = Intl.Segmenter;
  if (Segmenter)
    return Array.from(
      new Segmenter(undefined, { granularity: "grapheme" }).segment(value)
    ).length;
  return Array.from(value).length;
}

/** UTF-16 길이가 아닌 실제 Unicode code point 수로 DB 상한을 미리 확인한다. */
export function codePointLength(value: string): number {
  return Array.from(value).length;
}

/** DB/네트워크 제약과 분리해 안내용 UTF-8 바이트 수를 제공한다. */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function dailyAccumulatedThreshold(
  base: number | null,
  additional: number | null
): number | null {
  if (
    !Number.isInteger(base) ||
    (base ?? 0) <= 0 ||
    !Number.isInteger(additional) ||
    (additional ?? 0) <= 0
  )
    return null;
  return base! + additional!;
}

export function dailyAdditionalLabel(
  base: number | null,
  additional: number | null
): string {
  const total = dailyAccumulatedThreshold(base, additional);
  if (total === null)
    return "기본 기준과 추가 개수를 입력하면 누적 기준을 보여 드립니다.";
  return `기본 ${base}개 + 추가 ${additional}개 = 총 ${total}개`;
}

export function isAmountUnit(unit: ReinforcerUnit | undefined): boolean {
  return unit === "WON" || unit === "MIN" || unit === "POINT";
}

function finiteIntegerInRange(value: unknown, lower: number, upper: number) {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= lower &&
    value <= upper
  );
}

export function isRealIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** 유효하지 않은 날짜를 Date에 넣지 않고 ISO 요일(월=1, 일=7)을 구한다. */
export function isoWeekdayForDate(value: string): number | null {
  if (!isRealIsoDate(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

export function validateRoutineAssignmentDates(
  startsOn: string,
  endsOn: string,
  minimumStart: string
): string[] {
  const errors: string[] = [];
  if (!isRealIsoDate(minimumStart))
    return [
      "시작 가능일을 계산하지 못했습니다. 새로고침 후 다시 시도해 주세요.",
    ];
  if (!isRealIsoDate(startsOn))
    errors.push("시작일은 실제 달력 날짜로 입력해 주세요.");
  if (isRealIsoDate(startsOn) && startsOn < minimumStart)
    errors.push("시작일은 룰 효력일과 가족 시간대 기준 내일 이후여야 합니다.");
  if (endsOn) {
    if (!isRealIsoDate(endsOn))
      errors.push("종료일은 실제 달력 날짜로 입력해 주세요.");
    else if (isRealIsoDate(startsOn) && endsOn < startsOn)
      errors.push("종료일은 시작일보다 빠를 수 없습니다.");
  }
  return errors;
}

/** period_closed는 수동 정산 여부가 아니라 달력 기간 종료 projection이다. */
export function canCloseRoutinePeriod(
  flow: RoutineFlow,
  periodEnd: string,
  familyToday: string
): boolean {
  return (
    flow === "DAILY" &&
    isRealIsoDate(periodEnd) &&
    isRealIsoDate(familyToday) &&
    familyToday > periodEnd
  );
}

/** 편집 중 상태와 마지막 저장 draft snapshot이 다르면 저장 전 게시를 막는다. */
export function isDraftPayloadDirty(
  editedPayload: RoutineDraftPayload,
  storedPayload: RoutineDraftPayload | null | undefined
): boolean {
  return (
    !storedPayload ||
    stableRoutineJson(editedPayload) !== stableRoutineJson(storedPayload)
  );
}

function rewardErrors(
  reward: RoutineRewardInput,
  reinforcers: ReinforcerRow[]
): string[] {
  const errors: string[] = [];
  const reinforcer = reinforcers.find(item => item.id === reward.reinforcerId);
  if (!reinforcer) return ["각 보상에 강화물을 선택해 주세요."];
  if (reinforcer.unit === "STRING") {
    if (!reward.text.trim())
      errors.push(`“${reinforcer.name}”의 약속 내용을 입력해 주세요.`);
    return errors;
  }
  if (
    !(
      typeof reward.amount === "number" &&
      Number.isFinite(reward.amount) &&
      reward.amount > 0
    )
  ) {
    errors.push(
      `“${reinforcer.name}”의 ${reinforcer.unit_label || unitLabel[reinforcer.unit]} 값을 0보다 크게 입력해 주세요.`
    );
  } else if (
    (reinforcer.unit === "WON" || reinforcer.unit === "MIN") &&
    !Number.isInteger(reward.amount)
  ) {
    errors.push(
      `“${reinforcer.name}”의 ${reinforcer.unit_label || unitLabel[reinforcer.unit]} 값은 정수로 입력해 주세요.`
    );
  } else if (reinforcer.unit === "MIN" && reward.amount > 240) {
    errors.push(`“${reinforcer.name}”의 분 값은 240분 이하여야 합니다.`);
  }
  return errors;
}

/**
 * 게시 직전에만 쓰는 완성도 검증이다. 임시저장은 이 함수를 호출하지 않아
 * 1단계의 빈 이름·빈 보상도 보존할 수 있다.
 */
export function validateRoutineForPublish(
  payload: RoutineDraftPayload,
  reinforcers: ReinforcerRow[]
): string[] {
  const errors: string[] = [];
  if (payload.schemaVersion !== 1)
    errors.push("지원하지 않는 초안 형식입니다.");
  if (!payload.name.trim()) errors.push("활동 이름을 입력해 주세요.");
  if (codePointLength(payload.name) > 100)
    errors.push("활동 이름은 100자 이하여야 합니다.");
  if (!payload.childLabel.trim())
    errors.push("아이에게 보여 줄 키워드를 입력해 주세요.");
  if (visibleGraphemeLength(payload.childLabel) > 20)
    errors.push("아이 표시 키워드는 보이는 글자 20자 이하여야 합니다.");
  if (codePointLength(payload.childLabel) > 100)
    errors.push("아이 표시 키워드는 원문 100자 이하여야 합니다.");
  if (!payload.criteria.trim())
    errors.push("부모의 상세 확인 기준을 입력해 주세요.");
  if (payload.tiers.length < 1 || payload.tiers.length > 5)
    errors.push("달성 조건/구간은 1~5개로 설정해 주세요.");

  if (payload.flow === "DAILY") {
    if (payload.measurement !== "STICKER")
      errors.push("데일리 측정은 PASS 스티커로 고정됩니다.");
    if (payload.penaltyLimit !== null || payload.penaltyMinutes !== 0)
      errors.push("데일리에는 스티커 차감 패널티를 설정할 수 없습니다.");
  } else {
    if (payload.measurement !== "PERCENT" && payload.measurement !== "QUANTITY")
      errors.push("Quest의 수치 측정 방식을 선택해 주세요.");
    if (!finiteIntegerInRange(payload.penaltyLimit, 0, 100))
      errors.push("Quest 하한은 0~100의 정수로 명시해 주세요.");
    if (!finiteIntegerInRange(payload.penaltyMinutes, 0, 240))
      errors.push("패널티 후보 시간은 0~240분의 정수여야 합니다.");
  }

  let previous: number | null = null;
  payload.tiers.forEach((tier, tierIndex) => {
    if (!tier.label.trim())
      errors.push(`${tierIndex + 1}번째 조건의 이름을 입력해 주세요.`);
    if (tier.rewards.length < 1 || tier.rewards.length > 2)
      errors.push(`${tierIndex + 1}번째 조건의 보상은 1~2개여야 합니다.`);
    if (payload.flow === "DAILY") {
      if (tier.operator !== "GTE")
        errors.push("데일리 스티커 구간은 ‘이상’만 사용할 수 있습니다.");
      if (!finiteIntegerInRange(tier.threshold, 1, Number.MAX_SAFE_INTEGER))
        errors.push(
          `${tierIndex + 1}번째 스티커 기준은 1개 이상의 정수여야 합니다.`
        );
    } else if (!finiteIntegerInRange(tier.threshold, 0, 100)) {
      errors.push(`${tierIndex + 1}번째 Quest 기준은 0~100의 정수여야 합니다.`);
    }
    if (
      typeof tier.threshold === "number" &&
      previous !== null &&
      tier.threshold <= previous
    ) {
      errors.push("달성 조건/구간은 낮은 값부터 오름차순으로 입력해 주세요.");
    }
    if (typeof tier.threshold === "number") previous = tier.threshold;
    tier.rewards.forEach(reward =>
      errors.push(...rewardErrors(reward, reinforcers))
    );
  });
  return errors;
}

/** 재전송시 같은 JSON 문자열을 얻어 멱등 키와 payload를 정확히 짝지운다. */
export function stableRoutineJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(stableRoutineJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableRoutineJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
