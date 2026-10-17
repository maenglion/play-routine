import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getSupabaseConnectionString } from "../server/supabaseConnection";
import { seedOctoberRuntime } from "./seed-october-runtime";

const expected = "dsnvohyinazotouqbzrv";
const uri = new URL(getSupabaseConnectionString());
if (
  new URL(process.env.SUPABASE_URL!).hostname !== `${expected}.supabase.co` ||
  (!decodeURIComponent(uri.username).endsWith(`.${expected}`) &&
    uri.hostname !== `db.${expected}.supabase.co`)
)
  throw new Error("프로젝트 불일치");
const client = new Client({
  connectionString: uri.toString(),
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
});
let checks = 0;
const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
  checks++;
};
async function rejects(sql: string, args: unknown[], code: string) {
  await client.query("savepoint expected_rejection");
  let rejected = false;
  try {
    await client.query(sql, args);
  } catch (e) {
    rejected = (e as { code: string }).code === code;
  } finally {
    await client.query("rollback to savepoint expected_rejection");
    await client.query("release savepoint expected_rejection");
  }
  assert(rejected, `거절 예상 ${code}`);
}
try {
  await client.connect();
  await client.query("begin");
  if (process.argv.includes("--install")) {
    for (const name of ["0021_october_runtime.sql", "0022_october_audit.sql"]) {
      const sql = (await readFile(`supabase/migrations/${name}`, "utf8"))
        .replace(/^\s*begin\s*;/i, "")
        .replace(/commit\s*;\s*$/i, "");
      await client.query(sql);
    }
  }
  const target =
    await client.query(`select f.id family_id,cp.id child_id,p.id parent_id,p.auth_user_id from public.families f
    join public.child_profiles cp on cp.family_id=f.id and cp.status='ACTIVE'
    join public.family_memberships fm on fm.family_id=f.id and fm.role='OWNER_PARENT' and fm.status='ACTIVE'
    join public.principals p on p.id=fm.principal_id and p.status='ACTIVE' where f.status='ACTIVE'`);
  assert(target.rowCount === 1, "단일 대상 가족·자녀 필요");
  const t = target.rows[0];
  const fixture = {
    familyId: t.family_id,
    childId: t.child_id,
    parentId: t.parent_id,
    authUserId: t.auth_user_id,
  };
  // 모의 인증 context는 이 롤백 시험에서만 사용한다. 관리 seed CLI는 이를 설정하지 않는다.
  await client.query(
    "select set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true),set_config('request.jwt.claim.role','authenticated',true)",
    [
      JSON.stringify({ sub: t.auth_user_id, role: "authenticated" }),
      t.auth_user_id,
    ]
  );
  const baseline = (
    await client.query(
      "select coalesce(max(audit_id),0)::text n from play_audit.events"
    )
  ).rows[0].n;
  const seed = await seedOctoberRuntime(client, fixture),
    replay = await seedOctoberRuntime(client, fixture);
  assert(seed.ruleCount === 26 && seed.adoptionCount === 26, "26 규칙·26 채택");
  assert(
    !replay.inserted && replay.planId === seed.planId,
    "seed 동일 입력 재전송"
  );
  const triggers =
    await client.query(`select count(*)::int n from pg_trigger tr join pg_class c on c.oid=tr.tgrelid
    join pg_namespace ns on ns.oid=c.relnamespace where ns.nspname='public' and tr.tgname='play_audit_october_row_change' and tr.tgenabled='O'`);
  assert(triggers.rows[0].n === 12, "신규 감사 12 트리거 활성");
  const beforeRecords = (
    await client.query(
      "select count(*)::int n from public.october_occurrences where family_id=$1",
      [t.family_id]
    )
  ).rows[0].n;
  const r = (
    await client.query(
      `select rv.id from public.october_plan_adoptions a join public.october_rule_versions rv on rv.id=a.rule_version_id and rv.family_id=a.family_id
    join public.october_rule_identities ri on ri.id=rv.rule_identity_id and ri.family_id=rv.family_id where a.plan_id=$1 and a.child_profile_id=$2 and ri.stable_code='T-001'`,
      [seed.planId, t.child_id]
    )
  ).rows[0].id;
  const sentinel = "PR_AUDIT_PRIVATE_SENTINEL_20261018";
  await client.query(
    "select public.confirm_october_occurrence($1,$2,$3,'2026-10-18',$4,'PASS','{}'::jsonb,$5,'daily',0)",
    [t.family_id, t.child_id, r, randomUUID(), sentinel]
  );
  const events = await client.query(
    "select * from play_audit.events where audit_id>$1 and table_name like 'october_%'",
    [baseline]
  );
  assert(events.rowCount! > 0, "새 변경 감사 기록");
  assert(
    events.rows.every(
      e =>
        e.actor_auth_user_id === t.auth_user_id &&
        e.actor_principal_id === t.parent_id &&
        e.actor_kind === "AUTH_USER"
    ),
    "JWT 부모 행위자 확인"
  );
  assert(
    !JSON.stringify(
      events.rows.map(e => [e.old_values, e.new_values])
    ).includes(sentinel),
    "부모 사유 원문 제외"
  );
  const denied = [
    "reason",
    "criteria",
    "name",
    "metrics",
    "effects",
    "condition_spec",
    "effect_spec",
    "source_snapshot",
    "request_payload",
    "response_payload",
  ];
  assert(
    events.rows.every(e =>
      [e.old_values, e.new_values].every(
        v => !v || Object.keys(v).every(k => !denied.includes(k))
      )
    ),
    "민감·원문 필드 제외"
  );
  assert(
    events.rows.every(
      e =>
        e.new_fingerprint === null || /^[a-f0-9]{64}$/.test(e.new_fingerprint)
    ),
    "허용 필드 SHA256"
  );
  assert(
    events.rows.some(
      e =>
        e.table_name === "october_occurrences" &&
        e.changed_columns.includes("reason")
    ),
    "원문 아닌 열 이름 기록"
  );
  const sample = events.rows[0];
  await rejects(
    "update play_audit.events set table_name='X' where audit_id=$1",
    [sample.audit_id],
    "55000"
  );
  await rejects(
    "delete from play_audit.events where audit_id=$1",
    [sample.audit_id],
    "55000"
  );
  await rejects("truncate play_audit.events", [], "55000");
  await client.query("set local role authenticated");
  await rejects("select * from play_audit.events", [], "42501");
  await rejects(
    "insert into public.october_rights(family_id) values($1)",
    [t.family_id],
    "42501"
  );
  const read = await client.query(
    "select * from public.list_family_audit_events($1,null,100)",
    [t.family_id]
  );
  assert(read.rows.length > 0, "부모 감사 RPC 조회");
  await client.query("reset role");
  await client.query("rollback");
  console.log(
    JSON.stringify(
      {
        checks,
        rollback: true,
        seedOrFactsCommitted: false,
        existingOccurrencesBefore: beforeRecords,
      },
      null,
      2
    )
  );
} catch (e) {
  await client.query("rollback").catch(() => {});
  console.error(
    "10월 감사 검증 실패:",
    (e as { code?: string }).code ?? (e as Error).message
  );
  process.exitCode = 1;
} finally {
  await client.end();
}
