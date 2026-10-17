import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Client } from "pg";
import { getSupabaseConnectionString } from "../server/supabaseConnection";
import { createEmptyRoutinePayload } from "../client/src/lib/routine-v2-form";

// --preview: 설치 DDL도 동일 트랜잭션에서 실행 후 rollback.
// 기본 실행: 설치된 시스템의 트리거·실제 RPC만 시험하고 fixture는 rollback.
const preview = process.argv.includes("--preview");
const beforeFile = process.argv
  .find(a => a.startsWith("--snapshot="))
  ?.split("=")[1];
const verifyFile = process.argv
  .find(a => a.startsWith("--compare="))
  ?.split("=")[1];
if (
  new URL(process.env.SUPABASE_URL!).hostname !==
  "dsnvohyinazotouqbzrv.supabase.co"
) {
  throw new Error("SUPABASE_PROJECT_MISMATCH");
}
const c = new Client({
  connectionString: getSupabaseConnectionString(),
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
});
let passed = 0;
function assert(value: unknown, label: string) {
  if (!value) throw new Error(`FAILED: ${label}`);
  passed++;
  console.log(`PASS ${label}`);
}
async function asAdmin() {
  await c.query("reset role");
}
async function user(id: string | null, role = "authenticated") {
  await asAdmin();
  await c.query(
    "select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claim.role',$2,true)",
    [id ?? "", role]
  );
  if (!["authenticated", "anon", "service_role"].includes(role))
    throw new Error("TEST_ROLE_INVALID");
  await c.query(`set local role ${role}`);
}
async function rejection(
  sql: string,
  args: unknown[],
  code: string,
  label: string
) {
  await c.query("savepoint expected_rejection");
  let result = "";
  try {
    await c.query(sql, args);
  } catch (e) {
    result = (e as { code?: string }).code ?? "LOCAL_ERROR";
  }
  await c.query("rollback to savepoint expected_rejection");
  await c.query("release savepoint expected_rejection");
  assert(result === code, `${label}: ${result || "unexpected success"}`);
}
async function addUser(confirmed = true) {
  await asAdmin();
  const id = randomUUID();
  await c.query(
    `insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    values ($1,'authenticated','authenticated',$2,'',case when $3 then now() else null end,'{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now(),now())`,
    [id, `audit-${id}@example.invalid`, confirmed]
  );
  const principal = (
    await c.query("select id from public.principals where auth_user_id=$1", [
      id,
    ])
  ).rows[0].id as string;
  return { id, principal };
}
async function tableSnapshot() {
  await asAdmin();
  const tables = (
    await c.query(
      "select tablename from pg_tables where schemaname='public' order by tablename"
    )
  ).rows;
  const result = [];
  for (const { tablename } of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(tablename)) throw new Error("TABLE_INVALID");
    const { rows } = await c.query(
      `select count(*)::integer as n,coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) as data from public."${tablename}" t`
    );
    result.push({
      table: tablename,
      count: rows[0].n,
      sha256: createHash("sha256")
        .update(JSON.stringify(rows[0].data))
        .digest("hex"),
    });
  }
  return result;
}
async function traces(table: string, id: string) {
  await asAdmin();
  return (
    await c.query(
      "select * from play_audit.events where table_name=$1 and row_id=$2 order by audit_id",
      [table, id]
    )
  ).rows;
}
async function run() {
  await c.connect();
  const original = await tableSnapshot();
  if (beforeFile)
    await writeFile(beforeFile, JSON.stringify(original, null, 2) + "\n", {
      mode: 0o600,
    });
  if (verifyFile) {
    const expected = JSON.parse(await readFile(verifyFile, "utf8"));
    assert(
      JSON.stringify(expected) === JSON.stringify(original),
      `${original.length}개 기존 public 테이블 데이터 보존`
    );
  }
  await c.query("begin");
  await c.query(
    "select pg_advisory_xact_lock(hashtext('play-routine-live-fixtures'))"
  );
  await c.query("set local statement_timeout='60s'");
  try {
    if (preview) {
      const sql = await readFile(
        new URL("../supabase/migrations/0020_audit_log.sql", import.meta.url),
        "utf8"
      );
      await c.query(
        sql.replace(/^\s*begin\s*;/i, "").replace(/commit\s*;\s*$/i, "")
      );
    }
    const catalog = await c.query(
      "select count(*)::integer as n from pg_trigger t where t.tgname='play_audit_row_change' and not t.tgisinternal"
    );
    assert(catalog.rows[0].n === 16, "16개 업무 테이블에 감사 트리거 설치");
    assert(
      (
        await c.query(
          "select relrowsecurity from pg_class where oid='play_audit.events'::regclass"
        )
      ).rows[0].relrowsecurity,
      "감사 원시 테이블 RLS 활성화"
    );
    const parent = await addUser();
    const child = await addUser();
    const guardian = await addUser();
    const other = await addUser();
    const unverified = await addUser(false);
    await user(parent.id);
    const familyA = (
      await c.query(
        "select * from public.bootstrap_parent_family('Audit rollback A','Asia/Seoul','감사 테스트')"
      )
    ).rows[0].family_id as string;
    await user(other.id);
    const familyB = (
      await c.query(
        "select * from public.bootstrap_parent_family('Audit rollback B','Asia/Seoul','감사 테스트')"
      )
    ).rows[0].family_id as string;
    await asAdmin();
    await c.query(
      `insert into public.family_memberships(family_id,principal_id,role,created_by_principal_id)
      values ($1,$2,'CHILD',$4),($1,$3,'GUARDIAN',$4),($1,$5,'PARENT',$4)`,
      [
        familyA,
        child.principal,
        guardian.principal,
        parent.principal,
        unverified.principal,
      ]
    );
    const cp = (
      await c.query(
        "insert into public.child_profiles(family_id,principal_id,display_name,status,created_by_principal_id,linked_at) values($1,$2,'감사 합성 자녀','ACTIVE',$3,now()) returning id",
        [familyA, child.principal, parent.principal]
      )
    ).rows[0].id as string;

    await user(parent.id);
    const requestKey = randomUUID();
    const createReinforcer =
      "select public.create_routine_reinforcer($1,'감사 합성 강화물','MIN','분',$2) as value";
    const reward = (await c.query(createReinforcer, [familyA, requestKey]))
      .rows[0].value;
    const rid = reward.id as string;
    assert(Boolean(rid), "실제 부모 강화물 저장 RPC 성공");
    let rows = await traces("routine_reinforcers", rid);
    assert(
      rows.length === 1 && rows[0].operation === "INSERT",
      "RPC 생성 한 건에 INSERT 감사 한 건"
    );
    assert(
      rows[0].actor_auth_user_id === parent.id &&
        rows[0].actor_principal_id === parent.principal,
      "행 필드가 아닌 JWT 주체로 행위자 식별"
    );
    assert(
      !("name" in rows[0].new_values) && !("unit_label" in rows[0].new_values),
      "강화물 자유서술 필드 복제 안 함"
    );
    assert(
      rows[0].new_fingerprint.length === 64 && rows[0].old_fingerprint === null,
      "허용 필드의 SHA-256 사본 지문 생성"
    );
    await user(parent.id);
    await c.query(createReinforcer, [familyA, requestKey]);
    assert(
      (await traces("routine_reinforcers", rid)).length === 1,
      "같은 멱등 요청 재시도는 감사 중복 생성 안 함"
    );

    const payload = createEmptyRoutinePayload("QUEST");
    payload.name = "감사 샘플 Quest";
    const save =
      "select public.save_routine_draft($1,$2,null,1,$3::jsonb,$4,$5) as value";
    await user(parent.id);
    const draft = (
      await c.query(save, [
        familyA,
        null,
        JSON.stringify(payload),
        0,
        randomUUID(),
      ])
    ).rows[0].value;
    payload.criteria = "비공개 텍스트는 감사 사본에 복사하지 않음";
    const updated = (
      await c.query(save, [
        familyA,
        draft.id,
        JSON.stringify(payload),
        draft.revision,
        randomUUID(),
      ])
    ).rows[0].value;
    assert(
      updated.revision > draft.revision,
      "실제 초안 수정 RPC와 기존 revision 유지"
    );
    rows = await traces("routine_drafts", draft.id);
    assert(
      rows.length === 2 && rows[1].operation === "UPDATE",
      "초안 INSERT·UPDATE 모두 자동 감사"
    );
    assert(
      rows[1].changed_columns.includes("payload") &&
        !("payload" in rows[1].old_values) &&
        !("payload" in rows[1].new_values),
      "변경 열 이름은 남고 payload 원문은 제외"
    );
    assert(
      rows[1].old_values.revision === draft.revision &&
        rows[1].new_values.revision === updated.revision,
      "수정 전후 revision 저장"
    );
    assert(
      rows[0].transaction_id === rows[1].transaction_id,
      "한 transaction의 변경을 동일 ID로 연결"
    );

    await user(parent.id);
    const list = (
      await c.query(
        "select public.list_family_audit_events($1,null,100) as value",
        [familyA]
      )
    ).rows[0].value as any[];
    assert(
      list.length > 0 && list.every(x => x.family_id === familyA),
      "부모 조회 RPC는 자기 가족만 반환"
    );
    const page = (
      await c.query(
        "select public.list_family_audit_events($1,$2,1) as value",
        [familyA, list[0].audit_id]
      )
    ).rows[0].value;
    assert(
      page.length === 1 && page[0].audit_id < list[0].audit_id,
      "정렬·페이지 커서 동작"
    );
    await rejection(
      "select public.list_family_audit_events($1,null,101)",
      [familyA],
      "22023",
      "조회 최대 100건 제한"
    );
    await rejection(
      "select public.list_family_audit_events($1)",
      [familyB],
      "42501",
      "다른 가족 조회 차단"
    );
    await rejection(
      "select * from play_audit.events",
      [],
      "42501",
      "부모도 원시 감사 테이블 직접 조회 불가"
    );
    await rejection(
      "insert into play_audit.events(family_id,table_schema,table_name,row_id,operation,transaction_id,actor_kind,db_session_user,new_values) values($1,'public','routine_drafts',$2,'INSERT','fake','AUTH_USER','fake','{}')",
      [familyA, draft.id],
      "42501",
      "클라이언트 감사 위조 쓰기 차단"
    );
    for (const [who, label] of [
      [child, "자녀"],
      [guardian, "조회 보호자"],
      [unverified, "이메일 미확인 부모"],
    ] as const) {
      await user(who.id);
      await rejection(
        "select public.list_family_audit_events($1)",
        [familyA],
        "42501",
        `${label} 감사 조회 차단`
      );
    }
    await user(null, "anon");
    await rejection(
      "select public.list_family_audit_events($1)",
      [familyA],
      "42501",
      "익명 RPC 실행 권한 차단"
    );
    await user(null, "service_role");
    await rejection(
      "select * from play_audit.events",
      [],
      "42501",
      "service_role도 원시 테이블 접근 권한 없음"
    );

    await asAdmin();
    await rejection(
      "update play_audit.events set table_name='fake' where row_id=$1",
      [rid],
      "55000",
      "관리자 일반 UPDATE도 감사 불변 트리거로 차단"
    );
    await rejection(
      "delete from play_audit.events where row_id=$1",
      [rid],
      "55000",
      "감사 DELETE 차단"
    );
    await rejection(
      "truncate play_audit.events",
      [],
      "55000",
      "감사 TRUNCATE 문장 트리거로 차단"
    );
    await rejection(
      "update public.child_profiles set family_id=$1 where id=$2",
      [familyB, cp],
      "55000",
      "감사 대상의 가족 정체성 이동 차단"
    );
    const currentCount = Number(
      (await c.query("select count(*) from play_audit.events")).rows[0].count
    );
    await c.query("savepoint rollback_case");
    await c.query(
      "update public.child_profiles set display_name='rollback 표시' where id=$1",
      [cp]
    );
    assert(
      Number(
        (await c.query("select count(*) from play_audit.events")).rows[0].count
      ) ===
        currentCount + 1,
      "변경과 감사가 동일 트랜잭션에 생성"
    );
    await c.query("rollback to savepoint rollback_case");
    await c.query("release savepoint rollback_case");
    assert(
      Number(
        (await c.query("select count(*) from play_audit.events")).rows[0].count
      ) === currentCount,
      "rollback 변경의 감사행도 제거되는 범위 확인"
    );

    await c.query("savepoint suspended_case");
    await c.query(
      "update public.principals set status='SUSPENDED' where id=$1",
      [parent.principal]
    );
    await user(parent.id);
    await rejection(
      "select public.list_family_audit_events($1)",
      [familyA],
      "42501",
      "중지된 부모 조회 차단"
    );
    await asAdmin();
    await c.query("rollback to savepoint suspended_case");
    await c.query("release savepoint suspended_case");

    await user(null, "authenticated");
    await rejection(
      "select public.list_family_audit_events($1)",
      [familyA],
      "28000",
      "JWT 주체가 없는 authenticated 호출 차단"
    );
    await asAdmin();
    await c.query("delete from public.child_profiles where id=$1", [cp]);
    rows = await traces("child_profiles", cp);
    assert(
      rows.at(-1)?.operation === "DELETE" && rows.at(-1)?.new_values === null,
      "원본 삭제 뒤 제한된 이전 감사 사본 보존"
    );
    assert(
      rows.at(-1)?.actor_kind === "DATABASE_SESSION",
      "JWT 없는 관리자 작업은 임의 부모가 아닌 DB 세션으로 표시"
    );

    // 감사 저장 실패를 일부러 일으켰을 때 업무 변경도 성공하지 않음을 savepoint로 검증.
    await c.query("savepoint fail_closed_case");
    await c.query(
      "alter table play_audit.events add constraint audit_test_fail_closed check (table_name <> 'routine_drafts') not valid"
    );
    await user(parent.id);
    await rejection(
      save,
      [
        familyA,
        draft.id,
        JSON.stringify({ ...payload, criteria: "실패해야 할 변경" }),
        updated.revision,
        randomUUID(),
      ],
      "23514",
      "감사 쓰기 실패 시 업무 저장도 rollback"
    );
    await asAdmin();
    assert(
      (
        await c.query(
          "select revision from public.routine_drafts where id=$1",
          [draft.id]
        )
      ).rows[0].revision === updated.revision,
      "실패 후 업무 revision 보존"
    );
    await c.query("rollback to savepoint fail_closed_case");
    await c.query("release savepoint fail_closed_case");
  } finally {
    await c.query("rollback");
  }
  assert(
    JSON.stringify(await tableSnapshot()) === JSON.stringify(original),
    "실DB fixture 전체 rollback·기존 모든 public 행 보존"
  );
  console.log(
    JSON.stringify({
      status: "AUDIT_LIVE_OK",
      preview,
      checks: passed,
      fixtureRolledBack: true,
      publicTables: original.length,
    })
  );
}
run()
  .catch(e => {
    console.error("감사 검증 실패:", {
      code: (e as { code?: string }).code ?? "LOCAL_ASSERTION",
      message: (e as Error).message,
    });
    process.exitCode = 1;
  })
  .finally(() => c.end());
