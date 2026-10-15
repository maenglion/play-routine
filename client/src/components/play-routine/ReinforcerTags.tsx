import type { ReinforcerRow } from "@shared/routine-v2";

type Props = {
  rows: ReinforcerRow[];
  selectedId?: string;
  disabled?: boolean;
  label: string;
  onSelect?: (row: ReinforcerRow) => void;
};

/** 같은 카탈로그 ID를 선택만 한다. 새 강화물을 등록하거나 기존 보상을 자동 추가하지 않는다. */
export default function ReinforcerTags({
  rows,
  selectedId,
  disabled = false,
  label,
  onSelect,
}: Props) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
      {rows.map(row =>
        onSelect ? (
          <button
            key={row.id}
            type="button"
            disabled={disabled}
            aria-pressed={selectedId === row.id}
            onClick={() => onSelect(row)}
            className={`max-w-full rounded-full border px-3 py-2 text-left text-xs font-semibold transition-colors disabled:opacity-50 ${selectedId === row.id ? "border-[#4d2ddc] bg-[#4d2ddc] text-white" : "border-[#b9d7cc] bg-[#cde5de]/45 text-[#315f4d] hover:bg-[#cde5de]"}`}
          >
            <span className="break-words">{row.name}</span>
            <span className="ml-1 font-normal opacity-75">
              · {row.unit_label}
            </span>
          </button>
        ) : (
          <span
            key={row.id}
            className="max-w-full rounded-full bg-[#cde5de]/55 px-3 py-2 text-xs font-semibold text-[#315f4d]"
          >
            <span className="break-words">{row.name}</span> · {row.unit_label}
          </span>
        )
      )}
      {rows.length === 0 && (
        <p className="text-xs text-[#777a74]">
          등록한 강화물이 없습니다. 새 항목만 한 번 등록하세요.
        </p>
      )}
    </div>
  );
}
