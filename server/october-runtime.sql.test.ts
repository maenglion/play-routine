import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const sql = readFileSync(
  new URL("../supabase/migrations/0021_october_runtime.sql", import.meta.url),
  "utf8"
);
const audit = readFileSync(
  new URL("../supabase/migrations/0022_october_audit.sql", import.meta.url),
  "utf8"
);
describe("10월 운영 SQL 보안·계산 정적 계약", () => {
  it("신규 12개 테이블은 전부 RLS이고 raw authenticated 쓰기를 열지 않는다", () => {
    const tables = [
      ...sql.matchAll(/create table if not exists public\.(october_\w+)/g),
    ].map(x => x[1]);
    expect(tables).toHaveLength(12);
    for (const table of tables)
      expect(sql).toContain(
        `alter table public.${table} enable row level security`
      );
    expect(sql).not.toMatch(
      /grant\s+(?:all|insert|update|delete|truncate)\s+on\s+(?:table\s+)?public\.october_/i
    );
  });
  it("날짜별·월별·요청별 잠금과 nullable 검증 fail-closed를 유지한다", () => {
    expect(sql).toContain("october-cap:");
    expect(sql).toContain("october-month-cap:");
    expect(sql).toContain("october-key:");
    expect(sql).toMatch(
      /october_metrics_are_valid\([^\n]+\) is distinct from true/
    );
    expect(sql).toContain("OCTOBER_IDEMPOTENCY_KEY_REUSED");
    expect(sql).toContain("OCTOBER_OCCURRENCE_REVISION_CONFLICT");
  });
  it("실제 RPC는 다섯 개이며 auth.uid·고정 search_path를 유지한다", () => {
    const publicFunctions = [
      ...sql.matchAll(/create or replace function public\.(\w+)\(/g),
    ].map(x => x[1]);
    expect(publicFunctions.sort()).toEqual(
      [
        "get_october_board",
        "submit_october_occurrence",
        "confirm_october_occurrence",
        "close_october_school_week",
        "fulfill_october_right",
      ].sort()
    );
    expect(sql).toContain("auth.uid()");
    const definitions = [
      ...sql.matchAll(
        /returns (?:jsonb|uuid|boolean|date|integer|void|trigger|public\.october_\w+)[\s\S]*?as \$\$/g
      ),
    ];
    expect(definitions.length).toBeGreaterThan(10);
    expect(sql).not.toMatch(/security definer(?! set search_path = '')/);
  });
  it("새 감사 허용 필드는 부모 사유·의료·raw JSON 사본을 포함하지 않는다", () => {
    const allowlist = audit
      .split("v_columns text[] := array[")[1]
      .split("];", 1)[0];
    for (const name of [
      "reason",
      "metrics",
      "condition_spec",
      "effect_spec",
      "request_payload",
      "response_payload",
      "source_snapshot",
      "name",
      "criteria",
      "effects",
    ])
      expect(allowlist).not.toContain(`'${name}'`);
    expect(audit).toContain("actor_auth_user_id");
    expect(audit).toContain("play_audit.events");
    expect(audit).toContain("OCTOBER_AUDIT_TARGET_MISSING");
  });
});
