import { supabase } from "@/lib/supabase";
import type {
  OctoberAsset,
  OctoberBoard,
  OctoberDomain,
  OctoberEffect,
  OctoberRight,
  OctoberRow,
  OctoberRule,
  OctoberState,
} from "@shared/october-runtime";

/**
 * October runtime has no table writes from the browser. Keep the client behind
 * this accessor so every operation below remains an authenticated RPC call.
 */
export function getSupabaseBrowserClient() {
  return supabase;
}

export type OctoberBoardArgs = {
  familyId: string;
  childId: string;
  date: string;
};

export type SubmitOctoberOccurrenceArgs = OctoberBoardArgs & {
  ruleId: string;
  eventKey: string;
  slot?: string;
};

export type ConfirmOctoberOccurrenceArgs = OctoberBoardArgs & {
  ruleId: string;
  eventKey: string;
  decision: "PASS" | "NO_PASS" | "PENALTY" | "NO_VIOLATION";
  metrics: Record<string, unknown>;
  reason: string | null;
  slot?: string;
  expectedRevision: number | null;
};

export type CloseOctoberSchoolWeekArgs = {
  familyId: string;
  childId: string;
  start: string;
  end: string;
  eventKey: string;
};

export type FulfillOctoberRightArgs = {
  familyId: string;
  rightId: string;
  eventKey: string;
  reason: string | null;
};

function rpcError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error;
  const value = error as { message?: string } | null;
  return new Error(value?.message || fallback);
}

function asBoard(value: unknown): OctoberBoard {
  const source = (value ?? {}) as Partial<OctoberBoard>;
  return {
    plan: source.plan ?? null,
    rules: source.rules ?? [],
    rows: source.rows ?? [],
    rights: source.rights ?? [],
    summary: source.summary ?? {
      pending_minutes: 0,
      penalty_minutes: 0,
      unconfirmed: 0,
    },
  };
}

export async function getOctoberBoard(
  args: OctoberBoardArgs
): Promise<OctoberBoard> {
  const { data, error } = await getSupabaseBrowserClient().rpc(
    "get_october_board",
    {
      p_family_id: args.familyId,
      p_child_id: args.childId,
      p_date: args.date,
    }
  );
  if (error) throw rpcError(error, "10월 운영표를 불러오지 못했습니다.");
  return asBoard(data);
}

export async function submitOctoberOccurrence(
  args: SubmitOctoberOccurrenceArgs
): Promise<unknown> {
  const { data, error } = await getSupabaseBrowserClient().rpc(
    "submit_october_occurrence",
    {
      p_family_id: args.familyId,
      p_child_id: args.childId,
      p_rule_id: args.ruleId,
      p_date: args.date,
      p_event_key: args.eventKey,
      p_slot: args.slot ?? "daily",
    }
  );
  if (error) throw rpcError(error, "실천 기록을 저장하지 못했습니다.");
  return data;
}

export async function confirmOctoberOccurrence(
  args: ConfirmOctoberOccurrenceArgs
): Promise<unknown> {
  const { data, error } = await getSupabaseBrowserClient().rpc(
    "confirm_october_occurrence",
    {
      p_family_id: args.familyId,
      p_child_id: args.childId,
      p_rule_id: args.ruleId,
      p_date: args.date,
      p_event_key: args.eventKey,
      p_decision: args.decision,
      p_metrics: args.metrics,
      p_reason: args.reason,
      p_slot: args.slot ?? "daily",
      p_expected_revision: args.expectedRevision,
    }
  );
  if (error) throw rpcError(error, "부모 확인을 저장하지 못했습니다.");
  return data;
}

export async function closeOctoberSchoolWeek(
  args: CloseOctoberSchoolWeekArgs
): Promise<unknown> {
  const { data, error } = await getSupabaseBrowserClient().rpc(
    "close_october_school_week",
    {
      p_family_id: args.familyId,
      p_child_id: args.childId,
      p_start: args.start,
      p_end: args.end,
      p_event_key: args.eventKey,
    }
  );
  if (error) throw rpcError(error, "학교 기간을 마감하지 못했습니다.");
  return data;
}

export async function fulfillOctoberRight(
  args: FulfillOctoberRightArgs
): Promise<unknown> {
  const { data, error } = await getSupabaseBrowserClient().rpc(
    "fulfill_october_right",
    {
      p_family_id: args.familyId,
      p_right_id: args.rightId,
      p_event_key: args.eventKey,
      p_reason: args.reason,
    }
  );
  if (error) throw rpcError(error, "권리 이행 기록을 저장하지 못했습니다.");
  return data;
}

/** Locale-safe family business day. It deliberately does not derive a date from UTC. */
export function octoberBusinessDate(
  timezone: string,
  now = new Date()
): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (kind: Intl.DateTimeFormatPartTypes) =>
    parts.find(value => value.type === kind)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function newOctoberUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, token => {
    const value = Math.floor(Math.random() * 16);
    return (token === "x" ? value : (value & 0x3) | 0x8).toString(16);
  });
}

function normalizeStable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeStable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeStable(item)])
    );
  return value;
}

/** A corrected payload gets a new key; an unchanged retry finds the same key. */
export function octoberReplayFingerprint(
  operation: string,
  payload: unknown
): string {
  return `${operation}:${JSON.stringify(normalizeStable(payload))}`;
}

export function replayKeyFor(
  attempts: Map<string, string>,
  fingerprint: string,
  create: () => string = newOctoberUuid
): string {
  const previous = attempts.get(fingerprint);
  if (previous) return previous;
  const key = create();
  attempts.set(fingerprint, key);
  return key;
}

export type OctoberBoardDisplayState =
  | "loading"
  | "error"
  | "no-plan"
  | "empty"
  | "ready";

export function octoberBoardDisplayState(args: {
  loading: boolean;
  error: string | null;
  board: OctoberBoard | null;
}): OctoberBoardDisplayState {
  if (args.loading) return "loading";
  if (args.error) return "error";
  if (!args.board?.plan) return "no-plan";
  if (args.board.rows.length === 0 && args.board.rules.length === 0)
    return "empty";
  return "ready";
}

export function octoberStateLabel(state: OctoberState): string {
  return {
    UNCONFIRMED: "미확인",
    SELF_REPORTED: "실천 알림",
    PASS: "확인됨",
    NO_PASS: "통과 아님",
    PENALTY: "차감 예정",
    NO_VIOLATION: "위반 아님",
    LIMIT_EXCEEDED: "회차 한도 초과",
    REVIEW_REQUIRED: "재검토 필요",
  }[state];
}

export function octoberDomainLabel(domain: OctoberDomain): string {
  return { TASK: "TASK", QUEST: "QUEST", LIFESTYLE: "LIFESTYLE" }[domain];
}

export function octoberAssetLabel(asset: OctoberEffect["asset"]): string {
  return {
    MINUTES: "분 권리",
    CASH_KRW: "현금 보상권",
    COUPAY_KRW: "쿠페이 사용권",
    SCHOOL_BASIC: "학교 기본 스티커",
    SCHOOL_PRAISE: "교사 칭찬 스티커",
  }[asset];
}

export function octoberEffectLabel(effect: OctoberEffect): string {
  const quantity =
    effect.quantity === null
      ? "수량 미정"
      : effect.quantity.toLocaleString("ko-KR");
  const suffix =
    effect.asset === "MINUTES"
      ? "분"
      : effect.asset === "SCHOOL_BASIC" || effect.asset === "SCHOOL_PRAISE"
        ? "개"
        : effect.asset === "CASH_KRW"
          ? "원"
          : "원";
  return `${octoberAssetLabel(effect.asset)} ${quantity}${effect.quantity === null ? "" : suffix}`;
}

export function octoberRightLabel(right: OctoberRight): string {
  const remaining = Math.max(0, right.quantity - right.fulfilled_quantity);
  const total = `${right.quantity.toLocaleString("ko-KR")}${right.asset === "MINUTES" ? "분" : "원"}`;
  const left = `${remaining.toLocaleString("ko-KR")}${right.asset === "MINUTES" ? "분" : "원"}`;
  return `${octoberAssetLabel(right.asset)} · 발행 ${total} · 이행 전 ${left}`;
}

export function ruleForOctoberRow(
  rules: OctoberRule[],
  row: Pick<OctoberRow, "rule_id" | "code">
): OctoberRule | undefined {
  return rules.find(rule => rule.id === row.rule_id || rule.code === row.code);
}

/** Extra lifestyle event slots are not scheduled task rows and must not drive alerts. */
export function isScheduledOctoberTask(
  row: OctoberRow,
  rule: OctoberRule | undefined
): boolean {
  return rule?.domain === "TASK";
}

export function isOctoberConfirmed(state: OctoberState): boolean {
  return [
    "PASS",
    "NO_PASS",
    "PENALTY",
    "NO_VIOLATION",
    "LIMIT_EXCEEDED",
  ].includes(state);
}

/** Revision also advances on submissions: it does not mean a parent has confirmed. */
export function canQuickPassOctoberRow(
  row: OctoberRow,
  rule: OctoberRule | undefined
): boolean {
  return (
    row.confirmed_at === null &&
    ["UNCONFIRMED", "SELF_REPORTED"].includes(row.state) &&
    rule?.effect_kind === "REWARD" &&
    !["Q-001", "Q-003", "T-005", "T-007", "L-013"].includes(row.code)
  );
}
