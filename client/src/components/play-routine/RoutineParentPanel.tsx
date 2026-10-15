import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { familyBusinessDate, nextBusinessDate } from "@/lib/activity-flow";
import {
  canCloseRoutinePeriod,
  categoryLabel,
  iconLabel,
  isRealIsoDate,
  isoWeekdayForDate,
  newRoutineUuid,
  periodLabel,
  stableRoutineJson,
  unitLabel,
  validateRoutineAssignmentDates,
} from "@/lib/routine-v2-form";
import { supabase } from "@/lib/supabase";
import type {
  RoutineAssignmentRow,
  RoutineDayRow,
  RoutineEntitlementRow,
  RoutineRuleRow,
} from "@shared/routine-v2";
import {
  CalendarCheck2,
  CheckCircle2,
  CircleAlert,
  ClipboardCheck,
  Gift,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Star,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

export type RoutineParentChild = {
  id: string;
  display_name: string;
  status: string;
};
export type RoutineParentPanelProps = {
  familyId: string;
  timezone: string;
  children: RoutineParentChild[];
  preview?: boolean;
  refreshKey?: number;
};

type AssignmentForm = {
  childId: string;
  ruleId: string;
  startsOn: string;
  endsOn: string;
  repeat: "DAILY" | "ONCE";
  weekdays: number[];
};
type VerificationForm = {
  score: string;
  pass: boolean | null;
  praise: boolean;
  reason: string;
};
type Attempt = { fingerprint: string; key: string };

const weekdays = [
  { value: 1, label: "월" },
  { value: 2, label: "화" },
  { value: 3, label: "수" },
  { value: 4, label: "목" },
  { value: 5, label: "금" },
  { value: 6, label: "토" },
  { value: 7, label: "일" },
] as const;

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isNetworkFailure(error: unknown) {
  const value = error as { status?: number; message?: string } | null;
  return (
    error instanceof TypeError ||
    value?.status === 0 ||
    /network|fetch|failed to fetch|load failed/i.test(value?.message ?? "")
  );
}

function isConflict(error: unknown) {
  const value = error as { code?: string; message?: string } | null;
  return (
    value?.code === "40001" ||
    /revision|concurrent|conflict|stale/i.test(value?.message ?? "")
  );
}

function latestRules(rows: RoutineRuleRow[]) {
  const bySubject = new Map<string, RoutineRuleRow>();
  [...rows]
    .sort(
      (left, right) =>
        right.version - left.version ||
        right.effective_from.localeCompare(left.effective_from)
    )
    .forEach(row => {
      if (!bySubject.has(row.subject_ref_id))
        bySubject.set(row.subject_ref_id, row);
    });
  return Array.from(bySubject.values());
}

function defaultVerification(row: RoutineDayRow): VerificationForm {
  return {
    score:
      typeof row.score === "number" && Number.isFinite(row.score)
        ? String(row.score)
        : "",
    pass: row.flow === "DAILY" ? row.pass : null,
    praise: row.flow === "DAILY" ? row.praise : false,
    reason: row.parent_reason ?? "",
  };
}

const previewRule: RoutineRuleRow = {
  id: "preview-rule",
  family_id: "preview",
  subject_ref_id: "preview-subject",
  name: "저녁 책 읽기",
  effective_from: "2099-01-01",
  version: 1,
  payload: {
    schemaVersion: 1,
    flow: "DAILY",
    name: "저녁 책 읽기",
    category: "DAILY_STUDY",
    childLabel: "책 읽기",
    criteria: "부모가 읽은 내용 한 가지를 함께 확인합니다.",
    stickerIcon: "STAMP",
    measurement: "STICKER",
    period: "WEEKLY",
    penaltyLimit: null,
    penaltyMinutes: 0,
    tiers: [],
  },
};
const previewAssignments: RoutineAssignmentRow[] = [
  {
    id: "preview-assignment",
    rule_id: "preview-rule",
    child_profile_id: "preview-child",
    child_name: "자녀",
    rule_name: "저녁 책 읽기",
    flow: "DAILY",
    starts_on: "2099-01-01",
    ends_on: null,
    weekdays: [1, 2, 3, 4, 5],
    repeat: "DAILY",
  },
];
const previewDays: RoutineDayRow[] = [
  {
    id: "preview-day",
    assignment_id: "preview-assignment",
    rule_id: "preview-rule",
    business_date: "2099-01-02",
    name: "저녁 책 읽기",
    child_label: "책 읽기",
    criteria: "부모가 읽은 내용 한 가지를 함께 확인합니다.",
    category: "DAILY_STUDY",
    flow: "DAILY",
    sticker_icon: "STAMP",
    period: "WEEKLY",
    period_start: "2098-12-29",
    period_end: "2099-01-04",
    period_closed: false,
    child_reported: true,
    verification_status: "HELD",
    score: null,
    pass: null,
    praise: false,
    stickers: null,
    sticker_total: 3,
    revision: 1,
    parent_reason: null,
    parent_verified_at: null,
    penalty_minutes: null,
    tiers: [],
  },
];
const previewEntitlements: RoutineEntitlementRow[] = [
  {
    id: "preview-entitlement",
    child_profile_id: "preview-child",
    rule_id: "preview-rule",
    rule_name: "저녁 책 읽기",
    condition_label: "주간 기본",
    source_date: "2099-01-04",
    period_start: "2098-12-29",
    period_end: "2099-01-04",
    name: "자유 시간",
    unit: "MIN",
    unit_label: "분",
    amount: 30,
    text: "",
    status: "AVAILABLE",
    created_at: "2099-01-05T00:00:00Z",
    fulfilled_at: null,
  },
];

/** v2 전용 부모 운영 화면. 기존 시간 원장과 섞지 않고 배정·사실 확인·권리 이행을 분리한다. */
export default function RoutineParentPanel({
  familyId,
  timezone,
  children,
  preview = false,
  refreshKey,
}: RoutineParentPanelProps) {
  const activeChildren = useMemo(
    () => children.filter(child => child.status === "ACTIVE"),
    [children]
  );
  const [familyToday, setFamilyToday] = useState(() =>
    familyBusinessDate(timezone)
  );
  const tomorrow = useMemo(() => nextBusinessDate(familyToday), [familyToday]);
  const [rules, setRules] = useState<RoutineRuleRow[]>(
    preview ? [previewRule] : []
  );
  const [assignments, setAssignments] = useState<RoutineAssignmentRow[]>(
    preview ? previewAssignments : []
  );
  const [days, setDays] = useState<RoutineDayRow[]>(preview ? previewDays : []);
  const [entitlements, setEntitlements] = useState<RoutineEntitlementRow[]>(
    preview ? previewEntitlements : []
  );
  const [selectedChildId, setSelectedChildId] = useState(
    () => activeChildren[0]?.id ?? ""
  );
  const [businessDate, setBusinessDate] = useState(familyToday);
  const [assignmentForm, setAssignmentForm] = useState<AssignmentForm>({
    childId: "",
    ruleId: "",
    startsOn: tomorrow,
    endsOn: "",
    repeat: "DAILY",
    weekdays: [1, 2, 3, 4, 5],
  });
  const [verification, setVerification] = useState<
    Record<string, VerificationForm>
  >({});
  const [loading, setLoading] = useState(!preview);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creatingAssignment, setCreatingAssignment] = useState(false);
  const [pendingVerificationId, setPendingVerificationId] = useState<
    string | null
  >(null);
  const [pendingPeriodId, setPendingPeriodId] = useState<string | null>(null);
  const [pendingEntitlementId, setPendingEntitlementId] = useState<
    string | null
  >(null);
  const [endDates, setEndDates] = useState<Record<string, string>>({});
  const [pendingEndId, setPendingEndId] = useState<string | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const mutationLocked = useRef(false);
  const requestKey = useRef(0);
  const attempts = useRef(new Map<string, Attempt>());

  const publishedRules = useMemo(() => latestRules(rules), [rules]);
  const selectedRule = useMemo(
    () =>
      publishedRules.find(rule => rule.id === assignmentForm.ruleId) ?? null,
    [assignmentForm.ruleId, publishedRules]
  );
  const specialDaily =
    selectedRule?.payload.flow === "DAILY" &&
    selectedRule.payload.period === "SPECIAL_EVENT";
  const assignmentStartMin =
    selectedRule?.effective_from && selectedRule.effective_from > tomorrow
      ? selectedRule.effective_from
      : tomorrow;
  const selectedChild =
    activeChildren.find(child => child.id === selectedChildId) ??
    activeChildren[0];
  const mutationBusy =
    creatingAssignment ||
    Boolean(pendingVerificationId) ||
    Boolean(pendingPeriodId) ||
    Boolean(pendingEntitlementId) ||
    Boolean(pendingEndId);
  const actionsDisabled = loading || Boolean(loadError) || mutationBusy;
  const isCurrentContext = (context: number) =>
    mounted.current && context === generation.current;
  const beginMutation = () => {
    if (mutationLocked.current || loading || loadError) return null;
    mutationLocked.current = true;
    return generation.current;
  };
  const endMutation = (context: number) => {
    if (isCurrentContext(context)) mutationLocked.current = false;
  };

  const refresh = useCallback(async () => {
    const request = ++requestKey.current;
    const context = generation.current;
    if (preview) {
      if (request !== requestKey.current || !isCurrentContext(context)) return;
      setRules([previewRule]);
      setAssignments(previewAssignments);
      setDays(
        previewDays.map(row => ({ ...row, business_date: businessDate }))
      );
      setEntitlements(previewEntitlements);
      setLoading(false);
      setLoadError(null);
      return;
    }
    if (!familyId) {
      if (request !== requestKey.current || !isCurrentContext(context)) return;
      setRules([]);
      setAssignments([]);
      setDays([]);
      setEntitlements([]);
      setLoading(false);
      setLoadError(null);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const registry = await supabase.rpc("list_routine_registry", {
        p_family_id: familyId,
      });
      if (registry.error) throw registry.error;
      const registryData = (registry.data ?? { rules: [] }) as {
        rules?: RoutineRuleRow[];
      };
      const [assignmentResult, dayResult, entitlementResult] =
        await Promise.all([
          supabase.rpc("list_routine_assignments", { p_family_id: familyId }),
          selectedChildId
            ? supabase.rpc("list_routine_day", {
                p_child_profile_id: selectedChildId,
                p_business_date: businessDate,
              })
            : Promise.resolve({ data: [], error: null }),
          selectedChildId
            ? supabase.rpc("list_routine_entitlements", {
                p_child_profile_id: selectedChildId,
              })
            : Promise.resolve({ data: [], error: null }),
        ]);
      if (assignmentResult.error) throw assignmentResult.error;
      if (dayResult.error) throw dayResult.error;
      if (entitlementResult.error) throw entitlementResult.error;
      // A late child/date response must not overwrite the currently chosen date.
      if (request !== requestKey.current || !isCurrentContext(context)) return;
      const dayRows = (dayResult.data ?? []) as RoutineDayRow[];
      setRules(registryData.rules ?? []);
      setAssignments((assignmentResult.data ?? []) as RoutineAssignmentRow[]);
      setDays(dayRows);
      setEntitlements(
        (entitlementResult.data ?? []) as RoutineEntitlementRow[]
      );
      setVerification(current =>
        Object.fromEntries(
          Object.entries(current).filter(([id]) =>
            dayRows.some(row => row.id === id)
          )
        )
      );
    } catch (error) {
      if (request !== requestKey.current || !isCurrentContext(context)) return;
      setLoadError(
        errorMessage(error, "루틴 운영 정보를 불러오지 못했습니다.")
      );
    } finally {
      if (request === requestKey.current && isCurrentContext(context))
        setLoading(false);
    }
  }, [businessDate, familyId, preview, selectedChildId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      requestKey.current += 1;
      mutationLocked.current = false;
    };
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      requestKey.current += 1;
    };
  }, [refresh]);
  useEffect(() => {
    if (refreshKey !== undefined) void refresh();
  }, [refresh, refreshKey]);
  useEffect(() => {
    const timer = window.setInterval(
      () => setFamilyToday(familyBusinessDate(timezone)),
      60_000
    );
    setFamilyToday(familyBusinessDate(timezone));
    return () => window.clearInterval(timer);
  }, [timezone]);
  useEffect(() => {
    setSelectedChildId(current =>
      activeChildren.some(child => child.id === current)
        ? current
        : (activeChildren[0]?.id ?? "")
    );
    setAssignmentForm(current => ({
      ...current,
      childId: activeChildren.some(child => child.id === current.childId)
        ? current.childId
        : (activeChildren[0]?.id ?? ""),
      startsOn: current.startsOn < tomorrow ? tomorrow : current.startsOn,
    }));
  }, [activeChildren, tomorrow]);
  useEffect(() => {
    // family context changes must clear IDs, rows and unsaved review text before the new request starts.
    generation.current += 1;
    requestKey.current += 1;
    mutationLocked.current = false;
    setCreatingAssignment(false);
    setPendingVerificationId(null);
    setPendingPeriodId(null);
    setPendingEntitlementId(null);
    setPendingEndId(null);
    setRules(preview ? [previewRule] : []);
    setAssignments(preview ? previewAssignments : []);
    setDays(preview ? previewDays : []);
    setEntitlements(preview ? previewEntitlements : []);
    const familyDate = familyBusinessDate(timezone);
    const firstActiveChildId = activeChildren[0]?.id ?? "";
    setSelectedChildId(firstActiveChildId);
    setBusinessDate(familyDate);
    setVerification({});
    setEndDates({});
    attempts.current.clear();
    setAssignmentForm({
      childId: firstActiveChildId,
      ruleId: "",
      startsOn: nextBusinessDate(familyDate),
      endsOn: "",
      repeat: "DAILY",
      weekdays: [1, 2, 3, 4, 5],
    });
  }, [familyId, preview, timezone]);
  useEffect(() => {
    if (assignmentForm.startsOn < assignmentStartMin)
      setAssignmentForm(current => ({
        ...current,
        startsOn: assignmentStartMin,
      }));
  }, [assignmentForm.startsOn, assignmentStartMin]);
  useEffect(() => {
    const weekday = isoWeekdayForDate(assignmentForm.startsOn);
    if (specialDaily && assignmentForm.repeat !== "ONCE" && weekday !== null)
      setAssignmentForm(current => ({
        ...current,
        repeat: "ONCE",
        endsOn: current.startsOn,
        weekdays: [weekday],
      }));
  }, [assignmentForm.repeat, assignmentForm.startsOn, specialDaily]);

  const mutationKey = (fingerprint: string) => {
    const existing = attempts.current.get(fingerprint);
    if (existing) return existing.key;
    const key = newRoutineUuid();
    attempts.current.set(fingerprint, { fingerprint, key });
    return key;
  };

  const createAssignment = async () => {
    if (preview) return toast.message("미리보기에서는 배정하지 않습니다.");
    if (actionsDisabled) return;
    if (!selectedRule || !assignmentForm.childId)
      return toast.error("게시된 룰과 활성 자녀를 선택해 주세요.");
    const dateErrors = validateRoutineAssignmentDates(
      assignmentForm.startsOn,
      assignmentForm.endsOn,
      assignmentStartMin
    );
    if (dateErrors.length) return toast.error(dateErrors[0]);
    if (specialDaily && assignmentForm.repeat !== "ONCE")
      return toast.error("특별 이벤트 데일리는 하루 배정만 할 수 있습니다.");
    if (
      assignmentForm.repeat === "DAILY" &&
      assignmentForm.weekdays.length === 0
    )
      return toast.error("반복 요일을 하나 이상 선택해 주세요.");
    const repeat = assignmentForm.repeat;
    const endsOn =
      repeat === "ONCE"
        ? assignmentForm.startsOn
        : assignmentForm.endsOn || null;
    const startWeekday = isoWeekdayForDate(assignmentForm.startsOn);
    if (repeat === "ONCE" && startWeekday === null)
      return toast.error("시작일은 실제 달력 날짜로 입력해 주세요.");
    const week = repeat === "ONCE" ? [startWeekday!] : assignmentForm.weekdays;
    const args = {
      p_family_id: familyId,
      p_rule_id: selectedRule.id,
      p_child_profile_id: assignmentForm.childId,
      p_starts_on: assignmentForm.startsOn,
      p_ends_on: endsOn,
      p_weekdays: week,
      p_repeat: repeat,
    } as const;
    const context = beginMutation();
    if (context === null) return;
    const fingerprint = stableRoutineJson(args);
    const key = mutationKey(fingerprint);
    setCreatingAssignment(true);
    try {
      const { data, error } = await supabase.rpc("create_routine_assignment", {
        ...args,
        p_idempotency_key: key,
      });
      if (error) throw error;
      if (!isCurrentContext(context)) return;
      attempts.current.delete(fingerprint);
      setAssignments(current => [...current, data as RoutineAssignmentRow]);
      toast.success(
        repeat === "ONCE"
          ? "하루 루틴을 배정했습니다."
          : "반복 루틴을 배정했습니다."
      );
      await refresh();
    } catch (error) {
      if (!isCurrentContext(context)) return;
      toast.error(
        isNetworkFailure(error)
          ? "연결 결과를 알 수 없습니다. 같은 내용으로 다시 누르면 안전하게 재시도합니다."
          : errorMessage(error, "루틴을 배정하지 못했습니다.")
      );
    } finally {
      if (isCurrentContext(context)) setCreatingAssignment(false);
      endMutation(context);
    }
  };

  const endAssignment = async (row: RoutineAssignmentRow) => {
    if (preview)
      return toast.message("미리보기에서는 종료일을 바꾸지 않습니다.");
    if (actionsDisabled) return;
    const earliest = row.starts_on > familyToday ? row.starts_on : familyToday;
    const endsOn = endDates[row.id] ?? "";
    if (!isRealIsoDate(endsOn))
      return toast.error("종료일을 실제 달력 날짜로 선택해 주세요.");
    if (endsOn < earliest || (row.ends_on && endsOn > row.ends_on))
      return toast.error(
        "종료일은 오늘·시작일 이후이고 기존 종료일을 넘을 수 없습니다."
      );
    const args = { p_assignment_id: row.id, p_ends_on: endsOn };
    const fingerprint = stableRoutineJson(args);
    const key = mutationKey(fingerprint);
    const context = beginMutation();
    if (context === null) return;
    setPendingEndId(row.id);
    try {
      const { data, error } = await supabase.rpc("end_routine_assignment", {
        ...args,
        p_idempotency_key: key,
      });
      if (error) throw error;
      if (!isCurrentContext(context)) return;
      attempts.current.delete(fingerprint);
      setAssignments(current =>
        current.map(item =>
          item.id === row.id ? (data as RoutineAssignmentRow) : item
        )
      );
      toast.success("종료일을 저장했습니다.");
    } catch (error) {
      if (!isCurrentContext(context)) return;
      toast.error(
        isNetworkFailure(error)
          ? "연결 결과를 알 수 없습니다. 같은 내용으로 다시 시도해 주세요."
          : errorMessage(error, "종료일을 저장하지 못했습니다.")
      );
    } finally {
      if (isCurrentContext(context)) setPendingEndId(null);
      endMutation(context);
    }
  };

  const updateVerification = (
    row: RoutineDayRow,
    patch: Partial<VerificationForm>
  ) => {
    if (actionsDisabled) return;
    setVerification(current => ({
      ...current,
      [row.id]: { ...(current[row.id] ?? defaultVerification(row)), ...patch },
    }));
  };
  const verify = async (row: RoutineDayRow) => {
    if (preview)
      return toast.message("미리보기에서는 확인을 저장하지 않습니다.");
    if (actionsDisabled) return;
    const form = verification[row.id] ?? defaultVerification(row);
    const reason = form.reason.trim();
    if (!reason) return toast.error("자녀에게 보일 확인 이유를 입력해 주세요.");
    const isDaily = row.flow === "DAILY";
    if (isDaily && form.pass === null)
      return toast.error("PASS 또는 문제 있음을 선택해 주세요.");
    const score = Number(form.score);
    if (
      !isDaily &&
      (!form.score.trim() ||
        !Number.isFinite(score) ||
        score < 0 ||
        score > 100)
    )
      return toast.error("Quest 점수는 0~100 사이 숫자여야 합니다.");
    const args = {
      p_occurrence_id: row.id,
      p_score: isDaily ? null : score,
      p_pass: isDaily ? form.pass : null,
      p_praise: isDaily && form.pass === true ? form.praise : false,
      p_reason: reason,
      p_expected_revision: row.revision,
    } as const;
    const context = beginMutation();
    if (context === null) return;
    const fingerprint = stableRoutineJson(args);
    const key = mutationKey(fingerprint);
    setPendingVerificationId(row.id);
    try {
      const { error } = await supabase.rpc("verify_routine_occurrence", {
        ...args,
        p_idempotency_key: key,
      });
      if (error) throw error;
      if (!isCurrentContext(context)) return;
      attempts.current.delete(fingerprint);
      setVerification(current => {
        const { [row.id]: _removed, ...rest } = current;
        return rest;
      });
      toast.success(
        isDaily
          ? "부모 확인과 스티커 결과를 기록했습니다."
          : "Quest 부모 확인을 기록했습니다."
      );
      await refresh();
    } catch (error) {
      if (!isCurrentContext(context)) return;
      if (isConflict(error))
        toast.error(
          "다른 확인으로 내용이 바뀌었습니다. 최신 내용을 불러온 뒤 다시 검토해 주세요."
        );
      else
        toast.error(
          isNetworkFailure(error)
            ? "연결 결과를 알 수 없습니다. 값을 바꾸지 않고 다시 누르면 안전하게 재시도합니다."
            : errorMessage(error, "부모 확인을 저장하지 못했습니다.")
        );
    } finally {
      if (isCurrentContext(context)) setPendingVerificationId(null);
      endMutation(context);
    }
  };

  const closePeriod = async (row: RoutineDayRow) => {
    if (preview)
      return toast.message("미리보기에서는 기간을 마감하지 않습니다.");
    if (actionsDisabled) return;
    if (!canCloseRoutinePeriod(row.flow, row.period_end, familyToday))
      return toast.error(
        "기간 종료일 다음 날부터 부모가 직접 마감할 수 있습니다."
      );
    const args = {
      p_child_profile_id: rowChildId(row, selectedChildId),
      p_rule_id: row.rule_id,
      p_reference_date: row.business_date,
    };
    const context = beginMutation();
    if (context === null) return;
    const fingerprint = stableRoutineJson(args);
    const key = mutationKey(fingerprint);
    setPendingPeriodId(`${row.rule_id}:${row.period_start}`);
    try {
      const { data, error } = await supabase.rpc("confirm_routine_period", {
        ...args,
        p_idempotency_key: key,
      });
      if (error) throw error;
      if (!isCurrentContext(context)) return;
      attempts.current.delete(fingerprint);
      toast.success(
        `기간을 마감했습니다. ${Number((data as { issued?: number })?.issued ?? 0)}개의 권리를 확인했습니다.`
      );
      await refresh();
    } catch (error) {
      if (!isCurrentContext(context)) return;
      toast.error(
        isNetworkFailure(error)
          ? "연결 결과를 알 수 없습니다. 같은 마감 요청을 다시 누르면 안전하게 재시도합니다."
          : errorMessage(error, "기간을 마감하지 못했습니다.")
      );
    } finally {
      if (isCurrentContext(context)) setPendingPeriodId(null);
      endMutation(context);
    }
  };

  const fulfill = async (row: RoutineEntitlementRow) => {
    if (preview) return toast.message("미리보기에서는 이행 처리하지 않습니다.");
    if (actionsDisabled) return;
    if (row.status !== "AVAILABLE" || row.requires_review)
      return toast.error("검토가 필요한 권리는 이행 처리할 수 없습니다.");
    const args = { p_entitlement_id: row.id };
    const context = beginMutation();
    if (context === null) return;
    const fingerprint = stableRoutineJson(args);
    const key = mutationKey(fingerprint);
    setPendingEntitlementId(row.id);
    try {
      const { error } = await supabase.rpc("fulfill_routine_entitlement", {
        ...args,
        p_idempotency_key: key,
      });
      if (error) throw error;
      if (!isCurrentContext(context)) return;
      attempts.current.delete(fingerprint);
      setEntitlements(current =>
        current.map(item =>
          item.id === row.id
            ? {
                ...item,
                status: "FULFILLED",
                fulfilled_at: new Date().toISOString(),
              }
            : item
        )
      );
      toast.success(
        "앱 밖 이행 완료로 표시했습니다. 자동 송금·사용은 하지 않습니다."
      );
    } catch (error) {
      if (!isCurrentContext(context)) return;
      toast.error(
        isNetworkFailure(error)
          ? "연결 결과를 알 수 없습니다. 같은 권리를 다시 누르면 안전하게 재시도합니다."
          : errorMessage(error, "이행 처리하지 못했습니다.")
      );
    } finally {
      if (isCurrentContext(context)) setPendingEntitlementId(null);
      endMutation(context);
    }
  };

  return (
    <section
      className="rounded-[28px] bg-white p-6 shadow-[0_16px_48px_rgba(51,58,68,.08)] sm:p-8"
      aria-labelledby="routine-parent-panel-title"
    >
      <div className="flex flex-col gap-4 border-b border-black/8 pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold text-[#4d2ddc]">
            ROUTINE V2 OPERATIONS
          </p>
          <h2
            id="routine-parent-panel-title"
            className="mt-1 text-2xl font-bold tracking-[-0.04em]"
          >
            배정·확인·보상 권리
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[#747670]">
            게시 룰을 배정하고 수행일 사실을 확인합니다. 권리는 실제 돈·시간
            잔액이 아니며, 각 항목을 부모가 앱 밖에서 독립적으로 이행한 뒤
            표시합니다.
          </p>
        </div>
        <div className="rounded-2xl bg-[#cde5de]/60 px-3 py-2 text-xs leading-5 text-[#315f4d]">
          <ShieldCheck className="mr-1 inline h-4 w-4" />
          가족 시간대 {timezone}
          <br />
          시간 원장·자동 이전 미구현
        </div>
      </div>
      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <section
          className="rounded-2xl bg-[#f9f6ef] p-5"
          aria-labelledby="routine-assignment-title"
        >
          <div className="flex items-start gap-3">
            <CalendarCheck2 className="mt-0.5 h-5 w-5 text-[#4d2ddc]" />
            <div>
              <h3 id="routine-assignment-title" className="font-bold">
                새 배정
              </h3>
              <p className="mt-1 text-xs leading-5 text-[#666963]">
                각 배정은 선택한 게시 버전에 고정됩니다. 새 룰을 게시해도 기존
                배정은 자동으로 바뀌지 않습니다.
              </p>
            </div>
          </div>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="routine-assignment-child">자녀</Label>
              <select
                id="routine-assignment-child"
                value={assignmentForm.childId}
                disabled={actionsDisabled}
                onChange={event =>
                  setAssignmentForm(current => ({
                    ...current,
                    childId: event.target.value,
                  }))
                }
                className="flex h-10 w-full rounded-md border border-input bg-white px-3 text-sm"
              >
                <option value="">선택하세요</option>
                {activeChildren.map(child => (
                  <option key={child.id} value={child.id}>
                    {child.display_name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="routine-assignment-rule">최신 게시 룰</Label>
              <select
                id="routine-assignment-rule"
                value={assignmentForm.ruleId}
                disabled={actionsDisabled}
                onChange={event =>
                  setAssignmentForm(current => ({
                    ...current,
                    ruleId: event.target.value,
                  }))
                }
                className="flex h-10 w-full rounded-md border border-input bg-white px-3 text-sm"
              >
                <option value="">선택하세요</option>
                {publishedRules.map(rule => (
                  <option key={rule.id} value={rule.id}>
                    {rule.name} · v{rule.version} ·{" "}
                    {rule.payload.flow === "DAILY" ? "데일리" : "Quest"}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="routine-assignment-start">시작일</Label>
              <Input
                id="routine-assignment-start"
                type="date"
                min={assignmentStartMin}
                value={assignmentForm.startsOn}
                disabled={actionsDisabled || !selectedRule}
                onChange={event => {
                  const next = event.target.value;
                  if (isRealIsoDate(next))
                    setAssignmentForm(current => ({
                      ...current,
                      startsOn: next,
                    }));
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="routine-assignment-repeat">일정</Label>
              <select
                id="routine-assignment-repeat"
                value={assignmentForm.repeat}
                disabled={actionsDisabled || !selectedRule || specialDaily}
                onChange={event =>
                  setAssignmentForm(current => ({
                    ...current,
                    repeat: event.target.value as "DAILY" | "ONCE",
                  }))
                }
                className="flex h-10 w-full rounded-md border border-input bg-white px-3 text-sm"
              >
                <option value="DAILY">매주 반복</option>
                <option value="ONCE">하루만</option>
              </select>
            </div>
            {assignmentForm.repeat === "DAILY" ? (
              <>
                <fieldset className="space-y-2 sm:col-span-2">
                  <legend className="text-sm font-medium">반복 요일</legend>
                  <div className="flex flex-wrap gap-2">
                    {weekdays.map(day => (
                      <label
                        key={day.value}
                        className={`cursor-pointer rounded-full border px-3 py-2 text-xs font-semibold ${assignmentForm.weekdays.includes(day.value) ? "border-[#4d2ddc] bg-[#f0edfa] text-[#4d2ddc]" : "border-black/10 bg-white text-[#777a74]"}`}
                      >
                        <input
                          className="sr-only"
                          type="checkbox"
                          checked={assignmentForm.weekdays.includes(day.value)}
                          disabled={actionsDisabled}
                          onChange={() =>
                            setAssignmentForm(current => ({
                              ...current,
                              weekdays: current.weekdays.includes(day.value)
                                ? current.weekdays.filter(
                                    value => value !== day.value
                                  )
                                : [...current.weekdays, day.value].sort(
                                    (a, b) => a - b
                                  ),
                            }))
                          }
                        />
                        {day.label}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="routine-assignment-end">
                    종료일{" "}
                    <span className="font-normal text-muted-foreground">
                      (선택)
                    </span>
                  </Label>
                  <Input
                    id="routine-assignment-end"
                    type="date"
                    min={assignmentForm.startsOn}
                    value={assignmentForm.endsOn}
                    disabled={actionsDisabled}
                    onChange={event =>
                      setAssignmentForm(current => ({
                        ...current,
                        endsOn: event.target.value,
                      }))
                    }
                  />
                </div>
              </>
            ) : (
              <p className="rounded-xl bg-white p-3 text-xs leading-5 text-[#666963] sm:col-span-2">
                하루 배정은 시작일과 종료일이 같은 날입니다.
                {specialDaily
                  ? " 특별 이벤트 데일리는 하루 배정으로만 지원합니다."
                  : ""}
              </p>
            )}
          </div>
          <Button
            type="button"
            className="mt-5 rounded-xl bg-[#4d2ddc] text-white hover:bg-[#3d20c7]"
            disabled={
              actionsDisabled ||
              !familyId ||
              !selectedRule ||
              !assignmentForm.childId
            }
            onClick={() => void createAssignment()}
          >
            {creatingAssignment ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CalendarCheck2 className="h-4 w-4" />
            )}{" "}
            루틴 배정
          </Button>
        </section>
        <section
          className="rounded-2xl border border-black/10 p-5"
          aria-labelledby="routine-entitlement-title"
        >
          <div className="flex items-start gap-3">
            <Gift className="mt-0.5 h-5 w-5 text-[#4d2ddc]" />
            <div>
              <h3 id="routine-entitlement-title" className="font-bold">
                선택 자녀의 보상 권리
              </h3>
              <p className="mt-1 text-xs leading-5 text-[#666963]">
                권리는 잔액이 아니며 돈·시간·포인트·약속을 합산하지 않습니다.
                실제 이행은 앱 밖에서 각 항목별로 처리합니다.
              </p>
            </div>
          </div>
          <div className="mt-5 space-y-3">
            {!selectedChild ? (
              <p className="rounded-xl bg-[#f9f6ef] p-4 text-sm text-[#777a74]">
                활성 자녀를 먼저 선택해 주세요.
              </p>
            ) : entitlements.length === 0 ? (
              <p className="rounded-xl bg-[#f9f6ef] p-4 text-sm text-[#777a74]">
                이 자녀에게 아직 보상 권리가 없습니다.
              </p>
            ) : (
              entitlements.map(row => (
                <article key={row.id} className="rounded-xl bg-[#f9f6ef] p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <strong>{row.name}</strong>
                      <p className="mt-1 text-xs text-[#666963]">
                        {row.rule_name} · {row.condition_label} ·{" "}
                        {row.amount ?? row.text}{" "}
                        {row.amount !== null
                          ? row.unit_label || unitLabel[row.unit]
                          : ""}
                      </p>
                      <p className="mt-1 text-[11px] text-[#777a74]">
                        기간 {dateLabel(row.period_start)} ~{" "}
                        {dateLabel(row.period_end)}
                      </p>
                    </div>
                    <span
                      className={`rounded-full px-2 py-1 text-[10px] font-bold ${row.status === "FULFILLED" ? "bg-[#cde5de] text-[#315f4d]" : row.requires_review || row.status === "REVIEW_REQUIRED" ? "bg-[#f7e7d9] text-[#87472a]" : "bg-[#f0edfa] text-[#5b46a3]"}`}
                    >
                      {row.requires_review || row.status === "REVIEW_REQUIRED"
                        ? "검토 필요"
                        : row.status === "FULFILLED"
                          ? "이행 완료"
                          : "이행 가능"}
                    </span>
                  </div>
                  {row.status === "AVAILABLE" && !row.requires_review && (
                    <Button
                      type="button"
                      size="sm"
                      className="mt-3 bg-[#333a44] text-white hover:bg-[#232932]"
                      disabled={Boolean(pendingEntitlementId)}
                      onClick={() => void fulfill(row)}
                    >
                      {pendingEntitlementId === row.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <CheckCircle2 className="h-4 w-4" />
                      )}{" "}
                      앱 밖 이행 완료 표시
                    </Button>
                  )}
                  {(row.requires_review ||
                    row.status === "REVIEW_REQUIRED") && (
                    <p className="mt-3 text-xs text-[#9a4f2b]">
                      정정 후 보존된 권리입니다. 검토가 끝나기 전에는 이행
                      처리하지 않습니다.
                    </p>
                  )}
                </article>
              ))
            )}
          </div>
        </section>
      </div>
      <section
        className="mt-7 border-t border-black/8 pt-6"
        aria-labelledby="routine-review-title"
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold text-[#4d2ddc]">
              PARENT REVIEW
            </p>
            <h3 id="routine-review-title" className="mt-1 text-xl font-bold">
              수행일 확인과 기간 마감
            </h3>
            <p className="mt-1 text-xs leading-5 text-[#777a74]">
              자녀의 체크는 hold입니다. 부모가 이유와 함께 확인합니다. 데일리의
              스티커는 기간 마감 전 보상을 만들지 않습니다.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={loading || mutationBusy || preview}
            onClick={() => void refresh()}
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />{" "}
            새로고침
          </Button>
        </div>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="routine-review-child">자녀</Label>
            <select
              id="routine-review-child"
              value={selectedChildId}
              disabled={mutationBusy}
              onChange={event => setSelectedChildId(event.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-white px-3 text-sm"
            >
              <option value="">선택하세요</option>
              {activeChildren.map(child => (
                <option key={child.id} value={child.id}>
                  {child.display_name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="routine-review-date">수행일</Label>
            <Input
              id="routine-review-date"
              type="date"
              max={familyToday}
              value={businessDate}
              disabled={mutationBusy}
              onChange={event => {
                const next = event.target.value;
                if (isRealIsoDate(next) && next <= familyToday)
                  setBusinessDate(next);
              }}
            />
          </div>
        </div>
        {loadError ? (
          <div
            role="alert"
            className="mt-5 rounded-2xl bg-red-50 p-4 text-sm text-red-800"
          >
            <strong>목록을 불러오지 못했습니다.</strong>
            <p className="mt-1">{loadError}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => void refresh()}
            >
              다시 시도
            </Button>
          </div>
        ) : loading ? (
          <div className="mt-5 flex justify-center rounded-2xl bg-[#f9f6ef] p-8">
            <Loader2 className="h-5 w-5 animate-spin text-[#4d2ddc]" />
          </div>
        ) : !selectedChild ? (
          <div className="mt-5 rounded-2xl bg-[#f9f6ef] p-5 text-sm text-[#777a74]">
            확인할 활성 자녀가 없습니다.
          </div>
        ) : days.length === 0 ? (
          <div className="mt-5 rounded-2xl bg-[#f9f6ef] p-5 text-sm text-[#777a74]">
            이 날짜에 활성 배정으로 생성된 루틴이 없습니다.
          </div>
        ) : (
          <div className="mt-5 space-y-4">
            {days.map(row => {
              const form = verification[row.id] ?? defaultVerification(row);
              const pending = pendingVerificationId === row.id;
              const editing = Boolean(verification[row.id]);
              const canClose = canCloseRoutinePeriod(
                row.flow,
                row.period_end,
                familyToday
              );
              const periodKey = `${row.rule_id}:${row.period_start}`;
              const showReviewForm =
                row.verification_status !== "CONFIRMED" || editing;
              return (
                <article
                  key={row.id}
                  className="rounded-2xl border border-black/10 p-4 sm:p-5"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap gap-2">
                        <span className="rounded-full bg-[#f0edfa] px-2.5 py-1 text-[10px] font-bold text-[#5b46a3]">
                          {row.flow === "DAILY" ? "데일리" : "Quest"}
                        </span>
                        <span
                          className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${row.verification_status === "CONFIRMED" ? "bg-[#cde5de] text-[#315f4d]" : "bg-[#f9f6ef] text-[#666963]"}`}
                        >
                          {row.verification_status === "CONFIRMED"
                            ? "확인 완료"
                            : row.verification_status === "HELD"
                              ? "hold · 검토 대기"
                              : "기록 없음"}
                        </span>
                      </div>
                      <h4 className="mt-3 text-lg font-bold">{row.name}</h4>
                      <p className="mt-1 text-sm text-[#5d605b]">
                        아이 표시: {row.child_label} ·{" "}
                        {categoryLabel[row.category]}
                      </p>
                      <p className="mt-2 text-xs leading-5 text-[#777a74]">
                        확인 기준: {row.criteria}
                      </p>
                    </div>
                    {row.flow === "DAILY" && (
                      <div className="rounded-xl bg-[#cde5de]/45 px-3 py-2 text-xs text-[#315f4d]">
                        <Star className="mr-1 inline h-4 w-4" />
                        {iconLabel[row.sticker_icon]} 스티커{" "}
                        {row.stickers === null ? "hold" : `${row.stickers}개`}
                        <br />
                        기간 합계 {row.sticker_total}개
                      </div>
                    )}
                  </div>
                  {row.flow === "DAILY" && (
                    <div className="mt-4 rounded-xl bg-[#f9f6ef] p-3 text-xs leading-5 text-[#666963]">
                      {periodLabel[row.period]}: {dateLabel(row.period_start)} ~{" "}
                      {dateLabel(row.period_end)} ·{" "}
                      {canClose
                        ? "달력 기간 종료됨 · 권리 확인을 할 수 있습니다."
                        : "달력 기간이 끝난 뒤 권리를 확인합니다."}
                    </div>
                  )}
                  {showReviewForm ? (
                    <div className="mt-5 grid gap-4 border-t border-black/8 pt-4 sm:grid-cols-[190px_minmax(0,1fr)]">
                      <div className="space-y-2">
                        {row.flow === "DAILY" ? (
                          <>
                            <Label>부모 확인</Label>
                            <div className="grid gap-2">
                              <Button
                                type="button"
                                variant={
                                  form.pass === true ? "default" : "outline"
                                }
                                className={
                                  form.pass === true
                                    ? "bg-[#4d2ddc] hover:bg-[#3d20c7]"
                                    : ""
                                }
                                disabled={actionsDisabled}
                                onClick={() =>
                                  updateVerification(row, { pass: true })
                                }
                              >
                                문제없음 PASS
                              </Button>
                              <Button
                                type="button"
                                variant={
                                  form.pass === false ? "default" : "outline"
                                }
                                className={
                                  form.pass === false
                                    ? "bg-[#333a44] hover:bg-[#232932]"
                                    : ""
                                }
                                disabled={actionsDisabled}
                                onClick={() =>
                                  updateVerification(row, {
                                    pass: false,
                                    praise: false,
                                  })
                                }
                              >
                                문제 있음
                              </Button>
                              {form.pass === true && (
                                <label className="flex items-center gap-2 text-xs">
                                  <input
                                    type="checkbox"
                                    checked={form.praise}
                                    disabled={actionsDisabled}
                                    onChange={event =>
                                      updateVerification(row, {
                                        praise: event.target.checked,
                                      })
                                    }
                                  />
                                  선생님 칭찬 (+1 스티커)
                                </label>
                              )}
                            </div>
                          </>
                        ) : (
                          <>
                            <Label htmlFor={`routine-score-${row.id}`}>
                              부모 점수{" "}
                              <span className="font-normal text-muted-foreground">
                                (0~100)
                              </span>
                            </Label>
                            <Input
                              id={`routine-score-${row.id}`}
                              type="number"
                              min="0"
                              max="100"
                              step="any"
                              inputMode="decimal"
                              value={form.score}
                              disabled={actionsDisabled}
                              onChange={event =>
                                updateVerification(row, {
                                  score: event.target.value,
                                })
                              }
                            />
                          </>
                        )}
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor={`routine-reason-${row.id}`}>
                          자녀에게 보일 확인 이유{" "}
                          <span className="text-[#a13f38]">(필수)</span>
                        </Label>
                        <Textarea
                          id={`routine-reason-${row.id}`}
                          value={form.reason}
                          disabled={actionsDisabled}
                          maxLength={1000}
                          placeholder="확인한 사실과 이유를 자녀가 이해할 수 있게 적어 주세요."
                          onChange={event =>
                            updateVerification(row, {
                              reason: event.target.value,
                            })
                          }
                        />
                        <p className="text-xs text-[#777a74]">
                          비공개 메모가 아닙니다. 자녀에게도 보입니다.
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-4 rounded-xl bg-[#cde5de]/55 p-3 text-xs leading-5 text-[#315f4d]">
                      부모 확인 완료
                      {row.flow === "DAILY"
                        ? ` · ${row.pass ? `PASS ${row.praise ? "+ 칭찬" : ""}` : "문제 있음"}`
                        : ` · 점수 ${row.score ?? "—"}`}{" "}
                      {row.parent_reason ? (
                        <>
                          <br />
                          확인 이유: {row.parent_reason}
                        </>
                      ) : null}
                    </div>
                  )}
                  <div className="mt-4 flex flex-col gap-2 border-t border-black/8 pt-4 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-xs leading-5 text-[#777a74]">
                      {row.flow === "DAILY"
                        ? "PASS는 기본 1개, 칭찬이 함께 확인되면 1개를 더 기록합니다. 미확인은 0개가 아닙니다."
                        : "Quest의 수치와 이유는 새 확인 사건으로 보존됩니다."}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {canClose && (
                        <Button
                          type="button"
                          variant="outline"
                          disabled={actionsDisabled}
                          onClick={() => void closePeriod(row)}
                        >
                          {pendingPeriodId === periodKey ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <ClipboardCheck className="h-4 w-4" />
                          )}{" "}
                          기간 권리 확인
                        </Button>
                      )}
                      {row.verification_status === "CONFIRMED" && !editing && (
                        <Button
                          type="button"
                          variant="outline"
                          disabled={actionsDisabled}
                          onClick={() => updateVerification(row, {})}
                        >
                          수정 확인
                        </Button>
                      )}
                      {showReviewForm && (
                        <Button
                          type="button"
                          className="bg-[#333a44] text-white hover:bg-[#232932]"
                          disabled={actionsDisabled}
                          onClick={() => void verify(row)}
                        >
                          {pending ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <ShieldCheck className="h-4 w-4" />
                          )}
                          {row.verification_status === "CONFIRMED"
                            ? "수정 확인 기록"
                            : "부모 확인 기록"}
                        </Button>
                      )}
                    </div>
                  </div>
                  {row.verification_status === "CONFIRMED" &&
                    showReviewForm && (
                      <p className="mt-3 rounded-xl bg-[#f7e7d9] p-3 text-xs leading-5 text-[#87472a]">
                        수정 확인은 이전 부모 확인 사건을 지우지 않고 새
                        기록으로 남습니다. 이미 발생한 권리는 자동 회수되지
                        않으며 검토 필요 상태가 될 수 있습니다.
                      </p>
                    )}
                </article>
              );
            })}
          </div>
        )}
      </section>
      <section
        className="mt-7 border-t border-black/8 pt-6"
        aria-labelledby="routine-assigned-title"
      >
        <div className="flex items-center gap-2">
          <CircleAlert className="h-4 w-4 text-[#4d2ddc]" />
          <div>
            <h3 id="routine-assigned-title" className="font-bold">
              현재 배정
            </h3>
            <p className="mt-1 text-xs text-[#777a74]">
              종료일은 과거로 바꾸거나 연장할 수 없습니다. 기존 룰 버전과 실제
              수행 기록은 보존됩니다.
            </p>
          </div>
        </div>
        <div className="mt-4 space-y-3">
          {assignments.length === 0 ? (
            <div className="rounded-2xl bg-[#f9f6ef] p-5 text-sm text-[#777a74]">
              아직 배정한 v2 루틴이 없습니다.
            </div>
          ) : (
            assignments.map(row => {
              const earliest =
                row.starts_on > familyToday ? row.starts_on : familyToday;
              const end = endDates[row.id] ?? "";
              return (
                <article
                  key={row.id}
                  className="rounded-2xl border border-black/10 p-4"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <strong>{row.rule_name}</strong>
                      <p className="mt-1 text-xs text-[#777a74]">
                        {row.child_name} ·{" "}
                        {row.flow === "DAILY" ? "데일리" : "Quest"} · 시작{" "}
                        {dateLabel(row.starts_on)}
                        {row.ends_on ? ` · 종료 ${dateLabel(row.ends_on)}` : ""}
                      </p>
                      <p className="mt-1 text-xs text-[#777a74]">
                        {row.repeat === "ONCE"
                          ? "하루 배정"
                          : `반복 요일: ${row.weekdays
                              .map(
                                value =>
                                  weekdays.find(day => day.value === value)
                                    ?.label
                              )
                              .filter(Boolean)
                              .join(" · ")}`}
                      </p>
                    </div>
                  </div>
                  {row.repeat === "DAILY" && (
                    <div className="mt-4 flex flex-col gap-3 border-t border-black/8 pt-4 sm:flex-row sm:items-end">
                      <div className="space-y-1">
                        <Label
                          htmlFor={`routine-end-${row.id}`}
                          className="text-xs"
                        >
                          이 날짜까지 종료
                        </Label>
                        <Input
                          id={`routine-end-${row.id}`}
                          type="date"
                          min={earliest}
                          max={row.ends_on ?? undefined}
                          value={end}
                          disabled={actionsDisabled}
                          onChange={event =>
                            setEndDates(current => ({
                              ...current,
                              [row.id]: event.target.value,
                            }))
                          }
                        />
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={actionsDisabled || !isRealIsoDate(end)}
                        onClick={() => void endAssignment(row)}
                      >
                        {pendingEndId === row.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <CalendarCheck2 className="h-4 w-4" />
                        )}{" "}
                        종료일 저장
                      </Button>
                    </div>
                  )}
                </article>
              );
            })
          )}
        </div>
      </section>
    </section>
  );
}

// list_routine_day 자체는 child_profile_id를 반환하지 않는다. 현재 선택 자녀가 기간 마감의 권리 귀속 대상이다.
function rowChildId(_row: RoutineDayRow, selectedChildId: string) {
  return selectedChildId;
}
