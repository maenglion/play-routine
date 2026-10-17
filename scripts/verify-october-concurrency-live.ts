import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { getSupabaseConnectionString } from "../server/supabaseConnection";

const connection = getSupabaseConnectionString(),
  project = "dsnvohyinazotouqbzrv",
  uri = new URL(connection);
if (
  new URL(process.env.SUPABASE_URL!).hostname !== `${project}.supabase.co` ||
  (!decodeURIComponent(uri.username).endsWith(`.${project}`) &&
    uri.hostname !== `db.${project}.supabase.co`)
)
  throw new Error("프로젝트 불일치");
const clients = [0, 1, 2].map(
  () =>
    new Client({
      connectionString: connection,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 10000,
    })
);
const [a, b, monitor] = clients;
let passed = 0;
const assert = (v: unknown, label: string) => {
  if (!v) throw new Error(label);
  passed++;
  console.log(`통과 ${passed}: ${label}`);
};
try {
  await Promise.all(clients.map(c => c.connect()));
  const targets = (
    await monitor.query(`select cp.family_id,cp.id child_id,p.auth_user_id,rv.id rule_id
    from public.october_plan_adoptions ad join public.october_plans plan on plan.id=ad.plan_id and plan.family_id=ad.family_id and plan.status='ACTIVE'
    join public.child_profiles cp on cp.id=ad.child_profile_id and cp.family_id=ad.family_id and cp.status='ACTIVE'
    join public.family_memberships fm on fm.family_id=cp.family_id and fm.role='OWNER_PARENT' and fm.status='ACTIVE'
    join public.principals p on p.id=fm.principal_id and p.status='ACTIVE'
    join public.october_rule_versions rv on rv.id=ad.rule_version_id and rv.family_id=ad.family_id
    join public.october_rule_identities ri on ri.id=rv.rule_identity_id and ri.family_id=rv.family_id
    where ri.stable_code='L-001'`)
  ).rows;
  assert(
    targets.length === 1,
    "단일 실제 채택 대상을 식별 (개인정보 출력 없음)"
  );
  const t = targets[0];
  for (const c of [a, b]) {
    await c.query("begin");
    await c.query("set local statement_timeout='20s'");
    await c.query(
      "select set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true),set_config('request.jwt.claim.role','authenticated',true)",
      [
        JSON.stringify({ sub: t.auth_user_id, role: "authenticated" }),
        t.auth_user_id,
      ]
    );
    await c.query("set local role authenticated");
  }
  const sql =
    "select public.confirm_october_occurrence($1,$2,$3,'2026-10-18',$4,'PASS','{}'::jsonb,null,$5,0) r";
  const first = (
    await a.query(sql, [
      t.family_id,
      t.child_id,
      t.rule_id,
      randomUUID(),
      randomUUID(),
    ])
  ).rows[0].r;
  assert(first.state === "PASS", "연결 A가 첫 회차와 한도 잠금을 확보");
  const bPid = (await b.query("select pg_backend_pid() pid")).rows[0].pid;
  let bDone = false;
  const pending = b
    .query(sql, [
      t.family_id,
      t.child_id,
      t.rule_id,
      randomUUID(),
      randomUUID(),
    ])
    .then(r => {
      bDone = true;
      return r;
    });
  let lockObserved = false;
  for (let n = 0; n < 20 && !lockObserved; n++) {
    await new Promise(r => setTimeout(r, 100));
    lockObserved = (
      await monitor.query(
        "select exists(select 1 from pg_locks where pid=$1 and locktype='advisory' and not granted) locked",
        [bPid]
      )
    ).rows[0].locked;
  }
  assert(
    lockObserved && !bDone,
    "동일 가족·자녀·규칙·일자는 다른 slot이어도 B가 한도 잠금에서 대기"
  );
  await a.query("rollback");
  const resumed = (await pending).rows[0].r;
  assert(resumed.state === "PASS", "A rollback 뒤 B가 재계산하고 정상 진행");
  await b.query("rollback");
  console.log(
    JSON.stringify(
      {
        passed,
        connections: 2,
        serializedByRealPostgresAdvisoryLock: true,
        allWritesRolledBack: true,
        commitRaceScenarioClaimed: false,
      },
      null,
      2
    )
  );
} catch (e) {
  console.error(
    "동시 연결 시험 실패:",
    (e as { code?: string }).code ?? (e as Error).message
  );
  process.exitCode = 1;
} finally {
  await Promise.all(
    clients.map(async c => {
      await c.query("rollback").catch(() => {});
      await c.end().catch(() => {});
    })
  );
}
