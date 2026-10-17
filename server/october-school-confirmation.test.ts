import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeOctoberPreviewBoard } from "../client/src/lib/october-preview-data";
const sql = readFileSync(
  new URL(
    "../supabase/migrations/0023_october_school_coupay_confirmation.sql",
    import.meta.url
  ),
  "utf8"
);
describe("학교 쿠페이 확정 계약", () => {
  it("새 이력만 추가하고 기존 버전/회차/기간/권리를 reset하지 않는다", () => {
    expect(sql).toContain("unique(plan_id)");
    expect(sql).toContain("OCTOBER_SCHOOL_DECISION_APPEND_ONLY");
    expect(sql).not.toMatch(
      /(?:update|delete from|truncate) public\.october_(?:rule_versions|plan_adoptions|occurrences|buckets|rights|fulfillments)/i
    );
    expect(sql).toContain("'rights_issued',0");
    expect(sql).toContain("OCTOBER_SCHOOL_COUPAY_TIERS_MISMATCH");
  });
  it("관리 결정은 클라이언트에 열지 않고 board만 인증 조회한다", () => {
    expect(sql).toContain(
      "revoke all on function private.apply_october_school_coupay_confirmation(uuid,uuid) from public,anon,authenticated,service_role"
    );
    expect(sql).toContain(
      "grant execute on function public.get_october_board(uuid,uuid,date) to authenticated"
    );
    expect(sql).toContain(
      "october_school_asset_decisions enable row level security"
    );
  });
  it("26개 미리보기 중 학교 자산만 쿠페이 확정이며 문제+칭찬 보류는 유지한다", () => {
    const b = makeOctoberPreviewBoard("2026-10-18");
    expect(b.rules).toHaveLength(26);
    expect(b.plan?.school_asset).toBe("COUPAY_KRW");
    const r = b.rules.find(x => x.code === "T-007")!;
    expect(r.condition_spec.school_asset).toBe("COUPAY_KRW");
    expect(r.pending_fields.some(x => x.includes("자산 최신 확인"))).toBe(
      false
    );
    expect(r.pending_fields.some(x => x.includes("문제+칭찬"))).toBe(true);
  });
});
