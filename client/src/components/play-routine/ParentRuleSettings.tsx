import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/lib/supabase";
import {
  buildThreeRuleBands,
  formatBand,
  MEASUREMENT_KINDS,
  PASS_METRIC_LABEL,
  RULE_CATEGORIES,
  isPassMeasurementKind,
  type MeasurementKind,
  type RuleCategory,
  validatePassRule,
  validateNumericRule,
} from "@/lib/rule-registry";
import { CheckCircle2, Clock3, FilePlus2, Loader2, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

type RuleRegistryRow = {
  config_version_id: string;
  policy_rule_id: string;
  activity_template_id: string;
  status: "DRAFT" | "PUBLISHED";
  effective_from: string | null;
  name: string;
  category_code: RuleCategory;
  description: string | null;
  measurement_kind: MeasurementKind;
  metric_label: string;
  penalty_limit: number | string;
  reward_limit: number | string;
  penalty_minutes: number | string;
  reward_minutes: number | string;
  created_at: string;
};

type DraftForm = {
  name: string;
  category: RuleCategory;
  description: string;
  measurementKind: MeasurementKind;
  metricLabel: string;
  penaltyLimit: string;
  rewardLimit: string;
  penaltyMinutes: string;
  rewardMinutes: string;
};

const initialDraft: DraftForm = {
  name: "",
  category: "DAILY_STUDY",
  description: "",
  measurementKind: "PASS_FAIL",
  metricLabel: PASS_METRIC_LABEL,
  penaltyLimit: "50",
  rewardLimit: "80",
  penaltyMinutes: "0",
  rewardMinutes: "",
};

const categoryLabels: Record<RuleCategory, string> = {
  DAILY_STUDY: "매일 공부",
  SPECIAL_SCHEDULE: "스페셜 일정",
  LIFE_HABIT: "생활 습관",
  OTHER: "기타",
};

const measurementLabels: Record<MeasurementKind, string> = {
  PERCENT: "퍼센트(0~100)",
  QUANTITY: "수량 점수(0~100)",
  PASS_FAIL: "약속 PASS / 확인 필요",
};

function asNumber(value: string) {
  if (value.trim() === "") return Number.NaN;
  return Number(value);
}

function dateLabel(value: string | null) {
  if (!value) return "게시 전";
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "long" }).format(new Date(`${value}T00:00:00`));
}

/**
 * 부모 대시보드에서 familyId가 확보된 위치에 독립적으로 삽입하는 룰 등록 패널.
 * Home/ParentDashboard의 인증·레이아웃을 수정하지 않는다.
 */
export default function ParentRuleSettings({ familyId, preview = false, onPublished }: { familyId: string; preview?: boolean; onPublished?: () => void }) {
  const [draft, setDraft] = useState<DraftForm>(initialDraft);
  const [rows, setRows] = useState<RuleRegistryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [publishingId, setPublishingId] = useState<string | null>(null);

  const isPassRule = isPassMeasurementKind(draft.measurementKind);

  const numericInput = useMemo(() => ({
    penaltyLimit: asNumber(draft.penaltyLimit),
    rewardLimit: asNumber(draft.rewardLimit),
    penaltyMinutes: asNumber(draft.penaltyMinutes),
    rewardMinutes: asNumber(draft.rewardMinutes),
  }), [draft.penaltyLimit, draft.rewardLimit, draft.penaltyMinutes, draft.rewardMinutes]);

  const numericErrors = useMemo(() => validateNumericRule(numericInput), [numericInput]);
  const passErrors = useMemo(() => validatePassRule({ rewardMinutes: numericInput.rewardMinutes }), [numericInput.rewardMinutes]);
  const formErrors = isPassRule ? passErrors : numericErrors;
  const previewBands = useMemo(() => {
    if (isPassRule) return null;
    if (numericErrors.length > 0) return null;
    try {
      return buildThreeRuleBands(numericInput);
    } catch {
      return null;
    }
  }, [isPassRule, numericErrors, numericInput]);

  const update = <K extends keyof DraftForm>(key: K, value: DraftForm[K]) => {
    setDraft(current => ({ ...current, [key]: value }));
  };

  const refresh = useCallback(async () => {
    // 대시보드 디자인 미리보기는 네트워크·권한 오류 없이 정적 패널만 렌더링한다.
    if (!familyId || preview) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const { data, error } = await supabase.rpc("list_parent_rule_registry", { p_family_id: familyId });
      if (error) throw error;
      setRows((data ?? []) as RuleRegistryRow[]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "등록한 룰을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [familyId, preview]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveDraft = async () => {
    if (preview) return toast.message("미리보기에서는 저장하지 않습니다.");
    const name = draft.name.trim();
    const metricLabel = draft.metricLabel.trim();
    if (!name) return toast.error("활동 이름을 입력해 주세요.");
    if (!isPassRule && !metricLabel) return toast.error("부모가 확인할 측정 기준을 직접 입력해 주세요.");
    if (formErrors.length > 0) return toast.error(formErrors[0]);

    setSaving(true);
    try {
      const { error } = isPassRule
        ? await supabase.rpc("save_parent_pass_rule_draft", {
          p_family_id: familyId,
          p_name: name,
          p_category_code: draft.category,
          p_description: draft.description.trim() || null,
          p_metric_label: metricLabel || PASS_METRIC_LABEL,
          p_reward_minutes: numericInput.rewardMinutes,
        })
        : await supabase.rpc("save_parent_rule_draft", {
          p_family_id: familyId,
          p_name: name,
          p_category_code: draft.category,
          p_description: draft.description.trim() || null,
          p_measurement_kind: draft.measurementKind,
          p_metric_label: metricLabel,
          p_penalty_limit: numericInput.penaltyLimit,
          p_reward_limit: numericInput.rewardLimit,
          p_reward_minutes: numericInput.rewardMinutes,
          p_penalty_minutes: numericInput.penaltyMinutes,
        });
      if (error) throw error;
      setDraft(initialDraft);
      await refresh();
      toast.success("초안으로 저장했습니다. 아직 오늘의 기록이나 정산에는 연결되지 않습니다.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "초안 저장에 실패했습니다.");
    } finally {
      setSaving(false);
    }
  };

  const publish = async (configVersionId: string) => {
    if (preview) return toast.message("미리보기에서는 게시하지 않습니다.");
    setPublishingId(configVersionId);
    try {
      const { data, error } = await supabase.rpc("publish_parent_rule_draft", {
        p_config_version_id: configVersionId,
      });
      if (error) throw error;
      const effectiveFrom = (data?.[0] as { effective_from?: string } | undefined)?.effective_from;
      await refresh();
      onPublished?.();
      toast.success(`게시했습니다. ${dateLabel(effectiveFrom ?? null)}부터 새 규칙이 적용됩니다.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "게시할 수 없습니다. 세 구간과 시간 효과를 확인해 주세요.");
    } finally {
      setPublishingId(null);
    }
  };

  const startNewVersion = (row: RuleRegistryRow) => {
    setDraft({
      name: row.name,
      category: row.category_code,
      description: row.description ?? "",
      measurementKind: row.measurement_kind,
      metricLabel: row.metric_label,
      penaltyLimit: String(row.penalty_limit),
      rewardLimit: String(row.reward_limit),
      penaltyMinutes: String(row.penalty_minutes),
      rewardMinutes: String(row.reward_minutes),
    });
    document.getElementById("parent-rule-settings-title")?.scrollIntoView({ behavior: "smooth", block: "start" });
    toast.message(`“${row.name}”의 새 버전을 준비합니다. 저장하면 같은 활동의 새 초안이 만들어집니다.`);
  };

  return (
    <section className="rounded-[28px] bg-white p-6 shadow-[0_16px_48px_rgba(51,58,68,.08)] sm:p-8" aria-labelledby="parent-rule-settings-title">
      <div className="flex flex-col gap-4 border-b border-black/8 pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold text-[#4d2ddc]">RULE REGISTRY</p>
          <h2 id="parent-rule-settings-title" className="mt-1 text-2xl font-bold tracking-[-0.04em]">부모 룰 등록</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[#747670]">
            지금 초안을 저장하고, 검토한 뒤 별도로 게시하세요. 게시한 룰은 <strong>가족 시간대 기준 내일부터</strong> 효력이 생기며 오늘·과거 기록을 다시 쓰지 않습니다.
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-2xl bg-[#f5f3ed] px-3 py-2 text-xs leading-5 text-[#575a54]">
          <ShieldCheck className="h-4 w-4 shrink-0 text-[#4d2ddc]" />
          부모 확인 미완료는 hold이며 패널티가 아닙니다.
        </div>
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="rule-name">활동 이름</Label>
            <Input id="rule-name" value={draft.name} onChange={event => update("name", event.target.value)} placeholder="예: 수학 문제 풀이" disabled={saving} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="rule-category">분류</Label>
            <select id="rule-category" value={draft.category} onChange={event => update("category", event.target.value as RuleCategory)} disabled={saving} className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
              {RULE_CATEGORIES.map(category => <option key={category} value={category}>{categoryLabels[category]}</option>)}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="rule-measurement">측정 방식</Label>
            <select id="rule-measurement" value={draft.measurementKind} onChange={event => {
              const measurementKind = event.target.value as MeasurementKind;
              setDraft(current => ({
                ...current,
                measurementKind,
                metricLabel: measurementKind === "PASS_FAIL" ? PASS_METRIC_LABEL : current.metricLabel,
              }));
            }} disabled={saving} className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
              {MEASUREMENT_KINDS.map(kind => <option key={kind} value={kind}>{measurementLabels[kind]}</option>)}
            </select>
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="rule-description">설명 <span className="font-normal text-muted-foreground">(선택)</span></Label>
            <Textarea id="rule-description" value={draft.description} onChange={event => update("description", event.target.value)} placeholder="무엇을, 어떻게 확인할지 적어 주세요." maxLength={1000} disabled={saving} />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="rule-metric">부모 확인 측정 기준</Label>
            <Input id="rule-metric" value={draft.metricLabel} onChange={event => update("metricLabel", event.target.value)} placeholder={isPassRule ? PASS_METRIC_LABEL : draft.measurementKind === "PERCENT" ? "예: 채점한 정답률" : "예: 부모가 확인한 완료량 점수"} disabled={saving} readOnly={isPassRule} />
            <p className="text-xs leading-5 text-[#777a74]">{isPassRule ? "선생님의 문제 지적이 없었음을 부모가 확인하면 PASS입니다. 확인 자체가 없으면 유보이며, 연락 여부만으로 자동 판정하거나 패널티를 주지 않습니다. 약 복용은 별도 관리입니다." : "자녀 자기보고만으로 패널티를 확정하지 않습니다. 약 복용은 이 룰 등록 대상이 아닙니다."}</p>
          </div>
        </div>

        <aside className="rounded-2xl bg-[#f5f3ed] p-4">
          <p className="text-xs font-bold text-[#4d2ddc]">{isPassRule ? "PASS 약속" : "구간 미리보기"}</p>
          <p className="mt-2 text-xs leading-5 text-[#666963]">{isPassRule ? "점수나 기준값을 입력하지 않습니다. 부모가 그날 문제없음을 확인할 때만 등록한 기본 시간이 예정됩니다. 주간 현금·칭찬 보너스는 별도 수동 확인입니다." : "평가된 0~100 값은 빈틈 없이 세 구간 중 하나가 됩니다. 중간 구간은 항상 차감·보상 없음입니다."}</p>
          <div className="mt-4 space-y-2 text-sm">
            {isPassRule ? <>
              <div className="rounded-xl bg-white px-3 py-2"><strong className="block text-xs">문제없음 PASS</strong><span className="text-xs text-[#666963]">부모 확인 시 +{numericInput.rewardMinutes || 0}분 예정</span></div>
              <div className="rounded-xl bg-white px-3 py-2"><strong className="block text-xs">문제 있음 / 확인 필요</strong><span className="text-xs text-[#666963]">보상 없음 · 자동 패널티 없음</span></div>
              <p className="px-1 text-[11px] leading-5 text-[#777a74]">칭찬 보너스와 실제 정산은 별도 기능입니다.</p>
            </> : previewBands ? previewBands.map((band, index) => (
              <div key={index} className="rounded-xl bg-white px-3 py-2">
                <strong className="block text-xs">{formatBand(band)}</strong>
                <span className="text-xs text-[#666963]">
                  {band.outcome === "PENALTY" ? `패널티 · -${band.effectMinutes}분 후보 (부모 개별 확인)` : band.outcome === "REWARD" ? `보상 · +${band.effectMinutes}분` : "보상·차감 없음"}
                </span>
              </div>
            )) : <p className="rounded-xl bg-white px-3 py-4 text-xs text-[#9b453f]">하한·보상 기준과 시간 값을 입력하면 세 구간을 확인할 수 있습니다.</p>}
          </div>
        </aside>
      </div>

      <div className="mt-6 grid gap-4 border-t border-black/8 pt-6 sm:grid-cols-2">
        <div className="grid gap-4 sm:grid-cols-2">
          {isPassRule ? <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="pass-reward-minutes">PASS 기본 시간 보상 <span className="font-normal text-muted-foreground">(0 = 시간 보상 없음)</span></Label>
            <Input id="pass-reward-minutes" type="number" min="0" max="240" step="1" inputMode="numeric" value={draft.rewardMinutes} onChange={event => update("rewardMinutes", event.target.value)} placeholder="30" disabled={saving} />
            <p className="text-xs leading-5 text-[#777a74]">부모가 문제없음 PASS를 확인한 경우의 예정 시간입니다. 일일 현금 지급이 아니며, 주간 현금·칭찬 보너스와 실제 정산은 별도 수동 확인입니다.</p>
          </div> : <>
          <div className="space-y-2">
            <Label htmlFor="penalty-limit">하한 기준 <span className="font-normal text-muted-foreground">(미만)</span></Label>
            <Input id="penalty-limit" type="number" min="1" max="98" step="1" inputMode="decimal" value={draft.penaltyLimit} onChange={event => update("penaltyLimit", event.target.value)} placeholder="50" disabled={saving} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="reward-limit">보상 기준 <span className="font-normal text-muted-foreground">(이상)</span></Label>
            <Input id="reward-limit" type="number" min="2" max="99" step="1" inputMode="decimal" value={draft.rewardLimit} onChange={event => update("rewardLimit", event.target.value)} placeholder="80" disabled={saving} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="penalty-minutes">-분 <span className="font-normal text-muted-foreground">(0 = 패널티 없음)</span></Label>
            <Input id="penalty-minutes" type="number" min="0" max="240" step="1" inputMode="numeric" value={draft.penaltyMinutes} onChange={event => update("penaltyMinutes", event.target.value)} placeholder="0" disabled={saving} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="reward-minutes">+분 <span className="font-normal text-muted-foreground">(0 = 보상 없음)</span></Label>
            <Input id="reward-minutes" type="number" min="0" max="240" step="1" inputMode="numeric" value={draft.rewardMinutes} onChange={event => update("rewardMinutes", event.target.value)} placeholder="30" disabled={saving} />
          </div>
          </>}
        </div>
        <div className="flex flex-col justify-end gap-2">
          {formErrors.length > 0 && <p className="text-xs leading-5 text-[#9b453f]">{formErrors[0]}</p>}
          <Button type="button" disabled={saving || !familyId || preview} onClick={() => void saveDraft()} className="rounded-xl bg-[#4d2ddc] text-white hover:bg-[#3d20c7]">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <FilePlus2 className="h-4 w-4" />} 초안 저장
          </Button>
          <p className="text-center text-xs text-[#777a74]">게시한 뒤 아래에서 자녀에게 배정하세요. 사용 가능한 원장 정산은 별도입니다.</p>
        </div>
      </div>

      <div className="mt-8 border-t border-black/8 pt-6">
        <div className="flex items-center justify-between gap-3">
          <div><h3 className="font-bold">등록한 룰</h3><p className="mt-1 text-xs text-[#777a74]">초안은 수정 대신 새 초안으로 등록합니다. 게시본은 불변입니다.</p></div>
          <Button type="button" variant="outline" size="sm" onClick={() => void refresh()} disabled={loading || saving || preview}>새로고침</Button>
        </div>
        {loading ? <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-[#4d2ddc]" /></div> : rows.length === 0 ? (
          <div className="mt-4 rounded-2xl bg-[#f5f3ed] px-4 py-6 text-center text-sm text-[#777a74]">아직 등록한 룰이 없습니다.</div>
        ) : (
          <div className="mt-4 space-y-3">
            {rows.map(row => {
              const penalty = Number(row.penalty_minutes);
              const reward = Number(row.reward_minutes);
              const isPassRow = isPassMeasurementKind(row.measurement_kind);
              return <article key={row.config_version_id} className="rounded-2xl border border-black/8 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2"><h4 className="font-bold">{row.name}</h4><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${row.status === "PUBLISHED" ? "bg-[#e4f1eb] text-[#315f4d]" : "bg-[#f0edfa] text-[#5b46a3]"}`}>{row.status === "PUBLISHED" ? "게시됨" : "초안"}</span></div>
                    <p className="mt-1 text-xs text-[#777a74]">{categoryLabels[row.category_code]} · {measurementLabels[row.measurement_kind]} · 부모 확인: {row.metric_label}</p>
                    {row.description && <p className="mt-2 text-sm text-[#555852]">{row.description}</p>}
                  </div>
                  {row.status === "DRAFT" ? <Button type="button" disabled={publishingId === row.config_version_id || saving} onClick={() => void publish(row.config_version_id)} className="rounded-xl bg-[#333a44] text-white hover:bg-[#232932]">
                    {publishingId === row.config_version_id ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} 내일부터 게시
                  </Button> : <span className="inline-flex items-center gap-1 text-xs font-medium text-[#315f4d]"><Clock3 className="h-4 w-4" /> {dateLabel(row.effective_from)}부터</span>}
                </div>
                {isPassRow ? <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                  <span className="rounded-lg bg-[#edf7f3] px-3 py-2">문제없음 PASS: +{reward}분 예정</span>
                  <span className="rounded-lg bg-[#f5f3ed] px-3 py-2">문제 있음 / 확인 필요: 보상 없음 · 자동 패널티 없음</span>
                </div> : <div className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
                  <span className="rounded-lg bg-[#f5f3ed] px-3 py-2">0 ~ {Number(row.penalty_limit)} 미만: {penalty > 0 ? `-${penalty}분 후보` : "차감 없음"}</span>
                  <span className="rounded-lg bg-[#f5f3ed] px-3 py-2">{Number(row.penalty_limit)} ~ {Number(row.reward_limit)} 미만: 보상·차감 없음</span>
                  <span className="rounded-lg bg-[#f5f3ed] px-3 py-2">{Number(row.reward_limit)} ~ 100 이하: {reward > 0 ? `+${reward}분` : "보상 없음"}</span>
                </div>}
                <div className="mt-3"><Button type="button" variant="outline" size="sm" onClick={() => startNewVersion(row)} disabled={saving || preview}>이 룰의 새 버전</Button></div>
              </article>;
            })}
          </div>
        )}
      </div>
    </section>
  );
}
