import { supabase } from "@/lib/supabase";

export const WEEKLY_MONEY_PRESET = {
  baseAmountKrw: 10_000,
  praiseThreshold: 5,
  /** Threshold is met: total is 15,000 KRW (not +15,000 KRW). */
  praiseTotalAmountKrw: 15_000,
} as const;

/** PostgreSQL integer upper bound; keep browser validation within the RPC parameter type. */
export const MAX_POSTGRES_INTEGER = 2_147_483_647;

export type ManualMoneyRewardKind = "DAILY" | "WEEKLY" | "MONTHLY" | "SPECIAL_EVENT";
export type ManualMoneyRewardStatus = "PENDING" | "SCHEDULED" | "PAID" | "VOID";
export type ManualBonusUnit = "TIME_MINUTES" | "MONEY_KRW" | "ACTIVITY" | "CUSTOM" | "TEXT";
export type ManualBonusCouponStatus = "ISSUED" | "REDEEMED" | "VOID";

export type ManualMoneyRewardRow = {
  reward_id: string;
  child_profile_id: string;
  child_name?: string;
  reward_kind: ManualMoneyRewardKind;
  period_start: string;
  period_end: string;
  event_title: string | null;
  status: ManualMoneyRewardStatus;
  scheduled_amount_krw: number | null;
  good_this_week: boolean | null;
  praise_count: number | null;
  base_amount_snapshot_krw: number | null;
  praise_threshold_snapshot: number | null;
  praise_total_amount_snapshot_krw: number | null;
  paid_on: string | null;
  created_at: string;
};

export type ChildManualRewardRow = {
  record_type: "MONEY" | "BONUS_COUPON";
  record_id: string;
  title: string;
  reason: string;
  state: ManualMoneyRewardStatus | ManualBonusCouponStatus;
  unit: "MONEY_KRW" | ManualBonusUnit;
  amount: number | null;
  scheduled_amount_krw: number | null;
  period_start: string | null;
  period_end: string | null;
  issued_on: string | null;
  paid_on: string | null;
  created_at: string;
};

export type WeeklyMoneyRewardInput = {
  familyId: string;
  childId: string;
  weekReferenceDate: string;
  goodThisWeek: boolean;
  praiseCount: number;
  baseAmountKrw: number;
  praiseThreshold: number;
  praiseTotalAmountKrw: number;
  idempotencyKey?: string;
};

export type PeriodMoneyRewardInput = {
  familyId: string;
  childId: string;
  rewardKind: Exclude<ManualMoneyRewardKind, "WEEKLY">;
  referenceDate: string;
  amountKrw: number;
  eventKey?: string | null;
  eventTitle?: string | null;
  idempotencyKey?: string;
};

export type ManualBonusCouponInput = {
  familyId: string;
  childId: string;
  title: string;
  reason: string;
  unit: ManualBonusUnit;
  amount?: number | null;
  issuedOn: string;
  idempotencyKey?: string;
};

function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  throw new Error("이 브라우저에서는 안전한 요청 식별자를 만들 수 없습니다.");
}

export function createManualRewardIdempotencyKey() {
  return uuid();
}

export function asFiniteInteger(value: unknown): number | null {
  // Number(null), Number(""), and Number(false) are all 0. RPC NULLs must stay NULL;
  // accepting those values would turn a pending weekly reward into an apparent zero amount.
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value !== "number" && (typeof value !== "string" || value.trim() === "")) return null;
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) && Number.isInteger(numberValue) && Math.abs(numberValue) <= MAX_POSTGRES_INTEGER ? numberValue : null;
}

function asIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("날짜는 YYYY-MM-DD 형식이어야 합니다.");
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error("실제 달력 날짜를 입력해 주세요.");
  }
  return date;
}

/** Date inputs can be cleared by the browser; validate them without throwing during render. */
export function validateRequiredIsoDate(value: string, label = "날짜") {
  if (!value?.trim()) return `${label}을 선택해 주세요.`;
  try {
    asIsoDate(value);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : `${label}을 확인해 주세요.`;
  }
}

/** Family-local date from Intl: no browser/UTC offset arithmetic. */
export function familyManualRewardDate(timezone: string, now: Date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.filter(part => part.type !== "literal").map(part => [part.type, part.value])) as Record<string, string>;
  return `${values.year}-${values.month}-${values.day}`;
}

function isoDate(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

/** ISO week is Monday through Sunday, based only on calendar dates. */
export function isoWeekRange(referenceDate: string) {
  const date = asIsoDate(referenceDate);
  const weekday = date.getUTCDay() || 7;
  const monday = new Date(date);
  monday.setUTCDate(monday.getUTCDate() - weekday + 1);
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  return { start: isoDate(monday), end: isoDate(sunday) };
}

export function isWholeNumberAtLeast(value: unknown, minimum: number) {
  const integer = asFiniteInteger(value);
  return integer !== null && integer >= minimum;
}

export function validateWeeklyMoneyInput(input: Pick<WeeklyMoneyRewardInput, "praiseCount" | "baseAmountKrw" | "praiseThreshold" | "praiseTotalAmountKrw">) {
  if (!isWholeNumberAtLeast(input.praiseCount, 0)) return "칭찬 수는 0 이상의 정수여야 합니다.";
  if (!isWholeNumberAtLeast(input.baseAmountKrw, 1)) return "기본 금액은 1원 이상의 정수여야 합니다.";
  if (!isWholeNumberAtLeast(input.praiseThreshold, 1)) return "칭찬 기준은 1 이상의 정수여야 합니다.";
  if (!isWholeNumberAtLeast(input.praiseTotalAmountKrw, 1)) return "칭찬 총액은 1원 이상의 정수여야 합니다.";
  if (input.praiseTotalAmountKrw < input.baseAmountKrw) return "칭찬 달성 시 총액은 기본 금액보다 작을 수 없습니다.";
  return null;
}

export function weeklyScheduledAmount(input: Pick<WeeklyMoneyRewardInput, "goodThisWeek" | "praiseCount" | "baseAmountKrw" | "praiseThreshold" | "praiseTotalAmountKrw">) {
  const error = validateWeeklyMoneyInput(input);
  if (error || !input.goodThisWeek) return null;
  return input.praiseCount >= input.praiseThreshold ? input.praiseTotalAmountKrw : input.baseAmountKrw;
}

// 현재 운영 UI는 칭찬 수를 기본 금액에 섞지 않는다. 기존 RPC의 호환 컬럼만 중립으로 채운다.
export function flatWeeklyMoneyConfiguration(amountKrw: number) {
  return { praiseCount: 0, baseAmountKrw: amountKrw, praiseThreshold: 1, praiseTotalAmountKrw: amountKrw };
}

export function formatKrw(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  const safe = asFiniteInteger(value);
  return safe === null ? "—" : `${new Intl.NumberFormat("ko-KR").format(safe)}원`;
}

export function moneyRewardStatusLabel(status: ManualMoneyRewardStatus) {
  switch (status) {
    case "PENDING": return "대기";
    case "SCHEDULED": return "지급 예정";
    case "PAID": return "지급 완료";
    case "VOID": return "예정 취소";
  }
}

export function bonusCouponStatusLabel(status: ManualBonusCouponStatus) {
  switch (status) {
    case "ISSUED": return "발행됨";
    case "REDEEMED": return "사용 처리됨";
    case "VOID": return "취소됨";
  }
}

export function bonusUnitLabel(unit: ManualBonusUnit | "MONEY_KRW") {
  return {
    TIME_MINUTES: "시간 쿠폰(분)",
    MONEY_KRW: "금액 쿠폰(원)",
    ACTIVITY: "활동 이용권",
    CUSTOM: "자유 이용 쿠폰",
    TEXT: "자유 문구 쿠폰",
  }[unit];
}

export function normalizeMoneyRewardRow(row: Record<string, unknown>): ManualMoneyRewardRow {
  const numberOrNull = (value: unknown) => asFiniteInteger(value);
  return {
    reward_id: String(row.reward_id),
    child_profile_id: String(row.child_profile_id),
    child_name: row.child_name == null ? undefined : String(row.child_name),
    reward_kind: row.reward_kind as ManualMoneyRewardKind,
    period_start: String(row.period_start),
    period_end: String(row.period_end),
    event_title: row.event_title == null ? null : String(row.event_title),
    status: row.status as ManualMoneyRewardStatus,
    scheduled_amount_krw: numberOrNull(row.scheduled_amount_krw),
    good_this_week: row.good_this_week == null ? null : Boolean(row.good_this_week),
    praise_count: numberOrNull(row.praise_count),
    base_amount_snapshot_krw: numberOrNull(row.base_amount_snapshot_krw),
    praise_threshold_snapshot: numberOrNull(row.praise_threshold_snapshot),
    praise_total_amount_snapshot_krw: numberOrNull(row.praise_total_amount_snapshot_krw),
    paid_on: row.paid_on == null ? null : String(row.paid_on),
    created_at: String(row.created_at),
  };
}

export function normalizeChildManualRewardRow(row: Record<string, unknown>): ChildManualRewardRow {
  const numberOrNull = (value: unknown) => asFiniteInteger(value);
  return {
    record_type: row.record_type as ChildManualRewardRow["record_type"],
    record_id: String(row.record_id),
    title: String(row.title),
    reason: String(row.reason),
    state: row.state as ChildManualRewardRow["state"],
    unit: row.unit as ChildManualRewardRow["unit"],
    amount: numberOrNull(row.amount),
    scheduled_amount_krw: numberOrNull(row.scheduled_amount_krw),
    period_start: row.period_start == null ? null : String(row.period_start),
    period_end: row.period_end == null ? null : String(row.period_end),
    issued_on: row.issued_on == null ? null : String(row.issued_on),
    paid_on: row.paid_on == null ? null : String(row.paid_on),
    created_at: String(row.created_at),
  };
}

async function oneMoneyRow(request: PromiseLike<{ data: unknown; error: unknown }>) {
  const { data, error } = await request;
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : null;
  if (!row || typeof row !== "object") throw new Error("보상 기록 응답이 비어 있습니다.");
  return normalizeMoneyRewardRow(row as Record<string, unknown>);
}

export async function upsertWeeklyMoneyReward(input: WeeklyMoneyRewardInput) {
  const validation = validateWeeklyMoneyInput(input);
  if (validation) throw new Error(validation);
  asIsoDate(input.weekReferenceDate);
  return oneMoneyRow(supabase.rpc("upsert_weekly_money_reward", {
    p_family_id: input.familyId,
    p_child_profile_id: input.childId,
    p_week_reference_date: input.weekReferenceDate,
    p_good_this_week: input.goodThisWeek,
    p_praise_count: input.praiseCount,
    p_base_amount_krw: input.baseAmountKrw,
    p_praise_threshold: input.praiseThreshold,
    p_praise_total_amount_krw: input.praiseTotalAmountKrw,
    p_idempotency_key: input.idempotencyKey ?? uuid(),
  }));
}

export async function createPeriodMoneyReward(input: PeriodMoneyRewardInput) {
  if (!isWholeNumberAtLeast(input.amountKrw, 1)) throw new Error("금액은 1원 이상의 정수여야 합니다.");
  asIsoDate(input.referenceDate);
  return oneMoneyRow(supabase.rpc("create_period_money_reward", {
    p_family_id: input.familyId,
    p_child_profile_id: input.childId,
    p_reward_kind: input.rewardKind,
    p_reference_date: input.referenceDate,
    p_event_key: input.eventKey?.trim() || null,
    p_event_title: input.eventTitle?.trim() || null,
    p_amount_krw: input.amountKrw,
    p_idempotency_key: input.idempotencyKey ?? uuid(),
  }));
}

export async function markManualMoneyRewardPaid(rewardId: string, actualPaidOn: string, idempotencyKey = uuid()) {
  asIsoDate(actualPaidOn);
  return oneMoneyRow(supabase.rpc("mark_manual_money_reward_paid", {
    p_reward_id: rewardId,
    p_actual_paid_on: actualPaidOn,
    p_idempotency_key: idempotencyKey,
  }));
}

export async function voidScheduledMoneyReward(rewardId: string, reason: string, idempotencyKey = uuid()) {
  const { data, error } = await supabase.rpc("void_scheduled_money_reward", {
    p_reward_id: rewardId,
    p_reason: reason.trim(),
    p_idempotency_key: idempotencyKey,
  });
  if (error) throw error;
  return data;
}

export async function issueManualBonusCoupon(input: ManualBonusCouponInput) {
  if (!input.title.trim() || !input.reason.trim()) throw new Error("쿠폰 이름과 간단한 사유를 입력해 주세요.");
  if (input.amount !== null && input.amount !== undefined && !isWholeNumberAtLeast(input.amount, 1)) {
    throw new Error("쿠폰 수량은 비워 두거나 1 이상의 정수여야 합니다.");
  }
  asIsoDate(input.issuedOn);
  const { data, error } = await supabase.rpc("issue_manual_bonus_coupon", {
    p_family_id: input.familyId,
    p_child_profile_id: input.childId,
    p_title: input.title.trim(),
    p_reason: input.reason.trim(),
    p_unit: input.unit,
    p_amount: input.amount ?? null,
    p_issued_on: input.issuedOn,
    p_idempotency_key: input.idempotencyKey ?? uuid(),
  });
  if (error) throw error;
  return data;
}

export async function redeemManualBonusCoupon(couponId: string, idempotencyKey = uuid()) {
  const { data, error } = await supabase.rpc("redeem_manual_bonus_coupon", { p_coupon_id: couponId, p_idempotency_key: idempotencyKey });
  if (error) throw error;
  return data;
}

export async function voidManualBonusCoupon(couponId: string, reason: string, idempotencyKey = uuid()) {
  const { data, error } = await supabase.rpc("void_manual_bonus_coupon", {
    p_coupon_id: couponId,
    p_reason: reason.trim(),
    p_idempotency_key: idempotencyKey,
  });
  if (error) throw error;
  return data;
}

export async function listParentManualRewards(familyId: string) {
  const { data, error } = await supabase.rpc("list_parent_manual_rewards", { p_family_id: familyId });
  if (error) throw error;
  return (data ?? []).map((row: unknown) => normalizeMoneyRewardRow(row as Record<string, unknown>));
}

export async function listChildManualRewards(childId: string) {
  const { data, error } = await supabase.rpc("list_child_manual_rewards", { p_child_profile_id: childId });
  if (error) throw error;
  return (data ?? []).map((row: unknown) => normalizeChildManualRewardRow(row as Record<string, unknown>));
}
