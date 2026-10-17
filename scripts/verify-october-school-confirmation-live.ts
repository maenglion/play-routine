import { Client } from "pg";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { getSupabaseConnectionString } from "../server/supabaseConnection";
const connection = getSupabaseConnectionString(),
  uri = new URL(connection),
  project = "dsnvohyinazotouqbzrv";
if (
  new URL(process.env.SUPABASE_URL!).hostname !== `${project}.supabase.co` ||
  (!decodeURIComponent(uri.username).endsWith(`.${project}`) &&
    uri.hostname !== `db.${project}.supabase.co`)
)
  throw new Error("프로젝트 불일치");
const c = new Client({
  connectionString: connection,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
});
let checks = 0;
function assert(v: unknown, label: string) {
  if (!v) throw new Error(label);
  checks++;
  console.log(`통과 ${checks}: ${label}`);
}
async function denied(
  sql: string,
  args: unknown[],
  code: string,
  label: string
) {
  await c.query("savepoint rejected");
  let got = "";
  try {
    await c.query(sql, args);
  } catch (e) {
    got = (e as { code?: string }).code ?? "";
  } finally {
    await c.query("rollback to savepoint rejected");
    await c.query("release savepoint rejected");
  }
  assert(got === code, label);
}
async function snapshots() {
  const out: Record<string, string> = {};
  for (const table of [
    "october_rule_identities",
    "october_rule_versions",
    "october_ordinance_versions",
    "october_plan_adoptions",
    "october_occurrences",
    "october_occurrence_events",
    "october_buckets",
    "october_rights",
    "october_fulfillments",
  ]) {
    const r = await c.query(
      `select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) data from public.${table} t`
    );
    out[table] = createHash("sha256")
      .update(JSON.stringify(r.rows[0].data))
      .digest("hex");
  }
  return JSON.stringify(out);
}
try {
  await c.connect();
  await c.query("begin");
  if (process.argv.includes("--install")) {
    let s = await readFile(
      "supabase/migrations/0023_october_school_coupay_confirmation.sql",
      "utf8"
    );
    s = s.replace(/^\s*begin\s*;/i, "").replace(/commit\s*;\s*$/i, "");
    await c.query(s);
  }
  const rows =
    await c.query(`select plan.id plan_id,plan.family_id,cp.id child_id,p.id parent_id,p.auth_user_id from public.october_plans plan
 join public.child_profiles cp on cp.family_id=plan.family_id and cp.status='ACTIVE'
 join public.family_memberships fm on fm.family_id=plan.family_id and fm.role='OWNER_PARENT' and fm.status='ACTIVE'
 join public.principals p on p.id=fm.principal_id and p.status='ACTIVE' where plan.status='ACTIVE' and plan.month='2026-10-01'`);
  assert(rows.rowCount === 1, "단일 현재 계획·부모·자녀 (식별자 출력 없음)");
  const t = rows.rows[0];
  const before = await snapshots();
  const apply =
    "select private.apply_october_school_coupay_confirmation($1,$2) result";
  const first = (await c.query(apply, [t.plan_id, t.parent_id])).rows[0].result;
  assert(
    first.school_asset === "COUPAY_KRW" && first.rights_issued === 0,
    "쿠페이 자산 확정만 적용·권리 자동 발행0"
  );
  const replay = (await c.query(apply, [t.plan_id, t.parent_id])).rows[0]
    .result;
  assert(
    !replay.inserted && replay.rights_issued === 0,
    "같은 결정 재실행은 이력/권리 중복 없음"
  );
  assert(
    before === (await snapshots()),
    "규칙 버전·채택·기존 원사건·학교 bucket·권리·이행 보존"
  );
  const d = (
    await c.query(
      "select * from public.october_school_asset_decisions where plan_id=$1",
      [t.plan_id]
    )
  ).rows;
  assert(
    d.length === 1 &&
      d[0].prior_asset === "PENDING" &&
      d[0].school_asset === "COUPAY_KRW",
    "PENDING→쿠페이 결정 한 행 추가"
  );
  await denied(
    "update public.october_school_asset_decisions set school_asset='COUPAY_KRW' where plan_id=$1",
    [t.plan_id],
    "55000",
    "결정 이력 덮어쓰기 거절"
  );
  await denied(
    "delete from public.october_school_asset_decisions where plan_id=$1",
    [t.plan_id],
    "55000",
    "결정 이력 삭제 거절"
  );
  await denied(
    "truncate public.october_school_asset_decisions",
    [],
    "55000",
    "결정 이력 truncate 거절"
  );
  const audit = (
    await c.query(
      "select new_values from play_audit.events where table_name='october_school_asset_decisions' and row_id=$1",
      [d[0].id]
    )
  ).rows;
  assert(
    audit.length === 1 &&
      audit[0].new_values.school_asset === "COUPAY_KRW" &&
      !("source_snapshot" in audit[0].new_values),
    "확정 감사 한 행·원문 제외"
  );
  const rule = (
    await c.query(
      `select rv.id from public.october_plan_adoptions a join public.october_rule_versions rv on rv.id=a.rule_version_id join public.october_rule_identities i on i.id=rv.rule_identity_id where a.plan_id=$1 and a.child_profile_id=$2 and i.stable_code='T-007'`,
      [t.plan_id, t.child_id]
    )
  ).rows[0];
  for (const [total, quantity] of [
    [4, 0],
    [5, 10000],
    [7, 10000],
    [8, 15000],
  ]) {
    const effects = (
      await c.query(
        "select private.october_school_target_effects(r,'COUPAY_KRW',$2) effects from public.october_rule_versions r where id=$1",
        [rule.id, total]
      )
    ).rows[0].effects;
    assert(
      (effects[0]?.quantity ?? 0) === quantity,
      `스티커 ${total}개 최고총액 ${quantity}원`
    );
  }
  await c.query(
    "select set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true),set_config('request.jwt.claim.role','authenticated',true)",
    [
      JSON.stringify({ sub: t.auth_user_id, role: "authenticated" }),
      t.auth_user_id,
    ]
  );
  await c.query("set local role authenticated");
  const b = (
    await c.query(
      "select public.get_october_board($1,$2,'2026-10-18') result",
      [t.family_id, t.child_id]
    )
  ).rows[0].result;
  const school = b.rules.find((r: any) => r.code === "T-007");
  assert(
    b.plan.school_asset === "COUPAY_KRW" &&
      school.condition_spec.school_asset === "COUPAY_KRW" &&
      !school.pending_fields.some((v: string) => v.includes("자산 최신 확인")),
    "부모 실제 board는 확정 자산·보류 제거, 불변 원본은 그대로"
  );
  await denied(
    apply,
    [t.plan_id, t.parent_id],
    "42501",
    "authenticated의 관리 자산 적용 함수 접근 거절"
  );
  await denied(
    "select * from public.october_school_asset_decisions",
    [],
    "42501",
    "authenticated의 raw 결정 원문 접근 거절"
  );
  await c.query("reset role");
  assert(
    before === (await snapshots()),
    "조회 후에도 기존 발생·확인·권리/이행 내용 그대로"
  );
  await c.query("rollback");
  console.log(
    JSON.stringify(
      { checks, rollback: true, noAutomaticCloseOrRightsOrFulfillment: true },
      null,
      2
    )
  );
} catch (e) {
  await c.query("rollback").catch(() => {});
  console.error(
    "학교 확정 검증 실패:",
    (e as { code?: string }).code ?? (e as Error).message
  );
  process.exitCode = 1;
} finally {
  await c.end();
}
