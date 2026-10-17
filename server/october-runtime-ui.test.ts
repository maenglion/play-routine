import { describe, expect, it } from "vitest";
import {
  canQuickPassOctoberRow,
  isScheduledOctoberTask,
  octoberBoardDisplayState,
  octoberBusinessDate,
  octoberReplayFingerprint,
  replayKeyFor,
  ruleForOctoberRow,
} from "../client/src/lib/october-runtime-api";
import type {
  OctoberBoard,
  OctoberRow,
  OctoberRule,
} from "../shared/october-runtime";

const rules: OctoberRule[] = [
  {
    id: "task",
    code: "T-007",
    domain: "TASK",
    name: "학교생활 확인",
    criteria: "0/1 확인",
    schedule_label: "등교일",
    effect_kind: "SCHOOL",
    daily_limit: 1,
    period: "WEEKLY",
    effects: [],
    pending_fields: [],
    condition_spec: {},
  },
  {
    id: "quest",
    code: "Q-003",
    domain: "QUEST",
    name: "성취 도전",
    criteria: "조건",
    schedule_label: "이벤트",
    effect_kind: "REWARD",
    daily_limit: 1,
    period: "EVENT",
    effects: [],
    pending_fields: [],
    condition_spec: {},
  },
  {
    id: "life",
    code: "L-013",
    domain: "LIFESTYLE",
    name: "직접 확인 생활 사건",
    criteria: "직접 물어 확인",
    schedule_label: "19:30",
    effect_kind: "PENALTY",
    daily_limit: 1,
    period: "DAILY",
    effects: [],
    pending_fields: [],
    condition_spec: {},
  },
];

const row = (
  ruleId: string,
  state: OctoberRow["state"] = "UNCONFIRMED"
): OctoberRow => ({
  id: `${ruleId}-row`,
  rule_id: ruleId,
  code: rules.find(rule => rule.id === ruleId)?.code ?? "unknown",
  date: "2026-10-18",
  slot: "daily",
  revision: 0,
  state,
  self_reported: false,
  confirmed_at: null,
  reason: null,
  metrics: {},
  effects: [],
  recognized_count: 0,
});

const activeBoard = (rows: OctoberRow[] = []): OctoberBoard => ({
  plan: {
    id: "plan",
    month: "2026-10-01",
    effective_from: "2026-10-18",
    status: "ACTIVE",
    school_asset: "PENDING",
  },
  rules,
  rows,
  rights: [],
  summary: { pending_minutes: 0, penalty_minutes: 0, unconfirmed: 0 },
});

describe("10월 운영 UI 순수 표시·재시도 규칙", () => {
  it("회차 추가·자녀 보고의 revision은 최초 부모 PASS를 막지 않는다", () => {
    const rule = { ...rules[2], code: "L-001", effect_kind: "REWARD" as const };
    const first = { ...row("life"), code: "L-001", revision: 1, slot: "extra" };
    expect(canQuickPassOctoberRow(first, rule)).toBe(true);
    expect(
      canQuickPassOctoberRow({ ...first, state: "SELF_REPORTED" }, rule)
    ).toBe(true);
    expect(
      canQuickPassOctoberRow(
        { ...first, state: "PASS", confirmed_at: "2026-10-18T00:00:00Z" },
        rule
      )
    ).toBe(false);
    expect(
      canQuickPassOctoberRow(first, { ...rule, effect_kind: "PENALTY" })
    ).toBe(false);
    expect(canQuickPassOctoberRow({ ...first, code: "Q-001" }, rule)).toBe(
      false
    );
    expect(
      canQuickPassOctoberRow({ ...first, state: "REVIEW_REQUIRED" }, rule)
    ).toBe(false);
  });
  it("로딩·오류·새 10월 규정 없음·준비 상태를 구분한다", () => {
    expect(
      octoberBoardDisplayState({ loading: true, error: null, board: null })
    ).toBe("loading");
    expect(
      octoberBoardDisplayState({ loading: false, error: "실패", board: null })
    ).toBe("error");
    expect(
      octoberBoardDisplayState({
        loading: false,
        error: null,
        board: { ...activeBoard(), plan: null },
      })
    ).toBe("no-plan");
    expect(
      octoberBoardDisplayState({
        loading: false,
        error: null,
        board: activeBoard([row("task")]),
      })
    ).toBe("ready");
  });

  it("수행일은 UTC 오늘이 아니라 가족 시간대를 사용한다", () => {
    const nearMidnightUtc = new Date("2026-10-18T00:30:00.000Z");
    expect(octoberBusinessDate("America/Los_Angeles", nearMidnightUtc)).toBe(
      "2026-10-17"
    );
    expect(octoberBusinessDate("Asia/Seoul", nearMidnightUtc)).toBe(
      "2026-10-18"
    );
  });

  it("같은 payload는 같은 replay key, 수정한 payload는 새 key를 갖는다", () => {
    const attempts = new Map<string, string>();
    let count = 0;
    const create = () => `event-${++count}`;
    const original = octoberReplayFingerprint("confirm", {
      b: 2,
      a: 1,
      reason: "확인",
    });
    const sameValuesDifferentOrder = octoberReplayFingerprint("confirm", {
      reason: "확인",
      a: 1,
      b: 2,
    });
    const corrected = octoberReplayFingerprint("confirm", {
      a: 1,
      b: 2,
      reason: "정정",
    });
    expect(original).toBe(sameValuesDifferentOrder);
    expect(replayKeyFor(attempts, original, create)).toBe("event-1");
    expect(replayKeyFor(attempts, sameValuesDifferentOrder, create)).toBe(
      "event-1"
    );
    expect(replayKeyFor(attempts, corrected, create)).toBe("event-2");
  });

  it("자녀 일일 미확인 안내는 TASK만 포함하고 월간 도전·생활 사건·자녀 보고는 제외한다", () => {
    const task = row("task");
    const quest = row("quest", "PASS");
    const selfReported = {
      ...row("task"),
      id: "task-self-reported",
      self_reported: true,
    };
    const life = row("life");
    expect(isScheduledOctoberTask(task, ruleForOctoberRow(rules, task))).toBe(
      true
    );
    expect(isScheduledOctoberTask(quest, ruleForOctoberRow(rules, quest))).toBe(
      false
    );
    expect(isScheduledOctoberTask(life, ruleForOctoberRow(rules, life))).toBe(
      false
    );
    const scheduledUnconfirmed = [task, quest, selfReported, life].filter(
      item => {
        const rule = ruleForOctoberRow(rules, item);
        return (
          isScheduledOctoberTask(item, rule) &&
          !item.self_reported &&
          item.state === "UNCONFIRMED"
        );
      }
    );
    expect(scheduledUnconfirmed).toHaveLength(1);
    expect(scheduledUnconfirmed[0].code).toBe("T-007");
  });
});
