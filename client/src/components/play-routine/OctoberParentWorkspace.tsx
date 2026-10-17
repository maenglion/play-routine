import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  closeOctoberSchoolWeek,
  confirmOctoberOccurrence,
  fulfillOctoberRight,
  getOctoberBoard,
  isOctoberConfirmed,
  newOctoberUuid,
  octoberAssetLabel,
  octoberBoardDisplayState,
  octoberBusinessDate,
  octoberDomainLabel,
  octoberEffectLabel,
  octoberReplayFingerprint,
  octoberRightLabel,
  octoberStateLabel,
  replayKeyFor,
  ruleForOctoberRow,
  submitOctoberOccurrence,
} from "@/lib/october-runtime-api";
import { makeOctoberPreviewBoard as makePreviewBoard } from "@/lib/october-preview-data";
import type {
  OctoberBoard,
  OctoberDomain,
  OctoberRight,
  OctoberRow,
  OctoberRule,
} from "@shared/october-runtime";
import {
  AlertTriangle,
  Check,
  CircleAlert,
  ClipboardCheck,
  Gift,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type ParentChild = { id: string; display_name: string; status: string };

export type OctoberParentWorkspaceProps = {
  familyId: string;
  timezone: string;
  children: ParentChild[];
  preview?: boolean;
};

type Decision = "PASS" | "NO_PASS" | "PENALTY" | "NO_VIOLATION";
type ReviewDraft = {
  reason: string;
  q001Passed: boolean;
  q001ProblemCount: string;
  q001Seconds: string;
  q003Scores: Array<{ subject: string; score: string }>;
  t005NoGiftedClass: boolean;
  l013VerifiedDirectly: boolean;
  t007Feedback: "" | "NO_PROBLEM" | "PROBLEM";
  t007Praised: boolean;
  incidentKey: string;
};

type OctoberPane = "board" | "rules" | "rights";

const paneHash: Record<OctoberPane, string> = {
  board: "#october-board",
  rules: "#october-rules",
  rights: "#october-rights",
};

function paneForHash(hash: string): OctoberPane {
  return (Object.entries(paneHash).find(([, value]) => value === hash)?.[0] ??
    "board") as OctoberPane;
}

const blankReview = (): ReviewDraft => ({
  reason: "",
  q001Passed: true,
  q001ProblemCount: "20",
  q001Seconds: "240",
  q003Scores: [
    { subject: "국어", score: "" },
    { subject: "수학", score: "" },
    { subject: "사회", score: "" },
    { subject: "과학", score: "" },
  ],
  t005NoGiftedClass: false,
  l013VerifiedDirectly: false,
  t007Feedback: "",
  t007Praised: false,
  incidentKey: "",
});

const domains: OctoberDomain[] = ["TASK", "QUEST", "LIFESTYLE"];

function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isIsoDate(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  );
}

function dateText(value: string) {
  if (!isIsoDate(value)) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(`${value}T00:00:00Z`));
}

function isSaturday(dayISO: string) {
  return new Date(`${dayISO}T00:00:00Z`).getUTCDay() === 6;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

function scrollToExisting(id: string) {
  if (typeof document === "undefined") return;
  const previousWorkspace = document.getElementById(
    "parent-previous-workspace"
  );
  if (previousWorkspace instanceof HTMLDetailsElement)
    previousWorkspace.open = true;
  const target = document.getElementById(id);
  if (!target) return;
  let ancestor: HTMLElement | null = target;
  while (ancestor) {
    if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
    ancestor = ancestor.parentElement;
  }
  target.scrollIntoView({ behavior: "smooth", block: "start" });
}

function reviewMetrics(
  rule: OctoberRule | undefined,
  draft: ReviewDraft
): Record<string, unknown> | null {
  if (rule?.code === "Q-001") {
    const problemCount = Number(draft.q001ProblemCount);
    const seconds = Number(draft.q001Seconds);
    if (!Number.isInteger(problemCount) || !Number.isFinite(seconds))
      return null;
    return { passed: draft.q001Passed, problemCount, seconds };
  }
  if (rule?.code === "Q-003") {
    const scores = draft.q003Scores
      .filter(item => item.subject.trim() || item.score.trim())
      .map(item => ({
        subject: item.subject.trim(),
        score: Number(item.score),
      }));
    if (
      !scores.length ||
      scores.some(item => !item.subject || !Number.isFinite(item.score))
    )
      return null;
    if (new Set(scores.map(item => item.subject)).size !== scores.length)
      return null;
    return { scores };
  }
  if (rule?.code === "T-005") return { noGiftedClass: draft.t005NoGiftedClass };
  if (rule?.code === "L-013")
    return { verifiedDirectly: draft.l013VerifiedDirectly };
  if (rule?.code === "L-015" || rule?.code === "L-016") {
    if (!isUuid(draft.incidentKey)) return null;
    return { incidentKey: draft.incidentKey };
  }
  if (rule?.code === "T-007") {
    if (!draft.t007Feedback) return null;
    return { feedback: draft.t007Feedback, praised: draft.t007Praised };
  }
  return {};
}

function shortRuleName(rule: OctoberRule | undefined, fallback: string) {
  return rule?.name || fallback;
}

/**
 * Parent-only board: it calls fixed RPCs only and never infers reward amounts.
 * The main dashboard owns placement and account authentication.
 */
export default function OctoberParentWorkspace({
  familyId,
  timezone,
  children,
  preview = false,
}: OctoberParentWorkspaceProps) {
  const usableChildren = useMemo(
    () => children.filter(child => child.status === "ACTIVE"),
    [children]
  );
  const [today, setToday] = useState(() => octoberBusinessDate(timezone));
  const [selectedChildId, setSelectedChildId] = useState(
    () => usableChildren[0]?.id ?? ""
  );
  const [day, setDay] = useState(() => octoberBusinessDate(timezone));
  const [board, setBoard] = useState<OctoberBoard | null>(
    preview ? makePreviewBoard(day) : null
  );
  const [loading, setLoading] = useState(!preview);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reviews, setReviews] = useState<Record<string, ReviewDraft>>({});
  const [activePane, setActivePane] = useState<OctoberPane>(() =>
    typeof window === "undefined" ? "board" : paneForHash(window.location.hash)
  );
  const [reviewRow, setReviewRow] = useState<OctoberRow | null>(null);
  const [schoolStart, setSchoolStart] = useState("");
  const [schoolEnd, setSchoolEnd] = useState("");
  const [fulfillReasons, setFulfillReasons] = useState<Record<string, string>>(
    {}
  );
  const [penaltyRow, setPenaltyRow] = useState<OctoberRow | null>(null);
  const requestId = useRef(0);
  const epoch = useRef(0);
  const mounted = useRef(true);
  const attempts = useRef(new Map<string, string>());
  const lifeSlots = useRef(new Map<string, string>());

  const selectedChild =
    usableChildren.find(child => child.id === selectedChildId) ??
    usableChildren[0];
  const displayState = octoberBoardDisplayState({
    loading,
    error: loadError,
    board,
  });
  const isLiveActionDisabled =
    !selectedChild || loading || Boolean(loadError) || Boolean(busy);

  const load = useCallback(async () => {
    const request = ++requestId.current;
    const activeEpoch = epoch.current;
    if (preview) {
      if (
        mounted.current &&
        activeEpoch === epoch.current &&
        request === requestId.current
      ) {
        setBoard(makePreviewBoard(day));
        setLoadError(null);
        setLoading(false);
      }
      return;
    }
    if (!familyId || !selectedChildId) {
      if (
        mounted.current &&
        activeEpoch === epoch.current &&
        request === requestId.current
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
      const next = await getOctoberBoard({
        familyId,
        childId: selectedChildId,
        date: day,
      });
      if (
        !mounted.current ||
        activeEpoch !== epoch.current ||
        request !== requestId.current
      )
        return;
      setBoard(next);
    } catch (error) {
      if (
        !mounted.current ||
        activeEpoch !== epoch.current ||
        request !== requestId.current
      )
        return;
      setBoard(null);
      setLoadError(errorText(error, "10월 운영표를 불러오지 못했습니다."));
    } finally {
      if (
        mounted.current &&
        activeEpoch === epoch.current &&
        request === requestId.current
      )
        setLoading(false);
    }
  }, [day, familyId, preview, selectedChildId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current += 1;
      requestId.current += 1;
    };
  }, []);

  useEffect(() => {
    const restorePaneFromHash = () =>
      setActivePane(paneForHash(window.location.hash));
    restorePaneFromHash();
    window.addEventListener("hashchange", restorePaneFromHash);
    return () => window.removeEventListener("hashchange", restorePaneFromHash);
  }, []);

  useEffect(() => {
    setSelectedChildId(current =>
      usableChildren.some(child => child.id === current)
        ? current
        : (usableChildren[0]?.id ?? "")
    );
  }, [usableChildren]);

  useEffect(() => {
    const tick = () => setToday(octoberBusinessDate(timezone));
    tick();
    const timer = window.setInterval(tick, 60_000);
    return () => window.clearInterval(timer);
  }, [timezone]);

  useEffect(() => {
    epoch.current += 1;
    requestId.current += 1;
    attempts.current.clear();
    lifeSlots.current.clear();
    setBoard(preview ? makePreviewBoard(day) : null);
    setReviews({});
    setSchoolStart("");
    setSchoolEnd("");
    setPenaltyRow(null);
    setReviewRow(null);
  }, [familyId, preview]);

  useEffect(() => {
    setReviewRow(null);
    setPenaltyRow(null);
  }, [selectedChildId, day]);

  useEffect(() => {
    void load();
    return () => {
      requestId.current += 1;
    };
  }, [load]);

  const draftFor = (row: OctoberRow) => reviews[row.id] ?? blankReview();
  const updateDraft = (row: OctoberRow, patch: Partial<ReviewDraft>) => {
    setReviews(current => ({
      ...current,
      [row.id]: { ...draftFor(row), ...patch },
    }));
  };

  const mutate = async (
    key: string,
    payload: unknown,
    action: () => Promise<unknown>
  ) => {
    if (preview) {
      setServerError(null);
      return true;
    }
    const fingerprint = octoberReplayFingerprint(key, payload);
    const replay = replayKeyFor(attempts.current, fingerprint);
    setBusy(key);
    try {
      await action();
      attempts.current.delete(fingerprint);
      setServerError(null);
      await load();
      return true;
    } catch (error) {
      setServerError(
        errorText(
          error,
          "서버 요청을 처리하지 못했습니다. 같은 내용으로 다시 시도해 주세요."
        )
      );
      return false;
    } finally {
      setBusy(null);
      // `replay` is intentionally retained on failures through attempts.current.
      void replay;
    }
  };

  const confirm = async (
    row: OctoberRow,
    decision: Decision,
    confirmedPenalty = false
  ): Promise<boolean> => {
    if (isLiveActionDisabled && !preview) return false;
    const rule = ruleForOctoberRow(board?.rules ?? [], row);
    const draft = draftFor(row);
    const reason = draft.reason.trim() || null;
    if (row.revision > 0 && !reason) {
      setServerError("정정(revision) 확인에는 변경 사유를 입력해 주세요.");
      return false;
    }
    if (decision === "PENALTY" && !reason) {
      setServerError(
        "차감 예정은 부모 사유를 입력한 뒤, 확인 대화상자에서 한 번 더 확정해야 합니다."
      );
      return false;
    }
    if (decision === "PENALTY" && !confirmedPenalty) {
      setPenaltyRow(row);
      setReviewRow(null);
      return false;
    }
    const metrics = reviewMetrics(rule, draft);
    if (metrics === null) {
      setServerError(
        rule?.code === "Q-003"
          ? "Q-003은 과목명과 점수를 입력하고 같은 과목을 중복하지 마세요. 구간·보상량은 서버가 판정합니다."
          : rule?.code === "L-015" || rule?.code === "L-016"
            ? "L-015/L-016은 동일 파손 사건 ID에 UUID를 입력하거나 새 ID를 만드세요."
            : rule?.code === "T-007"
              ? "학교 피드백을 0/1로 선택해 주세요. 칭찬은 별도 항목입니다."
              : "필수 확인값을 올바르게 입력해 주세요."
      );
      return false;
    }
    if (
      rule?.code === "T-005" &&
      decision === "PASS" &&
      isSaturday(row.date) &&
      !draft.t005NoGiftedClass
    ) {
      setServerError(
        "T-005 토요일 통과에는 영재원 수업이 없었다는 체크가 필요합니다."
      );
      return false;
    }
    if (
      rule?.code === "L-013" &&
      decision === "PENALTY" &&
      !draft.l013VerifiedDirectly
    ) {
      setServerError(
        "L-013 차감 예정에는 부모가 아이에게 직접 물어 확인했다는 체크가 필요합니다."
      );
      return false;
    }
    const payload = {
      familyId,
      childId: selectedChildId,
      ruleId: row.rule_id,
      date: row.date,
      decision,
      metrics,
      reason,
      slot: row.slot,
      expectedRevision: row.revision,
    };
    const fingerprint = octoberReplayFingerprint("confirm", payload);
    const eventKey = replayKeyFor(attempts.current, fingerprint);
    if (preview) {
      setBoard(current =>
        current
          ? {
              ...current,
              rows: current.rows.map(item =>
                item.id === row.id
                  ? {
                      ...item,
                      state: decision === "PENALTY" ? "PENALTY" : decision,
                      confirmed_at: new Date().toISOString(),
                      revision: item.revision + 1,
                      reason,
                      metrics,
                    }
                  : item
              ),
            }
          : current
      );
      setServerError(null);
      return true;
    }
    return mutate("confirm", payload, () =>
      confirmOctoberOccurrence({ ...payload, eventKey })
    );
  };

  const addLifestyleSlot = async (rule: OctoberRule) => {
    if (isLiveActionDisabled && !preview) return;
    const base = `${selectedChildId}:${day}:${rule.id}`;
    const slot = lifeSlots.current.get(base) ?? newOctoberUuid();
    lifeSlots.current.set(base, slot);
    const payload = {
      familyId,
      childId: selectedChildId,
      ruleId: rule.id,
      date: day,
      slot,
    };
    const fingerprint = octoberReplayFingerprint("submit-lifestyle", payload);
    const eventKey = replayKeyFor(attempts.current, fingerprint);
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
                  state: "UNCONFIRMED",
                  self_reported: false,
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
      lifeSlots.current.delete(base);
      return;
    }
    const ok = await mutate("submit-lifestyle", payload, () =>
      submitOctoberOccurrence({ ...payload, eventKey })
    );
    if (ok) lifeSlots.current.delete(base);
  };

  const closeSchoolPeriod = async () => {
    if (isLiveActionDisabled && !preview) return;
    if (
      !isIsoDate(schoolStart) ||
      !isIsoDate(schoolEnd) ||
      schoolStart >= schoolEnd
    ) {
      setServerError(
        "학교 기간은 실제 시작일과 종료일(종료일 미포함)을 직접 입력하고, 종료일을 시작일 뒤로 선택해 주세요."
      );
      return;
    }
    const payload = {
      familyId,
      childId: selectedChildId,
      start: schoolStart,
      end: schoolEnd,
    };
    const fingerprint = octoberReplayFingerprint("close-school-week", payload);
    const eventKey = replayKeyFor(attempts.current, fingerprint);
    if (preview) {
      setServerError(null);
      return;
    }
    await mutate("close-school-week", payload, () =>
      closeOctoberSchoolWeek({ ...payload, eventKey })
    );
  };

  const fulfillRight = async (right: OctoberRight) => {
    if (isLiveActionDisabled && !preview) return;
    if (right.status !== "ISSUED" || right.fulfilled_quantity >= right.quantity)
      return;
    const reason = fulfillReasons[right.id]?.trim() || "앱 밖 제공 완료 확인";
    const payload = { familyId, rightId: right.id, reason };
    const fingerprint = octoberReplayFingerprint("fulfill-right", payload);
    const eventKey = replayKeyFor(attempts.current, fingerprint);
    if (preview) {
      setBoard(current =>
        current
          ? {
              ...current,
              rights: current.rights.map(item =>
                item.id === right.id
                  ? { ...item, fulfilled_quantity: item.quantity }
                  : item
              ),
            }
          : current
      );
      setServerError(null);
      return;
    }
    await mutate("fulfill-right", payload, () =>
      fulfillOctoberRight({ ...payload, eventKey })
    );
  };

  const rowsFor = (domain: OctoberDomain) =>
    (board?.rows ?? []).filter(
      row => ruleForOctoberRow(board?.rules ?? [], row)?.domain === domain
    );
  const lifestyleRules = (board?.rules ?? []).filter(
    rule => rule.domain === "LIFESTYLE"
  );

  return (
    <section
      id="october-runtime"
      className="rounded-[28px] bg-white p-5 sm:p-8"
      aria-labelledby="october-parent-title"
    >
      <div className="flex flex-col gap-5 border-b border-black/10 pb-6 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-[11px] font-bold tracking-[.16em] text-[#4d2ddc]">
            OCTOBER ACTUAL RUNTIME
          </p>
          <h2
            id="october-parent-title"
            className="mt-1 text-2xl font-bold tracking-[-.04em]"
          >
            10월 운영표
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[#666963]">
            부모가 사실을 확인하고 권리를 따로 이행 기록합니다. 표시된
            분·원·쿠페이는 잔액이나 실제 송금이 아닙니다.
          </p>
        </div>
        <div className="rounded-2xl bg-[#cde5de]/65 px-3 py-2 text-xs leading-5 text-[#315f4d]">
          <ShieldCheck className="mr-1 inline h-4 w-4" />
          가족 시간대 {timezone}
          <br />
          수행일 기준으로 조회
        </div>
      </div>

      {preview && (
        <div
          role="status"
          className="mt-5 rounded-2xl border border-[#c7baed] bg-[#f3efff] p-4 text-xs leading-5 text-[#51447f]"
        >
          미리보기 데이터입니다. 실제 Supabase RPC를 호출하지 않고, 화면에서만
          확인 상태를 바꿉니다.
        </div>
      )}

      <nav
        aria-label="부모 운영 메뉴"
        className="sticky top-0 z-20 -mx-5 mt-5 overflow-x-auto border-y border-black/8 bg-white/95 px-5 py-2 backdrop-blur sm:-mx-8 sm:px-8"
      >
        <div className="flex min-w-max gap-2 text-sm font-semibold">
          <button
            type="button"
            aria-current={activePane === "board" ? "page" : undefined}
            onClick={() => {
              setActivePane("board");
              window.location.hash = paneHash.board;
            }}
            className={`rounded-full px-4 py-2 ${activePane === "board" ? "bg-[#4d2ddc] text-white" : "bg-[#f0edfa] text-[#4d2ddc]"}`}
          >
            운영표
          </button>
          <button
            type="button"
            aria-current={activePane === "rules" ? "page" : undefined}
            onClick={() => {
              setActivePane("rules");
              window.location.hash = paneHash.rules;
            }}
            className={`rounded-full px-4 py-2 ${activePane === "rules" ? "bg-[#4d2ddc] text-white" : "bg-[#f0edfa] text-[#4d2ddc]"}`}
          >
            규정
          </button>
          <button
            type="button"
            aria-current={activePane === "rights" ? "page" : undefined}
            onClick={() => {
              setActivePane("rights");
              window.location.hash = paneHash.rights;
            }}
            className={`rounded-full px-4 py-2 ${activePane === "rights" ? "bg-[#315f4d] text-white" : "bg-[#cde5de] text-[#315f4d]"}`}
          >
            보상·원장
          </button>
          <button
            type="button"
            onClick={() => scrollToExisting("parent-reinforcers")}
            className="rounded-full bg-[#f5f3ed] px-4 py-2 text-[#4e504c]"
          >
            강화물
          </button>
          <button
            type="button"
            onClick={() => scrollToExisting("parent-family-settings")}
            className="rounded-full bg-[#f5f3ed] px-4 py-2 text-[#4e504c]"
          >
            설정
          </button>
        </div>
      </nav>

      <div className="mt-6 grid gap-4 rounded-2xl bg-[#f9f6ef] p-4 sm:grid-cols-[1fr_1fr_auto]">
        <div className="space-y-1">
          <Label htmlFor="october-parent-child" className="text-xs">
            자녀
          </Label>
          <select
            id="october-parent-child"
            value={selectedChildId}
            disabled={loading || !!busy}
            onChange={event => setSelectedChildId(event.target.value)}
            className="flex h-10 w-full rounded-md border border-input bg-white px-3 text-sm"
          >
            <option value="">자녀를 선택하세요</option>
            {usableChildren.map(child => (
              <option key={child.id} value={child.id}>
                {child.display_name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="october-parent-day" className="text-xs">
            수행일
          </Label>
          <Input
            id="october-parent-day"
            type="date"
            max={today}
            value={day}
            onChange={event => {
              if (event.target.value && event.target.value <= today)
                setDay(event.target.value);
            }}
            disabled={loading || !!busy}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          className="self-end"
          disabled={loading || !!busy}
          onClick={() => void load()}
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          새로고침
        </Button>
      </div>

      {serverError && (
        <div
          role="alert"
          className="mt-4 flex gap-3 rounded-2xl border border-[#e7b6ac] bg-[#fbebe8] p-4 text-sm leading-6 text-[#8b3e34]"
        >
          <CircleAlert className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <strong>서버 요청을 다시 확인해 주세요.</strong>
            <p>{serverError}</p>
            <p className="mt-1 text-xs">
              입력을 바꾸지 않고 다시 누르면 같은 요청 키로 재시도합니다. 입력을
              고치면 새 요청 키를 사용합니다.
            </p>
          </div>
        </div>
      )}

      {displayState === "loading" ? (
        <p role="status" className="mt-7 text-sm text-[#737670]">
          10월 운영표를 불러오는 중…
        </p>
      ) : displayState === "error" ? (
        <div
          role="alert"
          className="mt-6 rounded-2xl bg-[#fbebe8] p-5 text-sm text-[#8b3e34]"
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
      ) : !selectedChild ? (
        <div className="mt-6 rounded-2xl bg-[#f5f3ed] p-5 text-sm text-[#737670]">
          연결된 활성 자녀를 선택하면 10월 운영표를 볼 수 있어요.
        </div>
      ) : displayState === "no-plan" ? (
        <div className="mt-6 rounded-2xl bg-[#f5f3ed] p-5 text-sm text-[#737670]">
          <strong className="block text-[#333a44]">새 10월 규정 없음</strong>
          <p className="mt-1">
            이 가족·자녀·수행일에는 활성 10월 운영 계획을 찾지 못했습니다. 기존
            기록은 바꾸지 않습니다.
          </p>
        </div>
      ) : (
        <>
          <div
            id="october-board"
            style={{ display: activePane === "board" ? undefined : "none" }}
            className="mt-7"
          >
            <div className="grid grid-cols-3 gap-2 sm:gap-3 [&>div]:p-2 sm:[&>div]:p-4 [&_strong]:text-2xl sm:[&_strong]:text-3xl [&_span]:text-[10px] sm:[&_span]:text-xs">
              <div className="rounded-2xl bg-[#d4cfe7] p-4">
                <span className="text-xs font-semibold">확인 대기</span>
                <strong className="mt-2 block text-3xl">
                  {board?.summary.unconfirmed ?? 0}
                </strong>
                <span className="text-xs text-[#5b46a3]">
                  생활 추가 사건은 별도 확인
                </span>
              </div>
              <div className="rounded-2xl bg-[#cde5de] p-4">
                <span className="text-xs font-semibold">보상 예정</span>
                <strong className="mt-2 block text-3xl">
                  {board?.summary.pending_minutes ?? 0}
                  <small className="ml-1 text-sm">분</small>
                </strong>
                <span className="text-xs text-[#315f4d]">
                  권리 발행 전·잔액 아님
                </span>
              </div>
              <div className="rounded-2xl bg-[#f0e5c9] p-4">
                <span className="text-xs font-semibold">차감 예정</span>
                <strong className="mt-2 block text-3xl">
                  {board?.summary.penalty_minutes ?? 0}
                  <small className="ml-1 text-sm">분</small>
                </strong>
                <span className="text-xs text-[#69521f]">
                  부모 확인 뒤에만 권리
                </span>
              </div>
            </div>
            <section className="mt-7" aria-labelledby="october-board-heading">
              <h3 id="october-board-heading" className="text-xl font-bold">
                {dateText(day)} 운영 확인
              </h3>
              <p className="mt-1 text-xs text-[#737670]">
                최초 일반 보상 PASS만 바로 확인할 수 있습니다. 특수
                규칙·차감·정정은 행을 선택해 근거를 입력합니다.
              </p>
              <OperationalBoardTable
                rows={board?.rows ?? []}
                rules={board?.rules ?? []}
                disabled={isLiveActionDisabled}
                busy={busy === "confirm"}
                onQuickPass={row => void confirm(row, "PASS")}
                onOpenReview={row => setReviewRow(row)}
                onAddLifestyle={addLifestyleSlot}
              />
            </section>
          </div>

          <section
            id="october-rules"
            style={{ display: activePane === "rules" ? undefined : "none" }}
            className="mt-7"
            aria-labelledby="october-rules-heading"
          >
            <h3 id="october-rules-heading" className="text-xl font-bold">
              규정과 조건
            </h3>
            <p className="mt-1 text-xs leading-5 text-[#737670]">
              규칙 코드가 10월 시행규칙의 안정된 식별자입니다. 보상 구간·수량은
              이 화면이 계산하지 않고 서버가 판정합니다.
            </p>
            <div className="mt-4 max-h-[56vh] overflow-auto rounded-2xl border border-black/10">
              <table className="min-w-[880px] w-full border-separate border-spacing-0 text-left text-xs">
                <thead className="sticky top-0 z-10 bg-[#f9f6ef] text-[#555852]">
                  <tr>
                    <th className="border-b border-black/10 px-3 py-3 font-bold">
                      코드
                    </th>
                    <th className="border-b border-black/10 px-3 py-3 font-bold">
                      종류
                    </th>
                    <th className="border-b border-black/10 px-3 py-3 font-bold">
                      활동·조건
                    </th>
                    <th className="border-b border-black/10 px-3 py-3 font-bold">
                      일정·한도
                    </th>
                    <th className="border-b border-black/10 px-3 py-3 font-bold">
                      효과
                    </th>
                    <th className="border-b border-black/10 px-3 py-3 font-bold">
                      확인 대기
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(board?.rules ?? []).map(rule => (
                    <tr key={rule.id} className="align-top hover:bg-[#fcfbf8]">
                      <td className="border-b border-black/5 px-3 py-3 font-bold text-[#4d2ddc]">
                        {rule.code}
                      </td>
                      <td className="border-b border-black/5 px-3 py-3">
                        {octoberDomainLabel(rule.domain)}
                      </td>
                      <td className="border-b border-black/5 px-3 py-3">
                        <strong className="block text-sm">{rule.name}</strong>
                        <span className="mt-1 block leading-5 text-[#666963]">
                          {rule.criteria}
                        </span>
                      </td>
                      <td className="border-b border-black/5 px-3 py-3 leading-5">
                        {rule.schedule_label}
                        <br />
                        {rule.daily_limit === null
                          ? rule.period
                          : `${rule.period} · 하루 ${rule.daily_limit}회`}
                      </td>
                      <td className="border-b border-black/5 px-3 py-3 text-[#315f4d]">
                        {rule.code === "T-007" && board?.plan?.school_asset === "COUPAY_KRW"
                          ? "학교 스티커 0~4개: 무보상 · 5~7개: 쿠페이 총 10,000원 · 8개 이상: 쿠페이 총 15,000원 (5→8 차액 5,000원)"
                          : rule.effects.length
                          ? rule.effects.map(octoberEffectLabel).join(" · ")
                          : "학교 스티커"}
                      </td>
                      <td className="border-b border-black/5 px-3 py-3 text-[#8b5b15]">
                        {(board?.plan?.school_asset === "COUPAY_KRW" && rule.code === "T-007"
                          ? rule.pending_fields.filter(field => !field.includes("자산 최신 확인"))
                          : rule.pending_fields).length
                          ? (board?.plan?.school_asset === "COUPAY_KRW" && rule.code === "T-007"
                              ? rule.pending_fields.filter(field => !field.includes("자산 최신 확인"))
                              : rule.pending_fields).join(" · ")
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section
            id="october-rights"
            style={{ display: activePane === "rights" ? undefined : "none" }}
            className="mt-7"
            aria-labelledby="october-rights-heading"
          >
            <div className="flex items-start gap-3">
              <Gift className="mt-0.5 h-5 w-5 text-[#4d2ddc]" />
              <div>
                <h3 id="october-rights-heading" className="text-xl font-bold">
                  보상 권리·이행 원장
                </h3>
                <p className="mt-1 text-xs leading-5 text-[#737670]">
                  발행(ISSUED)과 앱 밖 이행 기록은 다릅니다. 실제 송금·충전·차감
                  또는 사용 가능한 잔액을 뜻하지 않습니다.
                </p>
              </div>
            </div>
            <div className="mt-4 space-y-3">
              {(board?.rights ?? []).length === 0 ? (
                <p className="rounded-2xl bg-[#f5f3ed] p-4 text-sm text-[#737670]">
                  이 자녀에게 발행된 10월 권리가 없습니다.
                </p>
              ) : (
                (board?.rights ?? []).map(right => (
                  <RightCard
                    key={right.id}
                    right={right}
                    reason={fulfillReasons[right.id] ?? ""}
                    disabled={isLiveActionDisabled}
                    busy={busy === "fulfill-right"}
                    onReason={value =>
                      setFulfillReasons(current => ({
                        ...current,
                        [right.id]: value,
                      }))
                    }
                    onFulfill={() => void fulfillRight(right)}
                  />
                ))
              )}
            </div>
            <section
              className="mt-8 rounded-2xl border border-[#d8cfae] bg-[#fcf9ef] p-5"
              aria-labelledby="october-school-heading"
            >
              <h3 id="october-school-heading" className="font-bold">
                학교 기간 마감
              </h3>
              <p className="mt-1 text-xs leading-5 text-[#625a40]">
                기간은 부모가 직접 선택합니다. 시작일 이상, 종료일{" "}
                <strong>미포함</strong> [start, end) 범위입니다. 월요일 시작을
                임의로 가정하지 않고, 미확인·겹친 기간은 서버가 거절합니다.
              </p>
              {board?.plan?.school_asset === "PENDING" && (
                <p className="mt-3 rounded-xl bg-[#f0e5c9] p-3 text-xs text-[#69521f]">
                  학교 보상 자산은 확인 대기입니다. 쿠페이 10,000/15,000원 또는
                  미디어 300/480분 중 확정 전에는, 기간 자료만 기록하고 보상권은
                  발행하지 않습니다.
                </p>
              )}
              {board?.plan?.school_asset === "COUPAY_KRW" && (
                <p className="mt-3 rounded-xl bg-[#e4f1eb] p-3 text-xs leading-5 text-[#315f4d]">
                  <strong>확정 쿠페이 보상표:</strong> 기본·칭찬 스티커 합계
                  0~4개는 무보상, 5~7개는 쿠페이 총 10,000원, 8개 이상은 총
                  15,000원입니다. 5개에서 8개로 올라가면 총액 차액 5,000원만
                  안내하며, 스티커 효과와 금융 권리는 서로 섞지 않습니다.
                </p>
              )}
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <div className="space-y-1">
                  <Label htmlFor="october-school-start" className="text-xs">
                    시작일
                  </Label>
                  <Input
                    id="october-school-start"
                    type="date"
                    value={schoolStart}
                    onChange={event => setSchoolStart(event.target.value)}
                    disabled={isLiveActionDisabled}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="october-school-end" className="text-xs">
                    종료일 (미포함)
                  </Label>
                  <Input
                    id="october-school-end"
                    type="date"
                    min={schoolStart || undefined}
                    value={schoolEnd}
                    onChange={event => setSchoolEnd(event.target.value)}
                    disabled={isLiveActionDisabled}
                  />
                </div>
                <Button
                  type="button"
                  className="self-end bg-[#4d2ddc] text-white hover:bg-[#3d20c7]"
                  disabled={isLiveActionDisabled || !schoolStart || !schoolEnd}
                  onClick={() => void closeSchoolPeriod()}
                >
                  {busy === "close-school-week" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ClipboardCheck className="h-4 w-4" />
                  )}{" "}
                  학교 기간 마감
                </Button>
              </div>
            </section>
          </section>
        </>
      )}

      <Dialog
        open={!!reviewRow}
        onOpenChange={open => {
          if (!open) setReviewRow(null);
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto bg-white shadow-none">
          <DialogHeader>
            <DialogTitle>행 확인·정정</DialogTitle>
            <DialogDescription>
              특수 조건, 차감 예정, 또는 이전 확인의 정정은 이 사건 한 건만
              검토합니다.
            </DialogDescription>
          </DialogHeader>
          {reviewRow && (
            <DomainColumn
              domain={
                ruleForOctoberRow(board?.rules ?? [], reviewRow)?.domain ??
                "TASK"
              }
              rows={[reviewRow]}
              rules={board?.rules ?? []}
              reviews={reviews}
              draftFor={draftFor}
              updateDraft={updateDraft}
              busy={busy}
              disabled={isLiveActionDisabled}
              showLifestyleAdds={false}
              onConfirm={async (row, decision) => {
                const done = await confirm(row, decision);
                if (done) setReviewRow(null);
              }}
              onAddLifestyle={addLifestyleSlot}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!penaltyRow}
        onOpenChange={open => {
          if (!open) setPenaltyRow(null);
        }}
      >
        <DialogContent className="max-w-md bg-white shadow-none">
          <DialogHeader>
            <DialogTitle>차감 예정으로 확정할까요?</DialogTitle>
            <DialogDescription>
              이 작업은 여러 항목을 한꺼번에 처리하지 않습니다. 해당 사건
              하나에만 부모 사유와 함께 차감 예정 권리를 기록합니다. 자녀
              자기보고만으로 최종 확정하지 않습니다.
            </DialogDescription>
          </DialogHeader>
          {penaltyRow && (
            <div className="rounded-xl bg-[#fbebe8] p-3 text-sm text-[#8b3e34]">
              <strong>{penaltyRow.code}</strong> ·{" "}
              {shortRuleName(
                ruleForOctoberRow(board?.rules ?? [], penaltyRow),
                penaltyRow.code
              )}
              <p className="mt-1">사유: {draftFor(penaltyRow).reason.trim()}</p>
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPenaltyRow(null)}
              disabled={busy === "confirm"}
            >
              돌아가기
            </Button>
            <Button
              type="button"
              className="bg-[#a7493e] text-white hover:bg-[#8f382f]"
              disabled={busy === "confirm"}
              onClick={() => {
                const row = penaltyRow;
                setPenaltyRow(null);
                if (row) void confirm(row, "PENALTY", true);
              }}
            >
              {busy === "confirm" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <AlertTriangle className="h-4 w-4" />
              )}
              이 사건만 차감 예정 확정
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function OperationalBoardTable({
  rows,
  rules,
  disabled,
  busy,
  onQuickPass,
  onOpenReview,
  onAddLifestyle,
}: {
  rows: OctoberRow[];
  rules: OctoberRule[];
  disabled: boolean;
  busy: boolean;
  onQuickPass: (row: OctoberRow) => void;
  onOpenReview: (row: OctoberRow) => void;
  onAddLifestyle: (rule: OctoberRule) => Promise<void>;
}) {
  const lifestyleRules = rules.filter(rule => rule.domain === "LIFESTYLE");
  return (
    <div className="mt-4 max-h-[56vh] overflow-auto rounded-2xl border border-black/10">
      <table className="min-w-[940px] w-full border-separate border-spacing-0 text-left text-xs">
        <thead className="sticky top-0 z-10 bg-[#f9f6ef] text-[#555852]">
          <tr>
            <th className="sticky left-0 z-20 border-b border-black/10 bg-[#f9f6ef] px-3 py-3 font-bold">
              코드
            </th>
            <th className="border-b border-black/10 px-3 py-3 font-bold">
              종류
            </th>
            <th className="border-b border-black/10 px-3 py-3 font-bold">
              활동
            </th>
            <th className="border-b border-black/10 px-3 py-3 font-bold">
              회차 한도
            </th>
            <th className="border-b border-black/10 px-3 py-3 font-bold">
              효과
            </th>
            <th className="border-b border-black/10 px-3 py-3 font-bold">
              상태
            </th>
            <th className="border-b border-black/10 px-3 py-3 font-bold">
              부모 확인
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => {
            const rule = ruleForOctoberRow(rules, row);
            const special = [
              "Q-001",
              "Q-003",
              "T-005",
              "T-007",
              "L-013",
            ].includes(row.code);
            const penalty = rule?.effect_kind === "PENALTY";
            const canQuickPass =
              !isOctoberConfirmed(row.state) &&
              !special &&
              !penalty &&
              row.revision === 0;
            return (
              <tr key={row.id} className="align-top hover:bg-[#fcfbf8]">
                <td className="sticky left-0 z-[1] border-b border-black/5 bg-white px-3 py-3 font-bold text-[#4d2ddc]">
                  {row.code}
                </td>
                <td className="border-b border-black/5 px-3 py-3">
                  {rule ? octoberDomainLabel(rule.domain) : "—"}
                </td>
                <td className="border-b border-black/5 px-3 py-3">
                  <strong className="block text-sm">
                    {shortRuleName(rule, row.code)}
                  </strong>
                  <span className="mt-1 block text-[#737670]">
                    {row.slot === "daily"
                      ? "기본 회차"
                      : `추가 회차 ${row.slot.slice(0, 8)}`}
                    {row.self_reported ? " · 자녀 알림" : ""}
                  </span>
                </td>
                <td className="border-b border-black/5 px-3 py-3">
                  {rule?.daily_limit === null || !rule
                    ? (rule?.period ?? "—")
                    : `${rule.period} · ${rule.daily_limit}회`}
                </td>
                <td className="border-b border-black/5 px-3 py-3 text-[#315f4d]">
                  {row.effects.length
                    ? row.effects.map(octoberEffectLabel).join(" · ")
                    : rule?.effects.length
                      ? rule.effects.map(octoberEffectLabel).join(" · ")
                      : rule?.effect_kind === "SCHOOL"
                        ? "학교 스티커"
                        : "—"}
                </td>
                <td className="border-b border-black/5 px-3 py-3">
                  {octoberStateLabel(row.state)}
                  {row.revision > 0 ? ` · 정정 ${row.revision}` : ""}
                </td>
                <td className="border-b border-black/5 px-3 py-3">
                  {isOctoberConfirmed(row.state) && row.revision === 0 ? (
                    <span className="font-semibold text-[#315f4d]">확인됨</span>
                  ) : canQuickPass ? (
                    <Button
                      type="button"
                      size="sm"
                      className="h-8 bg-[#4d2ddc] text-white hover:bg-[#3d20c7]"
                      disabled={disabled || busy}
                      onClick={() => onQuickPass(row)}
                    >
                      {busy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Check className="h-3.5 w-3.5" />
                      )}{" "}
                      PASS
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8"
                      disabled={disabled || busy}
                      onClick={() => onOpenReview(row)}
                    >
                      확인·정정
                    </Button>
                  )}
                  {rule?.domain === "LIFESTYLE" && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="mt-1 h-7"
                      disabled={disabled || busy}
                      onClick={() => void onAddLifestyle(rule)}
                    >
                      <Plus className="h-3 w-3" />
                      회차 추가
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-6 text-center text-[#737670]">
                이 날짜에는 표시할 운영 항목이 없습니다.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function DomainColumn({
  domain,
  rows,
  rules,
  reviews,
  draftFor,
  updateDraft,
  busy,
  disabled,
  showLifestyleAdds = true,
  onConfirm,
  onAddLifestyle,
}: {
  domain: OctoberDomain;
  rows: OctoberRow[];
  rules: OctoberRule[];
  reviews: Record<string, ReviewDraft>;
  draftFor: (row: OctoberRow) => ReviewDraft;
  updateDraft: (row: OctoberRow, patch: Partial<ReviewDraft>) => void;
  busy: string | null;
  disabled: boolean;
  showLifestyleAdds?: boolean;
  onConfirm: (row: OctoberRow, decision: Decision) => Promise<void>;
  onAddLifestyle: (rule: OctoberRule) => Promise<void>;
}) {
  const lifestyleRules =
    domain === "LIFESTYLE"
      ? rules.filter(rule => rule.domain === "LIFESTYLE")
      : [];
  return (
    <section
      className="min-w-0 rounded-2xl bg-[#f9f6ef] p-4"
      aria-label={`${octoberDomainLabel(domain)} 규칙`}
    >
      <div className="flex items-center justify-between">
        <h4 className="font-bold">{octoberDomainLabel(domain)}</h4>
        <span className="text-xs text-[#737670]">{rows.length}건</span>
      </div>
      <div className="mt-3 space-y-3">
        {rows.length === 0 && (
          <p className="rounded-xl bg-white p-3 text-xs text-[#737670]">
            이 날짜에는 표시할 항목이 없습니다.
          </p>
        )}
        {rows.map(row => (
          <ReviewCard
            key={row.id}
            row={row}
            rule={ruleForOctoberRow(rules, row)}
            draft={reviews[row.id] ?? draftFor(row)}
            disabled={disabled}
            busy={busy === "confirm"}
            onDraft={patch => updateDraft(row, patch)}
            onConfirm={decision => void onConfirm(row, decision)}
          />
        ))}
      </div>
      {showLifestyleAdds &&
        domain === "LIFESTYLE" &&
        lifestyleRules.length > 0 && (
          <div className="mt-4 border-t border-black/8 pt-4">
            <p className="text-xs leading-5 text-[#666963]">
              반복 생활 사건은 새 UUID 회차로 추가합니다. 먼저 미확인 사건으로
              남고, 부모가 각 회차를 따로 확인합니다.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {lifestyleRules.map(rule => (
                <Button
                  key={rule.id}
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => void onAddLifestyle(rule)}
                >
                  <Plus className="h-3.5 w-3.5" />
                  {rule.code} 회차 추가
                </Button>
              ))}
            </div>
          </div>
        )}
    </section>
  );
}

function ReviewCard({
  row,
  rule,
  draft,
  disabled,
  busy,
  onDraft,
  onConfirm,
}: {
  row: OctoberRow;
  rule?: OctoberRule;
  draft: ReviewDraft;
  disabled: boolean;
  busy: boolean;
  onDraft: (patch: Partial<ReviewDraft>) => void;
  onConfirm: (decision: Decision) => void;
}) {
  const confirmed = isOctoberConfirmed(row.state);
  const canEdit = !confirmed || row.revision > 0;
  const isPenaltyRule = rule?.effect_kind === "PENALTY";
  const t003Pending =
    rule?.code === "T-003" &&
    (rule.effects.some(effect => effect.quantity === null) ||
      rule.pending_fields.length > 0);
  return (
    <article className="rounded-xl bg-white p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-[#f0edfa] px-2 py-1 text-[10px] font-bold text-[#4d2ddc]">
              {row.code}
            </span>
            <span className="rounded-full bg-[#f5f3ed] px-2 py-1 text-[10px] font-semibold text-[#555852]">
              {octoberStateLabel(row.state)}
            </span>
          </div>
          <h5 className="mt-2 text-sm font-semibold">
            {shortRuleName(rule, row.code)}
          </h5>
          <p className="mt-1 text-[11px] text-[#737670]">
            {row.slot === "daily"
              ? "예정 회차"
              : `추가 회차 ${row.slot.slice(0, 8)}`}{" "}
            · 인식 {row.recognized_count}회
          </p>
        </div>
        {row.self_reported && (
          <span className="text-[10px] font-semibold text-[#315f4d]">
            자녀 알림
          </span>
        )}
      </div>
      {rule?.criteria && (
        <p className="mt-2 text-xs leading-5 text-[#666963]">{rule.criteria}</p>
      )}
      {row.reason && (
        <p className="mt-2 rounded-lg bg-[#f5f3ed] p-2 text-xs text-[#555852]">
          부모 사유: {row.reason}
        </p>
      )}
      {canEdit && (
        <ReviewInputs
          row={row}
          rule={rule}
          draft={draft}
          disabled={disabled || busy}
          onDraft={onDraft}
        />
      )}
      {t003Pending && (
        <p className="mt-2 rounded-lg bg-[#f0e5c9] p-2 text-xs text-[#69521f]">
          보상 수량이 미정입니다. 사실 확인은 가능하지만 이 화면에서 임의
          지급·보상 확정은 하지 않습니다.
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {confirmed && row.revision === 0 ? (
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-[#315f4d]">
            <Check className="h-4 w-4" />
            {octoberStateLabel(row.state)} · revision {row.revision}
          </span>
        ) : (
          <>
            {isPenaltyRule ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled || busy}
                  onClick={() => onConfirm("PENALTY")}
                >
                  차감 예정
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={disabled || busy}
                  onClick={() => onConfirm("NO_VIOLATION")}
                >
                  위반 아님
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  size="sm"
                  className="bg-[#4d2ddc] text-white hover:bg-[#3d20c7]"
                  disabled={disabled || busy}
                  onClick={() => onConfirm("PASS")}
                >
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )}{" "}
                  PASS 확인
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled || busy}
                  onClick={() => onConfirm("NO_PASS")}
                >
                  NO PASS
                </Button>
              </>
            )}
            {row.revision > 0 && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={disabled || busy}
                onClick={() =>
                  onConfirm(isPenaltyRule ? "NO_VIOLATION" : "NO_PASS")
                }
              >
                정정 반영
              </Button>
            )}
          </>
        )}
      </div>
    </article>
  );
}

function ReviewInputs({
  row,
  rule,
  draft,
  disabled,
  onDraft,
}: {
  row: OctoberRow;
  rule?: OctoberRule;
  draft: ReviewDraft;
  disabled: boolean;
  onDraft: (patch: Partial<ReviewDraft>) => void;
}) {
  return (
    <div className="mt-3 space-y-2 border-t border-black/8 pt-3">
      {rule?.code === "Q-001" && (
        <>
          <p className="text-xs font-semibold text-[#4d2ddc]">
            Q-001 부모 확인값
          </p>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs">
              문제 수
              <Input
                type="number"
                min="0"
                value={draft.q001ProblemCount}
                disabled={disabled}
                onChange={event =>
                  onDraft({ q001ProblemCount: event.target.value })
                }
              />
            </label>
            <label className="text-xs">
              초
              <Input
                type="number"
                min="0"
                value={draft.q001Seconds}
                disabled={disabled}
                onChange={event => onDraft({ q001Seconds: event.target.value })}
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={draft.q001Passed}
              disabled={disabled}
              onChange={event => onDraft({ q001Passed: event.target.checked })}
            />
            20문제·240초 이내를 부모가 통과로 확인
          </label>
        </>
      )}
      {rule?.code === "Q-003" && (
        <>
          <p className="text-xs font-semibold text-[#4d2ddc]">
            Q-003 과목별 점수
          </p>
          {draft.q003Scores.map((item, index) => (
            <div key={index} className="grid grid-cols-[1fr_88px] gap-2">
              <Input
                aria-label={`Q-003 과목 ${index + 1}`}
                value={item.subject}
                disabled={disabled}
                onChange={event =>
                  onDraft({
                    q003Scores: draft.q003Scores.map((value, itemIndex) =>
                      itemIndex === index
                        ? { ...value, subject: event.target.value }
                        : value
                    ),
                  })
                }
                placeholder="과목명"
              />
              <Input
                aria-label={`Q-003 점수 ${index + 1}`}
                type="number"
                min="0"
                max="100"
                value={item.score}
                disabled={disabled}
                onChange={event =>
                  onDraft({
                    q003Scores: draft.q003Scores.map((value, itemIndex) =>
                      itemIndex === index
                        ? { ...value, score: event.target.value }
                        : value
                    ),
                  })
                }
                placeholder="점수"
              />
            </div>
          ))}
          <p className="text-[10px] leading-4 text-[#737670]">
            동일 과목은 중복할 수 없습니다. 3·4과목 구간의 보상 수량은 앱이
            계산하지 않고 서버가 판정합니다.
          </p>
        </>
      )}
      {rule?.code === "T-005" && isSaturday(row.date) && (
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={draft.t005NoGiftedClass}
            disabled={disabled}
            onChange={event =>
              onDraft({ t005NoGiftedClass: event.target.checked })
            }
          />
          해당 토요일에 영재원 수업이 없었음을 확인
        </label>
      )}
      {rule?.code === "T-007" && (
        <>
          <label className="block text-xs">
            선생님 피드백 (기본 0/1)
            <select
              value={draft.t007Feedback}
              disabled={disabled}
              onChange={event =>
                onDraft({
                  t007Feedback: event.target
                    .value as ReviewDraft["t007Feedback"],
                })
              }
              className="mt-1 flex h-9 w-full rounded-md border border-input bg-white px-2 text-sm"
            >
              <option value="">선택</option>
              <option value="NO_PROBLEM">문제 없음 (1)</option>
              <option value="PROBLEM">문제 있음 (0)</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={draft.t007Praised}
              disabled={disabled}
              onChange={event => onDraft({ t007Praised: event.target.checked })}
            />
            칭찬 받음 (별도 1)
          </label>
          {draft.t007Feedback === "PROBLEM" && draft.t007Praised && (
            <p className="rounded-lg bg-[#f0e5c9] p-2 text-[11px] text-[#69521f]">
              문제 있음+칭찬은 정책 미정이라 서버에서 재검토 상태로 처리될 수
              있습니다.
            </p>
          )}
        </>
      )}
      {rule?.code === "L-013" && (
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={draft.l013VerifiedDirectly}
            disabled={disabled}
            onChange={event =>
              onDraft({ l013VerifiedDirectly: event.target.checked })
            }
          />
          부모가 아이에게 직접 물어 복용 여부를 확인 (위반 확정은 19:30 이후)
        </label>
      )}
      {(rule?.code === "L-015" || rule?.code === "L-016") && (
        <div className="space-y-2">
          <Label htmlFor={`incident-${row.id}`} className="text-xs">
            동일 파손 사건 ID (두 규칙이면 같은 ID)
          </Label>
          <div className="flex gap-2">
            <Input
              id={`incident-${row.id}`}
              value={draft.incidentKey}
              disabled={disabled}
              onChange={event => onDraft({ incidentKey: event.target.value })}
              placeholder="엄격 UUID"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => onDraft({ incidentKey: newOctoberUuid() })}
            >
              새 사건 ID 만들기
            </Button>
          </div>
          <p className="text-[10px] leading-4 text-[#737670]">
            같은 파손을 두 규칙에서 확인하면 같은 ID로 서버 재검토 상태를
            남깁니다.
          </p>
        </div>
      )}
      {
        <label className="block text-xs">
          부모 확인 사유{" "}
          <span className="font-normal text-[#737670]">
            (NO PASS는 선택, 차감 예정은 필수)
          </span>
          <Textarea
            value={draft.reason}
            disabled={disabled}
            onChange={event => onDraft({ reason: event.target.value })}
            className="mt-1 min-h-16"
            placeholder="확인한 사실 또는 차감 사유"
          />
        </label>
      }
    </div>
  );
}

function RightCard({
  right,
  reason,
  disabled,
  busy,
  onReason,
  onFulfill,
}: {
  right: OctoberRight;
  reason: string;
  disabled: boolean;
  busy: boolean;
  onReason: (value: string) => void;
  onFulfill: () => void;
}) {
  const pendingDeduction = right.quantity < 0;
  const available =
    !pendingDeduction &&
    right.status === "ISSUED" &&
    right.fulfilled_quantity < right.quantity;
  return (
    <article className="rounded-2xl border border-black/10 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-[#f0edfa] px-2 py-1 text-[10px] font-bold text-[#4d2ddc]">
              {right.code}
            </span>
            <h4 className="font-semibold">{right.rule_name}</h4>
            <span
              className={`rounded-full px-2 py-1 text-[10px] font-bold ${right.status === "ISSUED" ? "bg-[#e4f1eb] text-[#315f4d]" : "bg-[#f0e5c9] text-[#69521f]"}`}
            >
              {right.status === "ISSUED"
                ? "발행됨"
                : right.status === "REVIEW_REQUIRED"
                  ? "재검토"
                  : "무효"}
            </span>
          </div>
          <p className="mt-2 text-xs text-[#555852]">
            {octoberRightLabel(right)}
          </p>
          <p className="mt-1 text-[11px] text-[#737670]">
            발행일 {right.source_date} · 앱 밖 이행 기록만 남깁니다.{" "}
            {octoberAssetLabel(right.asset)}은 실제 잔액이 아닙니다.
          </p>
        </div>
      </div>
      {pendingDeduction && (
        <p className="mt-3 rounded-xl bg-[#f0e5c9] p-3 text-xs text-[#69521f]">
          차감예정·원장정책미확정 — 실제 이행은 기록할 수 없습니다.
        </p>
      )}
      {available && (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <Input
            aria-label={`${right.rule_name} 이행 메모`}
            value={reason}
            disabled={disabled || busy}
            onChange={event => onReason(event.target.value)}
            placeholder="앱 밖 이행 메모 (선택)"
          />
          <Button
            type="button"
            variant="outline"
            disabled={disabled || busy}
            onClick={onFulfill}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            이행 기록
          </Button>
        </div>
      )}
      {!available && (
        <p className="mt-3 rounded-xl bg-[#f5f3ed] p-3 text-xs text-[#737670]">
          {pendingDeduction
            ? "차감 예정은 이행·자동 차감을 하지 않습니다. 원장 정책 확정 전 검토로 남깁니다."
            : right.status === "REVIEW_REQUIRED"
              ? "재검토 권리는 이행 처리할 수 없습니다."
              : "이 권리는 더 이행할 수 있는 수량이 없습니다."}
        </p>
      )}
    </article>
  );
}
