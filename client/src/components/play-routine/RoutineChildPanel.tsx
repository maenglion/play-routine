import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import {
  rewardLabel,
  stickerLabel,
  thresholdLabel,
} from "@/lib/routine-v2-display";
import type { RoutineDayRow, RoutineEntitlementRow } from "@shared/routine-v2";
import { Check, RefreshCw, Star, Smile, Stamp } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

function previewRows(day: string): RoutineDayRow[] {
  return [
    {
      id: "preview-routine",
      assignment_id: "preview-assignment",
      rule_id: "preview-rule",
      business_date: day,
      name: "학교생활",
      child_label: "선생님과의 약속",
      criteria: "수업시간 약속을 지킨 하루인지 부모와 확인해요.",
      category: "DAILY_STUDY",
      flow: "DAILY",
      sticker_icon: "STAR",
      period: "WEEKLY",
      period_start: day,
      period_end: day,
      period_closed: false,
      child_reported: false,
      verification_status: "MISSING",
      score: null,
      pass: null,
      praise: false,
      stickers: null,
      sticker_total: 4,
      revision: 0,
      parent_reason: null,
      parent_verified_at: null,
      penalty_minutes: null,
      tiers: [
        {
          id: "tier-basic",
          label: "기본 달성",
          threshold: 5,
          operator: "GTE",
          reached: false,
          rewards: [
            {
              id: "reward-one",
              name: "약속한 용돈",
              unit: "WON",
              unit_label: "원",
              amount: 10000,
              text: "",
            },
          ],
        },
        {
          id: "tier-extra",
          label: "추가 달성",
          threshold: 8,
          operator: "GTE",
          reached: false,
          rewards: [
            {
              id: "reward-two",
              name: "함께 가기",
              unit: "STRING",
              unit_label: "소원",
              amount: null,
              text: "롯데월드 가기",
            },
          ],
        },
      ],
    },
  ];
}

export default function RoutineChildPanel({
  childId,
  day,
  preview = false,
  onSummaryChange,
}: {
  childId: string;
  day: string;
  preview?: boolean;
  onSummaryChange?: (value: {
    loading: boolean;
    error: boolean;
    missing: number;
    total: number;
    confirmed: number;
  }) => void;
}) {
  const [rows, setRows] = useState<RoutineDayRow[]>([]);
  const [rewards, setRewards] = useState<RoutineEntitlementRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reporting, setReporting] = useState<string | null>(null);
  const generation = useRef(0);
  const reportLock = useRef(false);
  const attempts = useRef(new Map<string, { revision: number; key: string }>());
  const load = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      if (preview) {
        if (request === generation.current) {
          setRows(previewRows(day));
          setRewards([]);
        }
        return;
      }
      const [dayResult, rewardResult] = await Promise.all([
        supabase.rpc("list_routine_day", {
          p_child_profile_id: childId,
          p_business_date: day,
        }),
        supabase.rpc("list_routine_entitlements", {
          p_child_profile_id: childId,
        }),
      ]);
      if (dayResult.error || rewardResult.error)
        throw new Error(
          "할 일과 보상권을 불러오지 못했어요. 다시 시도해 주세요."
        );
      if (request === generation.current) {
        setRows((dayResult.data ?? []) as RoutineDayRow[]);
        setRewards((rewardResult.data ?? []) as RoutineEntitlementRow[]);
      }
    } catch (e) {
      if (request === generation.current) {
        setRows([]);
        setRewards([]);
        setError(e instanceof Error ? e.message : "조회에 실패했어요.");
      }
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [childId, day, preview]);
  useEffect(() => {
    setRows([]);
    setRewards([]);
    attempts.current.clear();
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  useEffect(() => {
    onSummaryChange?.({
      loading,
      error: !!error,
      missing: rows.filter(row => row.verification_status === "MISSING").length,
      total: rows.length,
      confirmed: rows.filter(row => row.verification_status === "CONFIRMED")
        .length,
    });
  }, [rows, loading, error, onSummaryChange]);
  const report = async (row: RoutineDayRow) => {
    if (
      reportLock.current ||
      row.child_reported ||
      row.verification_status === "CONFIRMED"
    )
      return;
    if (preview) {
      setRows(current =>
        current.map(value =>
          value.id === row.id
            ? {
                ...value,
                child_reported: true,
                verification_status: "HELD",
                revision: value.revision + 1,
              }
            : value
        )
      );
      toast.info("미리보기예요. 실제 기록이나 스티커를 만들지 않아요.");
      return;
    }
    reportLock.current = true;
    setReporting(row.id);
    const request = generation.current;
    let attempt = attempts.current.get(row.id);
    if (!attempt || attempt.revision !== row.revision) {
      attempt = { revision: row.revision, key: crypto.randomUUID() };
      attempts.current.set(row.id, attempt);
    }
    try {
      const { error: mutationError } = await supabase.rpc(
        "report_routine_done",
        {
          p_occurrence_id: row.id,
          p_expected_revision: attempt.revision,
          p_idempotency_key: attempt.key,
        }
      );
      if (mutationError)
        throw new Error(
          mutationError.message.includes("REVISION")
            ? "부모의 확인이 먼저 바뀌었어요. 새로고침 후 확인해 주세요."
            : "체크를 저장하지 못했어요. 다시 시도해 주세요."
        );
      attempts.current.delete(row.id);
      if (request === generation.current) {
        toast.success("했다는 기록을 남겼어요. 부모 확인을 기다려요.");
        await load();
      }
    } catch (e) {
      if (request === generation.current)
        toast.error(e instanceof Error ? e.message : "기록하지 못했어요.");
    } finally {
      reportLock.current = false;
      setReporting(null);
    }
  };
  return (
    <section className="space-y-4 rounded-[24px] bg-white p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-[#4d2ddc]">
            DAILY / QUEST
          </p>
          <h3 className="mt-1 text-xl font-bold">스티커와 도전</h3>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="스티커와 도전 새로고침"
          disabled={loading || !!reporting}
          onClick={() => void load()}
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>
      <p className="text-xs leading-5 text-[#737670]">
        했어요 체크와 부모 확인은 달라요. 스티커는 모은 기록이며, 보상을 받아도
        없어지지 않아요.
      </p>
      {loading ? (
        <p role="status" className="text-sm text-[#737670]">
          불러오는 중…
        </p>
      ) : error ? (
        <div
          role="alert"
          className="space-y-2 rounded-xl bg-red-50 p-3 text-xs text-red-800"
        >
          {error}
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => void load()}
          >
            다시 불러오기
          </Button>
        </div>
      ) : (
        <>
          {rows.length === 0 && (
            <p className="rounded-xl bg-[#f5f3ed] p-4 text-xs leading-5 text-[#737670]">
              이 날짜에 배정된 새 데일리·Quest가 없어요.
            </p>
          )}
          {rows.map(row => {
            const Icon =
              row.sticker_icon === "SMILE"
                ? Smile
                : row.sticker_icon === "STAMP"
                  ? Stamp
                  : Star;
            const confirmed = row.verification_status === "CONFIRMED";
            return (
              <article
                key={row.id}
                className="space-y-3 rounded-2xl border border-black/8 p-4"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <span className="text-[10px] font-bold text-[#4d2ddc]">
                      {row.flow === "DAILY" ? "데일리" : "Quest"}
                    </span>
                    <h4 className="mt-1 font-semibold">
                      {row.child_label || row.name}
                    </h4>
                    {row.child_label && (
                      <p className="mt-1 text-[11px] text-[#737670]">
                        {row.name}
                      </p>
                    )}
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-1 text-[10px] ${confirmed ? "bg-[#e4f1eb] text-[#315f4d]" : "bg-[#f0edfa] text-[#5b46a3]"}`}
                  >
                    {confirmed
                      ? "부모 확인됨"
                      : row.child_reported
                        ? "확인 기다림"
                        : "미체크"}
                  </span>
                </div>
                <p className="whitespace-pre-wrap break-words text-xs leading-5 text-[#737670]">
                  {row.criteria}
                </p>
                {row.flow === "DAILY" ? (
                  <div className="rounded-xl bg-[#f7f4ff] p-3 text-xs text-[#51447f]">
                    <div className="flex items-center gap-2">
                      <Icon aria-hidden="true" className="h-4 w-4" />
                      <span>
                        {stickerLabel(row.sticker_icon)} · 오늘{" "}
                        {row.stickers === null
                          ? "부모 확인 전"
                          : `${row.stickers}개`}
                        {row.praise ? " (칭찬 포함)" : ""}
                      </span>
                    </div>
                    <p className="mt-2">
                      {row.period_start} ~ {row.period_end} · 이 활동 스티커{" "}
                      {row.sticker_total}개
                    </p>
                    {row.period !== "DAILY" && (
                      <p className="mt-1 text-[10px]">
                        {row.period_closed
                          ? "기간 종료 · 부모가 보상 확정"
                          : "기간 집계 중 · 보상 확정 전"}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-[#51447f]">
                    부모 확인 값:{" "}
                    {row.score === null ? "아직 확인하지 않았어요" : row.score}
                  </p>
                )}
                <div className="space-y-2">
                  {row.tiers.map(tier => (
                    <div
                      key={tier.id}
                      className="rounded-xl bg-[#f5f3ed] p-3 text-xs"
                    >
                      <div className="flex flex-wrap items-center gap-2 font-semibold">
                        <span>
                          {tier.label} ·{" "}
                          {thresholdLabel(
                            tier.threshold,
                            tier.operator,
                            row.flow,
                            row.measurement
                          )}
                        </span>
                        <span className="text-[#4d2ddc]">
                          {tier.reached ? "기준 달성" : "도전 중"}
                        </span>
                      </div>
                      {tier.rewards.map(reward => (
                        <p
                          key={reward.id}
                          className="mt-1.5 break-words leading-5"
                        >
                          {rewardLabel(reward)}
                        </p>
                      ))}
                    </div>
                  ))}
                </div>
                {row.parent_reason && (
                  <div className="rounded-xl bg-[#edf7f3] p-3 text-xs leading-5 text-[#315045]">
                    <strong>부모가 확인한 이유</strong>
                    <p className="mt-1 whitespace-pre-wrap break-words">
                      {row.parent_reason}
                    </p>
                    {row.parent_verified_at && (
                      <p className="mt-1 text-[10px]">
                        {new Date(row.parent_verified_at).toLocaleString(
                          "ko-KR"
                        )}
                      </p>
                    )}
                  </div>
                )}
                <Button
                  type="button"
                  disabled={
                    loading || !!reporting || row.child_reported || confirmed
                  }
                  onClick={() => void report(row)}
                  className="w-full rounded-xl bg-[#4d2ddc] text-white hover:bg-[#3d20c7]"
                >
                  <Check className="h-4 w-4" />
                  {reporting === row.id
                    ? "저장 중…"
                    : confirmed
                      ? "부모 확인 완료"
                      : row.child_reported
                        ? "부모 확인 기다림"
                        : "했어요"}
                </Button>
              </article>
            );
          })}
          <div className="border-t border-black/8 pt-4">
            <h4 className="font-semibold">달성한 보상권</h4>
            <p className="mt-1 text-[11px] leading-5 text-[#737670]">
              이 보상권은 일반 시간 잔액이나 송금 완료가 아니에요. 각각 부모와
              지급·사용을 확인해요.
            </p>
            {!rewards.length ? (
              <p className="mt-3 text-xs text-[#737670]">
                부모가 확정한 조건 보상권이 아직 없어요.
              </p>
            ) : (
              <div className="mt-3 space-y-2">
                {rewards.map(reward => (
                  <article
                    key={reward.id}
                    className="rounded-xl bg-[#f5f3ed] p-3 text-xs"
                  >
                    <p className="font-semibold">{rewardLabel(reward)}</p>
                    <p className="mt-1 text-[#737670]">
                      {reward.rule_name} · {reward.condition_label}
                    </p>
                    <p className="mt-1">
                      {reward.requires_review
                        ? "부모와 다시 확인 · 실제 지급 기록은 보존"
                        : reward.status === "FULFILLED"
                          ? "지급·사용 확인됨"
                          : reward.status === "REVIEW_REQUIRED"
                            ? "부모와 다시 확인"
                            : "약속한 보상권"}
                    </p>
                  </article>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
