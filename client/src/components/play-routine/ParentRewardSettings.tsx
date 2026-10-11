import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  bonusCouponStatusLabel,
  bonusUnitLabel,
  createManualRewardIdempotencyKey,
  createPeriodMoneyReward,
  familyManualRewardDate,
  formatKrw,
  flatWeeklyMoneyConfiguration,
  isWholeNumberAtLeast,
  isoWeekRange,
  issueManualBonusCoupon,
  listChildManualRewards,
  listParentManualRewards,
  markManualMoneyRewardPaid,
  moneyRewardStatusLabel,
  redeemManualBonusCoupon,
  type ChildManualRewardRow,
  type ManualBonusUnit,
  type ManualMoneyRewardKind,
  type ManualMoneyRewardRow,
  upsertWeeklyMoneyReward,
  validateWeeklyMoneyInput,
  voidManualBonusCoupon,
  voidScheduledMoneyReward,
  weeklyScheduledAmount,
  validateRequiredIsoDate,
} from "@/lib/manual-rewards";
import { CalendarDays, CheckCircle2, CircleDollarSign, Gift, Loader2, RefreshCw, ShieldCheck, Ticket, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

export type ParentRewardChild = { id: string; display_name: string; status: string };
export type ParentRewardSettingsProps = {
  familyId: string;
  timezone: string;
  children: ParentRewardChild[];
  preview?: boolean;
};

type WeeklyForm = {
  childId: string;
  referenceDate: string;
  goodThisWeek: boolean;
  praiseCount: string;
  baseAmountKrw: string;
  praiseThreshold: string;
  praiseTotalAmountKrw: string;
};

type PeriodForm = {
  childId: string;
  kind: Exclude<ManualMoneyRewardKind, "WEEKLY">;
  referenceDate: string;
  amountKrw: string;
  eventKey: string;
  eventTitle: string;
};

type CouponForm = {
  childId: string;
  title: string;
  reason: string;
  unit: ManualBonusUnit;
  amount: string;
  issuedOn: string;
};

const moneyKindLabel: Record<ManualMoneyRewardKind, string> = {
  DAILY: "일 보상",
  WEEKLY: "주간 보상",
  MONTHLY: "월 보상",
  SPECIAL_EVENT: "특별 이벤트",
};

function numberValue(value: string) {
  return Number(value);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

function statusClass(status: string) {
  if (status === "PAID" || status === "REDEEMED") return "bg-[#e4f1eb] text-[#315f4d]";
  if (status === "SCHEDULED" || status === "ISSUED") return "bg-[#f0edfa] text-[#5b46a3]";
  if (status === "VOID") return "bg-[#f4e8e5] text-[#97473f]";
  return "bg-[#f5f3ed] text-[#666963]";
}

function previewMoneyRows(today: string): ManualMoneyRewardRow[] {
  const week = isoWeekRange(today);
  return [{
    reward_id: "preview-weekly-money",
    child_profile_id: "preview-child",
    child_name: "자녀",
    reward_kind: "WEEKLY",
    period_start: week.start,
    period_end: week.end,
    event_title: null,
    // A preview is deliberately planned, never a fake real-world paid record.
    status: "SCHEDULED",
    scheduled_amount_krw: 15_000,
    good_this_week: true,
    praise_count: 5,
    base_amount_snapshot_krw: 10_000,
    praise_threshold_snapshot: 5,
    praise_total_amount_snapshot_krw: 15_000,
    paid_on: null,
    created_at: `${today}T12:00:00.000Z`,
  }];
}

function previewChildRows(today: string): ChildManualRewardRow[] {
  return [{
    record_type: "BONUS_COUPON",
    record_id: "preview-coupon",
    title: "주말 자유시간",
    reason: "선생님 칭찬을 들었어요",
    state: "ISSUED",
    unit: "TIME_MINUTES",
    amount: 30,
    scheduled_amount_krw: null,
    period_start: null,
    period_end: null,
    issued_on: today,
    paid_on: null,
    created_at: `${today}T12:00:00.000Z`,
  }];
}

/**
 * 부모 재량 수동 보상 패널. 활동 PASS 예정분과 분리된 금전 기록·칭찬 쿠폰만 다룬다.
 * SCHEDULED는 외부 송금이 아니라 지급 예정이며, 실제 지급 뒤 부모가 PAID로 표시한다.
 */
export default function ParentRewardSettings({ familyId, timezone, children, preview = false }: ParentRewardSettingsProps) {
  const [today, setToday] = useState(() => familyManualRewardDate(timezone));
  const activeChildren = useMemo(() => children.filter(child => child.status === "ACTIVE"), [children]);
  const initialChildId = activeChildren[0]?.id ?? "";
  const [weekly, setWeekly] = useState<WeeklyForm>(() => ({
    childId: initialChildId,
    referenceDate: familyManualRewardDate(timezone),
    goodThisWeek: false,
    praiseCount: "0",
    baseAmountKrw: "",
    praiseThreshold: "1",
    praiseTotalAmountKrw: "",
  }));
  const [period, setPeriod] = useState<PeriodForm>(() => ({
    childId: initialChildId, kind: "DAILY", referenceDate: familyManualRewardDate(timezone), amountKrw: "", eventKey: "", eventTitle: "",
  }));
  const [coupon, setCoupon] = useState<CouponForm>(() => ({
    childId: initialChildId, title: "", reason: "", unit: "CUSTOM", amount: "", issuedOn: familyManualRewardDate(timezone),
  }));
  const [moneyRows, setMoneyRows] = useState<ManualMoneyRewardRow[]>(() => preview ? previewMoneyRows(familyManualRewardDate(timezone)) : []);
  const [selectedChildRows, setSelectedChildRows] = useState<ChildManualRewardRow[]>(() => preview ? previewChildRows(familyManualRewardDate(timezone)) : []);
  const [loading, setLoading] = useState(!preview);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState<"weekly" | "period" | "coupon" | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);
  const [paying, setPaying] = useState<ManualMoneyRewardRow | null>(null);
  const [actualPaidOn, setActualPaidOn] = useState("");
  const [couponViewingChildId, setCouponViewingChildId] = useState(initialChildId);
  const [mutationBusy, setMutationBusy] = useState(false);
  const loadGenerationRef = useRef(0);
  const mutationBusyRef = useRef(false);
  const idempotencyKeysRef = useRef(new Map<string, string>());

  const weeklyDateError = useMemo(() => validateRequiredIsoDate(weekly.referenceDate, "주간 기준일"), [weekly.referenceDate]);
  const weekRange = useMemo(() => weeklyDateError ? null : isoWeekRange(weekly.referenceDate), [weekly.referenceDate, weeklyDateError]);
  const weeklyNumbers = useMemo(() => flatWeeklyMoneyConfiguration(numberValue(weekly.baseAmountKrw)), [weekly.baseAmountKrw]);
  const weeklyError = useMemo(() => weeklyDateError ?? validateWeeklyMoneyInput(weeklyNumbers), [weeklyDateError, weeklyNumbers]);
  const weeklyAmount = weeklyScheduledAmount({ ...weeklyNumbers, goodThisWeek: weekly.goodThisWeek });

  const withMutation = useCallback(async <T,>(fingerprint: string, operation: (idempotencyKey: string) => Promise<T>) => {
    if (mutationBusyRef.current) {
      toast.message("다른 보상 요청을 처리 중입니다. 완료 후 다시 시도해 주세요.");
      return undefined;
    }
    mutationBusyRef.current = true;
    setMutationBusy(true);
    const idempotencyKey = idempotencyKeysRef.current.get(fingerprint) ?? createManualRewardIdempotencyKey();
    idempotencyKeysRef.current.set(fingerprint, idempotencyKey);
    try {
      const result = await operation(idempotencyKey);
      // 성공한 payload만 키를 버린다. 네트워크 실패는 같은 payload/key로 안전하게 재시도한다.
      idempotencyKeysRef.current.delete(fingerprint);
      return result;
    } finally {
      mutationBusyRef.current = false;
      setMutationBusy(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    if (preview) {
      const previewToday = familyManualRewardDate(timezone);
      if (generation !== loadGenerationRef.current) return;
      setMoneyRows(previewMoneyRows(previewToday));
      setSelectedChildRows(previewChildRows(previewToday));
      setLoading(false);
      setLoadError(null);
      return;
    }
    if (!familyId) {
      if (generation !== loadGenerationRef.current) return;
      setMoneyRows([]);
      setSelectedChildRows([]);
      setLoading(false);
      setLoadError(null);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const [money, child] = await Promise.all([
        listParentManualRewards(familyId),
        couponViewingChildId ? listChildManualRewards(couponViewingChildId) : Promise.resolve([]),
      ]);
      if (generation !== loadGenerationRef.current) return;
      setMoneyRows(money);
      setSelectedChildRows(child);
    } catch (error) {
      if (generation !== loadGenerationRef.current) return;
      setLoadError(error instanceof Error ? error.message : "수동 보상 기록을 불러오지 못했습니다.");
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false);
    }
  }, [couponViewingChildId, familyId, preview, timezone]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const tick = () => setToday(familyManualRewardDate(timezone));
    tick();
    const timer = window.setInterval(tick, 60_000);
    return () => window.clearInterval(timer);
  }, [timezone]);
  useEffect(() => {
    const childId = activeChildren[0]?.id ?? "";
    setWeekly(current => activeChildren.some(child => child.id === current.childId) ? current : { ...current, childId });
    setPeriod(current => activeChildren.some(child => child.id === current.childId) ? current : { ...current, childId });
    setCoupon(current => activeChildren.some(child => child.id === current.childId) ? current : { ...current, childId });
    setCouponViewingChildId(current => activeChildren.some(child => child.id === current) ? current : childId);
  }, [activeChildren]);

  const saveWeekly = async () => {
    if (preview) return toast.message("미리보기에서는 저장하지 않습니다.");
    if (!weekly.childId) return toast.error("현재 활성 자녀를 선택해 주세요.");
    if (weeklyError) return toast.error(weeklyError);
    setSaving("weekly");
    try {
      const fingerprint = `weekly:${familyId}:${weekly.childId}:${weekly.referenceDate}:${weekly.goodThisWeek}:${weeklyNumbers.praiseCount}:${weeklyNumbers.baseAmountKrw}:${weeklyNumbers.praiseThreshold}:${weeklyNumbers.praiseTotalAmountKrw}`;
      const saved = await withMutation(fingerprint, idempotencyKey => upsertWeeklyMoneyReward({
        familyId, childId: weekly.childId, weekReferenceDate: weekly.referenceDate, goodThisWeek: weekly.goodThisWeek,
        ...weeklyNumbers, idempotencyKey,
      }));
      if (!saved) return;
      await refresh();
      toast.success(saved.status === "SCHEDULED" ? `${formatKrw(saved.scheduled_amount_krw)} 지급 예정으로 기록했습니다.` : "주간 초안을 저장했습니다. 아직 지급 예정은 아닙니다.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "주간 보상을 저장하지 못했습니다.");
    } finally {
      setSaving(null);
    }
  };

  const savePeriod = async () => {
    if (preview) return toast.message("미리보기에서는 저장하지 않습니다.");
    const amountKrw = numberValue(period.amountKrw);
    if (!period.childId) return toast.error("현재 활성 자녀를 선택해 주세요.");
    if (!isWholeNumberAtLeast(amountKrw, 1)) return toast.error("금액은 1원 이상의 정수여야 합니다.");
    const dateError = validateRequiredIsoDate(period.referenceDate, "기준일");
    if (dateError) return toast.error(dateError);
    if (period.kind === "SPECIAL_EVENT" && !period.eventTitle.trim()) return toast.error("특별 이벤트 제목을 입력해 주세요.");
    setSaving("period");
    try {
      const eventTitle = period.eventTitle.trim();
      const eventKey = period.eventKey.trim() || `event-${familyId.slice(0, 8)}-${period.childId.slice(0, 8)}-${period.referenceDate}-${eventTitle.toLocaleLowerCase("ko-KR").replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "reward"}`;
      const fingerprint = `period:${familyId}:${period.childId}:${period.kind}:${period.referenceDate}:${amountKrw}:${eventKey}:${eventTitle}`;
      const saved = await withMutation(fingerprint, idempotencyKey => createPeriodMoneyReward({
        familyId, childId: period.childId, rewardKind: period.kind, referenceDate: period.referenceDate, amountKrw,
        eventKey: period.kind === "SPECIAL_EVENT" ? eventKey : null,
        eventTitle: period.kind === "SPECIAL_EVENT" ? eventTitle : null, idempotencyKey,
      }));
      if (!saved) return;
      setPeriod(current => ({ ...current, amountKrw: "", eventKey: "", eventTitle: "" }));
      await refresh();
      toast.success("지급 예정으로 기록했습니다. 실제 송금이나 결제는 실행하지 않습니다.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "기간 보상을 기록하지 못했습니다.");
    } finally {
      setSaving(null);
    }
  };

  const saveCoupon = async () => {
    if (preview) return toast.message("미리보기에서는 발행하지 않습니다.");
    const amount = coupon.amount.trim() === "" ? null : numberValue(coupon.amount);
    if (!coupon.childId) return toast.error("현재 활성 자녀를 선택해 주세요.");
    if (["TIME_MINUTES", "MONEY_KRW"].includes(coupon.unit) && !isWholeNumberAtLeast(amount, 1)) return toast.error("시간/원 쿠폰은 1 이상의 정수 수량을 입력해 주세요.");
    if (amount !== null && !isWholeNumberAtLeast(amount, 1)) return toast.error("수량은 비워 두거나 1 이상의 정수여야 합니다.");
    const dateError = validateRequiredIsoDate(coupon.issuedOn, "발행일");
    if (dateError) return toast.error(dateError);
    setSaving("coupon");
    try {
      const fingerprint = `coupon:${familyId}:${coupon.childId}:${coupon.title.trim()}:${coupon.reason.trim()}:${coupon.unit}:${amount}:${coupon.issuedOn}`;
      const saved = await withMutation(fingerprint, idempotencyKey => issueManualBonusCoupon({
        familyId, childId: coupon.childId, title: coupon.title, reason: coupon.reason, unit: coupon.unit, amount, issuedOn: coupon.issuedOn, idempotencyKey,
      }));
      if (!saved) return;
      setCoupon(current => ({ ...current, title: "", reason: "", amount: "" }));
      await refresh();
      toast.success("특별보너스 쿠폰을 발행했습니다. 시간 잔액에는 연결되지 않습니다.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "쿠폰을 발행하지 못했습니다.");
    } finally {
      setSaving(null);
    }
  };

  const confirmPaid = async () => {
    if (!paying) return;
    if (preview) return toast.message("미리보기에서는 지급 완료로 바꾸지 않습니다.");
    const dateError = validateRequiredIsoDate(actualPaidOn, "실제 지급일");
    if (dateError) return toast.error(dateError);
    if (actualPaidOn > today || actualPaidOn < paying.period_start) return toast.error("실제 지급일은 보상 기간 시작일 이후이면서 오늘 이전이어야 합니다.");
    setActionId(paying.reward_id);
    try {
      const saved = await withMutation(`paid:${paying.reward_id}:${actualPaidOn}`, idempotencyKey => markManualMoneyRewardPaid(paying.reward_id, actualPaidOn, idempotencyKey));
      if (!saved) return;
      setPaying(null);
      await refresh();
      toast.success("외부 지급 완료로 표시했습니다. 이 앱은 송금하지 않습니다.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "지급 완료 표시를 저장하지 못했습니다.");
    } finally {
      setActionId(null);
    }
  };

  const voidMoney = async (row: ManualMoneyRewardRow) => {
    if (preview) return toast.message("미리보기에서는 취소하지 않습니다.");
    const reason = window.prompt("지급 예정 취소 사유를 짧게 입력해 주세요.");
    if (!reason?.trim()) return;
    setActionId(row.reward_id);
    try {
      const saved = await withMutation(`void-money:${row.reward_id}:${reason.trim()}`, idempotencyKey => voidScheduledMoneyReward(row.reward_id, reason, idempotencyKey));
      if (!saved) return;
      await refresh();
      toast.success("지급 예정만 취소했습니다. 이미 지급 완료된 기록은 취소할 수 없습니다.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "지급 예정을 취소하지 못했습니다.");
    } finally {
      setActionId(null);
    }
  };

  const actOnCoupon = async (row: ChildManualRewardRow, action: "redeem" | "void") => {
    if (preview) return toast.message("미리보기에서는 상태를 바꾸지 않습니다.");
    const promptedReason = action === "void" ? window.prompt("쿠폰 취소 사유를 짧게 입력해 주세요.") : "";
    if (action === "void" && !promptedReason?.trim()) return;
    const reason = promptedReason ?? "";
    setActionId(row.record_id);
    try {
      const saved = await withMutation(
        `${action}-coupon:${row.record_id}:${reason.trim()}`,
        idempotencyKey => action === "redeem" ? redeemManualBonusCoupon(row.record_id, idempotencyKey) : voidManualBonusCoupon(row.record_id, reason!, idempotencyKey),
      );
      if (!saved) return;
      await refresh();
      toast.success(action === "redeem" ? "쿠폰 사용을 처리했습니다. 시간 잔액은 변하지 않습니다." : "미사용 쿠폰을 취소했습니다.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "쿠폰 상태를 바꾸지 못했습니다.");
    } finally {
      setActionId(null);
    }
  };

  const canPublishWeekly = weekly.goodThisWeek && Boolean(weekRange && weekRange.end < today) && !weeklyError;

  return (
    <section className="rounded-[28px] bg-white p-6 shadow-[0_16px_48px_rgba(51,58,68,.08)] sm:p-8" aria-labelledby="parent-reward-settings-title">
      <Dialog open={Boolean(paying)} onOpenChange={open => { if (!open && !actionId) setPaying(null); }}>
        <DialogContent showCloseButton={!actionId}>
          <DialogHeader>
            <DialogTitle>실제 지급 완료로 표시할까요?</DialogTitle>
            <DialogDescription className="leading-6">
              이 기록의 정확한 금액은 <strong className="text-[#333a44]">{formatKrw(paying?.scheduled_amount_krw)}</strong>입니다. 부모가 앱 밖에서 이미 이 금액을 지급한 경우에만 확인하세요. 이 앱은 송금·외부 결제를 실행하지 않습니다.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="actual-paid-on">실제 지급일</Label>
            <Input id="actual-paid-on" type="date" min={paying?.period_start} max={today} value={actualPaidOn} disabled={Boolean(actionId) || mutationBusy} onChange={event => setActualPaidOn(event.target.value)} />
            <p className="text-xs text-[#666963]">보상 기간 시작일 이후, 오늘 이전 날짜만 기록할 수 있습니다.</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={Boolean(actionId) || mutationBusy} onClick={() => setPaying(null)}>아니요</Button>
            <Button type="button" className="bg-[#4d2ddc] text-white hover:bg-[#3d20c7]" disabled={Boolean(actionId) || mutationBusy} onClick={() => void confirmPaid()}>
              {actionId ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} {formatKrw(paying?.scheduled_amount_krw)} 지급 완료 표시
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex flex-col gap-4 border-b border-black/8 pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold text-[#4d2ddc]">MANUAL REWARDS</p>
          <h2 id="parent-reward-settings-title" className="mt-1 text-2xl font-bold tracking-[-0.04em]">부모 수동 보상</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[#747670]">PASS일의 기본 보상과 별개로 기록합니다. 금전은 자동 송금이 아닌 <strong>지급 예정</strong> 장부이며, 칭찬 보너스는 부모 재량의 독립 쿠폰입니다.</p>
        </div>
        <div className="flex items-center gap-2 rounded-2xl bg-[#edf7f3] px-3 py-2 text-xs leading-5 text-[#315045]"><ShieldCheck className="h-4 w-4 shrink-0" />가족 시간대 {timezone}</div>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <form className="rounded-2xl bg-[#f5f3ed] p-5" onSubmit={event => { event.preventDefault(); void saveWeekly(); }}>
          <div className="flex items-start gap-3"><CalendarDays className="mt-0.5 h-5 w-5 text-[#4d2ddc]" /><div><h3 className="font-bold">주간 돈 보상</h3><p className="mt-1 text-xs leading-5 text-[#666963]">부모가 약속한 금액을 직접 입력합니다. 칭찬 횟수로 자동 가산하지 않으며, 칭찬은 아래 특별보너스 쿠폰으로 따로 발행합니다.</p></div></div>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div className="space-y-2"><Label htmlFor="weekly-child">대상 자녀</Label><select id="weekly-child" value={weekly.childId} onChange={event => setWeekly(current => ({ ...current, childId: event.target.value }))} disabled={saving !== null} className="flex h-10 w-full rounded-md border border-input bg-white px-3 py-2 text-sm"><option value="">활성 자녀를 선택하세요</option>{activeChildren.map(child => <option key={child.id} value={child.id}>{child.display_name}</option>)}</select></div>
            <div className="space-y-2"><Label htmlFor="weekly-date">주간 기준일</Label><Input id="weekly-date" type="date" value={weekly.referenceDate} disabled={saving !== null || mutationBusy} onChange={event => setWeekly(current => ({ ...current, referenceDate: event.target.value }))} /><p className="text-xs text-[#666963]">{weekRange ? <>ISO 주간(월~일): {formatDate(weekRange.start)} ~ {formatDate(weekRange.end)}</> : "기준일을 선택하면 월요일~일요일 기간을 보여 드립니다."}</p></div>
            <label className="flex items-start gap-3 rounded-xl bg-white p-3 text-sm sm:col-span-2"><Checkbox checked={weekly.goodThisWeek} onCheckedChange={checked => setWeekly(current => ({ ...current, goodThisWeek: checked === true }))} disabled={saving !== null} /><span><strong>이번 주 잘했음</strong><span className="mt-1 block text-xs leading-5 text-[#666963]">체크하지 않으면 0원이 아니라 대기 초안이며 자동 지급하지 않습니다.</span></span></label>
            <div className="rounded-xl bg-white p-3 text-sm"><p className="text-xs text-[#666963]">현재 계산</p><strong className="mt-1 block text-lg text-[#4d2ddc]">{weekly.goodThisWeek ? formatKrw(weeklyAmount) : "대기 (자동 지급 없음)"}</strong></div>
            <div className="space-y-2"><Label htmlFor="weekly-base">약속한 주간 금액(원)</Label><Input id="weekly-base" type="number" min="1" step="1" inputMode="numeric" value={weekly.baseAmountKrw} disabled={saving !== null} onChange={event => setWeekly(current => ({ ...current, baseAmountKrw: event.target.value }))} /></div>
          </div>
          <div className="mt-5 flex flex-col gap-2 border-t border-black/8 pt-4 sm:flex-row sm:items-center sm:justify-between"><p className="text-xs leading-5 text-[#9b453f]">{weeklyError ?? (weekly.goodThisWeek && weekRange && weekRange.end >= today ? "주 전체가 끝나기 전에는 지급 예정으로 확정할 수 없으며 대기 초안만 저장됩니다." : "과거 기간은 기록할 수 있습니다.")}</p><Button type="submit" className="shrink-0 rounded-xl bg-[#4d2ddc] text-white hover:bg-[#3d20c7]" disabled={saving !== null || mutationBusy || !weekly.childId || Boolean(weeklyError)}>{saving === "weekly" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CircleDollarSign className="h-4 w-4" />}{canPublishWeekly ? "지급 예정 기록" : "주간 초안 저장"}</Button></div>
        </form>

        <div className="space-y-6">
          <form className="rounded-2xl border border-black/8 p-5" onSubmit={event => { event.preventDefault(); void savePeriod(); }}>
            <div className="flex items-start gap-3"><CircleDollarSign className="mt-0.5 h-5 w-5 text-[#4d2ddc]" /><div><h3 className="font-bold">일·월·특별 이벤트 돈 보상</h3><p className="mt-1 text-xs leading-5 text-[#666963]">부모가 확인한 별도 지급 예정만 기록합니다. 같은 자녀/기간은 1건, 특별 이벤트는 이벤트 키로 구분합니다.</p></div></div>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <div className="space-y-2"><Label htmlFor="period-child">대상 자녀</Label><select id="period-child" value={period.childId} onChange={event => setPeriod(current => ({ ...current, childId: event.target.value }))} className="flex h-10 w-full rounded-md border border-input bg-white px-3 py-2 text-sm"><option value="">선택하세요</option>{activeChildren.map(child => <option key={child.id} value={child.id}>{child.display_name}</option>)}</select></div>
              <div className="space-y-2"><Label htmlFor="period-kind">구분</Label><select id="period-kind" value={period.kind} onChange={event => setPeriod(current => ({ ...current, kind: event.target.value as PeriodForm["kind"] }))} className="flex h-10 w-full rounded-md border border-input bg-white px-3 py-2 text-sm"><option value="DAILY">일 보상</option><option value="MONTHLY">월 보상</option><option value="SPECIAL_EVENT">특별 이벤트</option></select></div>
              <div className="space-y-2"><Label htmlFor="period-date">기준일</Label><Input id="period-date" type="date" value={period.referenceDate} onChange={event => setPeriod(current => ({ ...current, referenceDate: event.target.value }))} /></div>
              <div className="space-y-2"><Label htmlFor="period-amount">지급 예정 금액(원)</Label><Input id="period-amount" type="number" min="1" step="1" inputMode="numeric" value={period.amountKrw} onChange={event => setPeriod(current => ({ ...current, amountKrw: event.target.value }))} /></div>
              {period.kind === "SPECIAL_EVENT" && <><div className="space-y-2"><Label htmlFor="event-key">이벤트 키</Label><Input id="event-key" value={period.eventKey} maxLength={100} placeholder="예: science-fair-2026" onChange={event => setPeriod(current => ({ ...current, eventKey: event.target.value }))} /></div><div className="space-y-2"><Label htmlFor="event-title">이벤트 제목</Label><Input id="event-title" value={period.eventTitle} maxLength={160} placeholder="예: 과학 발표회" onChange={event => setPeriod(current => ({ ...current, eventTitle: event.target.value }))} /></div></>}
            </div>
            <Button type="submit" className="mt-5 rounded-xl bg-[#333a44] text-white hover:bg-[#232932]" disabled={saving !== null || mutationBusy || !period.childId}>{saving === "period" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CircleDollarSign className="h-4 w-4" />} 지급 예정 기록</Button>
          </form>

          <form className="rounded-2xl border border-black/8 p-5" onSubmit={event => { event.preventDefault(); void saveCoupon(); }}>
            <div className="flex items-start gap-3"><Gift className="mt-0.5 h-5 w-5 text-[#4d2ddc]" /><div><h3 className="font-bold">선생님 칭찬 특별보너스 쿠폰</h3><p className="mt-1 text-xs leading-5 text-[#666963]">세부 칭찬 기준을 강제하지 않는 부모 재량 보너스입니다. 발행은 시간 잔액에 더해지지 않습니다.</p></div></div>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <div className="space-y-2"><Label htmlFor="coupon-child">대상 자녀</Label><select id="coupon-child" value={coupon.childId} onChange={event => setCoupon(current => ({ ...current, childId: event.target.value }))} className="flex h-10 w-full rounded-md border border-input bg-white px-3 py-2 text-sm"><option value="">선택하세요</option>{activeChildren.map(child => <option key={child.id} value={child.id}>{child.display_name}</option>)}</select></div>
              <div className="space-y-2"><Label htmlFor="coupon-date">발행일</Label><Input id="coupon-date" type="date" max={today} value={coupon.issuedOn} onChange={event => setCoupon(current => ({ ...current, issuedOn: event.target.value }))} /></div>
              <div className="space-y-2"><Label htmlFor="coupon-title">쿠폰 이름</Label><Input id="coupon-title" value={coupon.title} maxLength={120} placeholder="예: 주말 자유시간" onChange={event => setCoupon(current => ({ ...current, title: event.target.value }))} /></div>
              <div className="space-y-2"><Label htmlFor="coupon-unit">권리 종류</Label><select id="coupon-unit" value={coupon.unit} onChange={event => setCoupon(current => ({ ...current, unit: event.target.value as ManualBonusUnit }))} className="flex h-10 w-full rounded-md border border-input bg-white px-3 py-2 text-sm"><option value="TIME_MINUTES">시간(분)</option><option value="MONEY_KRW">원</option><option value="ACTIVITY">활동 이용권</option><option value="CUSTOM">자유 이용 쿠폰</option><option value="TEXT">자유 문구</option></select></div>
              <div className="space-y-2"><Label htmlFor="coupon-amount">수량 <span className="font-normal text-muted-foreground">(자유 쿠폰은 선택)</span></Label><Input id="coupon-amount" type="number" min="1" step="1" inputMode="numeric" value={coupon.amount} placeholder={coupon.unit === "TIME_MINUTES" ? "예: 30" : coupon.unit === "MONEY_KRW" ? "예: 1000" : "선택"} onChange={event => setCoupon(current => ({ ...current, amount: event.target.value }))} /></div>
              <div className="space-y-2 sm:col-span-2"><Label htmlFor="coupon-reason">간단한 사유</Label><Textarea id="coupon-reason" value={coupon.reason} maxLength={240} placeholder="예: 선생님이 발표 태도를 칭찬해 주셨어요" onChange={event => setCoupon(current => ({ ...current, reason: event.target.value }))} /></div>
            </div>
            <Button type="submit" className="mt-5 rounded-xl bg-[#4d2ddc] text-white hover:bg-[#3d20c7]" disabled={saving !== null || mutationBusy || !coupon.childId}>{saving === "coupon" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ticket className="h-4 w-4" />} 쿠폰 발행</Button>
          </form>
        </div>
      </div>

      <div className="mt-8 border-t border-black/8 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-bold">금전 지급 기록</h3><p className="mt-1 text-xs leading-5 text-[#777a74]">“지급 예정”은 금융 거래가 아닙니다. 지급 완료 후에는 취소하지 않고, 필요하면 정정 기록을 별도로 남기세요.</p></div><Button type="button" variant="outline" size="sm" disabled={loading || saving !== null || mutationBusy} onClick={() => void refresh()}><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> 새로고침</Button></div>
        {loading ? <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-[#4d2ddc]" /></div> : loadError ? <div className="mt-4 rounded-2xl bg-[#f4e8e5] p-5 text-sm leading-6 text-[#97473f]">{loadError}</div> : moneyRows.length === 0 ? <div className="mt-4 rounded-2xl bg-[#f5f3ed] p-5 text-center text-sm text-[#777a74]">아직 돈 보상 기록이 없습니다.</div> : <div className="mt-4 space-y-3">{moneyRows.map(row => <article key={row.reward_id} className="rounded-2xl border border-black/8 p-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><div className="flex flex-wrap items-center gap-2"><h4 className="font-bold">{row.event_title || moneyKindLabel[row.reward_kind]}</h4><span className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${statusClass(row.status)}`}>{moneyRewardStatusLabel(row.status)}</span></div><p className="mt-1 text-xs text-[#777a74]">{row.child_name ?? "자녀"} · {formatDate(row.period_start)} ~ {formatDate(row.period_end)}</p></div><strong className="text-lg text-[#4d2ddc]">{formatKrw(row.scheduled_amount_krw)}</strong></div>{row.reward_kind === "WEEKLY" && <p className="mt-3 rounded-xl bg-[#f5f3ed] px-3 py-2 text-xs leading-5 text-[#62656a]">이번 주 잘했음: {row.good_this_week ? "확인" : "미확인/아니오"} · 확인한 주간 금액 {formatKrw(row.scheduled_amount_krw)} · 칭찬은 별도 쿠폰</p>}{row.status === "PAID" && <p className="mt-3 text-xs text-[#315f4d]">부모가 {row.paid_on ? formatDate(row.paid_on) : ""}에 실제 외부 지급 완료로 표시했습니다.</p>}{row.status === "SCHEDULED" && <div className="mt-4 flex flex-wrap gap-2"><Button type="button" size="sm" className="rounded-xl bg-[#4d2ddc] text-white hover:bg-[#3d20c7]" disabled={Boolean(actionId) || mutationBusy} onClick={() => { setActualPaidOn(today); setPaying(row); }}><CheckCircle2 className="h-4 w-4" /> 지급 완료 표시</Button><Button type="button" variant="outline" size="sm" disabled={Boolean(actionId) || mutationBusy} onClick={() => void voidMoney(row)}><XCircle className="h-4 w-4" /> 예정 취소</Button></div>}</article>)}</div>}
      </div>

      <div className="mt-8 border-t border-black/8 pt-6"><div className="flex flex-wrap items-end justify-between gap-3"><div><h3 className="font-bold">선택 자녀의 특별보너스 쿠폰</h3><p className="mt-1 text-xs leading-5 text-[#777a74]">사용/취소는 부모만 처리합니다. 자녀 화면은 상태만 보여 주며 사용 버튼이 없습니다.</p></div><div className="space-y-1"><Label htmlFor="coupon-viewing-child" className="text-xs">쿠폰을 보는 자녀</Label><select id="coupon-viewing-child" value={couponViewingChildId} disabled={loading || mutationBusy} onChange={event => setCouponViewingChildId(event.target.value)} className="flex h-9 rounded-md border border-input bg-white px-3 text-sm"><option value="">선택하세요</option>{activeChildren.map(child => <option key={child.id} value={child.id}>{child.display_name}</option>)}</select></div></div>{loadError ? <div className="mt-4 rounded-2xl bg-[#f4e8e5] p-5 text-sm text-[#97473f]">{loadError}</div> : selectedChildRows.filter(row => row.record_type === "BONUS_COUPON").length === 0 ? <div className="mt-4 rounded-2xl bg-[#f5f3ed] p-5 text-center text-sm text-[#777a74]">선택 자녀에게 발행한 특별보너스 쿠폰이 없습니다.</div> : <div className="mt-4 space-y-3">{selectedChildRows.filter(row => row.record_type === "BONUS_COUPON").map(row => <article key={row.record_id} className="rounded-2xl border border-black/8 p-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><div className="flex flex-wrap items-center gap-2"><h4 className="font-bold">{row.title}</h4><span className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${statusClass(row.state)}`}>{bonusCouponStatusLabel(row.state as "ISSUED" | "REDEEMED" | "VOID")}</span></div><p className="mt-1 text-xs text-[#777a74]">{bonusUnitLabel(row.unit)}{row.amount ? ` · ${row.amount}${row.unit === "TIME_MINUTES" ? "분" : row.unit === "MONEY_KRW" ? "원" : ""}` : ""}</p><p className="mt-2 text-sm text-[#555852]">{row.reason}</p></div>{row.state === "ISSUED" && <div className="flex gap-2"><Button type="button" size="sm" variant="outline" disabled={Boolean(actionId) || mutationBusy} onClick={() => void actOnCoupon(row, "redeem")}>사용 처리</Button><Button type="button" size="sm" variant="outline" disabled={Boolean(actionId) || mutationBusy} onClick={() => void actOnCoupon(row, "void")}>취소</Button></div>}</div></article>)}</div>}</div>
    </section>
  );
}
