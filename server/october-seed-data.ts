import type { OctoberRule, OctoberAsset } from "../shared/october-runtime";

export type OctoberRuleSeed = Omit<OctoberRule, "id">;
const minutes = (quantity: number | null) => ({
  asset: "MINUTES" as const,
  quantity,
});
const task = (
  code: string,
  name: string,
  criteria: string,
  schedule_label: string,
  quantity: number | null,
  schedule: Record<string, unknown>,
  pending_fields: string[] = []
): OctoberRuleSeed => ({
  code,
  domain: "TASK",
  name,
  criteria,
  schedule_label,
  effect_kind: "REWARD",
  daily_limit: 1,
  period: "DAILY",
  effects: [minutes(quantity)],
  pending_fields,
  condition_spec: { kind: "TASK_PASS", schedule, requires_parent: true },
});
const life = (
  code: string,
  name: string,
  criteria: string,
  quantity: number,
  limit: number,
  event = false,
  extra: Record<string, unknown> = {}
): OctoberRuleSeed => ({
  code,
  domain: "LIFESTYLE",
  name,
  criteria,
  schedule_label: event ? "실제 사건당 1회" : `하루 최대 ${limit}회`,
  effect_kind: quantity > 0 ? "REWARD" : "PENALTY",
  daily_limit: event ? null : limit,
  period: event ? "EVENT" : "DAILY",
  effects: [minutes(quantity)],
  pending_fields: [],
  condition_spec: {
    kind: quantity > 0 ? "LIFESTYLE_PASS" : "PARENT_PENALTY",
    schedule: { event, weekdays: [1, 2, 3, 4, 5, 6, 7] },
    requires_parent: true,
    ...extra,
  },
});

/** 실제 수행·확인 사실은 넣지 않는다. 시행규칙과 보상 정의만 설치하는 원본이다. */
export const octoberRulesSeed: OctoberRuleSeed[] = [
  {
    code: "Q-001",
    domain: "QUEST",
    name: "기탄수학 G5 월간 목표",
    criteria:
      "하루 3장 학습과 별도인 월말 통과 평가: 20문제, 4분 이내, 부모 통과 확인. 정답률을 임의로 정하지 않음.",
    schedule_label: "10월 31일 월간 통과 평가",
    effect_kind: "REWARD",
    daily_limit: null,
    period: "MONTHLY",
    effects: [minutes(300), { asset: "CASH_KRW", quantity: 50000 }],
    pending_fields: [],
    condition_spec: {
      kind: "GITAN_MONTHLY",
      problem_count: 20,
      max_seconds: 240,
      requires_parent_pass: true,
      scope: "2026-10",
      schedule: { date: "2026-10-31" },
    },
  },
  {
    code: "Q-002",
    domain: "QUEST",
    name: "종이접기 하나 골라 완성",
    criteria:
      "선택한 종이접기 작품 하나를 완성하고 부모가 확인. 동일 완성 성취를 재발행하지 않음.",
    schedule_label: "10월 중 완성",
    effect_kind: "REWARD",
    daily_limit: null,
    period: "MONTHLY",
    effects: [{ asset: "COUPAY_KRW", quantity: 20000 }],
    pending_fields: [],
    condition_spec: {
      kind: "ORIGAMI_COMPLETE",
      scope: "2026-10",
      schedule: { from: "2026-10-01", to: "2026-10-31" },
      requires_parent: true,
    },
  },
  {
    code: "Q-003",
    domain: "QUEST",
    name: "밀크티 중간고사",
    criteria:
      "4개 과목 이상 90점 이상: 600분 / 3개 과목 90점 이상: 480분 / 3개 과목 이상 80점 이상: 360분. 최고 충족 구간 총액 하나만 인정.",
    schedule_label: "10월 19~22일",
    effect_kind: "REWARD",
    daily_limit: null,
    period: "EVENT",
    effects: [minutes(600)],
    pending_fields: [],
    condition_spec: {
      kind: "EXAM_HIGHEST",
      mode: "HIGHEST_MATCH_FINAL_TOTAL",
      scope: "2026-10-midterm",
      schedule: { from: "2026-10-19", to: "2026-10-22" },
      tiers: [
        { min_subjects: 4, min_score: 90, quantity: 600 },
        { min_subjects: 3, min_score: 90, quantity: 480 },
        { min_subjects: 3, min_score: 80, quantity: 360 },
      ],
    },
  },
  task("T-001", "밀크티 학습", "40분 수행 완료 후 부모 확인", "매일", 40, {
    weekdays: [1, 2, 3, 4, 5, 6, 7],
  }),
  task(
    "T-002",
    "기탄수학 G5 학습",
    "G5 3장·15분 학습 수행 후 부모 확인. 월말 시험 Quest와 별도 성취.",
    "매일",
    40,
    { weekdays: [1, 2, 3, 4, 5, 6, 7] }
  ),
  task(
    "T-003",
    "바이올린 연습",
    "30분 연습 수행 후 부모 확인",
    "화·목",
    null,
    { weekdays: [2, 4] },
    ["바이올린 보상량 미기재 — 0분이 아닌 미정"]
  ),
  task("T-004", "글씨 쓰기 연습", "수업 후 글씨 쓰기 연습 완료", "월·수", 60, {
    weekdays: [1, 3],
  }),
  task(
    "T-005",
    "영재원 문제 수업",
    "화·금 수행 완료. 토요일은 실제 영재원 수업이 없음을 부모가 확인할 때만 인정.",
    "화·금·영재원 수업 없는 토요일",
    60,
    {
      weekdays: [2, 5, 6],
      excluded_dates: ["2026-10-24"],
      saturday_requires_no_class: true,
    }
  ),
  {
    ...task(
      "T-006",
      "영재원 수업",
      "확정된 2026년 10월 24일 토요일 수업 완료. 당일 같은 수업의 T-005와 이중 인정하지 않음.",
      "2026년 10월 24일 토요일",
      240,
      { date: "2026-10-24" }
    ),
    period: "EVENT",
    daily_limit: null,
  },
  {
    code: "T-007",
    domain: "TASK",
    name: "학교수업 남들만큼 하기",
    criteria:
      "부모가 문제없음을 확인하면 기본 스티커 1개, 문제 있는 날 0개. 교사 칭찬은 별도 스티커 1개. 미확인은 0으로 확정하지 않음.",
    schedule_label: "학교 수업일 확인 → 주간 최고 구간",
    effect_kind: "SCHOOL",
    daily_limit: 1,
    period: "WEEKLY",
    effects: [],
    pending_fields: [
      "학교 보상 자산 최신 확인 대기",
      "문제+칭찬 동시 발생은 검토",
    ],
    condition_spec: {
      kind: "SCHOOL_STICKERS",
      basic_sticker_type: "SCHOOL_BASIC",
      praise_sticker_type: "SCHOOL_PRAISE",
      scope: "SCHOOL_STICKERS",
      mode: "HIGHEST_MATCH_FINAL_TOTAL",
      schedule: { weekdays: [1, 2, 3, 4, 5] },
      tiers: {
        COUPAY_KRW: [
          { min: 5, quantity: 10000 },
          { min: 8, quantity: 15000 },
        ],
        MINUTES: [
          { min: 5, quantity: 300 },
          { min: 8, quantity: 480 },
        ],
      },
    },
  },
  life(
    "L-001",
    "고양이 화장실 치우기",
    "부모 인정 1회마다 +15분, 하루 최대 3회. 실제 행동은 초과해도 기록 유지.",
    15,
    3
  ),
  life("L-002", "옷 걸기·치우기", "옷을 걸고 치운 행동을 부모가 인정", 15, 1),
  life(
    "L-003",
    "빗자루 쓸기·청소기",
    "청소 행동을 부모가 인정. 도구별 두 번이 아닌 같은 규칙의 하루 한도.",
    15,
    1
  ),
  life(
    "L-004",
    "누리 약 먹이기",
    "반려묘 누리 돌봄. 자녀 본인 약물 기록과 별개.",
    15,
    2
  ),
  life("L-005", "라온이 바닥 똥 치우기", "정리 행동을 부모가 인정", 15, 2),
  life(
    "L-006",
    "책상 정리하기(책상 3종)",
    "책상 정리를 부모 재량으로 인정. 책상 3개를 세 번 보상하는 구조가 아님.",
    30,
    1
  ),
  life(
    "L-007",
    "분리수거(양손 기준)",
    "양손 기준은 수행량. 하루 1회 인정.",
    30,
    1
  ),
  life(
    "L-008",
    "방 바닥 쓰레기 방치",
    "잠자기 전 실제 방치 확인과 부모 사유·승인",
    -40,
    1,
    false,
    { check_time: "BEFORE_SLEEP" }
  ),
  life(
    "L-009",
    "목욕 후 젖은 옷을 화장실 바닥에 두기",
    "잠자기 전 실제 위반 확인과 부모 사유·승인",
    -40,
    1,
    false,
    { check_time: "BEFORE_SLEEP" }
  ),
  life(
    "L-010",
    "식후 바닥·주변 정리하지 않기",
    "트레이·그릇을 싱크대까지 옮기지 않고 주변을 정리하지 않은 실제 식후 사건. 하루 최대 2회.",
    -40,
    2,
    false,
    { check_time: "AFTER_MEAL" }
  ),
  life(
    "L-011",
    "10시까지 안 자기",
    "22시 실제 위반을 부모가 직접 확인. 미체크로 추정하지 않음.",
    -40,
    1,
    false,
    { check_time: "22:00" }
  ),
  life(
    "L-012",
    "엄마·외부인 카드로 몰래 결제",
    "부모가 확인한 실제 결제 사건당 한 번만 승인",
    -200,
    1,
    true
  ),
  life(
    "L-013",
    "저녁 7시반까지 저녁약 안 먹기",
    "19:30까지 미복용 사실을 부모가 아이에게 직접 물어 확인. 의료·양육일기 공란으로 자동 판정하지 않음.",
    -40,
    1,
    false,
    {
      check_time: "19:30",
      requires_direct_verification: true,
      medication_record_dependency: false,
    }
  ),
  life(
    "L-014",
    "외부인에게 함부로 행동",
    "할머니·선생님·아저씨 등 상대에게 실제 있었던 행동과 부모 확인 사유를 기록. 지적 횟수마다 차감하지 않음.",
    -60,
    1,
    true
  ),
  life(
    "L-015",
    "일반 기물파손",
    "책상 찍기·연필 부러뜨리기·책 찢기 등 실제 사건. 기기파손과 같은 사건이면 중복 확정 보류.",
    -40,
    1,
    true,
    { exclusive_incident_group: "PROPERTY_DAMAGE" }
  ),
  life(
    "L-016",
    "핸드폰·태블릿·학습기기·모니터 파손",
    "실제 기기파손 사건. 일반 기물파손과 같은 사건이면 중복 확정 보류.",
    -200,
    1,
    true,
    { exclusive_incident_group: "PROPERTY_DAMAGE" }
  ),
];

export function approvedOctoberRules(
  schoolAsset: OctoberAsset | "PENDING"
): OctoberRuleSeed[] {
  return octoberRulesSeed.map(source => {
    const rule = structuredClone(source);
    const original = rule.condition_spec.schedule as Record<string, unknown>;
    const schedule: Record<string, unknown> = {};
    if (original.weekdays) schedule.supportDays = original.weekdays;
    if (original.excluded_dates)
      schedule.excludedDates = original.excluded_dates;
    if (original.date) schedule.eventDates = [original.date];
    if (original.from && original.to) {
      const dates: string[] = [];
      const cursor = new Date(`${original.from}T00:00:00Z`);
      const end = new Date(`${original.to}T00:00:00Z`);
      while (cursor <= end) {
        dates.push(cursor.toISOString().slice(0, 10));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
      schedule.eventDates = dates;
      schedule.deadline = original.to;
    }
    rule.condition_spec.schedule = schedule;
    if (original.saturday_requires_no_class)
      rule.condition_spec.saturday_requires_no_class = true;
    if (rule.code === "Q-001") rule.condition_spec.scope = "2026-10-31";
    if (rule.code === "Q-002") rule.condition_spec.completion_once = true;
    if (rule.code === "T-007") {
      rule.condition_spec.school_asset = schoolAsset;
      if (schoolAsset !== "PENDING")
        rule.pending_fields = rule.pending_fields.filter(
          value => !value.includes("자산 최신 확인")
        );
    }
    return rule;
  });
}
