import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { focusReinforcerRegistration } from "@/lib/reinforcer-navigation";
import { routineErrorMessage } from "@/lib/routine-v2-errors";
import {
  resumedRoutineStep,
  selectExistingReinforcer,
} from "@/lib/reinforcer-reuse";
import {
  categoryLabel,
  createEmptyRoutinePayload,
  dailyAdditionalLabel,
  emptyReward,
  emptyTier,
  iconLabel,
  isDraftPayloadDirty,
  newRoutineUuid,
  normalizeRoutinePayload as normalizePayload,
  periodLabel,
  ROUTINE_CATEGORIES,
  ROUTINE_PERIODS,
  stableRoutineJson,
  unitLabel,
  validateRoutineForPublish,
  visibleGraphemeLength,
} from "@/lib/routine-v2-form";
import { supabase } from "@/lib/supabase";
import type {
  ReinforcerRow,
  RoutineDraftPayload,
  RoutineDraftRow,
  RoutineRuleRow,
  RoutineTierInput,
} from "@shared/routine-v2";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  FilePlus2,
  Gift,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import RoutineReinforcers from "./RoutineReinforcers";
import ReinforcerTags from "./ReinforcerTags";

export type RoutineRuleWizardProps = {
  familyId: string;
  preview?: boolean;
  onPublished?: () => void;
};

type SavedDraft = {
  id: string | null;
  sourceRuleId: string | null;
  revision: number;
};
type SaveAttempt = { fingerprint: string; key: string };

const previewPayload: RoutineDraftPayload = {
  ...createEmptyRoutinePayload("DAILY"),
  name: "저녁 책 읽기",
  category: "DAILY_STUDY",
  childLabel: "책 읽기",
  criteria:
    "부모가 책을 읽고 난 뒤 내용을 한 가지 이상 이야기하는지 확인합니다.",
  stickerIcon: "STAMP",
  period: "WEEKLY",
  tiers: [
    {
      id: "preview-tier",
      label: "주간 기본",
      threshold: 5,
      operator: "GTE",
      rewards: [
        {
          id: "preview-reward",
          reinforcerId: "preview-min",
          amount: 30,
          text: "",
        },
      ],
    },
  ],
};
const previewReinforcers: ReinforcerRow[] = [
  { id: "preview-min", name: "자유 시간", unit: "MIN", unit_label: "분" },
  {
    id: "preview-string",
    name: "함께 할 약속",
    unit: "STRING",
    unit_label: "내용",
  },
];
const previewRules: RoutineRuleRow[] = [
  {
    id: "preview-rule",
    family_id: "preview",
    subject_ref_id: "preview-subject",
    name: "저녁 책 읽기",
    effective_from: "2099-01-01",
    version: 1,
    payload: previewPayload,
  },
];

function errorMessage(error: unknown, fallback: string) {
  return routineErrorMessage(error, fallback);
}

function isNetworkFailure(error: unknown) {
  const value = error as { status?: number; message?: string } | null;
  return (
    error instanceof TypeError ||
    value?.status === 0 ||
    /network|fetch|failed to fetch|load failed/i.test(value?.message ?? "")
  );
}

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

/** 신규 룰 전용 등록기. 초안은 불완전하게 저장하고, 게시에서만 서버와 동일한 완성 검증을 한다. */
export default function RoutineRuleWizard({
  familyId,
  preview = false,
  onPublished,
}: RoutineRuleWizardProps) {
  const [tab, setTab] = useState<"reward" | "penalty">("reward");
  const [payload, setPayload] = useState<RoutineDraftPayload>(() =>
    createEmptyRoutinePayload()
  );
  const [saved, setSaved] = useState<SavedDraft>({
    id: null,
    sourceRuleId: null,
    revision: 0,
  });
  const [step, setStep] = useState(1);
  const [drafts, setDrafts] = useState<RoutineDraftRow[]>([]);
  const [rules, setRules] = useState<RoutineRuleRow[]>(
    preview ? previewRules : []
  );
  const [reinforcers, setReinforcers] = useState<ReinforcerRow[]>(
    preview ? previewReinforcers : []
  );
  const [loading, setLoading] = useState(!preview);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [reinforcerBusy, setReinforcerBusy] = useState(false);
  const loadGeneration = useRef(0);
  const contextGeneration = useRef(0);
  const mounted = useRef(true);
  const mutationLocked = useRef(false);
  const saveAttempts = useRef(new Map<string, SaveAttempt>());
  const publishAttempts = useRef(new Map<string, string>());

  const publishErrors = useMemo(
    () => validateRoutineForPublish(payload, reinforcers),
    [payload, reinforcers]
  );
  const childLabelLength = visibleGraphemeLength(payload.childLabel);
  const activeDraft = saved.id
    ? drafts.find(draft => draft.id === saved.id)
    : null;
  const activeDraftDirty = Boolean(
    saved.id && isDraftPayloadDirty(payload, activeDraft?.payload)
  );
  const mutationBusy = saving || Boolean(publishingId) || reinforcerBusy;
  const actionDisabled = mutationBusy || loading;

  const isCurrentContext = (requestContext: number) =>
    mounted.current && requestContext === contextGeneration.current;
  const beginMutation = () => {
    if (mutationLocked.current || loading || loadError) return null;
    mutationLocked.current = true;
    setMutationError(null);
    return contextGeneration.current;
  };
  const endMutation = (requestContext: number) => {
    if (isCurrentContext(requestContext)) mutationLocked.current = false;
  };

  const refresh = useCallback(async () => {
    const request = ++loadGeneration.current;
    const requestContext = contextGeneration.current;
    if (preview) {
      if (
        request !== loadGeneration.current ||
        !isCurrentContext(requestContext)
      )
        return;
      setDrafts([]);
      setRules(previewRules);
      setReinforcers(previewReinforcers);
      setLoading(false);
      setLoadError(null);
      return;
    }
    if (!familyId) {
      if (
        request !== loadGeneration.current ||
        !isCurrentContext(requestContext)
      )
        return;
      setDrafts([]);
      setRules([]);
      setReinforcers([]);
      setLoading(false);
      setLoadError(null);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const [registryResult, reinforcerResult] = await Promise.all([
        supabase.rpc("list_routine_registry", { p_family_id: familyId }),
        supabase.rpc("list_routine_reinforcers", { p_family_id: familyId }),
      ]);
      if (registryResult.error) throw registryResult.error;
      if (reinforcerResult.error) throw reinforcerResult.error;
      if (
        request !== loadGeneration.current ||
        !isCurrentContext(requestContext)
      )
        return;
      const registry = (registryResult.data ?? { drafts: [], rules: [] }) as {
        drafts?: RoutineDraftRow[];
        rules?: RoutineRuleRow[];
      };
      setDrafts(registry.drafts ?? []);
      setRules(registry.rules ?? []);
      setReinforcers((reinforcerResult.data ?? []) as ReinforcerRow[]);
    } catch (error) {
      if (
        request !== loadGeneration.current ||
        !isCurrentContext(requestContext)
      )
        return;
      setLoadError(errorMessage(error, "룰 등록 목록을 불러오지 못했습니다."));
    } finally {
      if (
        request === loadGeneration.current &&
        isCurrentContext(requestContext)
      )
        setLoading(false);
    }
  }, [familyId, preview]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      contextGeneration.current += 1;
      loadGeneration.current += 1;
      mutationLocked.current = false;
    };
  }, []);

  useEffect(() => {
    // familyId 변화는 초안 ID와 이전 카탈로그 선택을 절대 넘기지 않는다.
    contextGeneration.current += 1;
    loadGeneration.current += 1;
    mutationLocked.current = false;
    setSaving(false);
    setPublishingId(null);
    setReinforcerBusy(false);
    setPayload(createEmptyRoutinePayload());
    setSaved({ id: null, sourceRuleId: null, revision: 0 });
    setStep(1);
    setDrafts([]);
    setRules(preview ? previewRules : []);
    setReinforcers(preview ? previewReinforcers : []);
    setLoading(!preview && Boolean(familyId));
    setLoadError(null);
    setMutationError(null);
    saveAttempts.current.clear();
    publishAttempts.current.clear();
  }, [familyId, preview]);

  useEffect(() => {
    void refresh();
    return () => {
      loadGeneration.current += 1;
    };
  }, [refresh]);

  const update = <K extends keyof RoutineDraftPayload>(
    key: K,
    value: RoutineDraftPayload[K]
  ) => {
    if (mutationBusy) return;
    setPayload(current => ({ ...current, [key]: value }));
  };

  const updateTier = (tierIndex: number, patch: Partial<RoutineTierInput>) => {
    if (mutationBusy) return;
    setPayload(current => ({
      ...current,
      tiers: current.tiers.map((tier, index) =>
        index === tierIndex ? { ...tier, ...patch } : tier
      ),
    }));
  };

  const addReward = (tierIndex: number) => {
    if (mutationBusy) return;
    setPayload(current => ({
      ...current,
      tiers: current.tiers.map((tier, index) =>
        index === tierIndex && tier.rewards.length < 2
          ? { ...tier, rewards: [...tier.rewards, emptyReward()] }
          : tier
      ),
    }));
  };
  const updateReward = (
    tierIndex: number,
    rewardIndex: number,
    patch: Record<string, unknown>
  ) => {
    if (mutationBusy) return;
    setPayload(current => ({
      ...current,
      tiers: current.tiers.map((tier, index) =>
        index !== tierIndex
          ? tier
          : {
              ...tier,
              rewards: tier.rewards.map((reward, rewardNumber) =>
                rewardNumber === rewardIndex ? { ...reward, ...patch } : reward
              ),
            }
      ),
    }));
  };
  const removeReward = (tierIndex: number, rewardIndex: number) => {
    if (mutationBusy) return;
    setPayload(current => ({
      ...current,
      tiers: current.tiers.map((tier, index) =>
        index !== tierIndex
          ? tier
          : {
              ...tier,
              rewards: tier.rewards.filter(
                (_, rewardNumber) => rewardNumber !== rewardIndex
              ),
            }
      ),
    }));
  };

  const changeFlow = (flow: "DAILY" | "QUEST") => {
    if (mutationBusy) return;
    const next = createEmptyRoutinePayload(flow);
    setPayload(current => ({
      ...next,
      name: current.name,
      category: current.category,
      childLabel: current.childLabel,
      criteria: current.criteria,
    }));
  };

  const saveDraft = async (stepToSave = step) => {
    if (preview) return toast.message("미리보기에서는 임시저장하지 않습니다.");
    if (!familyId || mutationBusy || loading || loadError) return;
    const requestContext = beginMutation();
    if (requestContext === null) return;
    // 재시도할 때는 같은 멱등 키에 정확히 같은 JSON payload 스냅샷을 보낸다.
    const requestPayload = normalizePayload(payload);
    const expectedRevision = saved.revision;
    const fingerprint = stableRoutineJson({
      familyId,
      draftId: saved.id,
      sourceRuleId: saved.sourceRuleId,
      step: stepToSave,
      expectedRevision,
      payload: requestPayload,
    });
    const existing = saveAttempts.current.get(fingerprint);
    const idempotencyKey = existing?.key ?? newRoutineUuid();
    saveAttempts.current.set(fingerprint, { fingerprint, key: idempotencyKey });
    setSaving(true);
    try {
      const { data, error } = await supabase.rpc("save_routine_draft", {
        p_family_id: familyId,
        p_draft_id: saved.id,
        p_source_rule_id: saved.sourceRuleId,
        p_step: stepToSave,
        p_payload: requestPayload,
        p_expected_revision: expectedRevision,
        p_idempotency_key: idempotencyKey,
      });
      if (error) throw error;
      if (!isCurrentContext(requestContext)) return;
      const row = data as RoutineDraftRow;
      saveAttempts.current.delete(fingerprint);
      setSaved({
        id: row.id,
        sourceRuleId: row.source_rule_id,
        revision: row.revision,
      });
      setPayload(normalizePayload(row.payload));
      setStep(row.step >= 1 && row.step <= 3 ? row.step : stepToSave);
      setDrafts(current => [
        row,
        ...current.filter(item => item.id !== row.id),
      ]);
      toast.success(
        "임시저장했습니다. 아직 자녀 배정·보상 권리·지급은 생기지 않습니다."
      );
    } catch (error) {
      if (!isCurrentContext(requestContext)) return;
      const message = isNetworkFailure(error)
        ? "연결 결과를 알 수 없습니다. 같은 내용으로 다시 누르면 안전하게 재시도합니다."
        : errorMessage(error, "임시저장하지 못했습니다.");
      setMutationError(message);
      toast.error(message);
    } finally {
      if (isCurrentContext(requestContext)) setSaving(false);
      endMutation(requestContext);
    }
  };

  const resumeDraft = (draft: RoutineDraftRow) => {
    if (mutationBusy) return;
    setMutationError(null);
    setPayload(normalizePayload(draft.payload));
    setSaved({
      id: draft.id,
      sourceRuleId: draft.source_rule_id,
      revision: draft.revision,
    });
    setTab("reward");
    setStep(resumedRoutineStep(draft));
    const registration = document.getElementById(
      "reinforcer-registration-form"
    ) as HTMLDetailsElement | null;
    if (registration) registration.open = false;
    window.setTimeout(
      () =>
        document
          .getElementById("routine-rule-wizard-title")
          ?.scrollIntoView({ behavior: "smooth", block: "start" }),
      0
    );
    toast.message(
      "초안을 불러왔습니다. 이어서 수정한 뒤 각 단계에서 임시저장할 수 있습니다."
    );
  };

  const newDraft = () => {
    if (mutationBusy) return;
    setMutationError(null);
    setPayload(createEmptyRoutinePayload());
    setSaved({ id: null, sourceRuleId: null, revision: 0 });
    setStep(1);
  };

  const newVersion = (rule: RoutineRuleRow) => {
    if (mutationBusy) return;
    setMutationError(null);
    // 게시본 자체는 변경하지 않고, 복사본을 별도 DRAFT 원천 버전으로 저장한다.
    setPayload(normalizePayload(rule.payload));
    setSaved({ id: null, sourceRuleId: rule.id, revision: 0 });
    setStep(1);
    window.setTimeout(
      () =>
        document
          .getElementById("routine-rule-wizard-title")
          ?.scrollIntoView({ behavior: "smooth", block: "start" }),
      0
    );
    toast.message(
      `“${rule.name}”의 새 버전을 준비합니다. 먼저 초안으로 저장하세요.`
    );
  };

  const publish = async (draft: RoutineDraftRow) => {
    if (preview) return toast.message("미리보기에서는 게시하지 않습니다.");
    if (mutationBusy || loading || loadError) return;
    if (draft.id === saved.id && isDraftPayloadDirty(payload, draft.payload)) {
      toast.message(
        "현재 편집 내용은 아직 저장되지 않았습니다. 임시저장 후 게시해 주세요."
      );
      return;
    }
    const requestContext = beginMutation();
    if (requestContext === null) return;
    // RPC는 draft의 저장된 payload/revision만 게시하므로, 화면의 미저장 편집본은 절대 게시하지 않는다.
    const errors = validateRoutineForPublish(draft.payload, reinforcers);
    if (errors.length) {
      setMutationError(errors[0]);
      toast.error(errors[0]);
      endMutation(requestContext);
      return;
    }
    const fingerprint = `${draft.id}:${draft.revision}`;
    const idempotencyKey =
      publishAttempts.current.get(fingerprint) ?? newRoutineUuid();
    publishAttempts.current.set(fingerprint, idempotencyKey);
    setPublishingId(draft.id);
    try {
      const { data, error } = await supabase.rpc("publish_routine_draft", {
        p_draft_id: draft.id,
        p_expected_revision: draft.revision,
        p_idempotency_key: idempotencyKey,
      });
      if (error) throw error;
      if (!isCurrentContext(requestContext)) return;
      publishAttempts.current.delete(fingerprint);
      const rule = data as RoutineRuleRow;
      setRules(current => [
        rule,
        ...current.filter(item => item.id !== rule.id),
      ]);
      setDrafts(current => current.filter(item => item.id !== draft.id));
      // publishingId가 아직 남아 있으므로 newDraft의 interactive guard를 거치지 않는다.
      if (saved.id === draft.id) {
        setPayload(createEmptyRoutinePayload());
        setSaved({ id: null, sourceRuleId: null, revision: 0 });
        setStep(1);
      }
      await refresh();
      if (!isCurrentContext(requestContext)) return;
      onPublished?.();
      toast.success(
        `내일부터 게시했습니다. ${dateLabel(rule.effective_from)}부터 사용할 수 있습니다.`
      );
    } catch (error) {
      if (!isCurrentContext(requestContext)) return;
      const message = isNetworkFailure(error)
        ? "연결 결과를 알 수 없습니다. 같은 게시 버튼을 다시 누르면 안전하게 재시도합니다."
        : errorMessage(error, "게시하지 못했습니다.");
      setMutationError(message);
      toast.error(message);
    } finally {
      if (isCurrentContext(requestContext)) setPublishingId(null);
      endMutation(requestContext);
    }
  };

  const stepContent = (() => {
    const disabled = actionDisabled;
    if (step === 1)
      return (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="grid gap-4 sm:grid-cols-2">
            <fieldset className="space-y-2 sm:col-span-2">
              <legend className="text-sm font-medium">활동 유형</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                <Button
                  type="button"
                  variant={payload.flow === "DAILY" ? "default" : "outline"}
                  disabled={disabled}
                  onClick={() => changeFlow("DAILY")}
                  className={
                    payload.flow === "DAILY"
                      ? "bg-[#4d2ddc] hover:bg-[#3d20c7]"
                      : ""
                  }
                >
                  데일리 · 매일 PASS 스티커
                </Button>
                <Button
                  type="button"
                  variant={payload.flow === "QUEST" ? "default" : "outline"}
                  disabled={disabled}
                  onClick={() => changeFlow("QUEST")}
                  className={
                    payload.flow === "QUEST"
                      ? "bg-[#4d2ddc] hover:bg-[#3d20c7]"
                      : ""
                  }
                >
                  Quest · 수치 조건
                </Button>
              </div>
              <p className="text-xs text-[#777a74]">
                활동 유형은 공부·생활습관 같은 분류와 별개입니다.
              </p>
            </fieldset>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="routine-name">활동 이름</Label>
              <Input
                id="routine-name"
                value={payload.name}
                disabled={disabled}
                maxLength={100}
                placeholder="예: 저녁 책 읽기"
                onChange={event => update("name", event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="routine-category">분류</Label>
              <select
                id="routine-category"
                value={payload.category}
                disabled={disabled}
                onChange={event =>
                  update(
                    "category",
                    event.target.value as RoutineDraftPayload["category"]
                  )
                }
                className="flex h-10 w-full rounded-md border border-input bg-white px-3 text-sm"
              >
                {ROUTINE_CATEGORIES.map(category => (
                  <option key={category} value={category}>
                    {categoryLabel[category]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="routine-child-label">
                아이 표시 키워드{" "}
                <span className="font-normal text-muted-foreground">
                  ({childLabelLength}/20)
                </span>
              </Label>
              <Input
                id="routine-child-label"
                value={payload.childLabel}
                disabled={disabled}
                placeholder="예: 책 읽기"
                onChange={event => update("childLabel", event.target.value)}
                aria-describedby="routine-child-label-help"
              />
              <p
                id="routine-child-label-help"
                className={`text-xs ${childLabelLength > 20 ? "text-[#a13f38]" : "text-[#777a74]"}`}
              >
                부모 확인 기준과 별도로 아이에게 짧게 보여 줍니다. 보이는 글자
                20자까지입니다.
              </p>
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="routine-criteria">부모의 상세 확인 기준</Label>
              <Textarea
                id="routine-criteria"
                value={payload.criteria}
                disabled={disabled}
                maxLength={1000}
                placeholder="무엇을 보고 어떤 사실을 확인할지 적어 주세요."
                onChange={event => update("criteria", event.target.value)}
              />
              <p className="text-xs text-[#777a74]">
                확인 결과의 이유는 자녀에게도 보입니다. 약 복용은 이 룰의
                평가·보상 대상이 아닙니다.
              </p>
            </div>
            {payload.flow === "DAILY" ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="routine-sticker-icon">
                    PASS 스티커 아이콘
                  </Label>
                  <select
                    id="routine-sticker-icon"
                    value={payload.stickerIcon}
                    disabled={disabled}
                    onChange={event =>
                      update(
                        "stickerIcon",
                        event.target.value as RoutineDraftPayload["stickerIcon"]
                      )
                    }
                    className="flex h-10 w-full rounded-md border border-input bg-white px-3 text-sm"
                  >
                    <option value="STAR">별</option>
                    <option value="SMILE">웃는 얼굴</option>
                    <option value="STAMP">도장</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="routine-period">스티커 보상 기간</Label>
                  <select
                    id="routine-period"
                    value={payload.period}
                    disabled={disabled}
                    onChange={event =>
                      update(
                        "period",
                        event.target.value as RoutineDraftPayload["period"]
                      )
                    }
                    className="flex h-10 w-full rounded-md border border-input bg-white px-3 text-sm"
                  >
                    {ROUTINE_PERIODS.map(period => (
                      <option key={period} value={period}>
                        {periodLabel[period]}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-[#777a74]">
                    기본은 주간입니다. 매일 수행 확인은 기간 보상과 별개입니다.
                  </p>
                </div>
              </>
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor="routine-measurement">수치 측정 방식</Label>
                  <select
                    id="routine-measurement"
                    value={payload.measurement}
                    disabled={disabled}
                    onChange={event =>
                      update(
                        "measurement",
                        event.target.value as RoutineDraftPayload["measurement"]
                      )
                    }
                    className="flex h-10 w-full rounded-md border border-input bg-white px-3 text-sm"
                  >
                    <option value="PERCENT">퍼센트 (0~100)</option>
                    <option value="QUANTITY">수량 점수 (0~100)</option>
                  </select>
                </div>
                <div className="rounded-xl bg-[#f9f6ef] p-3 text-xs leading-5 text-[#62656a]">
                  Quest는 수행 건마다 부모가 0~100 수치를 확인합니다. 정확한
                  측정 이름·단위는 위 상세 확인 기준에 적어 주세요.
                  <p className="mt-1">
                    기간은 수행 건별로 자동 설정됩니다. 데일리의 주간 스티커
                    누적과 다릅니다.
                  </p>
                </div>
              </>
            )}
          </div>
          <aside className="rounded-2xl bg-[#cde5de]/50 p-4 text-sm leading-6 text-[#315f4d]">
            <ShieldCheck className="h-5 w-5 text-[#4d2ddc]" />
            <h3 className="mt-3 font-bold">1단계도 저장 가능</h3>
            <p className="mt-2 text-xs">
              이름이나 보상이 비어 있어도 임시저장할 수 있습니다. 게시하기
              전에는 필요한 필드를 모두 확인합니다.
            </p>
          </aside>
        </div>
      );

    if (step === 2)
      return (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-[#cde5de]/50 p-4">
            <p className="text-sm text-[#315f4d]">
              아래에서 이미 등록한 강화물 태그를 선택하세요. 여러 활동에서 같은
              항목을 재사용하며 다시 등록하지 않습니다.
            </p>
            <Button
              type="button"
              variant="outline"
              disabled={actionDisabled}
              onClick={() => focusReinforcerRegistration()}
            >
              <Gift className="h-4 w-4" /> 새 강화물만 등록
            </Button>
          </div>
          {payload.flow === "QUEST" ? (
            <section className="rounded-2xl bg-[#f9f6ef] p-4">
              <h3 className="font-bold">Quest 패널티 후보</h3>
              <p className="mt-1 text-xs leading-5 text-[#666963]">
                하한 미달은 부모가 검토할 후보일 뿐 자동 차감·시간 원장 이전이
                아닙니다. 중립 구간과 보상 조건을 명시적으로 구분합니다.
              </p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="routine-penalty-limit">
                    하한 (이 값 미만)
                  </Label>
                  <Input
                    id="routine-penalty-limit"
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    inputMode="numeric"
                    value={payload.penaltyLimit ?? ""}
                    disabled={disabled}
                    onChange={event =>
                      update(
                        "penaltyLimit",
                        event.target.value === ""
                          ? null
                          : Number(event.target.value)
                      )
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="routine-penalty-minutes">
                    패널티 후보 시간 (0~240분)
                  </Label>
                  <Input
                    id="routine-penalty-minutes"
                    type="number"
                    min="0"
                    max="240"
                    step="1"
                    inputMode="numeric"
                    value={payload.penaltyMinutes}
                    disabled={disabled}
                    onChange={event =>
                      update(
                        "penaltyMinutes",
                        event.target.value === ""
                          ? 0
                          : Number(event.target.value)
                      )
                    }
                  />
                </div>
              </div>
            </section>
          ) : (
            <section className="rounded-2xl bg-[#f9f6ef] p-4 text-xs leading-5 text-[#62656a]">
              <strong>데일리에는 스티커 회수·자동 패널티가 없습니다.</strong>{" "}
              PASS는 기본 1개, 선생님 칭찬이 함께 확인되면 추가 1개입니다.
              미확인은 hold이며 0개 확정이 아닙니다.
            </section>
          )}
          <div className="space-y-4">
            {payload.tiers.map((tier, tierIndex) => {
              const base = payload.tiers[0]?.threshold ?? null;
              const isExtraDaily = payload.flow === "DAILY" && tierIndex > 0;
              const shownAdditional =
                isExtraDaily &&
                typeof tier.threshold === "number" &&
                typeof base === "number"
                  ? Math.max(0, tier.threshold - base)
                  : "";
              return (
                <article
                  key={tier.id}
                  className="rounded-2xl border border-black/10 p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="font-bold">
                        {tierIndex === 0
                          ? "기본 달성 구간"
                          : `추가 달성 구간 ${tierIndex}`}
                      </h3>
                      <p className="mt-1 text-xs text-[#777a74]">
                        한 조건에는 보상 1개 또는 2개를 연결할 수 있습니다. 두
                        번째는 선택입니다.
                      </p>
                    </div>
                    {tierIndex > 0 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={disabled}
                        onClick={() =>
                          setPayload(current => ({
                            ...current,
                            tiers: current.tiers.filter(
                              (_, index) => index !== tierIndex
                            ),
                          }))
                        }
                      >
                        <Trash2 className="h-4 w-4" /> 구간 제거
                      </Button>
                    )}
                  </div>
                  <div className="mt-4 grid gap-4 sm:grid-cols-3">
                    <div className="space-y-2">
                      <Label htmlFor={`tier-label-${tier.id}`}>조건 이름</Label>
                      <Input
                        id={`tier-label-${tier.id}`}
                        value={tier.label}
                        disabled={disabled}
                        maxLength={80}
                        placeholder={
                          tierIndex === 0 ? "기본 달성" : "추가 달성"
                        }
                        onChange={event =>
                          updateTier(tierIndex, { label: event.target.value })
                        }
                      />
                    </div>
                    {payload.flow === "QUEST" ? (
                      <>
                        <div className="space-y-2">
                          <Label htmlFor={`tier-operator-${tier.id}`}>
                            비교
                          </Label>
                          <select
                            id={`tier-operator-${tier.id}`}
                            value={tier.operator}
                            disabled={disabled}
                            onChange={event =>
                              updateTier(tierIndex, {
                                operator: event.target.value as "GTE" | "GT",
                              })
                            }
                            className="flex h-10 w-full rounded-md border border-input bg-white px-3 text-sm"
                          >
                            <option value="GTE">이상 (≥)</option>
                            <option value="GT">초과 (&gt;)</option>
                          </select>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor={`tier-threshold-${tier.id}`}>
                            기준 (
                            {payload.measurement === "PERCENT" ? "%" : "점"},
                            0~100)
                          </Label>
                          <Input
                            id={`tier-threshold-${tier.id}`}
                            type="number"
                            min="0"
                            max="100"
                            step="1"
                            inputMode="numeric"
                            value={tier.threshold ?? ""}
                            disabled={disabled}
                            onChange={event =>
                              updateTier(tierIndex, {
                                threshold:
                                  event.target.value === ""
                                    ? null
                                    : Number(event.target.value),
                              })
                            }
                          />
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="space-y-2">
                          <Label htmlFor={`tier-threshold-${tier.id}`}>
                            {isExtraDaily
                              ? "기본보다 추가 스티커"
                              : "기본 스티커 기준"}
                          </Label>
                          <Input
                            id={`tier-threshold-${tier.id}`}
                            type="number"
                            min="1"
                            step="1"
                            inputMode="numeric"
                            value={
                              isExtraDaily
                                ? shownAdditional
                                : (tier.threshold ?? "")
                            }
                            disabled={
                              disabled ||
                              (isExtraDaily && typeof base !== "number")
                            }
                            onChange={event => {
                              const entered =
                                event.target.value === ""
                                  ? null
                                  : Number(event.target.value);
                              updateTier(tierIndex, {
                                threshold:
                                  isExtraDaily &&
                                  typeof base === "number" &&
                                  typeof entered === "number"
                                    ? base + entered
                                    : entered,
                                operator: "GTE",
                              });
                            }}
                          />
                        </div>
                        <div className="rounded-xl bg-[#cde5de]/45 p-3 text-xs leading-5 text-[#45675b]">
                          {isExtraDaily
                            ? dailyAdditionalLabel(
                                base,
                                typeof shownAdditional === "number"
                                  ? shownAdditional
                                  : null
                              )
                            : "PASS 스티커를 이 개수 이상 모으면 기본 보상입니다."}
                        </div>
                      </>
                    )}
                  </div>
                  <div className="mt-4 border-t border-black/8 pt-4">
                    <div className="flex items-center justify-between gap-3">
                      <h4 className="text-sm font-bold">
                        연결 보상 ({tier.rewards.length}/2)
                      </h4>
                      {tier.rewards.length === 0 ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={disabled}
                          onClick={() => addReward(tierIndex)}
                        >
                          <Plus className="h-4 w-4" /> 보상 1 추가
                        </Button>
                      ) : tier.rewards.length < 2 ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={disabled}
                          onClick={() => addReward(tierIndex)}
                        >
                          <Plus className="h-4 w-4" /> 두 번째 보상
                        </Button>
                      ) : null}
                    </div>
                    {tier.rewards.length === 0 ? (
                      <div className="mt-3 space-y-3">
                        <p className="text-xs text-[#777a74]">
                          등록한 태그를 누르면 첫 번째 보상으로 연결됩니다. 두
                          번째 보상은 선택입니다.
                        </p>
                        <ReinforcerTags
                          rows={reinforcers}
                          disabled={disabled}
                          label={`${tier.label || "달성 조건"} 첫 보상 선택`}
                          onSelect={item =>
                            updateTier(tierIndex, {
                              rewards: [
                                { ...emptyReward(), reinforcerId: item.id },
                              ],
                            })
                          }
                        />
                      </div>
                    ) : (
                      <div className="mt-3 space-y-3">
                        {tier.rewards.map((reward, rewardIndex) => {
                          const selected = reinforcers.find(
                            item => item.id === reward.reinforcerId
                          );
                          return (
                            <div
                              key={reward.id}
                              className="grid gap-3 rounded-xl bg-[#f9f6ef] p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
                            >
                              <div className="space-y-1">
                                <Label className="text-xs">
                                  보상 {rewardIndex + 1} 강화물
                                </Label>
                                <ReinforcerTags
                                  rows={reinforcers}
                                  selectedId={reward.reinforcerId}
                                  disabled={disabled}
                                  label={`보상 ${rewardIndex + 1} 강화물 선택`}
                                  onSelect={item =>
                                    updateReward(
                                      tierIndex,
                                      rewardIndex,
                                      selectExistingReinforcer(reward, item.id)
                                    )
                                  }
                                />
                              </div>
                              <div className="space-y-1">
                                {selected?.unit === "STRING" ? (
                                  <>
                                    <Label
                                      htmlFor={`reward-text-${reward.id}`}
                                      className="text-xs"
                                    >
                                      약속 내용
                                    </Label>
                                    <Input
                                      id={`reward-text-${reward.id}`}
                                      value={reward.text}
                                      disabled={disabled}
                                      maxLength={240}
                                      placeholder="예: 함께 공원 가기"
                                      onChange={event =>
                                        updateReward(tierIndex, rewardIndex, {
                                          text: event.target.value,
                                        })
                                      }
                                    />
                                  </>
                                ) : (
                                  <>
                                    <Label
                                      htmlFor={`reward-amount-${reward.id}`}
                                      className="text-xs"
                                    >
                                      값{" "}
                                      {selected
                                        ? `(${selected.unit_label || unitLabel[selected.unit]})`
                                        : ""}
                                    </Label>
                                    <Input
                                      id={`reward-amount-${reward.id}`}
                                      type="number"
                                      min="1"
                                      step="any"
                                      inputMode="decimal"
                                      value={reward.amount ?? ""}
                                      disabled={disabled || !selected}
                                      onChange={event =>
                                        updateReward(tierIndex, rewardIndex, {
                                          amount:
                                            event.target.value === ""
                                              ? null
                                              : Number(event.target.value),
                                        })
                                      }
                                    />
                                  </>
                                )}
                              </div>
                              <div className="flex items-end">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  disabled={disabled}
                                  onClick={() =>
                                    removeReward(tierIndex, rewardIndex)
                                  }
                                  aria-label={`보상 ${rewardIndex + 1} 제거`}
                                >
                                  <Trash2 className="h-4 w-4" /> 제거
                                </Button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
          {payload.tiers.length < 5 && (
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() => {
                if (mutationBusy) return;
                setPayload(current => ({
                  ...current,
                  tiers: [
                    ...current.tiers,
                    emptyTier(
                      payload.flow === "DAILY" ? "추가 달성" : "추가 달성조건"
                    ),
                  ],
                }));
              }}
            >
              <Plus className="h-4 w-4" />{" "}
              {payload.flow === "DAILY" ? "추가 달성 구간" : "추가 달성조건"}
            </Button>
          )}
        </div>
      );

    return (
      <div className="space-y-5">
        <div className="rounded-2xl bg-[#cde5de]/55 p-4 text-sm leading-6 text-[#315f4d]">
          <ClipboardCheck className="mr-2 inline h-5 w-5 text-[#4d2ddc]" />
          <strong>게시 전 검토</strong>
          <p className="mt-1 text-xs">
            게시본은 바뀌지 않습니다. 이후 수정은 새 버전 초안으로 만들고, 가족
            시간대 기준 내일부터 효력이 생깁니다.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-2xl border border-black/10 p-4">
            <p className="text-xs font-bold text-[#4d2ddc]">활동·측정</p>
            <h3 className="mt-2 text-lg font-bold">
              {payload.name || "이름 미입력"}
            </h3>
            <p className="mt-2 text-sm">
              {payload.flow === "DAILY"
                ? `데일리 · PASS 스티커 · ${iconLabel[payload.stickerIcon]} · ${periodLabel[payload.period]}`
                : `Quest · ${payload.measurement === "QUANTITY" ? "수량 점수" : "퍼센트"}`}
            </p>
            <p className="mt-2 text-xs text-[#777a74]">
              아이 표시: {payload.childLabel || "미입력"}
              <br />
              확인 기준: {payload.criteria || "미입력"}
            </p>
          </div>
          <div className="rounded-2xl border border-black/10 p-4">
            <p className="text-xs font-bold text-[#4d2ddc]">조건·보상</p>
            {payload.tiers.map(tier => (
              <div
                key={tier.id}
                className="mt-2 rounded-xl bg-[#f9f6ef] p-3 text-xs"
              >
                <strong>{tier.label || "조건 이름 미입력"}</strong>
                <p className="mt-1">
                  {tier.operator === "GT" ? ">" : "≥"} {tier.threshold ?? "—"} ·
                  보상 {tier.rewards.length}개
                </p>
              </div>
            ))}
          </div>
        </div>
        {publishErrors.length > 0 ? (
          <div
            role="alert"
            className="rounded-2xl bg-red-50 p-4 text-sm text-red-800"
          >
            <strong>게시 전 확인할 항목</strong>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {publishErrors.map((error, index) => (
                <li key={`${error}-${index}`}>{error}</li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="rounded-2xl bg-[#cde5de]/55 p-4 text-sm text-[#315f4d]">
            <CheckCircle2 className="mr-2 inline h-4 w-4" />
            게시 가능한 구성입니다. 아래 초안 목록에서{" "}
            <strong>내일부터 게시</strong>를 누르세요.
          </div>
        )}
      </div>
    );
  })();

  return (
    <section
      className="rounded-[28px] bg-white p-6 shadow-[0_16px_48px_rgba(51,58,68,.08)] sm:p-8"
      aria-labelledby="routine-rule-wizard-title"
    >
      <div className="flex flex-col gap-4 border-b border-black/8 pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold text-[#4d2ddc]">
            ROUTINE V2 REGISTRY
          </p>
          <h2
            id="routine-rule-wizard-title"
            className="mt-1 text-2xl font-bold tracking-[-0.04em]"
          >
            데일리·Quest 룰 등록
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[#747670]">
            단계별로 미완성 초안을 저장하고 다시 이어 쓰세요. 데일리는 매일 PASS
            스티커를 기록하고 기간 구간으로 보상하며, Quest는 수치 조건을
            확인합니다.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={actionDisabled}
          onClick={newDraft}
        >
          <FilePlus2 className="h-4 w-4" /> 새 초안
        </Button>
      </div>
      <section
        id="parent-reinforcers"
        aria-labelledby="reinforcer-registration-title"
        className="mt-6 scroll-mt-6 rounded-2xl border border-[#b9d7cc] bg-white p-4 sm:p-5"
      >
        <div className="mb-4">
          <p className="text-xs font-semibold text-[#315f4d]">
            여러 활동에서 반복 사용하는 보상 목록
          </p>
          <h3
            id="reinforcer-registration-title"
            tabIndex={-1}
            className="mt-1 text-xl font-bold outline-offset-4"
          >
            내 강화물{" "}
            <span className="text-sm font-normal">
              · {reinforcers.length}개
            </span>
          </h3>
        </div>
        <ReinforcerTags rows={reinforcers} label="가족 강화물 목록" />
        <p className="mt-3 text-xs text-[#747670]">
          기존 항목은 2단계 ‘조건·보상’에서 태그로 선택합니다. 금액·시간·내용은
          활동마다 다르게 정할 수 있습니다.
        </p>
        <details
          id="reinforcer-registration-form"
          className="mt-4 rounded-xl bg-[#f9f6ef] p-3"
        >
          <summary className="cursor-pointer text-sm font-semibold text-[#315f4d]">
            새 강화물 등록 · 펼치기
          </summary>
          <div className="mt-4">
            <RoutineReinforcers
              familyId={familyId}
              preview={preview}
              rows={reinforcers}
              onRowsChange={setReinforcers}
              externalBusy={saving || Boolean(publishingId) || loading}
              onBusyChange={setReinforcerBusy}
            />
          </div>
        </details>
      </section>
      <Tabs
        value={tab}
        onValueChange={value => {
          if (!mutationBusy) setTab(value as typeof tab);
        }}
        className="mt-6"
      >
        <TabsList className="h-auto w-full max-w-full overflow-x-auto bg-[#f9f6ef] p-1">
          <TabsTrigger
            value="reward"
            className="min-w-[100px]"
            disabled={mutationBusy}
          >
            Reward
          </TabsTrigger>
          <TabsTrigger
            value="penalty"
            className="min-w-[100px]"
            disabled={mutationBusy}
          >
            Penalty
          </TabsTrigger>
        </TabsList>
        <TabsContent value="penalty" className="mt-5">
          <div className="rounded-2xl bg-[#f9f6ef] p-5 text-sm leading-6 text-[#565852]">
            <strong>Penalty</strong>
            <p className="mt-2">
              Quest의 하한과 0~240분 패널티 후보는 2단계에 설정합니다. 부모 확인
              전에는 어떤 차감도 확정되지 않으며, 데일리 PASS 스티커에는 차감
              패널티가 없습니다.
            </p>
          </div>
        </TabsContent>
        <TabsContent value="reward" className="mt-6">
          <div className="flex flex-wrap gap-2" aria-label="등록 단계">
            {["활동·측정", "조건·보상", "검토·게시"].map((label, index) => (
              <button
                key={label}
                type="button"
                disabled={actionDisabled}
                onClick={() => setStep(index + 1)}
                className={`rounded-full px-3 py-2 text-xs font-bold ${step === index + 1 ? "bg-[#4d2ddc] text-white" : "bg-[#f9f6ef] text-[#666963]"}`}
              >
                {index + 1}. {label}
              </button>
            ))}
          </div>
          <div className="mt-5">{stepContent}</div>
          {activeDraft?.payload.flow === "QUEST" &&
            activeDraft.payload.period !== "DAILY" && (
              <p
                role="status"
                className="mt-4 rounded-xl bg-[#f7e7d9] p-3 text-sm text-[#87472a]"
              >
                예전 초안의 숨겨진 기간값을 수행 건별로 수정했습니다. 입력한
                기준·보상은 그대로입니다. 임시저장하면 수정이 반영됩니다.
              </p>
            )}
          <div className="mt-6 flex flex-col gap-3 border-t border-black/8 pt-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex gap-2">
              {step > 1 && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={actionDisabled}
                  onClick={() => setStep(current => current - 1)}
                >
                  <ChevronLeft className="h-4 w-4" /> 이전
                </Button>
              )}
              {step < 3 && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={actionDisabled}
                  onClick={() => setStep(current => current + 1)}
                >
                  다음 <ChevronRight className="h-4 w-4" />
                </Button>
              )}
            </div>
            <Button
              type="button"
              className="rounded-xl bg-[#4d2ddc] text-white hover:bg-[#3d20c7]"
              disabled={actionDisabled || !familyId}
              onClick={() => void saveDraft()}
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Pencil className="h-4 w-4" />
              )}{" "}
              {step}단계 임시저장
            </Button>
          </div>
        </TabsContent>
      </Tabs>
      {mutationError && (
        <p
          role="alert"
          className="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-800"
        >
          {mutationError}
        </p>
      )}
      <div className="mt-8 border-t border-black/8 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-bold">저장한 초안</h3>
            <p className="mt-1 text-xs leading-5 text-[#777a74]">
              DRAFT만 편집·게시합니다. 네트워크 재시도는 같은 초안 revision과
              정확히 같은 payload에 같은 멱등 키를 사용합니다.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading || actionDisabled || preview}
            onClick={() => void refresh()}
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />{" "}
            새로고침
          </Button>
        </div>
        {activeDraftDirty && (
          <p
            role="status"
            className="mt-3 rounded-xl bg-[#f7e7d9] p-3 text-xs font-medium text-[#87472a]"
          >
            현재 편집 내용은 저장된 초안과 다릅니다.{" "}
            <strong>임시저장 후 게시</strong>할 수 있습니다.
          </p>
        )}
        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-[#4d2ddc]" />
          </div>
        ) : loadError ? (
          <div
            role="alert"
            className="mt-4 rounded-2xl bg-red-50 p-4 text-sm text-red-800"
          >
            {loadError}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="ml-3"
              onClick={() => void refresh()}
            >
              다시 시도
            </Button>
          </div>
        ) : drafts.filter(draft => draft.status === "DRAFT").length === 0 ? (
          <div className="mt-4 rounded-2xl bg-[#f9f6ef] p-5 text-center text-sm text-[#777a74]">
            저장한 초안이 없습니다.
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {drafts
              .filter(draft => draft.status === "DRAFT")
              .map(draft => (
                <article
                  key={draft.id}
                  className={`rounded-2xl border p-4 ${activeDraft?.id === draft.id ? "border-[#4d2ddc]" : "border-black/10"}`}
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="font-bold">
                          {draft.payload.name || "이름 없는 초안"}
                        </h4>
                        <span className="rounded-full bg-[#f0edfa] px-2 py-0.5 text-[10px] font-bold text-[#5b46a3]">
                          DRAFT · {draft.step}단계
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-[#777a74]">
                        {draft.payload.flow === "DAILY" ? "데일리" : "Quest"} ·
                        수정{" "}
                        {new Intl.DateTimeFormat("ko-KR", {
                          dateStyle: "short",
                          timeStyle: "short",
                        }).format(new Date(draft.updated_at))}
                      </p>
                      {draft.payload.flow === "QUEST" &&
                        draft.payload.period !== "DAILY" && (
                          <p className="mt-2 text-xs text-[#87472a]">
                            내부 기간값 수정이 필요합니다. 이어쓰기로 열고
                            임시저장해 주세요. 기준·보상은 유지됩니다.
                          </p>
                        )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={actionDisabled}
                        onClick={() => resumeDraft(draft)}
                      >
                        이어쓰기
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        className="bg-[#333a44] text-white hover:bg-[#232932]"
                        disabled={
                          actionDisabled ||
                          activeDraftDirty ||
                          validateRoutineForPublish(draft.payload, reinforcers)
                            .length > 0
                        }
                        onClick={() => void publish(draft)}
                      >
                        {publishingId === draft.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <CheckCircle2 className="h-4 w-4" />
                        )}{" "}
                        내일부터 게시
                      </Button>
                    </div>
                  </div>
                </article>
              ))}
          </div>
        )}
      </div>
      <details className="mt-6 rounded-2xl bg-[#f9f6ef] p-4">
        <summary className="cursor-pointer text-sm font-bold">
          게시한 v2 룰 (불변)
        </summary>
        <p className="mt-2 text-xs leading-5 text-[#777a74]">
          기존 레거시 규칙은 별도 영역에 보존됩니다. 여기는 v2 게시본만 보여
          주며, 변경하려면 새 버전을 만듭니다.
        </p>
        <div className="mt-3 space-y-2">
          {rules.length === 0 ? (
            <p className="text-sm text-[#777a74]">
              아직 게시한 v2 룰이 없습니다.
            </p>
          ) : (
            rules.map(rule => (
              <div
                key={rule.id}
                className="flex flex-col gap-2 rounded-xl bg-white p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="text-sm">
                  <strong>{rule.name}</strong> · v{rule.version} ·{" "}
                  {dateLabel(rule.effective_from)}부터
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={actionDisabled}
                  onClick={() => newVersion(rule)}
                >
                  새 버전
                </Button>
              </div>
            ))
          )}
        </div>
      </details>
    </section>
  );
}
