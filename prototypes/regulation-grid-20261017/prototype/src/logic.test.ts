import { describe, it, expect } from "vitest";
import {
  acknowledge,
  schoolTarget,
  schoolSummary,
  quoteCSV,
  type Occurrence,
  type SchoolDay,
  type Right,
} from "./logic";
import { rules } from "./rules";
const event = (id: string): Occurrence => ({
  id,
  code: "L-001",
  date: "2026-10-21",
  occurredAt: "2026-10-21T09:00:00+09:00",
  reported: true,
  verdict: "PENDING",
  reason: "",
  minutes: 0,
  revision: 0,
  requestKey: id,
});
const days = (base: (0 | 1 | null)[] = [1, 1, 1, 1, 1]): SchoolDay[] =>
  base.map((b, i) => ({
    date: `2026-10-${19 + i}`,
    base: b,
    praise: 0,
    feedback: true,
  }));
const period = "sample";
const right = (amount: number): Right => ({
  id: "right-" + amount,
  period,
  amount,
  issuedAt: "2026-10-23T08:00:00+09:00",
});
describe("모의 생활 인정", () => {
  it("4회 원사건과 3회 인정/45분을 분리한다", () => {
    let list = ["1", "2", "3", "4"].map(event);
    for (const id of ["1", "2", "3", "4"])
      list = acknowledge(list, id, 3, 15, true, "");
    expect(list).toHaveLength(4);
    expect(list.filter((e) => e.verdict === "APPROVED")).toHaveLength(3);
    expect(list[3].verdict).toBe("LIMIT_EXCEEDED");
    expect(list.reduce((n, e) => n + e.minutes, 0)).toBe(45);
  });
  it("같은 원사건 재확인은 중복 효과를 내지 않는다", () => {
    const once = acknowledge([event("1")], "1", 3, 15, true, "");
    expect(acknowledge(once, "1", 3, 15, true, "")).toEqual(once);
  });
  it("다른 날짜는 별도 일 한도다", () => {
    const list = [
      {
        ...event("1"),
        date: "2026-10-20",
        verdict: "APPROVED" as const,
        minutes: 15,
      },
      { ...event("2"), date: "2026-10-21" },
    ];
    expect(acknowledge(list, "2", 1, 15, true, "")[1].verdict).toBe("APPROVED");
  });
  it("미인정은 차감이 아니다", () =>
    expect(acknowledge([event("1")], "1", 3, 15, false, "")[0]).toMatchObject({
      verdict: "NO_EFFECT",
      minutes: 0,
    }));
  it("미정 한도·수량을 0으로 확정하지 않는다", () => {
    expect(acknowledge([event("1")], "1", null, 15, true, "")[0].verdict).toBe(
      "REVIEW_REQUIRED",
    );
    expect(acknowledge([event("1")], "1", 3, null, true, "")[0].verdict).toBe(
      "REVIEW_REQUIRED",
    );
  });
});
describe("학교 최고 구간·권리·이행", () => {
  it.each([
    [0, 0],
    [4, 0],
    [5, 10000],
    [7, 10000],
    [8, 15000],
    [10, 15000],
  ])("%i개 → 최종 %i원", (count, target) =>
    expect(schoolTarget(count)).toBe(target),
  );
  it("미확인을 0으로 최종 마감하지 않는다", () => {
    const s = schoolSummary(days([1, 1, 1, null, 1]), [], 0, period);
    expect(s.incomplete).toBe(1);
    expect(s.canIssue).toBe(false);
  });
  it("교사 피드백 미수신은 보류다", () => {
    const d = days();
    d[0].feedback = false;
    expect(schoolSummary(d, [], 0, period).canIssue).toBe(false);
  });
  it("문제+칭찬 동시 조건은 승인 전 보류다", () => {
    const d = days();
    d[0].base = 0;
    d[0].praise = 1;
    expect(schoolSummary(d, [], 0, period).incomplete).toBe(1);
  });
  it("5개 권리 발행 후 8개는 미이행이어도 5000원만 추가한다", () => {
    const d = days();
    for (let i = 0; i < 3; i++) d[i].praise = 1;
    const s = schoolSummary(d, [right(10000)], 0, period);
    expect(s.target).toBe(15000);
    expect(s.additional).toBe(5000);
    expect(s.outstanding).toBe(10000);
  });
  it("10000원 권리와 지급을 이중 공제하지 않는다", () => {
    const d = days();
    for (let i = 0; i < 3; i++) d[i].praise = 1;
    const s = schoolSummary(d, [right(10000)], 10000, period);
    expect(s.additional).toBe(5000);
    expect(s.outstanding).toBe(0);
  });
  it("15000원 발행 재전송은 추가0원이다", () => {
    const d = days();
    for (let i = 0; i < 3; i++) d[i].praise = 1;
    expect(
      schoolSummary(d, [right(10000), right(5000)], 0, period).additional,
    ).toBe(0);
  });
  it("지급 후 하향은 회수 대신 검토다", () => {
    const s = schoolSummary(days(), [right(15000)], 15000, period);
    expect(s.review).toBe(true);
    expect(s.canIssue).toBe(false);
  });
  it("다른 기간의 권리를 여기 합산하지 않는다", () =>
    expect(
      schoolSummary(days(), [{ ...right(10000), period: "other" }], 0, period)
        .issued,
    ).toBe(0));
});
describe("원문 보존과 CSV", () => {
  it("26개 규칙과 고유 번호를 보존한다", () => {
    expect(rules).toHaveLength(26);
    expect(new Set(rules.map((r) => r.code)).size).toBe(26);
  });
  it("바이올린 보상은 미정이다", () =>
    expect(rules.find((r) => r.code === "T-003")?.minutes).toBeNull());
  it("생활 +7개 명시 한도의 산술 합계는 195분이다", () =>
    expect(
      rules
        .filter((r) => r.domain === "LIFESTYLE" && !r.negative)
        .reduce((n, r) => n + (r.minutes || 0) * (r.cap || 0), 0),
    ).toBe(195));
  it("음수·공백 수식 셀을 실행시키지 않는다", () => {
    expect(quoteCSV('  =HYPERLINK("x")')).toMatch(/^"'/);
    expect(quoteCSV("hello")).toBe('"hello"');
  });
});
