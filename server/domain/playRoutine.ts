export type FamilyRole = "OWNER" | "GUARDIAN" | "VIEWER";
export type ChildCapability =
  | "view"
  | "evaluate"
  | "manageRules"
  | "manageCoupons"
  | "receiveNotifications";

export type OutcomeType = "REWARD" | "NEUTRAL" | "PENALTY";
export type AssetType = "TIME_MINUTE" | "MONEY_KRW";
export type CouponStatus = "ISSUED" | "ASSIGNED" | "REDEEMED" | "CANCELLED" | "EXPIRED" | "VOID";

export type PermissionFlags = {
  canView: boolean;
  canEvaluate: boolean;
  canManageRules: boolean;
  canManageCoupons: boolean;
  canReceiveNotifications: boolean;
};

export type LedgerEffect = {
  assetType: AssetType;
  amount: number;
};

export function hasCapability(
  role: FamilyRole,
  permissions: PermissionFlags,
  capability: ChildCapability,
): boolean {
  if (role === "OWNER") return true;
  if (role === "VIEWER") return capability === "view" && permissions.canView;

  const map: Record<ChildCapability, boolean> = {
    view: permissions.canView,
    evaluate: permissions.canEvaluate,
    manageRules: permissions.canManageRules,
    manageCoupons: permissions.canManageCoupons,
    receiveNotifications: permissions.canReceiveNotifications,
  };
  return map[capability];
}

export function validateEvaluationSelection(input: {
  applicability: "APPLICABLE" | "NOT_APPLICABLE";
  rubricLevelId?: number | null;
}) {
  if (input.applicability === "NOT_APPLICABLE" && input.rubricLevelId != null) {
    throw new Error("해당 없음 평가에는 루브릭 수준을 선택할 수 없습니다.");
  }
  if (input.applicability === "APPLICABLE" && input.rubricLevelId == null) {
    throw new Error("평가를 제출하려면 보상·중립·패널티 수준 중 하나를 선택해야 합니다.");
  }
}

export function validateEffectsForOutcome(outcomeType: OutcomeType, effects: LedgerEffect[]) {
  if (outcomeType === "NEUTRAL") {
    if (effects.length > 0) throw new Error("중립 수준은 원장 효과를 가질 수 없습니다.");
    return;
  }
  if (effects.length === 0) throw new Error("보상 또는 패널티 수준에는 원장 효과가 필요합니다.");

  for (const effect of effects) {
    if (!Number.isInteger(effect.amount) || effect.amount === 0) {
      throw new Error("점수 효과는 0이 아닌 정수여야 합니다.");
    }
    if (outcomeType === "REWARD" && effect.amount < 0) {
      throw new Error("보상 수준의 효과는 양수여야 합니다.");
    }
    if (outcomeType === "PENALTY" && effect.amount > 0) {
      throw new Error("패널티 수준의 효과는 음수여야 합니다.");
    }
  }
}

const ALLOWED_COUPON_TRANSITIONS: Record<CouponStatus, CouponStatus[]> = {
  ISSUED: ["ASSIGNED", "CANCELLED", "EXPIRED", "VOID"],
  ASSIGNED: ["REDEEMED", "CANCELLED", "EXPIRED", "VOID"],
  REDEEMED: ["CANCELLED"],
  CANCELLED: [],
  EXPIRED: [],
  VOID: [],
};

export function assertCouponTransition(from: CouponStatus, to: CouponStatus) {
  if (!ALLOWED_COUPON_TRANSITIONS[from].includes(to)) {
    throw new Error(`허용되지 않은 쿠폰 상태 변경입니다: ${from} → ${to}`);
  }
}

export function nextBalance(current: number, amount: number, enforceNonNegative = false) {
  if (!Number.isInteger(current) || !Number.isInteger(amount) || amount === 0) {
    throw new Error("잔액과 변동량은 정수이며 변동량은 0이 아니어야 합니다.");
  }
  const next = current + amount;
  if (enforceNonNegative && next < 0) throw new Error("사용 가능한 잔액이 부족합니다.");
  return next;
}
