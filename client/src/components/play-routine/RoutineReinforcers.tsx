import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase";
import type { ReinforcerRow, ReinforcerUnit } from "@shared/routine-v2";
import { Gift, Loader2, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  newRoutineUuid,
  REINFORCER_UNITS,
  stableRoutineJson,
  unitLabel,
} from "@/lib/routine-v2-form";

export type RoutineReinforcersProps = {
  familyId: string;
  preview?: boolean;
  rows: ReinforcerRow[];
  onRowsChange: (rows: ReinforcerRow[]) => void;
  externalBusy?: boolean;
  onBusyChange?: (busy: boolean) => void;
};

type NewReinforcer = { name: string; unit: ReinforcerUnit; unitLabel: string };

const reinforcerKindLabel: Record<ReinforcerUnit, string> = {
  WON: "돈 · 원",
  MIN: "시간 · 분",
  POINT: "포인트 · 점",
  STRING: "소원·활동 · 내용",
};

const previewRows: ReinforcerRow[] = [
  { id: "preview-min", name: "자유 시간", unit: "MIN", unit_label: "분" },
  {
    id: "preview-string",
    name: "함께 할 약속",
    unit: "STRING",
    unit_label: "내용",
  },
];

function messageOf(
  error: unknown,
  fallback = "강화물 카탈로그를 처리하지 못했습니다."
) {
  const value = error as { message?: unknown; code?: unknown } | null;
  if (error instanceof Error && error.message) return error.message;
  // Supabase/PostgREST may throw a plain object. Do not render raw details.
  if (typeof value?.code === "string")
    return `요청을 완료하지 못했습니다 (${value.code}). 다시 시도해 주세요.`;
  return fallback;
}

/** 가족별 불변 강화물 카탈로그. 룰에서 값만 정하고 타입/이름은 여기서 확정한다. */
export default function RoutineReinforcers({
  familyId,
  preview = false,
  rows,
  onRowsChange,
  externalBusy = false,
  onBusyChange,
}: RoutineReinforcersProps) {
  const [form, setForm] = useState<NewReinforcer>({
    name: "",
    unit: "MIN",
    unitLabel: "분",
  });
  const [loading, setLoading] = useState(!preview);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const contextGeneration = useRef(0);
  const mounted = useRef(true);
  const locked = useRef(false);
  const keys = useRef(new Map<string, string>());
  const busy = saving || externalBusy;
  const current = (context: number) =>
    mounted.current && context === contextGeneration.current;

  const refresh = useCallback(async () => {
    const request = ++requestGeneration.current;
    const context = contextGeneration.current;
    if (preview) {
      if (request !== requestGeneration.current || !current(context)) return;
      onRowsChange(previewRows);
      setLoading(false);
      setLoadError(null);
      return;
    }
    if (!familyId) {
      if (request !== requestGeneration.current || !current(context)) return;
      onRowsChange([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const { data, error } = await supabase.rpc("list_routine_reinforcers", {
        p_family_id: familyId,
      });
      if (error) throw error;
      if (request !== requestGeneration.current || !current(context)) return;
      onRowsChange((data ?? []) as ReinforcerRow[]);
    } catch (error) {
      if (request !== requestGeneration.current || !current(context)) return;
      setLoadError(messageOf(error));
    } finally {
      if (request === requestGeneration.current && current(context))
        setLoading(false);
    }
  }, [familyId, onRowsChange, preview]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      contextGeneration.current += 1;
      requestGeneration.current += 1;
      locked.current = false;
    };
  }, []);

  useEffect(() => {
    contextGeneration.current += 1;
    requestGeneration.current += 1;
    locked.current = false;
    setSaving(false);
    onBusyChange?.(false);
    setForm({ name: "", unit: "MIN", unitLabel: "분" });
  }, [familyId, onBusyChange, preview]);

  useEffect(() => {
    void refresh();
    return () => {
      requestGeneration.current += 1;
    };
  }, [refresh]);

  const updateUnit = (unit: ReinforcerUnit) => {
    setForm(current => ({
      ...current,
      unit,
      unitLabel: unit === "STRING" ? "내용" : unitLabel[unit],
    }));
  };

  const create = async () => {
    if (preview)
      return toast.message("미리보기에서는 강화물을 만들지 않습니다.");
    if (busy || loading || loadError || locked.current) return;
    const name = form.name.trim();
    const unitLabelValue = form.unitLabel.trim();
    if (!name) return toast.error("강화물 이름을 입력해 주세요.");
    if (!unitLabelValue) return toast.error("값 단위 표시를 입력해 주세요.");
    const fingerprint = stableRoutineJson({
      familyId,
      name,
      unit: form.unit,
      unitLabel: unitLabelValue,
    });
    const idempotencyKey = keys.current.get(fingerprint) ?? newRoutineUuid();
    keys.current.set(fingerprint, idempotencyKey);
    const context = contextGeneration.current;
    locked.current = true;
    setSaving(true);
    onBusyChange?.(true);
    try {
      const { data, error } = await supabase.rpc("create_routine_reinforcer", {
        p_family_id: familyId,
        p_name: name,
        p_unit: form.unit,
        p_unit_label: unitLabelValue,
        p_idempotency_key: idempotencyKey,
      });
      if (error) throw error;
      if (!current(context)) return;
      keys.current.delete(fingerprint);
      const added = data as ReinforcerRow;
      onRowsChange([...rows.filter(row => row.id !== added.id), added]);
      setForm({ name: "", unit: "MIN", unitLabel: "분" });
      toast.success(
        "강화물을 카탈로그에 추가했습니다. 이름과 값 종류는 이후 변경되지 않습니다."
      );
    } catch (error) {
      if (!current(context)) return;
      toast.error(
        messageOf(error, "강화물을 추가하지 못했습니다. 다시 시도해 주세요.")
      );
    } finally {
      if (current(context)) {
        setSaving(false);
        onBusyChange?.(false);
        locked.current = false;
      }
    }
  };

  return (
    <div className="space-y-5">
      <div className="rounded-2xl bg-[#f9f6ef] p-4 text-sm leading-6 text-[#565852]">
        <Gift className="mr-2 inline h-4 w-4 text-[#4d2ddc]" />
        강화물의 <strong>이름</strong>과 <strong>값 종류</strong>를 먼저 정하고,
        룰의 조건별로 값 또는 약속 내용을 정합니다. 등록한 이름·종류는 기존 룰을
        보존하기 위해 고정됩니다.
      </div>
      <div className="grid gap-4 rounded-2xl border border-black/10 p-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="routine-reinforcer-name">강화물 이름</Label>
          <Input
            id="routine-reinforcer-name"
            value={form.name}
            maxLength={100}
            disabled={busy}
            placeholder="예: 주말 자유 시간"
            onChange={event =>
              setForm(current => ({ ...current, name: event.target.value }))
            }
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="routine-reinforcer-unit">값 종류</Label>
          <select
            id="routine-reinforcer-unit"
            value={form.unit}
            disabled={busy}
            onChange={event => updateUnit(event.target.value as ReinforcerUnit)}
            className="flex h-10 w-full rounded-md border border-input bg-white px-3 text-sm"
          >
            <>
              {REINFORCER_UNITS.map(unit => (
                <option key={unit} value={unit}>
                  {reinforcerKindLabel[unit]}
                </option>
              ))}
            </>
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="routine-reinforcer-label">값 단위 표시</Label>
          <Input
            id="routine-reinforcer-label"
            value={form.unitLabel}
            maxLength={40}
            disabled={busy}
            placeholder={form.unit === "STRING" ? "예: 내용" : "예: 분"}
            onChange={event =>
              setForm(current => ({
                ...current,
                unitLabel: event.target.value,
              }))
            }
          />
        </div>
        <div className="flex items-end">
          <Button
            type="button"
            className="w-full rounded-xl bg-[#4d2ddc] text-white hover:bg-[#3d20c7]"
            disabled={busy || loading || Boolean(loadError) || !familyId}
            onClick={() => void create()}
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}{" "}
            강화물 저장
          </Button>
        </div>
      </div>
      <div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-bold">사용할 수 있는 강화물</h3>
            <p className="mt-1 text-xs text-[#777a74]">
              비어 있어도 초안은 저장할 수 있지만, 게시할 보상에는 카탈로그
              항목이 필요합니다.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading || busy || preview}
            onClick={() => void refresh()}
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />{" "}
            새로고침
          </Button>
        </div>
        {loading ? (
          <div className="flex justify-center py-7">
            <Loader2 className="h-5 w-5 animate-spin text-[#4d2ddc]" />
          </div>
        ) : loadError ? (
          <div
            role="alert"
            className="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-800"
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
        ) : rows.length === 0 ? (
          <div className="mt-4 rounded-xl bg-[#f9f6ef] p-4 text-sm text-[#777a74]">
            아직 등록한 강화물이 없습니다.
          </div>
        ) : (
          <ul className="mt-4 grid gap-2 sm:grid-cols-2">
            {rows.map(row => (
              <li
                key={row.id}
                className="min-w-0 rounded-xl bg-[#cde5de]/55 px-3 py-3"
              >
                <strong className="block truncate">{row.name}</strong>
                <span className="mt-1 block text-xs text-[#45675b]">
                  {unitLabel[row.unit]} · {row.unit_label} · 이후 변경 불가
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
