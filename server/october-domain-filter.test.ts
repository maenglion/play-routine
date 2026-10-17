import { describe, expect, it } from "vitest";
import {
  filterOctoberBoardByDomain,
  octoberDomainFilterFromSearch,
  octoberDomainFilterSearch,
  octoberDomainFilterValue,
} from "../client/src/lib/october-domain-filter";
import { makeOctoberPreviewBoard } from "../client/src/lib/october-preview-data";
describe("부모 종류 필터", () => {
  it("전체·Task·Quest·Lifestyle의 규정만 표시한다", () => {
    const b = makeOctoberPreviewBoard("2026-10-18");
    expect(filterOctoberBoardByDomain(b, "ALL").rules).toHaveLength(26);
    expect(filterOctoberBoardByDomain(b, "TASK").rules).toHaveLength(7);
    expect(filterOctoberBoardByDomain(b, "QUEST").rules).toHaveLength(3);
    expect(filterOctoberBoardByDomain(b, "LIFESTYLE").rules).toHaveLength(16);
    const view = filterOctoberBoardByDomain(b, "LIFESTYLE");
    expect(view.rows.every(x => x.code.startsWith("L-"))).toBe(true);
  });
  it("현재 상태·회차·전체 합계·원본 배열을 변경하지 않는다", () => {
    const b = makeOctoberPreviewBoard("2026-10-18");
    b.summary.pending_minutes = 45;
    b.rights = [
      {
        id: "r",
        code: "L-001",
        rule_name: "청소",
        asset: "MINUTES",
        quantity: 15,
        fulfilled_quantity: 0,
        status: "ISSUED",
        source_date: "2026-10-18",
        issued_at: "2026-10-18T00:00:00Z",
      },
    ];
    const before = JSON.stringify(b);
    const task = filterOctoberBoardByDomain(b, "TASK");
    expect(task.rights).toHaveLength(0);
    expect(filterOctoberBoardByDomain(b, "LIFESTYLE").rights).toHaveLength(1);
    expect(JSON.stringify(b)).toBe(before);
    expect(b.summary.pending_minutes).toBe(45);
  });
  it("URL 새로고침 복원·전체 선택·미지값 fallback과 다른 query를 보존한다", () => {
    expect(
      octoberDomainFilterFromSearch("?preview=parent&kind=LIFESTYLE")
    ).toBe("LIFESTYLE");
    expect(octoberDomainFilterValue("PENALTY")).toBe("ALL");
    expect(
      octoberDomainFilterSearch("?preview=parent&role=parent", "TASK")
    ).toBe("?preview=parent&role=parent&kind=TASK");
    expect(octoberDomainFilterSearch("?preview=parent&kind=TASK", "ALL")).toBe(
      "?preview=parent"
    );
    expect(octoberDomainFilterSearch("?kind=TASK", "ALL")).toBe("");
  });
  it("아직 로딩된 board가 없으면 빈 목록으로 표시한다", () =>
    expect(filterOctoberBoardByDomain(null, "ALL")).toEqual({
      rules: [],
      rows: [],
      rights: [],
    }));
});
