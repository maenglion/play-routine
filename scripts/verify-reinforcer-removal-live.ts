import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { getSupabaseConnectionString } from "../server/supabaseConnection";

const c = new Client({
  connectionString: getSupabaseConnectionString(),
  ssl: { rejectUnauthorized: false },
});
let count = 0;
function ok(value: unknown, label: string) {
  if (!value) throw new Error(label);
  count++;
  console.log("PASS", label);
}
async function reject(
  sql: string,
  args: unknown[],
  code: string,
  label: string
) {
  await c.query("savepoint denied");
  let actual = "";
  try {
    await c.query(sql, args);
  } catch (error) {
    actual = (error as { code: string }).code;
  }
  await c.query("rollback to savepoint denied");
  ok(actual === code, label);
}
async function claims(id: string) {
  await c.query("reset role");
  await c.query(
    "select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true)",
    [id]
  );
}
async function rpc(sql: string, args: unknown[]) {
  return (await c.query(sql, args)).rows[0].v;
}
try {
  await c.connect();
  await c.query("begin");
  await c.query(
    "select pg_advisory_xact_lock(hashtext('play-routine-live-fixtures'))"
  );
  const parent = randomUUID(),
    outsider = randomUUID(),
    suffix = randomUUID();
  for (const id of [parent, outsider])
    await c.query(
      `insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values($1,'authenticated','authenticated',$2,'',now(),'{"provider":"email","providers":["email"]}','{}',now(),now())`,
      [id, `remove-fixture-${id}@example.invalid`]
    );
  await claims(parent);
  await c.query("set local role authenticated");
  const family = (
    await c.query(
      "select * from public.bootstrap_parent_family($1,'Asia/Seoul','제거 시험')",
      [`롤백 삭제 ${suffix}`]
    )
  ).rows[0].family_id;
  const create = async (name: string) =>
    rpc("select public.create_routine_reinforcer($1,$2,'MIN','분',$3) v", [
      family,
      name,
      randomUUID(),
    ]);
  const unused = await create("미사용 테스트");
  await reject(
    "delete from public.routine_reinforcers where id=$1",
    [unused.id],
    "42501",
    "일반 클라이언트 직접 삭제 권한 없음"
  );
  await claims(outsider);
  await reject(
    "delete from public.routine_reinforcers where id=$1",
    [unused.id],
    "42501",
    "다른 계정은 관리자 연결에서도 삭제 가드 거절"
  );
  await claims("");
  await reject(
    "delete from public.routine_reinforcers where id=$1",
    [unused.id],
    "42501",
    "인증 주체 없으면 삭제 거절"
  );
  await claims(parent);
  await reject(
    "update public.routine_reinforcers set name='변경' where id=$1",
    [unused.id],
    "55000",
    "부모도 이름·종류 변경 불가"
  );
  const removed = await c.query(
    "delete from public.routine_reinforcers where id=$1 returning id",
    [unused.id]
  );
  ok(removed.rowCount === 1, "정확한 미사용 항목 한 건만 삭제");
  const audit = await c.query(
    "select id from public.routine_request_events where action='REMOVE_UNUSED_REINFORCER' and request_payload->>'reinforcer_id'=$1",
    [unused.id]
  );
  ok(audit.rowCount === 1, "삭제 감사 사건 1건 보존");
  await reject(
    "delete from public.routine_request_events where id=$1",
    [audit.rows[0].id],
    "55000",
    "삭제 감사 기록도 불변"
  );
  await c.query("set local role authenticated");
  const draftItem = await create("초안 사용");
  const partial = {
    schemaVersion: 1,
    name: "삭제 차단 초안",
    tiers: [
      {
        id: randomUUID(),
        label: "기본",
        threshold: 5,
        operator: "GTE",
        rewards: [
          {
            id: randomUUID(),
            reinforcerId: draftItem.id,
            amount: 30,
            text: "",
          },
        ],
      },
    ],
  };
  await rpc("select public.save_routine_draft($1,null,null,1,$2,0,$3) v", [
    family,
    partial,
    randomUUID(),
  ]);
  await c.query("reset role");
  await reject(
    "delete from public.routine_reinforcers where id=$1",
    [draftItem.id],
    "55000",
    "미게시 초안에서 사용하는 항목도 삭제 거절"
  );
  await c.query("set local role authenticated");
  const publishedItem = await create("게시 사용");
  const payload = {
    schemaVersion: 1,
    flow: "DAILY",
    name: "게시 보존 테스트",
    category: "DAILY_STUDY",
    childLabel: "게시보존",
    criteria: "부모 확인",
    stickerIcon: "STAR",
    measurement: "STICKER",
    period: "WEEKLY",
    penaltyLimit: null,
    penaltyMinutes: 0,
    tiers: [
      {
        id: randomUUID(),
        label: "기본",
        threshold: 5,
        operator: "GTE",
        rewards: [
          {
            id: randomUUID(),
            reinforcerId: publishedItem.id,
            amount: 30,
            text: "",
          },
        ],
      },
    ],
  };
  const draft = await rpc(
    "select public.save_routine_draft($1,null,null,2,$2,0,$3) v",
    [family, payload, randomUUID()]
  );
  await rpc("select public.publish_routine_draft($1,0,$2) v", [
    draft.id,
    randomUUID(),
  ]);
  await c.query("reset role");
  await reject(
    "delete from public.routine_reinforcers where id=$1",
    [publishedItem.id],
    "55000",
    "게시 룰·보상권의 원천은 삭제 거절"
  );
  await c.query("set local role authenticated");
  const catalog = await rpc("select public.list_routine_reinforcers($1) v", [
    family,
  ]);
  ok(
    !catalog.some((r: { id: string }) => r.id === unused.id) &&
      catalog.length === 2,
    "목록에서 삭제 항목만 빠지고 사용 항목은 유지"
  );
  await c.query("rollback");
  console.log(
    `REINFORCER_REMOVAL_LIVE_OK ${count}개 시험 완료. fixture·메일·실데이터 변경 없음`
  );
} catch (error) {
  await c.query("rollback").catch(() => {});
  throw error;
} finally {
  await c.end();
}
