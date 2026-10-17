import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const sql = readFileSync(
  new URL("../supabase/migrations/0020_audit_log.sql", import.meta.url),
  "utf8"
);
describe("감사 SQL 고정 보안 계약", () => {
  it("트랜잭션·잠금 제한·비공개 schema·RLS를 포함한다", () => {
    expect(sql).toMatch(/^begin;/);
    expect(sql.trim()).toMatch(/commit;$/);
    expect(sql).toContain("set local lock_timeout = '5s'");
    expect(sql).toContain(
      "alter table play_audit.events enable row level security"
    );
    expect(sql).toContain(
      "revoke all on schema play_audit from public, anon, authenticated, service_role"
    );
  });
  it("동일 16개 테이블만 사전 검사와 설치에 사용한다", () => {
    const lists = [
      ...sql.matchAll(/foreach v_table in array array\[([\s\S]*?)\]/g),
    ].map(x => [...x[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]));
    expect(lists).toHaveLength(2);
    expect(lists[0]).toHaveLength(16);
    expect(new Set(lists[0]).size).toBe(16);
    expect(lists[0]).toEqual(lists[1]);
  });
  it("허용 필드 배열에 토큰·이메일·자유서술·요청 원문이 없다", () => {
    const allow = sql
      .split("v_columns := case tg_table_name")[1]
      .split("else null end;")[0];
    const forbidden = [
      "payload",
      "request_payload",
      "response_payload",
      "reason",
      "parent_reason",
      "text_value",
      "email",
      "email_masked",
      "auth_email_fingerprint",
      "password",
      "token",
      "idempotency_key",
      "name",
      "unit_label",
    ];
    for (const field of forbidden) expect(allow).not.toContain(`'${field}'`);
    expect(sql).toContain("e.key = any(v_columns)");
  });
  it("감사 UPDATE·DELETE와 문장 단위 TRUNCATE를 차단한다", () => {
    expect(sql).toContain("before update or delete on play_audit.events");
    expect(sql).toContain("before truncate on play_audit.events");
    expect(sql).toContain("AUDIT_APPEND_ONLY");
  });
  it("SECURITY DEFINER는 고정 search_path·JWT·활성 부모 계약을 갖는다", () => {
    expect(sql.match(/security definer set search_path = ''/g)).toHaveLength(2);
    expect(sql).toContain("fm.role in ('OWNER_PARENT','PARENT')");
    expect(sql).toContain("u.email_confirmed_at is not null");
    expect(sql).toContain("p.status = 'ACTIVE' and f.status = 'ACTIVE'");
    expect(sql).toContain("fm.valid_from <= statement_timestamp()");
    expect(sql).toContain(
      "grant execute on function public.list_family_audit_events(uuid, bigint, integer) to authenticated"
    );
  });
  it("감사 실패 예외를 삼키지 않고 핵심 식별자 변경을 거절한다", () => {
    expect(sql).not.toMatch(/exception\s+when\s+others/i);
    expect(sql).toContain("AUDIT_IDENTITY_CHANGE_FORBIDDEN");
    expect(sql).toContain("session_user::text, auth.role()");
  });
});
const live = process.env.RUN_LIVE_AUDIT_TESTS === "1";
describe.skipIf(!live)("실제 Supabase 감사·권한·rollback 회귀", () => {
  it("설치된 감사 시스템과 기존 부모 RPC가 같이 동작한다", () => {
    const output = execFileSync(
      "pnpm",
      ["exec", "tsx", "scripts/verify-audit-log-live.ts"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 240000,
        env: process.env,
      }
    );
    expect(output).toContain("AUDIT_LIVE_OK");
    expect(output).toContain('"fixtureRolledBack":true');
  }, 260000);
});
