import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getSupabaseConnectionString } from "../server/supabaseConnection";
import { seedOctoberRuntime } from "./seed-october-runtime";

const connection = getSupabaseConnectionString(),
  uri = new URL(connection),
  project = "dsnvohyinazotouqbzrv";
if (
  new URL(process.env.SUPABASE_URL!).hostname !== `${project}.supabase.co` ||
  (!decodeURIComponent(uri.username).endsWith(`.${project}`) &&
    uri.hostname !== `db.${project}.supabase.co`)
)
  throw new Error("프로젝트 불일치");
const db = new Client({
  connectionString: connection,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
});
let passed = 0;
const assert = (v: unknown, label: string) => {
  if (!v) throw new Error(`실패: ${label}`);
  passed++;
  console.log(`통과 ${passed}: ${label}`);
};
async function user(id: string) {
  await db.query("reset role");
  await db.query(
    "select set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true),set_config('request.jwt.claim.role','authenticated',true)",
    [JSON.stringify({ sub: id, role: "authenticated" }), id]
  );
  await db.query("set local role authenticated");
}
async function reject(
  sql: string,
  args: unknown[],
  label: string,
  expected?: string
) {
  await db.query("savepoint negative_case");
  let code = "";
  try {
    await db.query(sql, args);
  } catch (e) {
    code = (e as { code: string }).code;
  }
  await db.query("rollback to savepoint negative_case");
  await db.query("release savepoint negative_case");
  assert(expected ? code === expected : Boolean(code), label);
}
async function addAuth(label: string) {
  const id = randomUUID();
  await db.query(
    `insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values($1,'authenticated','authenticated',$2,'',now(),'{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now(),now())`,
    [id, `october-${label}-${randomUUID()}@example.invalid`]
  );
  return id;
}
async function principal(auth: string) {
  return (
    await db.query("select id from public.principals where auth_user_id=$1", [
      auth,
    ])
  ).rows[0].id as string;
}

try {
  await db.connect();
  await db.query("begin");
  if (process.argv.includes("--install"))
    for (const file of ["0021_october_runtime.sql", "0022_october_audit.sql"]) {
      const sql = (await readFile(`supabase/migrations/${file}`, "utf8"))
        .replace(/^\s*begin\s*;/i, "")
        .replace(/commit\s*;\s*$/i, "");
      await db.query(sql);
    }
  assert(
    Boolean(
      (
        await db.query(
          "select to_regprocedure('public.get_october_board(uuid,uuid,date)') ok"
        )
      ).rows[0].ok
    ),
    "実제 RPC 설치 또는 동일 트랜잭션 DDL 컴파일"
  );
  const parentAuth = await addAuth("parent"),
    childAuth = await addAuth("child"),
    guardianAuth = await addAuth("guardian"),
    otherAuth = await addAuth("outsider");
  const parentId = await principal(parentAuth),
    childPrincipal = await principal(childAuth),
    guardianPrincipal = await principal(guardianAuth);
  await user(parentAuth);
  const family = (
    await db.query(
      "select * from public.bootstrap_parent_family('October rollback fixture','Asia/Seoul','October test parent')"
    )
  ).rows[0].family_id as string;
  await db.query("reset role");
  const child = (
    await db.query(
      `insert into public.child_profiles(family_id,principal_id,display_name,status,created_by_principal_id,linked_at) values($1,$2,'October fixture child','ACTIVE',$3,now()) returning id`,
      [family, childPrincipal, parentId]
    )
  ).rows[0].id as string;
  await db.query(
    `insert into public.family_memberships(family_id,principal_id,role,status,created_by_principal_id) values($1,$2,'CHILD','ACTIVE',$4),($1,$3,'GUARDIAN','ACTIVE',$4)`,
    [family, childPrincipal, guardianPrincipal, parentId]
  );
  const seeded = await seedOctoberRuntime(db, {
    familyId: family,
    childId: child,
    parentId,
    authUserId: parentAuth,
  });
  assert(
    seeded.ruleCount === 26 && seeded.adoptionCount === 26,
    "26 규칙·26 자녀 채택"
  );
  const replaySeed = await seedOctoberRuntime(db, {
    familyId: family,
    childId: child,
    parentId,
    authUserId: parentAuth,
  });
  assert(!replaySeed.inserted, "seed 동일 입력 재실행 시 추가 없음");
  const definitions = (
    await db.query(
      `select ri.stable_code code,rv.id,rv.rule_identity_id identity_id,rv.domain,rv.effect_spec,rv.condition_spec from public.october_plan_adoptions a join public.october_rule_versions rv on rv.id=a.rule_version_id and rv.family_id=a.family_id join public.october_rule_identities ri on ri.id=rv.rule_identity_id and ri.family_id=rv.family_id where a.plan_id=$1 and a.child_profile_id=$2`,
      [seeded.planId, child]
    )
  ).rows;
  const rules = Object.fromEntries(definitions.map(x => [x.code, x.id]));
  assert(
    ["QUEST", "TASK", "LIFESTYLE"]
      .map(d => definitions.filter(x => x.domain === d).length)
      .join(",") === "3,7,16",
    "Quest3·Task7·Lifestyle16 분류"
  );
  // 시험일은 아직 미래다. 이 관리자 시험 트랜잭션 안에서만 날짜 helper를 10/31로 바꾼다.
  // 전체 ROLLBACK하므로 운영 helper·시계·사실은 전혀 바뀌지 않는다. 실제 미래 수행을 저장하지 않는다.
  await db.query(
    `create or replace function private.october_family_today(p_family_id uuid) returns date language sql stable security definer set search_path='' as $$ select date '2026-10-31' $$`
  );
  await user(parentAuth);
  const board = (
    await db.query("select public.get_october_board($1,$2,'2026-10-18') b", [
      family,
      child,
    ])
  ).rows[0].b;
  assert(
    board.rules.length === 26 && board.plan.school_asset === "PENDING",
    "실제 반환 JSON과 학교 보상 자산 보류"
  );
  const confirmSql =
    "select public.confirm_october_occurrence($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) r";
  const confirm = async (
    code: string,
    date: string,
    slot = "daily",
    decision = "PASS",
    metrics: Record<string, unknown> = {},
    revision = 0,
    reason: string | null = null,
    key = randomUUID()
  ) =>
    (
      await db.query(confirmSql, [
        family,
        child,
        rules[code],
        date,
        key,
        decision,
        JSON.stringify(metrics),
        reason,
        slot,
        revision,
      ])
    ).rows[0].r;
  const raw = async (sql: string, args: unknown[]) => {
    await db.query("reset role");
    try {
      return await db.query(sql, args);
    } finally {
      await db.query("set local role authenticated");
    }
  };
  const rights = async (code: string) =>
    (
      await raw(
        `select x.* from public.october_rights x join public.october_rule_versions rv on rv.id=x.rule_version_id and rv.family_id=x.family_id join public.october_rule_identities ri on ri.id=rv.rule_identity_id and ri.family_id=rv.family_id where x.family_id=$1 and x.child_profile_id=$2 and ri.stable_code=$3 order by x.issued_at,x.id`,
        [family, child, code]
      )
    ).rows;
  const sum = (rs: any[]) => rs.reduce((n, x) => n + x.quantity, 0);
  const lifeResults = [];
  for (let n = 0; n < 4; n++)
    lifeResults.push(
      await confirm("L-001", "2026-10-18", n === 0 ? "daily" : randomUUID())
    );
  assert(
    lifeResults.map(x => x.state).join(",") === "PASS,PASS,PASS,LIMIT_EXCEEDED",
    "생활 4 원사건은 보존하고 3회만 인정"
  );
  assert(sum(await rights("L-001")) === 45, "L001 하루45분만 발행");
  const rowCount = (
    await raw(
      "select count(*)::int n from public.october_occurrences where family_id=$1 and rule_version_id=$2 and business_date='2026-10-18'",
      [family, rules["L-001"]]
    )
  ).rows[0].n;
  assert(rowCount === 4, "초과 원사건까지 네 행 보존");
  const life4 = [];
  for (let n = 0; n < 3; n++)
    life4.push(
      await confirm("L-004", "2026-10-18", n === 0 ? "daily" : randomUUID())
    );
  assert(
    life4[2].state === "LIMIT_EXCEEDED" && sum(await rights("L-004")) === 30,
    "누리 돌봄2회·30분 한도"
  );
  const eventKey = randomUUID(),
    params = [
      family,
      child,
      rules["L-002"],
      "2026-10-18",
      eventKey,
      "PASS",
      "{}",
      null,
      "daily",
      0,
    ];
  const first = (await db.query(confirmSql, params)).rows[0].r,
    second = (await db.query(confirmSql, params)).rows[0].r;
  assert(
    JSON.stringify(first) === JSON.stringify(second) &&
      sum(await rights("L-002")) === 15,
    "정확 재전송은 같은 결과·추가 발행 없음"
  );
  await reject(
    confirmSql,
    [...params.slice(0, 7), "수정된 사유", "daily", 0],
    "같은 요청키 다른 내용 거절",
    "22023"
  );
  await reject(
    confirmSql,
    [
      family,
      child,
      rules["L-002"],
      "2026-10-18",
      randomUUID(),
      "PASS",
      "{}",
      "정정",
      "daily",
      0,
    ],
    "오래된 revision CAS 거절",
    "40001"
  );
  await reject(
    confirmSql,
    [
      family,
      child,
      rules["L-008"],
      "2026-10-18",
      randomUUID(),
      "PENALTY",
      "{}",
      null,
      "daily",
      0,
    ],
    "패널티는 부모 사유 필수",
    "22023"
  );
  const penalties = [];
  for (let n = 0; n < 3; n++)
    penalties.push(
      await confirm(
        "L-010",
        "2026-10-18",
        n === 0 ? "daily" : randomUUID(),
        "PENALTY",
        {},
        0,
        "실제 식후 미정리 확인"
      )
    );
  assert(
    penalties[2].state === "LIMIT_EXCEEDED" &&
      sum(await rights("L-010")) === -80,
    "일일 패널티도 원사건 보존·2회만 인정"
  );
  const qp = await confirm("Q-001", "2026-10-31", "daily", "PASS", {
    passed: true,
    problemCount: 20,
    seconds: 240,
  });
  const qr = await rights("Q-001");
  assert(
    qr.length === 2 &&
      qr.some(x => x.asset === "MINUTES" && x.quantity === 300) &&
      qr.some(x => x.asset === "CASH_KRW" && x.quantity === 50000),
    "월간 기탄 시간300분+현금5만원 독립 권리"
  );
  const qrow = (
    await raw(
      "select recognized_count from public.october_occurrences where id=$1",
      [qp.id]
    )
  ).rows[0];
  assert(qrow.recognized_count === 1, "복수 효과라도 인정은 한 번");
  await reject(
    confirmSql,
    [
      family,
      child,
      rules["Q-001"],
      "2026-10-30",
      randomUUID(),
      "PASS",
      JSON.stringify({ passed: true, problemCount: 20, seconds: 240 }),
      null,
      "daily",
      0,
    ],
    "기탄 월말 시험의 지정일 아닌 수행 거절",
    "22023"
  );
  await confirm("Q-002", "2026-10-18");
  const origamiAgain = await confirm("Q-002", "2026-10-19");
  assert(
    origamiAgain.state === "LIMIT_EXCEEDED" &&
      sum(await rights("Q-002")) === 20000,
    "종이접기는 월별 동일 성취 한 번"
  );
  const scores = (values: number[]) => ({
    scores: values.map((score, i) => ({ subject: `과목${i + 1}`, score })),
  });
  await confirm("Q-003", "2026-10-19", "daily", "PASS", scores([80, 80, 80]));
  assert(sum(await rights("Q-003")) === 360, "시험 3과목80점은360분");
  await confirm("Q-003", "2026-10-20", "daily", "PASS", scores([90, 90, 90]));
  assert(
    sum(await rights("Q-003")) === 480,
    "같은 시험 상향은120분만 추가해 총480분"
  );
  await confirm(
    "Q-003",
    "2026-10-21",
    "daily",
    "PASS",
    scores([90, 90, 90, 90])
  );
  assert(sum(await rights("Q-003")) === 600, "4과목90점 최고총액600분");
  await confirm(
    "Q-003",
    "2026-10-22",
    "daily",
    "PASS",
    scores([90, 90, 90, 90])
  );
  assert(
    sum(await rights("Q-003")) === 600,
    "다른 시험창 날짜에 같은600분 재발행 금지"
  );
  await reject(
    confirmSql,
    [
      family,
      child,
      rules["Q-003"],
      "2026-10-22",
      randomUUID(),
      "PASS",
      JSON.stringify({
        scores: [
          { subject: "수학", score: 90 },
          { subject: "수학", score: 90 },
        ],
      }),
      "정정",
      "daily",
      1,
    ],
    "시험 과목 중복 거절",
    "22023"
  );
  const violin = await confirm("T-003", "2026-10-20");
  assert(
    (await rights("T-003")).length === 0 && violin.effects.length === 0,
    "바이올린 미정값을0분 보상으로 발행하지 않음"
  );
  await confirm("T-005", "2026-10-20", "daily", "PASS", {
    noGiftedClass: false,
  });
  assert(
    sum(await rights("T-005")) === 60,
    "화요일 문제수업에는 토요일 확인을 강요하지 않음"
  );
  await reject(
    confirmSql,
    [
      family,
      child,
      rules["T-005"],
      "2026-10-31",
      randomUUID(),
      "PASS",
      JSON.stringify({ noGiftedClass: false }),
      null,
      "daily",
      0,
    ],
    "토요일 실제 수업없음 미확인 거절",
    "22023"
  );
  await confirm("T-005", "2026-10-31", "daily", "PASS", {
    noGiftedClass: true,
  });
  await reject(
    confirmSql,
    [
      family,
      child,
      rules["T-005"],
      "2026-10-24",
      randomUUID(),
      "PASS",
      JSON.stringify({ noGiftedClass: true }),
      null,
      "daily",
      0,
    ],
    "10월24일 T005/T006 중복 인정 차단",
    "22023"
  );
  await confirm("T-006", "2026-10-24");
  assert(sum(await rights("T-006")) === 240, "확정10월24일 수업240분");
  await reject(
    confirmSql,
    [
      family,
      child,
      rules["L-013"],
      "2026-10-30",
      randomUUID(),
      "PENALTY",
      "{}",
      "기록 공란",
      "daily",
      0,
    ],
    "복약 기록 공란은 직접 확인 근거가 아님",
    "22023"
  );
  await confirm(
    "L-013",
    "2026-10-30",
    "daily",
    "PENALTY",
    { verifiedDirectly: true },
    0,
    "부모가 아이에게 직접 물어 확인"
  );
  assert(
    sum(await rights("L-013")) === -40,
    "복약 생활 사건 직접 확인 하루40분 후보"
  );
  const incident = randomUUID();
  await confirm(
    "L-015",
    "2026-10-18",
    "daily",
    "PENALTY",
    { incidentKey: incident },
    0,
    "실제 파손 확인"
  );
  const collision = await confirm(
    "L-016",
    "2026-10-18",
    "daily",
    "PENALTY",
    { incidentKey: incident },
    0,
    "동일 파손의 기기 해당 여부 확인"
  );
  assert(
    collision.state === "REVIEW_REQUIRED",
    "같은 일반·기기 파손은 검토 보류"
  );
  assert(
    (await rights("L-015")).every(x => x.status === "REVIEW_REQUIRED") &&
      (await rights("L-016")).length === 0,
    "동일 파손 자동240분 중복 차감 권리 금지"
  );
  await reject(
    "select public.close_october_school_week($1,$2,'2026-10-19','2026-10-24',$3)",
    [family, child, randomUUID()],
    "학교 기간 미확인 마감 거절",
    "22023"
  );
  for (const date of [
    "2026-10-19",
    "2026-10-20",
    "2026-10-21",
    "2026-10-22",
    "2026-10-23",
  ])
    await confirm("T-007", date, "daily", "PASS", {
      feedback: "NO_PROBLEM",
      praised: false,
    });
  const closeSql =
    "select public.close_october_school_week($1,$2,'2026-10-19','2026-10-24',$3) r";
  const pending = (await db.query(closeSql, [family, child, randomUUID()]))
    .rows[0].r;
  assert(
    pending.recognized_total === 5 && (await rights("T-007")).length === 0,
    "학교 자산PENDING이면 스티커만·권리발행0"
  );
  await db.query("reset role");
  await db.query("select set_config('private.october_seed_write','on',true)");
  await db.query(
    "update public.october_plans set school_asset='COUPAY_KRW' where id=$1",
    [seeded.planId]
  );
  await db.query("select set_config('private.october_seed_write','off',true)");
  await user(parentAuth);
  for (const date of ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29"])
    await confirm("T-007", date, "daily", "PASS", {
      feedback: "NO_PROBLEM",
      praised: false,
    });
  await confirm("T-007", "2026-10-30", "daily", "NO_PASS", {
    feedback: "PROBLEM",
    praised: false,
  });
  const four = (
    await db.query(
      "select public.close_october_school_week($1,$2,'2026-10-26','2026-10-31',$3) r",
      [family, child, randomUUID()]
    )
  ).rows[0].r;
  assert(
    four.recognized_total === 4 &&
      four.issued_difference === 0 &&
      (await rights("T-007")).length === 0,
    "스티커4개는0개로 추정하지 않고 확인된 무보상 구간"
  );
  const five = (await db.query(closeSql, [family, child, randomUUID()])).rows[0]
    .r;
  assert(
    five.issued_difference === 10000 && sum(await rights("T-007")) === 10000,
    "동일 기간5개 최종권리10000원"
  );
  const schoolRight = (await rights("T-007"))[0];
  const fulfillSql = "select public.fulfill_october_right($1,$2,$3,$4) r";
  const fulfillKey = randomUUID();
  const paid = (
    await db.query(fulfillSql, [
      family,
      schoolRight.id,
      fulfillKey,
      "앱 밖 지급 확인",
    ])
  ).rows[0].r;
  assert(paid.fulfilled_quantity === 10000, "학교 권리와 앱 밖 이행 분리");
  const paidReplay = (
    await db.query(fulfillSql, [
      family,
      schoolRight.id,
      fulfillKey,
      "앱 밖 지급 확인",
    ])
  ).rows[0].r;
  assert(
    paidReplay.fulfilled_quantity === 10000,
    "이행 정확 재전송 추가 지급 기록 없음"
  );
  await reject(
    fulfillSql,
    [family, schoolRight.id, randomUUID(), "두 번 지급 시도"],
    "이미 이행된 권리 초과 이행 거절",
    "22023"
  );
  for (const date of ["2026-10-19", "2026-10-20"])
    await confirm(
      "T-007",
      date,
      "daily",
      "PASS",
      { feedback: "NO_PROBLEM", praised: true },
      1,
      "교사 칭찬 추가 확인"
    );
  const seven = (await db.query(closeSql, [family, child, randomUUID()]))
    .rows[0].r;
  assert(
    seven.recognized_total === 7 && sum(await rights("T-007")) === 10000,
    "같은기간7개도 총10000원 유지"
  );
  await confirm(
    "T-007",
    "2026-10-21",
    "daily",
    "PASS",
    { feedback: "NO_PROBLEM", praised: true },
    1,
    "교사 칭찬 추가 확인"
  );
  const eight = (await db.query(closeSql, [family, child, randomUUID()]))
    .rows[0].r;
  assert(
    eight.recognized_total === 8 &&
      eight.issued_difference === 5000 &&
      sum(await rights("T-007")) === 15000,
    "10000원 이행 뒤8개 상향 추가5000원만 발행"
  );
  await reject(
    "select public.close_october_school_week($1,$2,'2026-10-20','2026-10-24',$3)",
    [family, child, randomUUID()],
    "다른 겹친 학교기간 거절",
    "23P01"
  );
  await confirm(
    "T-007",
    "2026-10-23",
    "daily",
    "PASS",
    { feedback: "PROBLEM", praised: true },
    1,
    "문제와 칭찬 동시 피드백 확인"
  );
  await reject(
    closeSql,
    [family, child, randomUUID()],
    "문제+칭찬 정책 미정은 마감 보류",
    "22023"
  );
  await confirm(
    "T-007",
    "2026-10-23",
    "daily",
    "NO_PASS",
    { feedback: "PROBLEM", praised: false },
    2,
    "문제 피드백으로 정정"
  );
  const lower = (await db.query(closeSql, [family, child, randomUUID()]))
    .rows[0].r;
  assert(
    (await rights("T-007")).every(x => x.status === "REVIEW_REQUIRED") &&
      sum(await rights("T-007")) === 15000,
    "학교 하향 정정은 총권리 보존·검토, 자동 회수 안함"
  );
  const dayBoard = (
    await db.query("select public.get_october_board($1,$2,'2026-10-18') b", [
      family,
      child,
    ])
  ).rows[0].b;
  assert(
    dayBoard.summary.pending_minutes === 90 &&
      dayBoard.summary.penalty_minutes === -80,
    "오늘 합계는 선택 수행일 효과이며 다른날 권리와 분리"
  );
  await reject(
    "select public.get_october_board($1,$2,'2026-11-01')",
    [family, child],
    "미래 날짜 조회로 발생 사실 생성 금지",
    "22023"
  );
  await user(childAuth);
  const childBoard = (
    await db.query("select public.get_october_board($1,$2,'2026-10-18') b", [
      family,
      child,
    ])
  ).rows[0].b;
  assert(childBoard.rules.length === 26, "연결 자녀는 자기 규칙 조회 가능");
  await reject(
    confirmSql,
    [
      family,
      child,
      rules["T-001"],
      "2026-10-18",
      randomUUID(),
      "PASS",
      "{}",
      null,
      "daily",
      0,
    ],
    "자녀의 부모 확인 권한 거절",
    "42501"
  );
  await reject(
    fulfillSql,
    [family, schoolRight.id, randomUUID(), "자녀 이행"],
    "자녀 보상 이행 권한 거절",
    "42501"
  );
  const childSubmitKey = randomUUID();
  const submitSql =
    "select public.submit_october_occurrence($1,$2,$3,'2026-10-18',$4,'daily') r";
  const submitted = (
    await db.query(submitSql, [family, child, rules["T-001"], childSubmitKey])
  ).rows[0].r;
  assert(
    submitted.state === "SELF_REPORTED",
    "자녀 자기보고는 유보이며 보상 미확정"
  );
  const submittedAgain = (
    await db.query(submitSql, [family, child, rules["T-001"], childSubmitKey])
  ).rows[0].r;
  assert(
    submittedAgain.revision === submitted.revision,
    "자녀 자기보고 정확 재전송 추가 사건 없음"
  );
  await user(guardianAuth);
  await reject(
    confirmSql,
    [
      family,
      child,
      rules["T-001"],
      "2026-10-18",
      randomUUID(),
      "PASS",
      "{}",
      null,
      "daily",
      1,
    ],
    "조회 보호자 부모 확인 거절",
    "42501"
  );
  await user(otherAuth);
  await reject(
    "select public.get_october_board($1,$2,'2026-10-18')",
    [family, child],
    "다른 가족·외부 계정 규칙 조회 거절",
    "42501"
  );
  await user(parentAuth);
  await reject(
    "insert into public.october_occurrences(family_id) values($1)",
    [family],
    "인증 사용자 raw table 쓰기 차단",
    "42501"
  );
  await reject(
    "select * from public.october_request_events",
    [],
    "raw 재전송 payload 조회 차단",
    "42501"
  );
  await db.query("reset role");
  const immutableRule = rules["L-001"];
  await reject(
    "update public.october_rule_versions set name='바꿈' where id=$1",
    [immutableRule],
    "게시한 규칙 버전 직접 덮어쓰기 차단",
    "55000"
  );
  await db.query("rollback");
  console.log(
    JSON.stringify(
      {
        passed,
        rollback: true,
        fixtureCommitted: false,
        clockOverrideRolledBack: true,
        schoolAssetDecisionChanged: false,
      },
      null,
      2
    )
  );
} catch (e) {
  await db.query("rollback").catch(() => {});
  console.error(
    "실제 10월 런타임 검증 실패:",
    (e as { code?: string }).code ?? (e as Error).message
  );
  process.exitCode = 1;
} finally {
  await db.end();
}
