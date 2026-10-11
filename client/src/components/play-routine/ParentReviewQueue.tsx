import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { familyBusinessDate, summarizeActivityDay, type ActivityDayRow } from "@/lib/activity-flow";
import { supabase } from "@/lib/supabase";
import { AlertTriangle, CheckCircle2, CircleAlert, Clock3, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

export type ParentReviewChild = {
  id: string;
  display_name: string;
  status: string;
};

export type ParentReviewQueueProps = {
  familyId: string;
  timezone: string;
  children: ParentReviewChild[];
  preview?: boolean;
  /** Receives exact rows for the currently selected child/date after every load. */
  onChanged?: (rows: ActivityDayRow[]) => void;
};

type ReviewDraft = {
  score: string;
  pass: boolean | null;
  reason: string;
};

type IdempotencyAttempt = {
  fingerprint: string;
  key: string;
};

const categoryLabels: Record<string, string> = {
  DAILY_STUDY: "매일 공부",
  SPECIAL_SCHEDULE: "특별 일정",
  LIFE_HABIT: "생활 습관",
  OTHER: "기타",
};

const previewRows: ActivityDayRow[] = [
  {
    occurrence_id: "preview-review-missing",
    assignment_id: "preview-assignment-one",
    policy_rule_id: "preview-rule-one",
    business_date: "2099-01-02",
    activity_name: "수학 문제 풀이",
    description: "문제를 풀고 확인을 부탁합니다.",
    category_code: "DAILY_STUDY",
    metric_label: "부모가 채점한 정답률",
    reward_minutes: 30,
    penalty_minutes: 0,
    child_reported: false,
    verification_status: "MISSING",
    parent_score: null,
    outcome_code: null,
    confirmed_minutes: null,
    revision: 0,
  },
  {
    occurrence_id: "preview-review-held",
    assignment_id: "preview-assignment-two",
    policy_rule_id: "preview-rule-two",
    business_date: "2099-01-02",
    activity_name: "책상 정리하기",
    description: "물건을 제자리에 둡니다.",
    category_code: "LIFE_HABIT",
    metric_label: "정리 완료율",
    reward_minutes: 10,
    penalty_minutes: 10,
    child_reported: true,
    verification_status: "HELD",
    parent_score: null,
    outcome_code: null,
    confirmed_minutes: null,
    revision: 2,
  },
];

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

function statusLabel(status: ActivityDayRow["verification_status"]) {
  if (status === "CONFIRMED") return "확인 완료";
  if (status === "HELD") return "검토 대기";
  return "기록 없음";
}

function statusClass(status: ActivityDayRow["verification_status"]) {
  if (status === "CONFIRMED") return "bg-[#e4f1eb] text-[#315f4d]";
  if (status === "HELD") return "bg-[#f0edfa] text-[#5b46a3]";
  return "bg-[#efefec] text-[#62656a]";
}

function draftFingerprint(row: ActivityDayRow, draft: ReviewDraft) {
  const assessment = row.measurement_kind === "PASS_FAIL" ? String(draft.pass) : draft.score.trim();
  return `${row.occurrence_id}|${row.revision}|${assessment}|${draft.reason.trim()}`;
}

function defaultDraft(row: ActivityDayRow): ReviewDraft {
  return {
    score: typeof row.parent_score === "number" && Number.isFinite(row.parent_score) ? String(row.parent_score) : "",
    pass: row.measurement_kind === "PASS_FAIL" && typeof row.parent_score === "number"
      ? row.parent_score === 100
      : null,
    reason: row.parent_reason ?? "",
  };
}

function isNetworkFailure(error: unknown) {
  if (error instanceof TypeError) return true;
  const value = error as { code?: string; status?: number; message?: string } | null;
  if (!value) return false;
  return value.status === 0 || /network|fetch|failed to fetch|load failed/i.test(value.message ?? "");
}

function isRevisionConflict(error: unknown) {
  const value = error as { code?: string; message?: string } | null;
  return Boolean(value && (value.code === "40001" || /revision|concurrent|conflict|stale/i.test(value.message ?? "")));
}

function errorMessage(error: unknown, fallback: string) {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = String((error as { message?: unknown }).message ?? "").trim();
    if (message) return message;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

function outcomeLabel(row: ActivityDayRow) {
  if (row.measurement_kind === "PASS_FAIL") return row.parent_score === 100 ? "문제없음 PASS" : "확인 필요";
  if (row.outcome_code === "REWARD") return "보상 예정";
  if (row.outcome_code === "PENALTY") return "차감 검토";
  if (row.outcome_code === "NO_REWARD" || row.outcome_code === "NEUTRAL") return "보상·차감 없음";
  return "결과 확인 필요";
}

/**
 * Parent-only review surface. It never guesses a score or applies a ledger
 * effect: a parent must submit a finite 0–100 score and a reason for each
 * confirmation/edit, and the database owns revision and family checks.
 */
export default function ParentReviewQueue({
  familyId,
  timezone,
  children,
  preview = false,
  onChanged,
}: ParentReviewQueueProps) {
  const today = useMemo(() => familyBusinessDate(timezone), [timezone]);
  const activeChildren = useMemo(() => children.filter(child => child.status === "ACTIVE"), [children]);
  const [childId, setChildId] = useState("");
  const [businessDate, setBusinessDate] = useState(today);
  const [rows, setRows] = useState<ActivityDayRow[]>(preview ? previewRows : []);
  const [loading, setLoading] = useState(!preview);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, ReviewDraft>>({});
  const [conflictedId, setConflictedId] = useState<string | null>(null);
  const attempts = useRef(new Map<string, IdempotencyAttempt>());
  const loadGeneration = useRef(0);
  const submitting = useRef(false);
  const selectionRef = useRef("");
  const onChangedRef = useRef(onChanged);

  const selectionKey = `${familyId}:${childId}:${businessDate}`;
  selectionRef.current = selectionKey;
  onChangedRef.current = onChanged;

  useEffect(() => {
    setBusinessDate(current => (current > today ? today : current));
  }, [today]);

  useEffect(() => {
    setChildId(current => activeChildren.some(child => child.id === current) ? current : (activeChildren[0]?.id ?? ""));
  }, [activeChildren]);

  const load = useCallback(async () => {
    const request = ++loadGeneration.current;
    if (preview) {
      const nextRows = previewRows.map(row => ({ ...row, business_date: businessDate }));
      if (request !== loadGeneration.current) return;
      setRows(nextRows);
      setLoadError(null);
      setLoading(false);
      onChangedRef.current?.(nextRows);
      return;
    }
    if (!childId || !familyId) {
      if (request !== loadGeneration.current) return;
      setRows([]);
      setLoadError(null);
      setLoading(false);
      onChangedRef.current?.([]);
      return;
    }

    setLoading(true);
    setLoadError(null);
    try {
      const { data, error } = await supabase.rpc("list_activity_day", {
        p_child_profile_id: childId,
        p_business_date: businessDate,
      });
      if (error) throw error;
      if (request !== loadGeneration.current) return;
      const nextRows = (data ?? []) as ActivityDayRow[];
      setRows(nextRows);
      setConflictedId(null);
      setDrafts(current => Object.fromEntries(Object.entries(current).filter(([occurrenceId]) => nextRows.some(row => row.occurrence_id === occurrenceId))));
      onChangedRef.current?.(nextRows);
    } catch (error) {
      if (request !== loadGeneration.current) return;
      setRows([]);
      setLoadError(errorMessage(error, "활동 기록을 불러오지 못했습니다."));
      onChangedRef.current?.([]);
    } finally {
      if (request === loadGeneration.current) setLoading(false);
    }
  }, [businessDate, childId, familyId, preview]);

  useEffect(() => {
    void load();
    return () => { loadGeneration.current += 1; };
  }, [load]);

  const updateDraft = (row: ActivityDayRow, patch: Partial<ReviewDraft>) => {
    setDrafts(current => ({
      ...current,
      [row.occurrence_id]: { ...(current[row.occurrence_id] ?? defaultDraft(row)), ...patch },
    }));
  };

  const submitVerification = async (row: ActivityDayRow) => {
    if (submitting.current) return;
    const submitSelection = selectionRef.current;
    const isPassRule = row.measurement_kind === "PASS_FAIL";
    if (preview) {
      const draft = drafts[row.occurrence_id] ?? defaultDraft(row);
      const score = isPassRule ? (draft.pass ? 100 : 0) : Number(draft.score);
      const reason = draft.reason.trim();
      if (isPassRule && draft.pass === null) {
        toast.error("문제없음 PASS 또는 확인 필요를 선택해 주세요.");
        return;
      }
      if (!isPassRule && (!draft.score.trim() || !Number.isFinite(score) || score < 0 || score > 100)) {
        toast.error("부모 확인 점수는 0~100 사이의 유한한 숫자로 입력해 주세요.");
        return;
      }
      if (!reason) {
        toast.error("확인 근거 또는 정정 이유를 입력해 주세요.");
        return;
      }
      setRows(current => current.map(item => item.occurrence_id === row.occurrence_id ? {
        ...item,
        verification_status: "CONFIRMED",
        parent_score: score,
        parent_reason: reason,
        parent_verified_at: new Date().toISOString(),
        revision: item.revision + 1,
      } : item));
      const nextRows = rows.map(item => item.occurrence_id === row.occurrence_id ? {
        ...item,
        verification_status: "CONFIRMED" as const,
        parent_score: score,
        parent_reason: reason,
        parent_verified_at: new Date().toISOString(),
        revision: item.revision + 1,
      } : item);
      onChangedRef.current?.(nextRows);
      toast.message("미리보기에서는 부모 확인을 저장하지 않습니다.");
      return;
    }
    if (conflictedId === row.occurrence_id) {
      toast.error("다른 확인 내용이 반영되었습니다. 새로고침 후 다시 검토해 주세요.");
      return;
    }

    const draft = drafts[row.occurrence_id] ?? defaultDraft(row);
    const score = isPassRule ? (draft.pass ? 100 : 0) : Number(draft.score);
    const reason = draft.reason.trim();
    if (isPassRule && draft.pass === null) {
      toast.error("문제없음 PASS 또는 확인 필요를 선택해 주세요.");
      return;
    }
    if (!isPassRule && (!draft.score.trim() || !Number.isFinite(score) || score < 0 || score > 100)) {
      toast.error("부모 확인 점수는 0~100 사이의 유한한 숫자로 입력해 주세요.");
      return;
    }
    if (!reason) {
      toast.error("확인 근거 또는 정정 이유를 입력해 주세요.");
      return;
    }

    const fingerprint = draftFingerprint(row, draft);
    const previousAttempt = attempts.current.get(row.occurrence_id);
    const idempotencyKey = previousAttempt?.fingerprint === fingerprint
      ? previousAttempt.key
      : crypto.randomUUID();
    attempts.current.set(row.occurrence_id, { fingerprint, key: idempotencyKey });

    submitting.current = true;
    setSubmittingId(row.occurrence_id);
    try {
      const { error } = isPassRule
        ? await supabase.rpc("verify_activity_pass", {
          p_occurrence_id: row.occurrence_id,
          p_pass: draft.pass,
          p_reason: reason,
          p_expected_revision: row.revision,
          p_idempotency_key: idempotencyKey,
        })
        : await supabase.rpc("verify_activity_occurrence", {
          p_occurrence_id: row.occurrence_id,
          p_score: score,
          p_reason: reason,
          p_expected_revision: row.revision,
          p_idempotency_key: idempotencyKey,
        });
      if (error) throw error;
      attempts.current.delete(row.occurrence_id);
      setDrafts(current => {
        const { [row.occurrence_id]: _submitted, ...rest } = current;
        return rest;
      });
      if (selectionRef.current === submitSelection) await load();
      toast.success(isPassRule ? (draft.pass ? "문제없음 PASS를 기록했습니다." : "확인 필요를 기록했습니다.") : row.verification_status === "CONFIRMED" ? "점수 정정을 기록했습니다." : "부모 확인을 기록했습니다.");
    } catch (error) {
      if (isRevisionConflict(error)) {
        setConflictedId(row.occurrence_id);
        toast.error("다른 부모 확인으로 내용이 바뀌었습니다. 새로고침 후 다시 검토해 주세요.");
      } else if (isNetworkFailure(error)) {
        toast.error("연결 문제로 확인 결과를 알 수 없습니다. 같은 내용으로 다시 누르면 같은 요청으로 확인합니다.");
      } else {
        // Keep this key for an explicit same-payload retry; a changed score/reason receives a new key.
        toast.error(errorMessage(error, "부모 확인을 저장하지 못했습니다."));
      }
    } finally {
      submitting.current = false;
      setSubmittingId(null);
    }
  };

  const summary = useMemo(() => summarizeActivityDay(rows), [rows]);

  return (
    <section className="rounded-[28px] bg-white p-6 shadow-[0_16px_48px_rgba(51,58,68,.08)] sm:p-8" aria-labelledby="parent-review-queue-title">
      <div className="flex flex-col gap-4 border-b border-black/8 pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold text-[#4d2ddc]">PARENT REVIEW</p>
          <h2 id="parent-review-queue-title" className="mt-1 text-2xl font-bold tracking-[-0.04em]">자녀 활동 확인</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[#747670]">
            자녀의 체크는 유보 상태입니다. 부모가 직접 관찰했거나 기록을 검토한 뒤 확인 결과와 근거를 남겨 주세요. PASS 약속은 문제없음 PASS 또는 확인 필요만 기록합니다.
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-2xl bg-[#edf7f3] px-3 py-2 text-xs leading-5 text-[#315045]">
          <ShieldCheck className="h-4 w-4 shrink-0" />
          부모 확인 전 자동 PASS·보상·차감 없음
        </div>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
        <div className="space-y-2">
          <Label htmlFor="review-child">자녀</Label>
          <select id="review-child" value={childId} disabled={loading || Boolean(submittingId) || activeChildren.length === 0} onChange={event => setChildId(event.target.value)} className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
            {activeChildren.length === 0 ? <option value="">활성 자녀가 없습니다</option> : activeChildren.map(child => <option key={child.id} value={child.id}>{child.display_name}</option>)}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="review-business-date">수행일</Label>
          <Input id="review-business-date" type="date" max={today} value={businessDate} disabled={loading || Boolean(submittingId)} onChange={event => { if (event.target.value && event.target.value <= today) setBusinessDate(event.target.value); }} />
        </div>
        <Button type="button" variant="outline" disabled={loading || Boolean(submittingId)} onClick={() => void load()}><RefreshCw className="h-4 w-4" /> 새로고침</Button>
      </div>
      <p className="mt-3 text-xs leading-5 text-[#777a74]">{dateLabel(businessDate)}의 수행 기록을 봅니다. 늦게 확인해도 사실과 평가는 이 수행일에 남고, 현재는 원장 정산과 연결하지 않습니다.</p>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl bg-[#f0edfa] p-4"><span className="text-xs font-semibold text-[#5b46a3]">확인 대기</span><strong className="mt-2 block text-2xl tracking-[-0.05em]">{summary.held + summary.missing}</strong><p className="mt-1 text-xs text-[#777a74]">총 {summary.total}건 중</p></div>
        <div className="rounded-2xl bg-[#e4f1eb] p-4"><span className="text-xs font-semibold text-[#315f4d]">부모 확인</span><strong className="mt-2 block text-2xl tracking-[-0.05em]">{summary.confirmed}</strong><p className="mt-1 text-xs text-[#5c7166]">자녀 보고 {summary.reported}건</p></div>
        <div className="rounded-2xl bg-[#f5f3ed] p-4"><span className="text-xs font-semibold text-[#62656a]">확인된 예정분</span><strong className="mt-2 block text-2xl tracking-[-0.05em]">{summary.positiveMinutes}분</strong><p className="mt-1 text-xs text-[#777a74]">아직 사용 불가 · 정산 미연결</p></div>
      </div>

      <div className="mt-7 border-t border-black/8 pt-6">
        {loading ? <div className="flex items-center justify-center rounded-2xl bg-[#f5f3ed] px-4 py-10 text-sm text-[#777a74]"><Loader2 className="mr-2 h-4 w-4 animate-spin" />활동 기록을 불러오는 중</div> : loadError ? (
          <div role="alert" className="rounded-2xl bg-red-50 p-4 text-sm leading-6 text-red-800"><strong>목록을 불러오지 못했습니다.</strong><p className="mt-1">{loadError}</p><Button type="button" variant="outline" className="mt-3" onClick={() => void load()}><RefreshCw className="h-4 w-4" /> 다시 불러오기</Button></div>
        ) : activeChildren.length === 0 ? (
          <div className="rounded-2xl bg-[#f5f3ed] px-4 py-7 text-center text-sm text-[#777a74]">확인할 현재 활성 자녀가 없습니다.</div>
        ) : rows.length === 0 ? (
          <div className="rounded-2xl bg-[#f5f3ed] px-4 py-7 text-center text-sm leading-6 text-[#777a74]">이 날짜에 생성된 활동이 없습니다. 게시된 규칙을 자녀에게 배정하면 수행일에 활동이 나타납니다.</div>
        ) : (
          <div className="space-y-4">
            {rows.map(row => {
              const draft = drafts[row.occurrence_id] ?? defaultDraft(row);
              const isPassRule = row.measurement_kind === "PASS_FAIL";
              const isConfirmed = row.verification_status === "CONFIRMED";
              const reviewing = submittingId === row.occurrence_id;
              const mayNeedPenaltyReview = !isPassRule && !isConfirmed && row.penalty_minutes > 0;
              const isConflicted = conflictedId === row.occurrence_id;
              return <article key={row.occurrence_id} className="rounded-2xl border border-black/8 p-4 sm:p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-[#f5f3ed] px-2.5 py-1 text-[10px] font-bold text-[#62656a]">{categoryLabels[row.category_code] ?? row.category_code}</span><span className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${statusClass(row.verification_status)}`}>{statusLabel(row.verification_status)}</span>{row.child_reported && <span className="text-[11px] font-medium text-[#5b46a3]">자녀가 했다고 알림</span>}</div><h3 className="mt-3 text-lg font-bold tracking-[-0.035em]">{row.activity_name}</h3>{row.description && <p className="mt-1 text-sm leading-6 text-[#5d605b]">{row.description}</p>}<p className="mt-3 text-xs leading-5 text-[#777a74]">확인 기준: {row.metric_label}</p></div>
                  {isConfirmed ? <CheckCircle2 className="h-5 w-5 shrink-0 text-[#315f4d]" aria-label="확인 완료" /> : <Clock3 className="h-5 w-5 shrink-0 text-[#5b46a3]" aria-label="검토 대기" />}
                </div>

                {mayNeedPenaltyReview && <div className="mt-4 rounded-xl bg-[#fff4e9] p-3 text-xs leading-5 text-[#7d4a22]"><div className="flex gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><p><strong>검토 안내</strong><br />이 활동의 규칙에는 차감 구간이 있을 수 있습니다. 실제 결과는 서버가 부모 점수로 판정하며, 아래 확인 전에는 보상·차감이 확정되지 않습니다. 현재 원장·실제 차감은 연결되지 않았습니다.</p></div></div>}

                {isConfirmed ? <div className="mt-4 rounded-xl bg-[#edf7f3] p-3 text-xs leading-5 text-[#315045]"><strong>{outcomeLabel(row)}</strong>{!isPassRule && typeof row.parent_score === "number" && Number.isFinite(row.parent_score) ? <span> · 부모 점수 {row.parent_score} / 100</span> : null}{typeof row.confirmed_minutes === "number" && Number.isFinite(row.confirmed_minutes) ? <p className="mt-1">{isPassRule && row.parent_score === 0 ? "문제 있음으로 확인되어 보상은 없습니다. 자동 패널티는 없습니다." : `확인된 ${row.confirmed_minutes > 0 ? `+${row.confirmed_minutes}` : row.confirmed_minutes}분은 `}<strong>{isPassRule && row.parent_score === 0 ? "실제 정산과 무관한 확인 결과" : "예정 / 아직 사용 불가 / 정산 미연결"}</strong> 상태입니다.</p> : <p className="mt-1">확인 결과는 <strong>예정 / 아직 사용 불가 / 정산 미연결</strong> 상태입니다.</p>}{row.parent_reason ? <p className="mt-2 rounded-lg bg-white/60 px-3 py-2"><strong>자녀에게 보이는 확인 이유:</strong> {row.parent_reason}</p> : null}</div> : <div className="mt-4 rounded-xl bg-[#f5f3ed] p-3 text-xs leading-5 text-[#62656a]">{isPassRule ? "자녀 체크·미확인·연락 없음만으로는 PASS가 되지 않습니다. 부모가 그날 문제없음을 확인하면 PASS, 문제가 있으면 확인 필요로 남깁니다." : row.verification_status === "MISSING" ? "자녀 체크가 없어도 직접 관찰한 사실이라면 부모가 확인할 수 있습니다. 체크가 없다는 이유만으로 차감하지 않습니다." : "자녀가 알려준 내용은 아직 유보입니다. 부모가 확인하기 전에는 보상·차감이 확정되지 않습니다."}</div>}

                <div className="mt-5 grid gap-4 border-t border-black/8 pt-4 sm:grid-cols-[150px_minmax(0,1fr)]">
                  <div className="space-y-2">{isPassRule ? <><Label>부모 확인 결과</Label><div className="grid gap-2"><Button type="button" variant={draft.pass === true ? "default" : "outline"} disabled={reviewing || isConflicted} onClick={() => updateDraft(row, { pass: true })}>문제없음 PASS</Button><Button type="button" variant={draft.pass === false ? "default" : "outline"} disabled={reviewing || isConflicted} onClick={() => updateDraft(row, { pass: false })}>문제 있음 · 확인 필요</Button></div></> : <><Label htmlFor={`score-${row.occurrence_id}`}>부모 점수 <span className="font-normal text-muted-foreground">(0~100)</span></Label><Input id={`score-${row.occurrence_id}`} type="number" min="0" max="100" step="any" inputMode="decimal" value={draft.score} disabled={reviewing || isConflicted} onChange={event => updateDraft(row, { score: event.target.value })} placeholder="점수 입력" /></>}</div>
                  <div className="space-y-2"><Label htmlFor={`reason-${row.occurrence_id}`}>자녀에게 보여줄 확인 이유 <span className="text-[#9b453f]">(필수)</span></Label><Textarea id={`reason-${row.occurrence_id}`} value={draft.reason} disabled={reviewing || isConflicted} onChange={event => updateDraft(row, { reason: event.target.value })} placeholder={isPassRule ? draft.pass === false ? "무슨 확인이 더 필요한지 자녀가 이해되게 적어 주세요." : "문제없음 PASS를 확인한 근거를 자녀가 이해되게 적어 주세요." : isConfirmed ? "점수를 정정하는 이유를 자녀에게 이해되게 적어 주세요." : row.verification_status === "MISSING" ? "직접 관찰한 사실을 자녀에게 이해되게 적어 주세요." : "확인한 내용과 근거를 자녀에게 이해되게 적어 주세요."} maxLength={1000} /><p className="text-xs leading-5 text-[#777a74]">비공개 메모가 아닙니다. 자녀가 확인 결과와 함께 볼 수 있는 설명을 적어 주세요.</p></div>
                </div>
                {isConflicted ? <div role="alert" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-red-50 p-3 text-xs leading-5 text-red-800"><span><CircleAlert className="mr-1 inline h-4 w-4 align-text-bottom" />다른 확인으로 revision이 바뀌었습니다. 자동 재시도하지 않았습니다.</span><Button type="button" variant="outline" size="sm" onClick={() => void load()}><RefreshCw className="h-4 w-4" /> 새로고침</Button></div> : <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><p className="text-xs leading-5 text-[#777a74]">{isPassRule ? "PASS 여부와 자녀에게 보여줄 이유는 새 확인 사건으로 기록됩니다. 확인 필요는 보상 없음이며 자동 패널티가 아닙니다." : "점수와 자녀에게 보여줄 이유는 새 확인 사건으로 기록됩니다. 저장 후 서버의 최신 결과를 다시 불러옵니다."}</p><Button type="button" disabled={Boolean(submittingId)} onClick={() => void submitVerification(row)} className="shrink-0 rounded-xl bg-[#333a44] text-white hover:bg-[#232932]">{reviewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}{isPassRule ? isConfirmed ? "PASS 확인 정정 기록" : "PASS 확인 기록" : isConfirmed ? "점수 정정 기록" : row.verification_status === "MISSING" ? "직접 관찰로 확인" : "부모 확인"}</Button></div>}
              </article>;
            })}
          </div>
        )}
      </div>
    </section>
  );
}
