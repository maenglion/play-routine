import { makeOctoberPreviewBoard as previewBoard } from "@/lib/october-preview-data";
import { Button } from "@/components/ui/button";
import {
  getOctoberBoard,
  isOctoberConfirmed,
  isScheduledOctoberTask,
  newOctoberUuid,
  octoberBoardDisplayState,
  octoberDomainLabel,
  octoberEffectLabel,
  octoberReplayFingerprint,
  octoberStateLabel,
  replayKeyFor,
  ruleForOctoberRow,
  submitOctoberOccurrence,
} from "@/lib/october-runtime-api";
import type {
  OctoberBoard,
  OctoberDomain,
  OctoberRow,
  OctoberRule,
} from "@shared/october-runtime";
import {
  Check,
  CircleAlert,
  ClipboardCheck,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type OctoberChildSummary = {
  pending_minutes: number;
  penalty_minutes: number;
  unconfirmed: number;
  rows: number;
  confirmed: number;
};

export type OctoberChildPanelProps = {
  familyId: string;
  childId: string;
  timezone: string;
  /** The dashboard owns selection of this family-timezone business date. */
  day: string;
  preview?: boolean;
  onSummary?: (summary: OctoberChildSummary) => void;
  onPlanState?: (active: boolean) => void;
};

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function ruleName(rule: OctoberRule | undefined, fallback: string) {
  return rule?.name || fallback;
}

function childSummary(board: OctoberBoard | null): OctoberChildSummary {
  if (!board)
    return {
      pending_minutes: 0,
      penalty_minutes: 0,
      unconfirmed: 0,
      rows: 0,
      confirmed: 0,
    };
  // Lifestyle event rows are never used to trigger a child "unfinished" warning.
  const scheduled = board.rows.filter(row =>
    isScheduledOctoberTask(row, ruleForOctoberRow(board.rules, row))
  );
  return {
    pending_minutes: board.summary.pending_minutes,
    penalty_minutes: board.summary.penalty_minutes,
    unconfirmed: scheduled.filter(
      row => !row.self_reported && !isOctoberConfirmed(row.state)
    ).length,
    rows: scheduled.length,
    confirmed: scheduled.filter(row => isOctoberConfirmed(row.state)).length,
  };
}

/** Child view deliberately contains no approve, grant, amount, or penalty-finalization control. */
export default function OctoberChildPanel({
  familyId,
  childId,
  timezone,
  day,
  preview = false,
  onSummary,
  onPlanState,
}: OctoberChildPanelProps) {
  const [board, setBoard] = useState<OctoberBoard | null>(
    preview ? previewBoard(day) : null
  );
  const [loading, setLoading] = useState(!preview);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [reporting, setReporting] = useState<string | null>(null);
  const mounted = useRef(true);
  const epoch = useRef(0);
  const requestId = useRef(0);
  const attempts = useRef(new Map<string, string>());
  const lifestyleSlots = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    const request = ++requestId.current;
    const currentEpoch = epoch.current;
    if (preview) {
      if (
        mounted.current &&
        request === requestId.current &&
        currentEpoch === epoch.current
      ) {
        setBoard(previewBoard(day));
        setLoadError(null);
        setLoading(false);
      }
      return;
    }
    if (!familyId || !childId || !day) {
      if (
        mounted.current &&
        request === requestId.current &&
        currentEpoch === epoch.current
      ) {
        setBoard(null);
        setLoadError(null);
        setLoading(false);
      }
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const next = await getOctoberBoard({ familyId, childId, date: day });
      if (
        !mounted.current ||
        request !== requestId.current ||
        currentEpoch !== epoch.current
      )
        return;
      setBoard(next);
    } catch (error) {
      if (
        !mounted.current ||
        request !== requestId.current ||
        currentEpoch !== epoch.current
      )
        return;
      setBoard(null);
      setLoadError(errorMessage(error, "10월 운영표를 불러오지 못했어요."));
    } finally {
      if (
        mounted.current &&
        request === requestId.current &&
        currentEpoch === epoch.current
      )
        setLoading(false);
    }
  }, [childId, day, familyId, preview]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current += 1;
      requestId.current += 1;
    };
  }, []);

  useEffect(() => {
    epoch.current += 1;
    requestId.current += 1;
    attempts.current.clear();
    lifestyleSlots.current.clear();
    setBoard(preview ? previewBoard(day) : null);
    setServerError(null);
  }, [childId, familyId, preview]);

  useEffect(() => {
    void load();
    return () => {
      requestId.current += 1;
    };
  }, [load]);

  const summary = useMemo(() => childSummary(board), [board]);
  useEffect(() => {
    onSummary?.(summary);
  }, [onSummary, summary]);
  useEffect(() => {
    // While loading or after an error, the dashboard must not start a legacy
    // query as a fallback. Only a successful October board says whether a plan
    // exists for this child/date.
    if (!loading && !loadError) onPlanState?.(Boolean(board?.plan));
  }, [board?.plan, loadError, loading, onPlanState]);

  const report = async (row: OctoberRow) => {
    const rule = ruleForOctoberRow(board?.rules ?? [], row);
    if (
      !rule ||
      reporting ||
      row.self_reported ||
      isOctoberConfirmed(row.state)
    )
      return;
    const payload = {
      familyId,
      childId,
      ruleId: row.rule_id,
      date: row.date,
      slot: row.slot,
    };
    const fingerprint = octoberReplayFingerprint("child-submit", payload);
    const eventKey = replayKeyFor(attempts.current, fingerprint);
    setReporting(row.id);
    if (preview) {
      setBoard(current =>
        current
          ? {
              ...current,
              rows: current.rows.map(item =>
                item.id === row.id
                  ? {
                      ...item,
                      state: "SELF_REPORTED",
                      self_reported: true,
                      revision: item.revision + 1,
                    }
                  : item
              ),
            }
          : current
      );
      setServerError(null);
      setReporting(null);
      return;
    }
    try {
      await submitOctoberOccurrence({ ...payload, eventKey });
      attempts.current.delete(fingerprint);
      setServerError(null);
      await load();
    } catch (error) {
      // Keep eventKey mapped for a safe identical retry. Corrected input/context makes a new key.
      setServerError(
        errorMessage(
          error,
          "실천 알림을 저장하지 못했어요. 같은 내용으로 다시 시도해 주세요."
        )
      );
    } finally {
      if (mounted.current) setReporting(null);
    }
  };

  const reportAdditionalLifestyle = async (rule: OctoberRule) => {
    if (reporting) return;
    // Keep this UUID after an uncertain failure so an identical retry cannot
    // create a second event; clear it only after the server accepts the event.
    const slotScope = `${childId}:${day}:${rule.id}`;
    const slot = lifestyleSlots.current.get(slotScope) ?? newOctoberUuid();
    lifestyleSlots.current.set(slotScope, slot);
    const payload = { familyId, childId, ruleId: rule.id, date: day, slot };
    const fingerprint = octoberReplayFingerprint(
      "child-repeat-lifestyle",
      payload
    );
    const eventKey = replayKeyFor(attempts.current, fingerprint);
    setReporting(`new:${rule.id}`);
    if (preview) {
      setBoard(current =>
        current
          ? {
              ...current,
              rows: [
                ...current.rows,
                {
                  id: `preview-${slot}`,
                  rule_id: rule.id,
                  code: rule.code,
                  date: day,
                  slot,
                  revision: 0,
                  state: "SELF_REPORTED",
                  self_reported: true,
                  confirmed_at: null,
                  reason: null,
                  metrics: {},
                  effects: [],
                  recognized_count: 0,
                },
              ],
            }
          : current
      );
      lifestyleSlots.current.delete(slotScope);
      setServerError(null);
      setReporting(null);
      return;
    }
    try {
      await submitOctoberOccurrence({ ...payload, eventKey });
      attempts.current.delete(fingerprint);
      lifestyleSlots.current.delete(slotScope);
      setServerError(null);
      await load();
    } catch (error) {
      setServerError(
        errorMessage(
          error,
          "생활 사건 알림을 저장하지 못했어요. 같은 내용으로 다시 시도해 주세요."
        )
      );
    } finally {
      if (mounted.current) setReporting(null);
    }
  };

  const displayState = octoberBoardDisplayState({
    loading,
    error: loadError,
    board,
  });
  const byDomain = (domain: OctoberDomain) =>
    (board?.rows ?? []).filter(
      row => ruleForOctoberRow(board?.rules ?? [], row)?.domain === domain
    );

  return (
    <section
      className="rounded-[24px] bg-white p-5"
      aria-labelledby="october-child-title"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold tracking-[.14em] text-[#4d2ddc]">
            OCTOBER ROUTINE
          </p>
          <h3 id="october-child-title" className="mt-1 text-xl font-bold">
            10월 약속 확인
          </h3>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="10월 약속 새로고침"
          disabled={loading || !!reporting}
          onClick={() => void load()}
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>
      <p className="mt-2 text-xs leading-5 text-[#737670]">
        내가 한 일을 알려줄 수 있어요. 최종 확인·보상 지급·차감 결정은 부모가
        사실을 확인한 뒤에만 해요.
      </p>
      {preview && (
        <div
          role="status"
          className="mt-3 rounded-xl bg-[#f3efff] p-3 text-xs leading-5 text-[#51447f]"
        >
          미리보기예요. 실제 기록을 만들거나 Supabase RPC를 호출하지 않아요.
        </div>
      )}
      {serverError && (
        <div
          role="alert"
          className="mt-3 rounded-xl border border-[#e7b6ac] bg-[#fbebe8] p-3 text-xs leading-5 text-[#8b3e34]"
        >
          <strong>저장하지 못했어요.</strong>
          <p>{serverError}</p>
          <p className="mt-1">
            입력을 바꾸지 않고 다시 누르면 같은 요청으로 안전하게 재시도해요.
          </p>
        </div>
      )}
      {displayState === "loading" ? (
        <p role="status" className="mt-5 text-sm text-[#737670]">
          10월 약속을 불러오는 중…
        </p>
      ) : displayState === "error" ? (
        <div
          role="alert"
          className="mt-4 rounded-xl bg-[#fbebe8] p-4 text-sm text-[#8b3e34]"
        >
          <p>{loadError}</p>
          <Button
            type="button"
            variant="outline"
            className="mt-3"
            onClick={() => void load()}
          >
            다시 불러오기
          </Button>
        </div>
      ) : displayState === "no-plan" ? (
        <div className="mt-4 rounded-xl bg-[#f5f3ed] p-4 text-sm leading-6 text-[#737670]">
          <strong className="block text-[#333a44]">새 10월 규정 없음</strong>
          <p className="mt-1">
            이 날짜에는 새 10월 운영표가 없어요. 기존 할 일과 기록은 그대로예요.
          </p>
        </div>
      ) : (
        <>
          <div className="mt-5 grid grid-cols-2 gap-3">
            <div className="rounded-2xl bg-[#d4cfe7] p-3">
              <span className="text-[10px] font-bold text-[#5b46a3]">
                확인 대기
              </span>
              <strong className="mt-1 block text-2xl">
                {summary.unconfirmed}
              </strong>
              <p className="mt-1 text-[10px] text-[#5b46a3]">
                예정된 할 일만 표시
              </p>
            </div>
            <div className="rounded-2xl bg-[#cde5de] p-3">
              <span className="text-[10px] font-bold text-[#315f4d]">
                부모 확인됨
              </span>
              <strong className="mt-1 block text-2xl">
                {summary.confirmed}
                <small className="ml-1 text-xs">/ {summary.rows}</small>
              </strong>
              <p className="mt-1 text-[10px] text-[#315f4d]">
                생활 사건은 경고에 넣지 않음
              </p>
            </div>
          </div>
          <div className="mt-5 space-y-5">
            {board?.plan?.school_asset === "COUPAY_KRW" && (
              <p className="rounded-xl bg-[#e4f1eb] p-3 text-xs leading-5 text-[#315f4d]">
                학교 스티커 합계가 0~4개면 무보상, 5~7개면 쿠페이 총
                10,000원, 8개 이상이면 총 15,000원이에요. 5개에서 8개로
                올라가면 차액 5,000원만 안내해요. 스티커와 금융 보상은
                별도로 표시해요.
              </p>
            )}
            {(["TASK", "QUEST"] as OctoberDomain[]).map(domain => (
              <ChildDomain
                key={domain}
                domain={domain}
                rows={byDomain(domain)}
                rules={board?.rules ?? []}
                reporting={reporting}
                onReport={report}
                onRepeatLifestyle={reportAdditionalLifestyle}
              />
            ))}
            <details className="rounded-2xl border border-black/10 p-3">
              <summary className="cursor-pointer text-sm font-semibold">
                생활습관·사건 기록 · 필요할 때 펼치기
              </summary>
              <div className="mt-3">
                <ChildDomain
                  domain="LIFESTYLE"
                  rows={byDomain("LIFESTYLE")}
                  rules={board?.rules ?? []}
                  reporting={reporting}
                  onReport={report}
                  onRepeatLifestyle={reportAdditionalLifestyle}
                />
              </div>
            </details>
          </div>
          <div className="mt-5 rounded-xl bg-[#f5f3ed] p-3 text-xs leading-5 text-[#666963]">
            <ShieldCheck className="mr-1 inline h-4 w-4 text-[#4d2ddc]" />
            권리는 쿠폰·현금·분의 실제 잔액이 아니에요. 부모가 앱 밖에서 제공한
            뒤 이행 기록을 남겨요.
          </div>
        </>
      )}
    </section>
  );
}

function ChildDomain({
  domain,
  rows,
  rules,
  reporting,
  onReport,
  onRepeatLifestyle,
}: {
  domain: OctoberDomain;
  rows: OctoberRow[];
  rules: OctoberRule[];
  reporting: string | null;
  onReport: (row: OctoberRow) => Promise<void>;
  onRepeatLifestyle: (rule: OctoberRule) => Promise<void>;
}) {
  const lifestyleRules =
    domain === "LIFESTYLE"
      ? rules.filter(rule => rule.domain === "LIFESTYLE")
      : [];
  return (
    <section aria-label={`${octoberDomainLabel(domain)} 목록`}>
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-bold text-[#333a44]">
          {octoberDomainLabel(domain)}
        </h4>
        <span className="text-[11px] text-[#737670]">{rows.length}건</span>
      </div>
      {rows.length === 0 ? (
        <p className="mt-2 rounded-xl bg-[#f9f6ef] p-3 text-xs text-[#737670]">
          이 날짜에는 표시할 항목이 없어요.
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          {rows.map(row => (
            <ChildRow
              key={row.id}
              row={row}
              rule={ruleForOctoberRow(rules, row)}
              reporting={reporting === row.id}
              blocked={Boolean(reporting)}
              onReport={() => void onReport(row)}
            />
          ))}
        </div>
      )}
      {lifestyleRules.length > 0 && (
        <div className="mt-3 border-t border-black/8 pt-3">
          <p className="text-[10px] leading-4 text-[#737670]">
            생활 사건을 한 번 더 알릴 때는 새 회차로 남겨요. 여기서 패널티나
            보상은 정하지 않아요.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {lifestyleRules.map(rule => (
              <Button
                key={rule.id}
                type="button"
                size="sm"
                variant="outline"
                disabled={Boolean(reporting)}
                onClick={() => void onRepeatLifestyle(rule)}
              >
                {reporting === `new:${rule.id}` ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ClipboardCheck className="h-3.5 w-3.5" />
                )}
                {rule.code} 한 번 더 알리기
              </Button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function ChildRow({
  row,
  rule,
  reporting,
  blocked,
  onReport,
}: {
  row: OctoberRow;
  rule?: OctoberRule;
  reporting: boolean;
  blocked: boolean;
  onReport: () => void;
}) {
  const final = isOctoberConfirmed(row.state);
  const canReport = !row.self_reported && !final;
  const lifestyle = rule?.domain === "LIFESTYLE";
  return (
    <article className="rounded-2xl border border-black/8 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-[#f0edfa] px-2 py-1 text-[10px] font-bold text-[#4d2ddc]">
              {row.code}
            </span>
            <span
              className={`rounded-full px-2 py-1 text-[10px] font-semibold ${final ? "bg-[#e4f1eb] text-[#315f4d]" : "bg-[#f5f3ed] text-[#666963]"}`}
            >
              {octoberStateLabel(row.state)}
            </span>
          </div>
          <h5 className="mt-2 text-sm font-semibold">
            {ruleName(rule, row.code)}
          </h5>
        </div>
        {row.self_reported && !final && (
          <span className="text-[10px] font-semibold text-[#4d2ddc]">
            부모 확인 기다림
          </span>
        )}
      </div>
      <p className="mt-2 text-xs leading-5 text-[#666963]">{rule?.criteria}</p>
      {rule?.effects.length ? (
        <p className="mt-2 text-[11px] text-[#315f4d]">
          조건: {rule.effects.map(octoberEffectLabel).join(" · ")}
        </p>
      ) : null}
      {rule?.code === "Q-003" && (
        <p className="mt-2 rounded-lg bg-[#f5f3ed] p-2 text-[11px] leading-5 text-[#555852]">
          점수는 여기서 입력하거나 계산하지 않아요. 성취 조건만 보고, 부모가
          실제 성적을 확인해요.
        </p>
      )}
      {rule?.code === "L-013" && (
        <p className="mt-2 rounded-lg bg-[#f5f3ed] p-2 text-[11px] leading-5 text-[#555852]">
          약 기록이 비어 있다고 자동으로 결정하지 않아요. 부모가 나에게 직접
          물어 확인해요.
        </p>
      )}
      {row.reason && (
        <p className="mt-2 rounded-lg bg-[#edf7f3] p-2 text-[11px] text-[#315045]">
          부모 확인 메모: {row.reason}
        </p>
      )}
      {canReport ? (
        <Button
          type="button"
          className="mt-3 w-full rounded-xl bg-[#4d2ddc] text-white hover:bg-[#3d20c7]"
          disabled={blocked}
          onClick={onReport}
        >
          {reporting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ClipboardCheck className="h-4 w-4" />
          )}
          {lifestyle ? "사실 알려주기" : "했어요 알리기"}
        </Button>
      ) : (
        <p className="mt-3 flex items-center gap-1 text-xs font-semibold text-[#315f4d]">
          <Check className="h-4 w-4" />
          {final ? "부모가 확인한 결과예요." : "부모 확인을 기다리고 있어요."}
        </p>
      )}
      {lifestyle && !final && (
        <p className="mt-2 text-[10px] leading-4 text-[#737670]">
          이 화면에서 차감·패널티를 정하지 않아요. 부모가 한 사건씩 사실과
          사유를 확인해요.
        </p>
      )}
    </article>
  );
}
