import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase";
import { familyBusinessDate, nextBusinessDate } from "@/lib/activity-flow";
import { CalendarDays, CheckCircle2, CircleAlert, Loader2, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

export type ParentActivityChild = {
  id: string;
  display_name: string;
  status: string;
};

export type ParentActivitySettingsProps = {
  familyId: string;
  timezone: string;
  children: ParentActivityChild[];
  preview?: boolean;
  /** Changes after rule publication to re-fetch options without clearing the form. */
  refreshKey?: number;
  onChanged?: () => void;
};

type RuleRegistryRow = {
  config_version_id: string;
  policy_rule_id: string;
  activity_template_id: string;
  status: "DRAFT" | "PUBLISHED";
  effective_from: string | null;
  name: string;
  category_code: string;
  description: string | null;
  metric_label: string;
  created_at: string;
};

type AssignmentRow = {
  assignment_id: string;
  child_profile_id: string;
  child_name: string;
  policy_rule_id: string;
  activity_name: string;
  category_code: string;
  starts_on: string;
  ends_on: string | null;
  weekdays: number[];
  repeat_kind: "DAILY" | "ONCE";
};

type AssignmentForm = {
  childId: string;
  ruleId: string;
  startsOn: string;
  endsOn: string;
  repeat: "DAILY" | "ONCE";
  weekdays: number[];
};

const weekDays = [
  { value: 1, label: "월" },
  { value: 2, label: "화" },
  { value: 3, label: "수" },
  { value: 4, label: "목" },
  { value: 5, label: "금" },
  { value: 6, label: "토" },
  { value: 7, label: "일" },
] as const;

const categoryLabels: Record<string, string> = {
  DAILY_STUDY: "매일 공부",
  SPECIAL_SCHEDULE: "특별 일정",
  LIFE_HABIT: "생활 습관",
  OTHER: "기타",
};

const previewRules: RuleRegistryRow[] = [
  {
    config_version_id: "preview-rule-version",
    policy_rule_id: "preview-rule",
    activity_template_id: "preview-template",
    status: "PUBLISHED",
    effective_from: "2099-01-01",
    name: "수학 문제 풀이",
    category_code: "DAILY_STUDY",
    description: "정답률을 부모가 확인합니다.",
    metric_label: "부모가 채점한 정답률",
    created_at: "2098-12-01T00:00:00.000Z",
  },
];

const previewAssignments: AssignmentRow[] = [
  {
    assignment_id: "preview-assignment",
    child_profile_id: "preview-child",
    child_name: "자녀",
    policy_rule_id: "preview-rule",
    activity_name: "수학 문제 풀이",
    category_code: "DAILY_STUDY",
    starts_on: "2099-01-01",
    ends_on: null,
    weekdays: [1, 2, 3, 4, 5],
    repeat_kind: "DAILY",
  },
];

function isoWeekday(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return dayOfWeek === 0 ? 7 : dayOfWeek;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(`${value}T00:00:00Z`),
  );
}

function assignmentErrorMessage(error: unknown) {
  const message = typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? "")
    : error instanceof Error ? error.message : "";
  if (/duplicate|overlap|already.*assign|assignment.*exists/i.test(message)) {
    return "같은 활동의 일정이 이미 겹칩니다. 시작일·종료일·요일을 확인해 주세요.";
  }
  if (/effective|start.*date|tomorrow/i.test(message)) {
    return "게시 규칙의 효력일과 가족 시간대 기준 내일 이후로 시작일을 선택해 주세요.";
  }
  if (/child|family|access|parent/i.test(message)) {
    return "이 가족의 현재 활성 자녀와 게시된 규칙만 배정할 수 있습니다.";
  }
  return message || "활동을 배정하지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

function errorMessage(error: unknown, fallback: string) {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = String((error as { message?: unknown }).message ?? "").trim();
    if (message) return message;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

function newestPublishedRules(rows: RuleRegistryRow[]) {
  const newest = new Map<string, RuleRegistryRow>();
  rows
    .filter(row => row.status === "PUBLISHED")
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .forEach(row => {
      if (!newest.has(row.activity_template_id)) newest.set(row.activity_template_id, row);
    });
  return Array.from(newest.values());
}

/**
 * Parent-only schedule assignment. Rule policy versions are picked once and
 * pinned by the database to preserve historical meaning after later rule edits.
 */
export default function ParentActivitySettings({
  familyId,
  timezone,
  children,
  preview = false,
  refreshKey,
  onChanged,
}: ParentActivitySettingsProps) {
  const [familyToday, setFamilyToday] = useState(() => familyBusinessDate(timezone));
  const tomorrow = useMemo(() => nextBusinessDate(familyToday), [familyToday]);
  const activeChildren = useMemo(() => children.filter(child => child.status === "ACTIVE"), [children]);
  const [rules, setRules] = useState<RuleRegistryRow[]>(preview ? previewRules : []);
  const [assignments, setAssignments] = useState<AssignmentRow[]>(preview ? previewAssignments : []);
  const [loading, setLoading] = useState(!preview);
  const [saving, setSaving] = useState(false);
  const [endingId, setEndingId] = useState<string | null>(null);
  const [endDates, setEndDates] = useState<Record<string, string>>({});
  const refreshGeneration = useRef(0);
  const creating = useRef(false);
  const [form, setForm] = useState<AssignmentForm>(() => ({
    childId: "",
    ruleId: "",
    startsOn: tomorrow,
    endsOn: "",
    repeat: "DAILY",
    weekdays: [1, 2, 3, 4, 5],
  }));

  const publishedRules = useMemo(() => newestPublishedRules(rules), [rules]);
  const selectedRule = useMemo(
    () => publishedRules.find(rule => rule.policy_rule_id === form.ruleId) ?? null,
    [form.ruleId, publishedRules],
  );
  const startMin = selectedRule?.effective_from && selectedRule.effective_from > tomorrow
    ? selectedRule.effective_from
    : tomorrow;

  const refresh = useCallback(async () => {
    const request = ++refreshGeneration.current;
    if (preview) {
      if (request !== refreshGeneration.current) return;
      setRules(previewRules);
      setAssignments(previewAssignments);
      setLoading(false);
      return;
    }
    if (!familyId) {
      if (request !== refreshGeneration.current) return;
      setRules([]);
      setAssignments([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const [registry, assignmentList] = await Promise.all([
        supabase.rpc("list_parent_rule_registry", { p_family_id: familyId }),
        supabase.rpc("list_parent_activity_assignments", { p_family_id: familyId }),
      ]);
      if (registry.error) throw registry.error;
      if (assignmentList.error) throw assignmentList.error;
      if (request !== refreshGeneration.current) return;
      setRules((registry.data ?? []) as RuleRegistryRow[]);
      setAssignments((assignmentList.data ?? []) as AssignmentRow[]);
    } catch (error) {
      if (request !== refreshGeneration.current) return;
      toast.error(errorMessage(error, "활동 배정 목록을 불러오지 못했습니다."));
    } finally {
      if (request === refreshGeneration.current) setLoading(false);
    }
  }, [familyId, preview]);

  useEffect(() => {
    void refresh();
    return () => { refreshGeneration.current += 1; };
  }, [refresh]);

  useEffect(() => {
    if (refreshKey === undefined) return;
    void refresh();
  }, [refresh, refreshKey]);

  useEffect(() => {
    const updateFamilyToday = () => setFamilyToday(familyBusinessDate(timezone));
    updateFamilyToday();
    const timer = window.setInterval(updateFamilyToday, 60_000);
    return () => window.clearInterval(timer);
  }, [timezone]);

  useEffect(() => {
    setForm(current => ({
      ...current,
      childId: activeChildren.some(child => child.id === current.childId) ? current.childId : (activeChildren[0]?.id ?? ""),
      startsOn: current.startsOn < tomorrow ? tomorrow : current.startsOn,
    }));
  }, [activeChildren, tomorrow]);

  useEffect(() => {
    if (form.startsOn < startMin) {
      setForm(current => ({ ...current, startsOn: startMin }));
    }
  }, [form.startsOn, startMin]);

  const updateForm = <K extends keyof AssignmentForm>(key: K, value: AssignmentForm[K]) => {
    setForm(current => ({ ...current, [key]: value }));
  };

  const toggleWeekday = (weekday: number) => {
    setForm(current => ({
      ...current,
      weekdays: current.weekdays.includes(weekday)
        ? current.weekdays.filter(value => value !== weekday)
        : [...current.weekdays, weekday].sort((left, right) => left - right),
    }));
  };

  const createAssignment = async () => {
    if (creating.current) return;
    const currentTomorrow = nextBusinessDate(familyBusinessDate(timezone));
    const currentStartMin = selectedRule?.effective_from && selectedRule.effective_from > currentTomorrow
      ? selectedRule.effective_from
      : currentTomorrow;
    if (preview) {
      toast.message("미리보기에서는 배정을 저장하지 않습니다.");
      return;
    }
    if (!form.childId) return toast.error("현재 활성 자녀를 선택해 주세요.");
    if (!selectedRule) return toast.error("게시된 활동 규칙을 선택해 주세요.");
    if (form.startsOn < currentStartMin) return toast.error("시작일은 가족 시간대 기준 내일과 규칙 효력일 이후여야 합니다.");
    if (form.repeat === "DAILY" && form.weekdays.length === 0) return toast.error("반복할 요일을 하나 이상 선택해 주세요.");
    if (form.repeat === "DAILY" && form.endsOn && form.endsOn < form.startsOn) return toast.error("종료일은 시작일보다 빠를 수 없습니다.");

    const weekdays = form.repeat === "ONCE" ? [isoWeekday(form.startsOn)] : form.weekdays;
    const endsOn = form.repeat === "ONCE" ? form.startsOn : (form.endsOn || null);
    creating.current = true;
    setSaving(true);
    try {
      const { error } = await supabase.rpc("create_activity_assignment", {
        p_family_id: familyId,
        p_child_profile_id: form.childId,
        p_policy_rule_id: selectedRule.policy_rule_id,
        p_starts_on: form.startsOn,
        p_ends_on: endsOn,
        p_weekdays: weekdays,
        p_repeat: form.repeat,
      });
      if (error) throw error;
      await refresh();
      await onChanged?.();
      toast.success(form.repeat === "ONCE" ? "하루 활동을 배정했습니다." : "반복 활동을 배정했습니다.");
    } catch (error) {
      toast.error(assignmentErrorMessage(error));
    } finally {
      creating.current = false;
      setSaving(false);
    }
  };

  const endAssignment = async (assignment: AssignmentRow) => {
    if (preview) {
      toast.message("미리보기에서는 종료일을 저장하지 않습니다.");
      return;
    }
    const earliestEnd = assignment.starts_on > familyToday ? assignment.starts_on : familyToday;
    const requestedEnd = endDates[assignment.assignment_id] ?? earliestEnd;
    if (requestedEnd < earliestEnd) {
      toast.error("종료일은 오늘과 시작일 중 더 늦은 날짜보다 빠를 수 없습니다.");
      return;
    }
    if (assignment.ends_on && requestedEnd > assignment.ends_on) {
      toast.error("이미 정한 종료일 이후로는 연장할 수 없습니다. 새 배정을 만들어 주세요.");
      return;
    }

    setEndingId(assignment.assignment_id);
    try {
      const { error } = await supabase.rpc("end_activity_assignment", {
        p_assignment_id: assignment.assignment_id,
        p_ends_on: requestedEnd,
      });
      if (error) throw error;
      await refresh();
      await onChanged?.();
      toast.success(`${formatDate(requestedEnd)}까지 활동을 종료하도록 저장했습니다.`);
    } catch (error) {
      toast.error(assignmentErrorMessage(error));
    } finally {
      setEndingId(null);
    }
  };

  return (
    <section className="rounded-[28px] bg-white p-6 shadow-[0_16px_48px_rgba(51,58,68,.08)] sm:p-8" aria-labelledby="parent-activity-settings-title">
      <div className="flex flex-col gap-4 border-b border-black/8 pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold text-[#4d2ddc]">ACTIVITY ASSIGNMENTS</p>
          <h2 id="parent-activity-settings-title" className="mt-1 text-2xl font-bold tracking-[-0.04em]">자녀 활동 배정</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[#747670]">
            게시된 규칙을 현재 활성 자녀에게 배정합니다. 배정 뒤에도 선택한 규칙 버전은 고정되어, 이후 새 규칙을 게시해도 기존 기록의 기준은 바뀌지 않습니다.
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-2xl bg-[#edf7f3] px-3 py-2 text-xs leading-5 text-[#315045]">
          <ShieldCheck className="h-4 w-4 shrink-0" />
          가족 시간대({timezone}) 기준 내일부터 시작
        </div>
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="assignment-child">자녀</Label>
            <select id="assignment-child" value={form.childId} disabled={saving || activeChildren.length === 0} onChange={event => updateForm("childId", event.target.value)} className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
              {activeChildren.length === 0 ? <option value="">활성 자녀가 없습니다</option> : activeChildren.map(child => <option key={child.id} value={child.id}>{child.display_name}</option>)}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="assignment-rule">게시된 활동 규칙</Label>
            <select id="assignment-rule" value={form.ruleId} disabled={saving || publishedRules.length === 0} onChange={event => updateForm("ruleId", event.target.value)} className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
              <option value="">활동을 선택하세요</option>
              {publishedRules.map(rule => <option key={rule.policy_rule_id} value={rule.policy_rule_id}>{rule.name} · {categoryLabels[rule.category_code] ?? rule.category_code}</option>)}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="assignment-start">시작일</Label>
            <Input id="assignment-start" type="date" min={startMin} value={form.startsOn} disabled={saving || publishedRules.length === 0} onChange={event => updateForm("startsOn", event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="assignment-repeat">배정 방식</Label>
            <select id="assignment-repeat" value={form.repeat} disabled={saving || publishedRules.length === 0} onChange={event => updateForm("repeat", event.target.value as AssignmentForm["repeat"])} className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
              <option value="DAILY">매주 반복</option>
              <option value="ONCE">하루만</option>
            </select>
          </div>
          {form.repeat === "DAILY" ? <>
            <fieldset className="space-y-2 sm:col-span-2">
              <legend className="text-sm font-medium leading-none">반복 요일</legend>
              <div className="flex flex-wrap gap-2 pt-1">
                {weekDays.map(day => <label key={day.value} className={`cursor-pointer rounded-full border px-3 py-2 text-xs font-semibold transition-colors ${form.weekdays.includes(day.value) ? "border-[#4d2ddc] bg-[#f0edfa] text-[#4d2ddc]" : "border-black/10 bg-white text-[#777a74]"}`}>
                  <input className="sr-only" type="checkbox" checked={form.weekdays.includes(day.value)} onChange={() => toggleWeekday(day.value)} disabled={saving || publishedRules.length === 0} />
                  {day.label}
                </label>)}
              </div>
            </fieldset>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="assignment-end">종료일 <span className="font-normal text-muted-foreground">(선택)</span></Label>
              <Input id="assignment-end" type="date" min={form.startsOn || startMin} value={form.endsOn} disabled={saving || publishedRules.length === 0} onChange={event => updateForm("endsOn", event.target.value)} />
            </div>
          </> : <p className="rounded-xl bg-[#f5f3ed] px-4 py-3 text-xs leading-5 text-[#62656a] sm:col-span-2">하루 배정은 시작일과 종료일이 같은 날로 저장됩니다. 그 날짜의 요일만 적용합니다.</p>}
        </div>

        <aside className="rounded-2xl bg-[#f5f3ed] p-4">
          <CalendarDays className="h-5 w-5 text-[#4d2ddc]" />
          <p className="mt-3 text-sm font-bold">선택 전 확인</p>
          {selectedRule ? <div className="mt-2 text-xs leading-5 text-[#666963]">
            <p><strong>{selectedRule.name}</strong> · 부모 확인: {selectedRule.metric_label}</p>
            <p className="mt-2">이 버전은 {selectedRule.effective_from ? formatDate(selectedRule.effective_from) : "게시 효력일"}부터 사용할 수 있습니다.</p>
          </div> : <p className="mt-2 text-xs leading-5 text-[#666963]">활동을 고르면 이 배정에 고정될 게시 규칙과 시작 가능일을 확인할 수 있습니다.</p>}
          <div className="mt-4 rounded-xl bg-white p-3 text-xs leading-5 text-[#555852]">
            보상·차감은 자녀 체크만으로 확정되지 않습니다. 부모 점수 확인 뒤에도 <strong>정산 연결 전에는 사용할 수 없습니다.</strong>
          </div>
        </aside>
      </div>

      <div className="mt-6 flex flex-col gap-3 border-t border-black/8 pt-6 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs leading-5 text-[#777a74]">
          {publishedRules.length === 0 ? "위의 규칙을 먼저 초안 저장하고 게시하세요" : activeChildren.length === 0 ? "배정하려면 현재 ACTIVE 상태인 자녀가 필요합니다." : `가장 이른 시작일: ${formatDate(startMin)}`}
        </p>
        <Button type="button" className="rounded-xl bg-[#4d2ddc] text-white hover:bg-[#3d20c7]" disabled={saving || !familyId || !form.childId || !selectedRule || publishedRules.length === 0} onClick={() => void createAssignment()}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          활동 배정
        </Button>
      </div>

      <div className="mt-8 border-t border-black/8 pt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h3 className="font-bold">배정한 활동</h3><p className="mt-1 text-xs text-[#777a74]">현재 배정 목록입니다. 일정이 겹치면 저장되지 않으며, 기존 배정의 규칙 버전은 바뀌지 않습니다.</p></div>
          <Button type="button" variant="outline" size="sm" disabled={loading || saving || preview} onClick={() => void refresh()}><RefreshCw className="h-4 w-4" /> 새로고침</Button>
        </div>
        {loading ? <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-[#4d2ddc]" /></div> : assignments.length === 0 ? (
          <div className="mt-4 rounded-2xl bg-[#f5f3ed] px-4 py-6 text-center text-sm text-[#777a74]">아직 자녀에게 배정한 활동이 없습니다.</div>
        ) : (
          <div className="mt-4 space-y-3">
            {assignments.map(assignment => {
              const earliestEnd = assignment.starts_on > familyToday ? assignment.starts_on : familyToday;
              const requestedEnd = endDates[assignment.assignment_id] ?? earliestEnd;
              const ending = endingId === assignment.assignment_id;
              return <article key={assignment.assignment_id} className="rounded-2xl border border-black/8 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div><div className="flex flex-wrap items-center gap-2"><h4 className="font-bold">{assignment.activity_name}</h4><span className="rounded-full bg-[#f0edfa] px-2.5 py-1 text-[10px] font-bold text-[#5b46a3]">{assignment.repeat_kind === "ONCE" ? "하루" : "반복"}</span></div><p className="mt-1 text-xs text-[#777a74]">{assignment.child_name} · {categoryLabels[assignment.category_code] ?? assignment.category_code}</p></div>
                <CheckCircle2 className="h-5 w-5 text-[#4d2ddc]" aria-label="배정됨" />
              </div>
              <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2"><span className="rounded-lg bg-[#f5f3ed] px-3 py-2">시작 {formatDate(assignment.starts_on)}{assignment.ends_on ? ` · 종료 ${formatDate(assignment.ends_on)}` : " · 종료일 없음"}</span><span className="rounded-lg bg-[#f5f3ed] px-3 py-2">{assignment.repeat_kind === "ONCE" ? "선택한 하루" : `반복 요일: ${assignment.weekdays.map(value => weekDays.find(day => day.value === value)?.label).filter(Boolean).join(" · ")}`}</span></div>
              {assignment.repeat_kind === "DAILY" && <div className="mt-4 grid gap-3 border-t border-black/8 pt-4 sm:grid-cols-[minmax(0,220px)_auto] sm:items-end"><div className="space-y-2"><Label htmlFor={`assignment-end-${assignment.assignment_id}`}>이 날짜까지 종료</Label><Input id={`assignment-end-${assignment.assignment_id}`} type="date" min={earliestEnd} max={assignment.ends_on ?? undefined} value={requestedEnd} disabled={Boolean(endingId)} onChange={event => setEndDates(current => ({ ...current, [assignment.assignment_id]: event.target.value }))} /><p className="text-xs leading-5 text-[#777a74]">오늘 이전에는 끝낼 수 없고, 이미 정한 종료일은 연장할 수 없습니다.</p></div><Button type="button" variant="outline" disabled={Boolean(endingId) || !requestedEnd} onClick={() => void endAssignment(assignment)}>{ending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarDays className="h-4 w-4" />} 이 날짜까지 종료</Button></div>}
            </article>;
            })}
          </div>
        )}
        {!loading && assignments.length > 0 && <p className="mt-4 flex items-start gap-2 text-xs leading-5 text-[#777a74]"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />활동 변경이 필요하면 새 규칙 버전을 게시하고 새 배정을 만드세요. 이미 배정된 규칙은 기록 재현을 위해 그대로 보존됩니다.</p>}
      </div>
    </section>
  );
}
