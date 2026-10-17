import { Client } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { approvedOctoberRules } from "../server/october-seed-data";
import { getSupabaseConnectionString } from "../server/supabaseConnection";

export type OctoberSeedTarget = {
  familyId: string;
  childId: string;
  parentId: string;
  authUserId: string;
};
export const octoberSeedRules = approvedOctoberRules("PENDING");
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const seedHash = hash(octoberSeedRules);

/** Caller owns BEGIN/COMMIT. No existing record, assignment, catalog or reward is modified. */
export async function seedOctoberRuntime(
  client: Client,
  target: OctoberSeedTarget
) {
  const { familyId, childId, parentId, authUserId } = target;
  const verified = await client.query(
    `select cp.id from public.child_profiles cp
    join public.families f on f.id=cp.family_id
    join public.family_memberships fm on fm.family_id=f.id
    join public.principals p on p.id=fm.principal_id
    join auth.users u on u.id=p.auth_user_id
    where cp.id=$1 and cp.family_id=$2 and cp.status='ACTIVE' and f.status='ACTIVE'
    and p.id=$3 and p.auth_user_id=$4 and p.status='ACTIVE' and u.email_confirmed_at is not null
    and fm.role in ('OWNER_PARENT','PARENT') and fm.status='ACTIVE'
    and fm.valid_from<=statement_timestamp() and (fm.valid_to is null or fm.valid_to>statement_timestamp())`,
    [childId, familyId, parentId, authUserId]
  );
  if (verified.rowCount !== 1) throw new Error("OCTOBER_SEED_TARGET_INVALID");
  await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
    `october-seed:${familyId}:2026-10`,
  ]);
  // 승인 대상 principal은 provenance/FK에 남긴다. 관리 DB 세션을 부모 로그인으로 위장하지 않는다.
  // 실제 CLI 설치의 감사 actor_kind는 DATABASE_SESSION이며 시험 caller만 자체 JWT context를 설정한다.
  const existing = await client.query(
    `select p.id, p.school_asset, ov.source_snapshot
    from public.october_plans p join public.october_ordinance_versions ov
    on ov.id=p.ordinance_version_id and ov.family_id=p.family_id
    where p.family_id=$1 and p.month='2026-10-01' and p.status='ACTIVE'`,
    [familyId]
  );
  if (existing.rowCount) {
    if (
      existing.rowCount !== 1 ||
      existing.rows[0].source_snapshot.seed_sha256 !== seedHash
    )
      throw new Error("OCTOBER_SEED_EXISTING_PLAN_MISMATCH");
    if (existing.rows[0].school_asset !== "PENDING") {
      const decision = await client.query(
        "select 1 from public.october_school_asset_decisions where plan_id=$1 and school_asset=$2 and decision_code='SCHOOL_COUPAY_CONFIRMATION_20261018'",
        [existing.rows[0].id, existing.rows[0].school_asset]
      );
      if (decision.rowCount !== 1)
        throw new Error("OCTOBER_SEED_SCHOOL_DECISION_MISSING");
    }
    const count = await client.query(
      "select count(*)::int n from public.october_plan_adoptions where family_id=$1 and child_profile_id=$2 and plan_id=$3",
      [familyId, childId, existing.rows[0].id]
    );
    if (count.rows[0].n !== 26)
      throw new Error("OCTOBER_SEED_ADOPTION_MISMATCH");
    return {
      inserted: false,
      planId: existing.rows[0].id,
      ruleCount: 26,
      adoptionCount: 26,
      schoolAsset: existing.rows[0].school_asset,
      seedHash,
    };
  }
  const ordinanceId = randomUUID(),
    ordinanceVersionId = randomUUID(),
    planId = randomUUID();
  const provenance = {
    source_label: "Play-Routine-October-Enforcement-Rules-v0.5",
    seed_file: "server/october-seed-data.ts",
    seed_sha256: seedHash,
    constitution_version: "v0.6",
    lifecycle_design_version: "v0.2",
    user_authorization: "10월 26개 규칙 실제 반영 요청",
    school_asset_decision: "PENDING",
    month: "2026-10-01",
    effective_from: "2026-10-18",
    effective_to: "2026-11-01",
  };
  await client.query(
    `insert into public.october_ordinances(id,family_id,stable_code,title,jurisdiction,created_by_principal_id)
    values($1,$2,'PLAY_ROUTINE_OCTOBER_2026','Play Routine 10월 시행령','FAMILY',$3)`,
    [ordinanceId, familyId, parentId]
  );
  await client.query(
    `insert into public.october_ordinance_versions(id,family_id,ordinance_id,version,ordinance_kind,source_label,source_snapshot,adopted_by_principal_id)
    values($1,$2,$3,1,'OCTOBER_ENFORCEMENT',$4,$5::jsonb,$6)`,
    [
      ordinanceVersionId,
      familyId,
      ordinanceId,
      provenance.source_label,
      JSON.stringify(provenance),
      parentId,
    ]
  );
  await client.query(
    `insert into public.october_plans(id,family_id,ordinance_version_id,month,effective_from,effective_to,status,school_asset,created_by_principal_id)
    values($1,$2,$3,'2026-10-01','2026-10-18','2026-11-01','ACTIVE','PENDING',$4)`,
    [planId, familyId, ordinanceVersionId, parentId]
  );
  for (const rule of octoberSeedRules) {
    const identityId = randomUUID(),
      versionId = randomUUID();
    const effectSpec = {
      kind: rule.effect_kind,
      effects: rule.effects,
      pending_fields: rule.pending_fields,
      schedule_label: rule.schedule_label,
      ...(rule.code === "T-007" ? { school_asset: "PENDING" } : {}),
    };
    await client.query(
      `insert into public.october_rule_identities(id,family_id,ordinance_id,stable_code,created_by_principal_id)
      values($1,$2,$3,$4,$5)`,
      [identityId, familyId, ordinanceId, rule.code, parentId]
    );
    await client.query(
      `insert into public.october_rule_versions(id,family_id,rule_identity_id,ordinance_version_id,version,domain,name,criteria,period,daily_limit,condition_spec,effect_spec,created_by_principal_id)
      values($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12)`,
      [
        versionId,
        familyId,
        identityId,
        ordinanceVersionId,
        rule.domain,
        rule.name,
        rule.criteria,
        rule.period,
        rule.daily_limit,
        JSON.stringify(rule.condition_spec),
        JSON.stringify(effectSpec),
        parentId,
      ]
    );
    await client.query(
      `insert into public.october_plan_adoptions(id,family_id,plan_id,child_profile_id,rule_version_id,adopted_by_principal_id)
      values($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), familyId, planId, childId, versionId, parentId]
    );
  }
  const totals = await client.query(
    `select rv.domain,count(*)::int n from public.october_plan_adoptions a
    join public.october_rule_versions rv on rv.id=a.rule_version_id and rv.family_id=a.family_id
    where a.plan_id=$1 and a.child_profile_id=$2 group by rv.domain`,
    [planId, childId]
  );
  const counts = Object.fromEntries(totals.rows.map(x => [x.domain, x.n]));
  if (counts.QUEST !== 3 || counts.TASK !== 7 || counts.LIFESTYLE !== 16)
    throw new Error("OCTOBER_SEED_COUNTS_INVALID");
  return {
    inserted: true,
    planId,
    ruleCount: 26,
    adoptionCount: 26,
    schoolAsset: "PENDING",
    seedHash,
  };
}

async function main() {
  const mode = process.argv[2] ?? "dry-run";
  if (!["dry-run", "apply"].includes(mode))
    throw new Error("사용법: seed-october-runtime.ts dry-run|apply");
  const project = "dsnvohyinazotouqbzrv";
  const connection = getSupabaseConnectionString(),
    uri = new URL(connection);
  if (
    new URL(process.env.SUPABASE_URL!).hostname !== `${project}.supabase.co` ||
    (!decodeURIComponent(uri.username).endsWith(`.${project}`) &&
      uri.hostname !== `db.${project}.supabase.co`)
  )
    throw new Error("OCTOBER_PROJECT_MISMATCH");
  const client = new Client({
    connectionString: connection,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });
  try {
    await client.connect();
    await client.query("begin");
    const target =
      await client.query(`select f.id family_id,cp.id child_id,p.id parent_id,p.auth_user_id
      from public.families f join public.child_profiles cp on cp.family_id=f.id and cp.status='ACTIVE'
      join public.family_memberships fm on fm.family_id=f.id and fm.role='OWNER_PARENT' and fm.status='ACTIVE'
      join public.principals p on p.id=fm.principal_id and p.status='ACTIVE'
      where f.status='ACTIVE' and fm.valid_from<=statement_timestamp() and (fm.valid_to is null or fm.valid_to>statement_timestamp())`);
    if (target.rowCount !== 1)
      throw new Error(
        "단일 활성 가족·자녀를 확인할 수 없어 자동 선택을 중단합니다."
      );
    const t = target.rows[0];
    const result = await seedOctoberRuntime(client, {
      familyId: t.family_id,
      childId: t.child_id,
      parentId: t.parent_id,
      authUserId: t.auth_user_id,
    });
    await client.query(mode === "apply" ? "commit" : "rollback");
    console.log(
      JSON.stringify(
        {
          mode,
          inserted: result.inserted,
          rules: result.ruleCount,
          adoptions: result.adoptionCount,
          schoolAsset: result.schoolAsset,
          seedHash: result.seedHash,
          existingDataModified: false,
          committed: mode === "apply",
        },
        null,
        2
      )
    );
  } catch (e) {
    await client.query("rollback").catch(() => {});
    console.error(
      "10월 seed 실패:",
      (e as { code?: string; message?: string }).code ?? (e as Error).message
    );
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
