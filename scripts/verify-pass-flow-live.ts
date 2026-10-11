import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { getSupabaseConnectionString } from "../server/supabaseConnection";

type Fixture = {
  familyId: string;
  parentAuthId: string;
  parentPrincipalId: string;
  childAuthId: string;
  childProfileId: string;
};

let passed = 0;
function assert(value: unknown, label: string): asserts value {
  if (!value) throw new Error(`FAILED: ${label}`);
  console.log(`PASS ${label}`);
  passed += 1;
}

function sqlState(error: unknown) {
  return typeof error === "object" && error && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
}

async function setUser(client: Client, authUserId: string | null) {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claim.sub', $1, true)", [authUserId ?? ""]);
  await client.query("set local role authenticated");
}

async function rejected(client: Client, sql: string, values: unknown[], expected: string, label: string) {
  await client.query("savepoint expected_failure");
  let actual = "";
  try {
    await client.query(sql, values);
  } catch (error) {
    actual = sqlState(error);
  }
  await client.query("rollback to savepoint expected_failure");
  assert(actual === expected, `${label} (expected ${expected}, got ${actual || "success"})`);
}

async function addAuthUser(client: Client, email: string) {
  const id = randomUUID();
  await client.query(
    `insert into auth.users(
       id, aud, role, email, encrypted_password, email_confirmed_at,
       raw_app_meta_data, raw_user_meta_data, created_at, updated_at
     ) values (
       $1, 'authenticated', 'authenticated', $2, '', now(),
       '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
     )`,
    [id, email],
  );
  return id;
}

async function principalId(client: Client, authUserId: string) {
  const result = await client.query<{ id: string }>(
    "select id from public.principals where auth_user_id=$1",
    [authUserId],
  );
  const id = result.rows[0]?.id;
  assert(id, "auth fixture bootstraps an application principal");
  return id;
}

async function createFixtures(client: Client): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 12);
  const parentAuthId = await addAuthUser(client, `pass-parent-${suffix}@example.invalid`);
  const childAuthId = await addAuthUser(client, `pass-child-${suffix}@example.invalid`);

  await setUser(client, parentAuthId);
  const family = await client.query<{ family_id: string; principal_id: string }>(
    "select * from public.bootstrap_parent_family($1, 'Asia/Seoul', 'PASS rollback parent')",
    [`PASS rollback ${suffix}`],
  );
  const familyId = family.rows[0]?.family_id;
  const parentPrincipalId = family.rows[0]?.principal_id;
  assert(familyId && parentPrincipalId, "parent creates rollback-only PASS family");

  await client.query("reset role");
  const childPrincipalId = await principalId(client, childAuthId);
  const child = await client.query<{ id: string }>(
    `insert into public.child_profiles(
       family_id, principal_id, display_name, status, created_by_principal_id, linked_at
     ) values ($1, $2, 'PASS rollback child', 'ACTIVE', $3, now()) returning id`,
    [familyId, childPrincipalId, parentPrincipalId],
  );
  const childProfileId = child.rows[0]?.id;
  assert(childProfileId, "linked active PASS child fixture exists");
  await client.query(
    `insert into public.family_memberships(family_id, principal_id, role, status, created_by_principal_id)
     values ($1, $2, 'CHILD', 'ACTIVE', $3)`,
    [familyId, childPrincipalId, parentPrincipalId],
  );
  return { familyId, parentAuthId, parentPrincipalId, childAuthId, childProfileId };
}

async function today(client: Client) {
  const result = await client.query<{ today: string; dow: number }>(
    `select (now() at time zone 'Asia/Seoul')::date::text as today,
       extract(isodow from (now() at time zone 'Asia/Seoul')::date)::int as dow`,
  );
  const row = result.rows[0];
  assert(row, "family-local PASS test date is available");
  return row;
}

/**
 * Real Supabase validation. It deliberately never applies migrations: it first requires 0011,
 * serializes rollback-only fixtures under a shared advisory key, and rolls back the transaction
 * in every outcome so no user family, rule, activity, or assessment persists.
 */
export async function verifyPassFlowLive() {
  const client = new Client({
    connectionString: getSupabaseConnectionString(),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
  });

  try {
    await client.connect();
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext('play-routine-live-fixtures'))");
    const ready = await client.query<{ ready: boolean }>(
      `select to_regprocedure('public.save_parent_pass_rule_draft(uuid,text,public.activity_category_code,text,text,integer)') is not null
          and to_regprocedure('public.verify_activity_pass(uuid,boolean,text,integer,uuid)') is not null
          and to_regprocedure('public.list_activity_day(uuid,date)') is not null as ready`,
    );
    assert(ready.rows[0]?.ready, "0010/0011 are applied before PASS live verification (this script never applies them)");

    const fixture = await createFixtures(client);
    const calendar = await today(client);

    await setUser(client, fixture.parentAuthId);
    const saved = await client.query<{ config_version_id: string; policy_rule_id: string; status: string }>(
      `select * from public.save_parent_pass_rule_draft(
         $1, '숙제 약속', 'DAILY_STUDY'::public.activity_category_code,
         '부모가 그날 문제없음을 확인하면 PASS', '부모가 그날 문제없음을 확인', 30
       )`,
      [fixture.familyId],
    );
    const rule = saved.rows[0];
    assert(rule?.config_version_id && rule.policy_rule_id && rule.status === "DRAFT", "PASS draft is saved through its dedicated RPC");

    const zeroReward = await client.query<{ policy_rule_id: string }>(
      `select * from public.save_parent_pass_rule_draft(
         $1, '시간 없는 약속', 'LIFE_HABIT'::public.activity_category_code,
         null, '부모가 그날 문제없음을 확인', 0
       )`,
      [fixture.familyId],
    );
    assert(Boolean(zeroReward.rows[0]?.policy_rule_id), "PASS draft permits an explicit zero-minute time reward without creating a cash rule");

    await client.query("reset role");
    const dimension = await client.query<{ measurement_kind: string; unit: string }>(
      `select pd.measurement_kind::text, pd.unit from public.policy_dimensions pd where pd.policy_rule_id=$1`,
      [rule.policy_rule_id],
    );
    assert(dimension.rows[0]?.measurement_kind === "PASS_FAIL" && dimension.rows[0]?.unit === "PASS_FAIL", "PASS_FAIL is actually stored, not merely a client label");

    await setUser(client, fixture.parentAuthId);
    await client.query("select * from public.publish_parent_rule_draft($1)", [rule.config_version_id]);

    // Fixture-only time adjustment permits a real current-day occurrence without waiting for the
    // product's immutable next-day publication. It is inside this rollback-only transaction.
    await client.query("reset role");
    await client.query("alter table public.family_config_versions disable trigger family_config_versions_immutable_after_publish");
    try {
      await client.query(
        "update public.family_config_versions set effective_from=$2::date where id=$1",
        [rule.config_version_id, calendar.today],
      );
    } finally {
      await client.query("alter table public.family_config_versions enable trigger family_config_versions_immutable_after_publish");
    }

    const template = await client.query<{ activity_template_id: string }>(
      `select av.activity_template_id from public.policy_rules pr
       join public.activity_versions av on av.id=pr.activity_version_id where pr.id=$1`,
      [rule.policy_rule_id],
    );
    const templateId = template.rows[0]?.activity_template_id;
    assert(templateId, "PASS activity template is resolved");
    await client.query(
      `insert into public.activity_assignments(
         family_id, child_profile_id, policy_rule_id, activity_template_id,
         starts_on, ends_on, weekdays, repeat_kind, created_by_principal_id
       ) values ($1,$2,$3,$4,$5::date,$5::date,array[$6]::integer[],'DAILY',$7)`,
      [fixture.familyId, fixture.childProfileId, rule.policy_rule_id, templateId, calendar.today, calendar.dow, fixture.parentPrincipalId],
    );

    await setUser(client, fixture.childAuthId);
    let day = await client.query<Record<string, unknown>>(
      "select * from public.list_activity_day($1,$2::date)",
      [fixture.childProfileId, calendar.today],
    );
    let occurrence = day.rows[0];
    assert(occurrence?.measurement_kind === "PASS_FAIL" && occurrence.verification_status === "MISSING" && occurrence.parent_score === null && occurrence.confirmed_minutes === null, "missing/unknown contact is not auto-PASS and has no planned reward or penalty");

    const occurrenceId = String(occurrence.occurrence_id);
    await client.query("select public.report_activity_done($1,$2,null)", [occurrenceId, randomUUID()]);
    day = await client.query<Record<string, unknown>>("select * from public.list_activity_day($1,$2::date)", [fixture.childProfileId, calendar.today]);
    occurrence = day.rows[0];
    assert(occurrence?.verification_status === "HELD" && occurrence.parent_score === null && occurrence.confirmed_minutes === null, "child report remains held and cannot become PASS automatically");
    await rejected(client, "select public.verify_activity_pass($1,true,'child cannot confirm',1,$2)", [occurrenceId, randomUUID()], "42501", "child cannot confirm PASS");

    await setUser(client, fixture.parentAuthId);
    await rejected(client, "select public.verify_activity_occurrence($1,50,'numeric bypass',1,$2)", [occurrenceId, randomUUID()], "22023", "generic verification rejects non-binary PASS score bypass");
    await rejected(client, "select public.verify_activity_pass($1,null::boolean,'missing choice',1,$2)", [occurrenceId, randomUUID()], "22023", "PASS requires an explicit parent choice");

    const notPassKey = randomUUID();
    await client.query("select public.verify_activity_pass($1,false,'오늘은 확인이 더 필요해요',1,$2)", [occurrenceId, notPassKey]);
    await client.query("select public.verify_activity_pass($1,false,'오늘은 확인이 더 필요해요',1,$2)", [occurrenceId, notPassKey]);
    day = await client.query<Record<string, unknown>>("select * from public.list_activity_day($1,$2::date)", [fixture.childProfileId, calendar.today]);
    occurrence = day.rows[0];
    assert(Number(occurrence?.parent_score) === 0 && occurrence?.outcome_code === "NO_REWARD" && occurrence?.confirmed_minutes === 0 && occurrence?.revision === 2, "not PASS stores 0 as no reward with no automatic penalty and preserves idempotency");

    const passKey = randomUUID();
    await client.query("select public.verify_activity_pass($1,true,'그날 문제없음을 확인했어요',2,$2)", [occurrenceId, passKey]);
    day = await client.query<Record<string, unknown>>("select * from public.list_activity_day($1,$2::date)", [fixture.childProfileId, calendar.today]);
    occurrence = day.rows[0];
    assert(Number(occurrence?.parent_score) === 100 && occurrence?.outcome_code === "REWARD" && occurrence?.confirmed_minutes === 30 && occurrence?.revision === 3, "explicit PASS stores 100 and only the registered basic time as planned reward");
    await rejected(client, "select public.verify_activity_pass($1,false,'stale',2,$2)", [occurrenceId, randomUUID()], "40001", "PASS retains optimistic revision conflicts");

    await client.query("reset role");
    const passEvents = await client.query<{ n: number }>(
      `select count(*)::int as n from public.activity_occurrence_events
       where occurrence_id=$1 and event_kind='PARENT_VERIFIED'`,
      [occurrenceId],
    );
    assert(passEvents.rows[0]?.n === 2, "each non-replayed PASS decision remains append-only audit history");
    const ledgerTables = await client.query<{ n: number }>(
      `select count(*)::int as n from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relkind='r' and c.relname in ('activity_ledger_entries','activity_balances','activity_time_balances')`,
    );
    assert(ledgerTables.rows[0]?.n === 0, "PASS assessment creates no ledger or balance table");

    console.log(`RESULT ${passed} checks; all PASS fixtures are rolled back.`);
    console.log("PASS_FLOW_LIVE_OK");
  } catch (error) {
    console.error("PASS flow validation failed:", sqlState(error) || (error as Error).message);
    const diagnostic = error as { message?: string; where?: string };
    console.error(diagnostic.message, diagnostic.where);
    process.exitCode = 1;
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  verifyPassFlowLive();
}
