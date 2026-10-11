import { Button } from "@/components/ui/button";
import {
  bonusCouponStatusLabel,
  bonusUnitLabel,
  familyManualRewardDate,
  formatKrw,
  isoWeekRange,
  listChildManualRewards,
  moneyRewardStatusLabel,
  type ChildManualRewardRow,
} from "@/lib/manual-rewards";
import { CircleDollarSign, Gift, Loader2, RefreshCw, Ticket } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

export type ChildRewardListProps = {
  childId: string;
  preview?: boolean;
};

function previewRows(today: string): ChildManualRewardRow[] {
  const week = isoWeekRange(today);
  return [
    {
      record_type: "MONEY",
      record_id: "preview-money",
      title: "주간 보상",
      reason: "부모가 실제로 지급하기 전의 지급 예정 기록",
      // Never pretend that this local preview was actually paid.
      state: "SCHEDULED",
      unit: "MONEY_KRW",
      amount: null,
      scheduled_amount_krw: 15_000,
      period_start: week.start,
      period_end: week.end,
      issued_on: null,
      paid_on: null,
      created_at: `${today}T12:00:00.000Z`,
    },
    {
      record_type: "BONUS_COUPON",
      record_id: "preview-coupon",
      title: "주말 자유시간",
      reason: "선생님이 발표 태도를 칭찬해 주셨어요",
      state: "ISSUED",
      unit: "TIME_MINUTES",
      amount: 30,
      scheduled_amount_krw: null,
      period_start: null,
      period_end: null,
      issued_on: today,
      paid_on: null,
      created_at: `${today}T12:00:00.000Z`,
    },
  ];
}

function formatDate(value: string | null) {
  if (!value) return null;
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

function statusClass(state: string) {
  if (state === "PAID" || state === "REDEEMED") return "bg-[#e4f1eb] text-[#315f4d]";
  if (state === "SCHEDULED" || state === "ISSUED") return "bg-[#f0edfa] text-[#5b46a3]";
  if (state === "VOID") return "bg-[#f4e8e5] text-[#97473f]";
  return "bg-[#f5f3ed] text-[#666963]";
}

/**
 * Child projection only: this component intentionally has no spend, redeem, or money-transfer
 * control. A TIME_MINUTES bonus is a coupon entitlement, not the normal routine time balance.
 */
export default function ChildRewardList({ childId, preview = false }: ChildRewardListProps) {
  const [rows, setRows] = useState<ChildManualRewardRow[]>(() => preview ? previewRows(familyManualRewardDate("Asia/Seoul")) : []);
  const [loading, setLoading] = useState(!preview);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (preview) {
      setRows(previewRows(familyManualRewardDate("Asia/Seoul")));
      setLoading(false);
      setError(null);
      return;
    }
    if (!childId) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setRows(await listChildManualRewards(childId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "보상 기록을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [childId, preview]);

  useEffect(() => { void refresh(); }, [refresh]);

  const money = rows.filter(row => row.record_type === "MONEY");
  const coupons = rows.filter(row => row.record_type === "BONUS_COUPON");

  return (
    <section className="rounded-[28px] bg-white p-5 shadow-[0_16px_48px_rgba(51,58,68,.08)]" aria-labelledby="child-reward-list-title">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-[#4d2ddc]">MY REWARDS</p>
          <h2 id="child-reward-list-title" className="mt-1 text-xl font-bold tracking-[-0.04em]">내 보상 기록</h2>
          <p className="mt-2 text-xs leading-5 text-[#737670]">돈 보상과 쿠폰은 시간 티켓 잔액과 따로 보여요.</p>
        </div>
        <Button type="button" size="icon" variant="ghost" onClick={() => void refresh()} disabled={loading} aria-label="보상 기록 새로고침">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {loading ? <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-[#4d2ddc]" /></div> : error ? <div className="mt-5 rounded-2xl bg-[#f4e8e5] p-4 text-sm leading-6 text-[#97473f]">{error}</div> : <>
        <div className="mt-6">
          <div className="flex items-center gap-2"><CircleDollarSign className="h-4 w-4 text-[#4d2ddc]" /><h3 className="text-sm font-bold">돈 보상</h3></div>
          <p className="mt-1 text-xs leading-5 text-[#777a74]">“지급 예정”은 부모가 실제로 주기 전의 기록이에요. 이 앱에서 돈을 보내거나 받을 수 없어요.</p>
          {money.length === 0 ? <div className="mt-3 rounded-2xl bg-[#f5f3ed] p-4 text-center text-sm text-[#777a74]">아직 돈 보상 기록이 없어요.</div> : <div className="mt-3 space-y-2">{money.map(row => <article key={row.record_id} className="rounded-2xl border border-black/8 p-3"><div className="flex items-start justify-between gap-3"><div><strong className="text-sm">{row.title}</strong><p className="mt-1 text-xs leading-5 text-[#777a74]">{row.reason}</p>{row.period_start && <p className="mt-1 text-[11px] text-[#8a8b85]">{formatDate(row.period_start)}{row.period_end && row.period_end !== row.period_start ? ` ~ ${formatDate(row.period_end)}` : ""}</p>}</div><div className="text-right"><span className={`inline-flex rounded-full px-2 py-1 text-[10px] font-bold ${statusClass(row.state)}`}>{moneyRewardStatusLabel(row.state as "PENDING" | "SCHEDULED" | "PAID" | "VOID")}</span><strong className="mt-2 block text-base text-[#4d2ddc]">{formatKrw(row.scheduled_amount_krw)}</strong></div></div></article>)}</div>}
        </div>

        <div className="mt-7 border-t border-black/8 pt-6">
          <div className="flex items-center gap-2"><Gift className="h-4 w-4 text-[#4d2ddc]" /><h3 className="text-sm font-bold">특별보너스 쿠폰</h3></div>
          <p className="mt-1 text-xs leading-5 text-[#777a74]">칭찬을 받아 부모가 발행한 쿠폰이에요. 사용 처리는 부모와 함께 해요.</p>
          {coupons.length === 0 ? <div className="mt-3 rounded-2xl bg-[#f5f3ed] p-4 text-center text-sm text-[#777a74]">아직 특별보너스 쿠폰이 없어요.</div> : <div className="mt-3 space-y-2">{coupons.map(row => <article key={row.record_id} className="rounded-2xl border border-black/8 p-3"><div className="flex items-start justify-between gap-3"><div className="flex min-w-0 gap-3"><div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#f0edfa] text-[#4d2ddc]"><Ticket className="h-4 w-4" /></div><div><strong className="text-sm">{row.title}</strong><p className="mt-1 text-xs leading-5 text-[#777a74]">{row.reason}</p><p className="mt-1 text-[11px] text-[#8a8b85]">{bonusUnitLabel(row.unit)}{row.amount ? ` · ${row.amount}${row.unit === "TIME_MINUTES" ? "분" : row.unit === "MONEY_KRW" ? "원" : ""}` : ""}</p></div></div><span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-bold ${statusClass(row.state)}`}>{bonusCouponStatusLabel(row.state as "ISSUED" | "REDEEMED" | "VOID")}</span></div></article>)}</div>}
          <p className="mt-4 rounded-xl bg-[#f5f3ed] px-3 py-3 text-xs leading-5 text-[#62656a]">시간(분) 쿠폰도 일반 시간 티켓 보유량에 더해지지 않아요. 여기의 쿠폰 상태만 확인할 수 있어요.</p>
        </div>
      </>}
    </section>
  );
}
