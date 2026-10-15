import { randomUUID, createHash } from "node:crypto";
import { Client } from "pg";
import { getSupabaseConnectionString } from "../server/supabaseConnection";
import {
  normalizeRoutinePayload,
  stableRoutineJson,
} from "../client/src/lib/routine-v2-form";
import type { RoutineDraftPayload } from "../shared/routine-v2";

const apply = process.argv.includes("--apply");
const project = new URL(process.env.SUPABASE_URL ?? "https://invalid.invalid")
  .hostname;
if (project !== "dsnvohyinazotouqbzrv.supabase.co")
  throw new Error("검증한 프로젝트가 아닙니다.");
const client = new Client({
  connectionString: getSupabaseConnectionString(),
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
});
const preservedTables = [
  "principals",
  "families",
  "family_memberships",
  "child_profiles",
  "child_invitations",
  "routine_rules",
  "routine_assignments",
  "routine_reinforcers",
  "routine_entitlements",
  "routine_occurrences",
];
async function snapshot() {
  const hashes: Record<string, string> = {};
  for (const table of preservedTables) {
    const rows = await client.query(
      `select to_jsonb(t)::text as content from public.${table} t order by id`
    );
    hashes[table] = createHash("sha256")
      .update(JSON.stringify(rows.rows))
      .digest("hex");
  }
  return hashes;
}
async function main() {
  await client.connect();
  await client.query("begin");
  try {
    // 사용자 캡처와 대조한 오류 모양이 정확히 한 건일 때만 진행한다. 기준·이름·금액은 바꾸지 않는다.
    const result =
      await client.query(`select d.id,d.family_id,d.source_rule_id,d.revision,d.step,d.payload,to_jsonb(d) as original_row,p.auth_user_id
      from public.routine_drafts d join public.principals p on p.id=d.created_by_principal_id
      where d.status='DRAFT' and d.payload->>'flow'='QUEST' and d.payload->>'period'='WEEKLY'
        and d.payload->>'measurement'='QUANTITY' and d.payload->>'penaltyLimit'='60'
        and d.payload->>'penaltyMinutes'='80' and d.payload->'tiers'->0->>'threshold'='80'
        and d.payload->'tiers'->0->'rewards'->0->>'amount'='120'`);
    if (result.rows.length !== 1)
      throw new Error(
        `대상 초안이 정확히 한 건이 아닙니다: ${result.rows.length}`
      );
    const draft = result.rows[0];
    const payload = draft.payload as RoutineDraftPayload;
    const repaired = normalizeRoutinePayload(payload);
    if (
      stableRoutineJson({ ...repaired, period: payload.period }) !==
      stableRoutineJson(payload)
    )
      throw new Error("기간 외 값 변경을 차단했습니다.");
    console.log({
      candidateCount: 1,
      beforePeriod: payload.period,
      afterPeriod: repaired.period,
      allUserInputsPreserved: true,
      apply,
    });
    if (!apply) {
      await client.query("rollback");
      return;
    }
    const before = await snapshot();
    await client.query(
      "select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true)",
      [draft.auth_user_id]
    );
    await client.query("set local role authenticated");
    const saved = (
      await client.query(
        "select public.save_routine_draft($1,$2,$3,$4,$5::jsonb,$6,$7) as value",
        [
          draft.family_id,
          draft.id,
          draft.source_rule_id,
          draft.step,
          JSON.stringify(repaired),
          draft.revision,
          randomUUID(),
        ]
      )
    ).rows[0]?.value;
    if (
      saved?.id !== draft.id ||
      saved.status !== "DRAFT" ||
      saved.revision !== draft.revision + 1 ||
      stableRoutineJson(saved.payload) !== stableRoutineJson(repaired)
    )
      throw new Error("동일 초안·수정 번호·입력 보존 확인 실패");
    await client.query("reset role");
    const savedRow = (
      await client.query(
        "select to_jsonb(d) as value from public.routine_drafts d where id=$1",
        [draft.id]
      )
    ).rows[0]?.value;
    for (const key of ["revision", "updated_at", "payload"]) {
      delete draft.original_row[key];
      delete savedRow[key];
    }
    if (stableRoutineJson(draft.original_row) !== stableRoutineJson(savedRow))
      throw new Error("초안의 다른 컬럼 변경 감지");
    await client.query(
      "select private.routine_assert_payload($1::jsonb,true,$2)",
      [JSON.stringify(saved.payload), draft.family_id]
    );
    const after = await snapshot();
    if (stableRoutineJson(before) !== stableRoutineJson(after))
      throw new Error(
        "기존 계정·가족·게시·배정·보상 기록 변화 감지, 롤백합니다."
      );
    await client.query("commit");
    console.log({
      sameDraft: true,
      status: "DRAFT",
      revisionIncrement: 1,
      serverPublishValidation: "PASS",
      preservedTables: preservedTables.length,
      automaticPublishing: false,
    });
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}
main().catch((error: unknown) => {
  const e = error as { code?: string };
  console.error("Quest 기간 복구 실패", e.code ?? "안전 검증 실패");
  process.exitCode = 1;
});
