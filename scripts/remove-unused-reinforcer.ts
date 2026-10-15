import { Client } from "pg";
import { getSupabaseConnectionString } from "../server/supabaseConnection";

// 승인받은 항목 한 건만 관리자가 처리한다. 클라이언트 삭제 권한·불변 트리거를 해제하지 않는다.
const [familyId, name, mode] = process.argv.slice(2);
if (
  !/^[0-9a-f-]{36}$/i.test(familyId ?? "") ||
  !name?.trim() ||
  !["--check", "--apply"].includes(mode)
) {
  throw new Error(
    "사용법: tsx scripts/remove-unused-reinforcer.ts FAMILY_ID 정확한이름 --check|--apply"
  );
}
const client = new Client({
  connectionString: getSupabaseConnectionString(),
  ssl: { rejectUnauthorized: false },
});
try {
  const authUrl = new URL(process.env.SUPABASE_URL ?? "");
  if (authUrl.hostname !== "dsnvohyinazotouqbzrv.supabase.co")
    throw new Error("대상 프로젝트 불일치");
  await client.connect();
  await client.query("begin");
  await client.query("set local lock_timeout='10s'");
  // 초안/게시 및 새 카탈로그와 경쟁하는 쓰기를 삭제 트랜잭션 동안만 막는다.
  await client.query(
    "lock table public.routine_reinforcers, public.routine_drafts, public.routine_rules, public.routine_reward_items in share row exclusive mode"
  );
  const found = await client.query(
    `select r.id,r.created_by_principal_id,p.auth_user_id,
    (select count(*) from public.routine_reward_items i where i.reinforcer_id=r.id) as published_refs,
    (select count(*) from public.routine_drafts d where d.payload::text like '%'||r.id::text||'%') as draft_refs,
    (select count(*) from public.routine_rules x where x.payload::text like '%'||r.id::text||'%') as rule_refs
    from public.routine_reinforcers r join public.principals p on p.id=r.created_by_principal_id
    where r.family_id=$1 and btrim(r.name)=$2`,
    [familyId, name.trim()]
  );
  if (found.rowCount !== 1)
    throw new Error("정확히 일치하는 항목이 한 건이 아님. 자동 삭제하지 않음");
  const row = found.rows[0];
  console.log("일치 항목 1건. 참조 검사:", {
    published: Number(row.published_refs),
    draft: Number(row.draft_refs),
    rule: Number(row.rule_refs),
  });
  if (
    [row.published_refs, row.draft_refs, row.rule_refs].some(
      n => Number(n) !== 0
    )
  )
    throw new Error("사용 중인 강화물: 기존 기록 보존을 위해 삭제하지 않음");
  await client.query(
    "select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true)",
    [row.auth_user_id]
  );
  const allowed = await client.query(
    "select private.activity_actor_is_verified_parent($1,$2) as ok",
    [row.created_by_principal_id, familyId]
  );
  if (!allowed.rows[0]?.ok)
    throw new Error("등록자가 이 가족의 활성 인증 부모가 아님");
  if (mode === "--apply") {
    const result = await client.query(
      "delete from public.routine_reinforcers where id=$1 and family_id=$2 and btrim(name)=$3 returning id",
      [row.id, familyId, name.trim()]
    );
    if (result.rowCount !== 1) throw new Error("삭제 수 불일치");
    const audit = await client.query(
      "select count(*) as n from public.routine_request_events where action='REMOVE_UNUSED_REINFORCER' and request_payload->>'reinforcer_id'=$1",
      [row.id]
    );
    if (Number(audit.rows[0].n) !== 1) throw new Error("삭제 감사 기록 불일치");
    await client.query("commit");
    console.log(
      "미사용 강화물 1건 삭제·감사 1건 저장 완료. 초안·게시·자녀 연결 불변"
    );
  } else {
    await client.query("rollback");
    console.log("확인만 완료. 변경 없음");
  }
} catch (error) {
  await client.query("rollback").catch(() => {});
  throw error;
} finally {
  await client.end();
}
