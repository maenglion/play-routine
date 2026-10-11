import { randomUUID } from "node:crypto";
import { Client, type QueryResult } from "pg";
import { getSupabaseConnectionString } from "../server/supabaseConnection";

type Fixture = {
  familyId: string;
  parentAuthId: string;
  parentPrincipalId: string;
  childAuthId: string;
  childProfileId: string;
  guardianAuthId: string;
  crossParentAuthId: string;
  unverifiedAuthId: string;
  unverifiedChildProfileId: string;
};

let passed = 0;
function assert(value: unknown, label: string): asserts value {
  if (!value) throw new Error(`FAILED: ${label}`);
  console.log(`PASS ${label}`);
  passed++;
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

async function rejected(
  client: Client,
  sql: string,
  values: unknown[],
  expected: string,
  label: string,
) {
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

async function addAuthUser(client: Client, email: string, confirmed = true) {
  const id = randomUUID();
  await client.query(
    `insert into auth.users(
       id, aud, role, email, encrypted_password, email_confirmed_at,
       raw_app_meta_data, raw_user_meta_data, created_at, updated_at
     ) values (
       $1, 'authenticated', 'authenticated', $2, '', $3,
       '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
     )`,
    [id, email, confirmed ? new Date() : null],
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
  const parentAuthId = await addAuthUser(client, `activity-parent-${suffix}@example.invalid`);
  const childAuthId = await addAuthUser(client, `activity-child-${suffix}@example.invalid`);
  const guardianAuthId = await addAuthUser(client, `activity-guardian-${suffix}@example.invalid`);
  const crossParentAuthId = await addAuthUser(client, `activity-cross-${suffix}@example.invalid`);
  const unverifiedAuthId = await addAuthUser(client, `activity-unverified-${suffix}@example.invalid`, false);

  await setUser(client, parentAuthId);
  const family = await client.query<{ family_id: string; principal_id: string }>(
    "select * from public.bootstrap_parent_family($1, 'Asia/Seoul', 'rollback parent')",
    [`Activity rollback ${suffix}`],
  );
  const familyId = family.rows[0]?.family_id;
  const parentPrincipalId = family.rows[0]?.principal_id;
  assert(familyId && parentPrincipalId, "parent creates rollback-only family");

  await client.query("reset role");
  const childPrincipalId = await principalId(client, childAuthId);
  const guardianPrincipalId = await principalId(client, guardianAuthId);
  const unverifiedPrincipalId = await principalId(client, unverifiedAuthId);
  const child = await client.query<{ id: string }>(
    `insert into public.child_profiles(
       family_id, principal_id, display_name, status, created_by_principal_id, linked_at
     ) values ($1, $2, 'Rollback child', 'ACTIVE', $3, now()) returning id`,
    [familyId, childPrincipalId, parentPrincipalId],
  );
  const childProfileId = child.rows[0]?.id;
  assert(childProfileId, "linked active child fixture exists");
  await client.query(
    `insert into public.family_memberships(family_id, principal_id, role, status, created_by_principal_id)
     values ($1, $2, 'CHILD', 'ACTIVE', $3), ($1, $4, 'GUARDIAN', 'ACTIVE', $3)`,
    [familyId, childPrincipalId, parentPrincipalId, guardianPrincipalId],
  );
  const unverified = await client.query<{ id: string }>(
    `insert into public.child_profiles(
       family_id, principal_id, display_name, status, created_by_principal_id, linked_at
     ) values ($1, $2, 'Unverified child', 'ACTIVE', $3, now()) returning id`,
    [familyId, unverifiedPrincipalId, parentPrincipalId],
  );
  const unverifiedChildProfileId = unverified.rows[0]?.id;
  assert(unverifiedChildProfileId, "unverified linked-child fixture exists");
  await client.query(
    `insert into public.family_memberships(family_id, principal_id, role, status, created_by_principal_id)
     values ($1, $2, 'CHILD', 'ACTIVE', $3)`,
    [familyId, unverifiedPrincipalId, parentPrincipalId],
  );

  await setUser(client, crossParentAuthId);
  const cross = await client.query("select * from public.bootstrap_parent_family($1, 'Asia/Seoul', 'cross parent')", [
    `Cross rollback ${suffix}`,
  ]);
  assert(cross.rows.length === 1, "cross-family parent fixture exists");
  return { familyId, parentAuthId, parentPrincipalId, childAuthId, childProfileId, guardianAuthId, crossParentAuthId, unverifiedAuthId, unverifiedChildProfileId };
}

async function saveAndPublishRule(client: Client, fixture: Fixture, name: string) {
  await setUser(client, fixture.parentAuthId);
  const saved = await client.query<{ config_version_id: string; policy_rule_id: string }>(
    `select * from public.save_parent_rule_draft(
       $1, $2, 'DAILY_STUDY'::public.activity_category_code, 'public review feedback',
       'PERCENT'::public.policy_measurement_kind, '완료율', 40, 80, 30, 15
     )`,
    [fixture.familyId, name],
  );
  const row = saved.rows[0];
  assert(row?.config_version_id && row.policy_rule_id, `${name} draft is saved`);
  await client.query("select * from public.publish_parent_rule_draft($1)", [row.config_version_id]);

  // Test fixture only: publication is immutable in product. Move it to today so a rollback
  // transaction can materialize a real current-day occurrence without waiting overnight.
  await client.query("reset role");
  await client.query("alter table public.family_config_versions disable trigger family_config_versions_immutable_after_publish");
  try {
    await client.query(
      `update public.family_config_versions
       set effective_from=(now() at time zone 'Asia/Seoul')::date
       where id=$1`,
      [row.config_version_id],
    );
  } finally {
    await client.query("alter table public.family_config_versions enable trigger family_config_versions_immutable_after_publish");
  }
  return row;
}

async function currentDates(client: Client) {
  const result = await client.query<{ today: string; tomorrow: string; today_dow: number; tomorrow_dow: number }>(
    `select
       (now() at time zone 'Asia/Seoul')::date::text as today,
       ((now() at time zone 'Asia/Seoul')::date + 1)::text as tomorrow,
       extract(isodow from (now() at time zone 'Asia/Seoul')::date)::int as today_dow,
       extract(isodow from ((now() at time zone 'Asia/Seoul')::date + 1))::int as tomorrow_dow`,
  );
  const row = result.rows[0];
  assert(row, "family-local test dates available");
  return row;
}

/**
 * Real Supabase PostgreSQL verification. It opens one transaction and always rolls it back;
 * it does not apply migrations, touch existing users, mutate persisted balances, or send email.
 */
export async function verifyActivityFlowLive() {
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
      `select to_regprocedure('public.create_activity_assignment(uuid,uuid,uuid,date,date,integer[],text)') is not null
          and to_regprocedure('public.list_activity_day(uuid,date)') is not null
          and to_regprocedure('public.verify_activity_occurrence(uuid,numeric,text,integer,uuid)') is not null as ready`,
    );
    assert(ready.rows[0]?.ready, "0009 is applied before live verification (this script never applies it)");

    const fixture = await createFixtures(client);
    const dates = await currentDates(client);
    const oldRule = await saveAndPublishRule(client, fixture, "Frozen Math");
    const otherDow = dates.tomorrow_dow === 7 ? 1 : dates.tomorrow_dow + 1;
    const spareDow = [1, 2, 3, 4, 5, 6, 7].find(day => day !== dates.tomorrow_dow && day !== otherDow);
    assert(spareDow, "a disjoint weekday is available for superseded-rule validation");

    await setUser(client, fixture.parentAuthId);
    const createSql = "select public.create_activity_assignment($1,$2,$3,$4::date,$5::date,$6::integer[],$7) as id";
    const daily = await client.query<{ id: string }>(createSql, [
      fixture.familyId, fixture.childProfileId, oldRule.policy_rule_id,
      dates.tomorrow, null, [dates.tomorrow_dow], "DAILY",
    ]);
    const dailyAssignmentId = daily.rows[0]?.id;
    assert(dailyAssignmentId, "parent schedules frozen published rule for tomorrow");
    await rejected(client, createSql, [fixture.familyId, fixture.childProfileId, oldRule.policy_rule_id, dates.tomorrow, dates.tomorrow, [dates.tomorrow_dow], "DAILY"], "23P01", "same template/day/weekday assignment conflict is rejected");
    const differentWeekday = await client.query(createSql, [fixture.familyId, fixture.childProfileId, oldRule.policy_rule_id, dates.tomorrow, dates.tomorrow, [otherDow], "DAILY"]);
    assert(differentWeekday.rows.length === 1, "overlapping range but disjoint actual weekdays is not a false conflict");
    await rejected(client, createSql, [fixture.familyId, fixture.childProfileId, oldRule.policy_rule_id, dates.today, dates.today, [dates.today_dow], "DAILY"], "22023", "today/past assignment creation is rejected");
    await rejected(client, createSql, [fixture.familyId, fixture.childProfileId, oldRule.policy_rule_id, dates.tomorrow, dates.tomorrow, [1, 1], "DAILY"], "22023", "duplicate weekdays are rejected");

    const onceRule = await saveAndPublishRule(client, fixture, "One Time Task");
    await setUser(client, fixture.parentAuthId);
    const once = await client.query(createSql, [fixture.familyId, fixture.childProfileId, onceRule.policy_rule_id, dates.tomorrow, dates.tomorrow, [1, 2, 3, 4, 5, 6, 7], "ONCE"]);
    assert(once.rows.length === 1, "ONCE schedule is accepted only on its start/end date");
    await rejected(client, createSql, [fixture.familyId, fixture.childProfileId, onceRule.policy_rule_id, dates.tomorrow, null, [dates.tomorrow_dow], "ONCE"], "22023", "ONCE without matching ends_on is rejected");

    // Create two current-day fixture schedules directly under the owning DB role so list RPC can
    // exercise on-demand materialization today; direct client table access remains denied below.
    await client.query("reset role");
    const template = await client.query<{ activity_template_id: string }>(
      `select av.activity_template_id from public.policy_rules pr
       join public.activity_versions av on av.id=pr.activity_version_id where pr.id=$1`,
      [oldRule.policy_rule_id],
    );
    const templateId = template.rows[0]?.activity_template_id;
    assert(templateId, "frozen activity template is resolved");
    const manual = await client.query<{ id: string }>(
      `insert into public.activity_assignments(
         family_id,child_profile_id,policy_rule_id,activity_template_id,starts_on,ends_on,weekdays,repeat_kind,created_by_principal_id
       ) values
         ($1,$2,$3,$4,$5::date,$5::date,array[$6]::integer[],'DAILY',$7),
         ($1,$2,$3,$4,$5::date,$5::date,array[$6]::integer[],'DAILY',$7)
       returning id`,
      [fixture.familyId, fixture.childProfileId, oldRule.policy_rule_id, templateId, dates.today, dates.today_dow, fixture.parentPrincipalId],
    );
    const firstManualId = manual.rows[0]?.id;
    const secondManualId = manual.rows[1]?.id;
    assert(firstManualId && secondManualId, "rollback-only current-day assignments exist");

    await setUser(client, fixture.childAuthId);
    let day = await client.query("select * from public.list_activity_day($1,$2::date)", [fixture.childProfileId, dates.today]);
    assert(day.rows.length === 2 && day.rows.every(r => r.verification_status === "MISSING" && r.confirmed_minutes === null), "missing is neutral: no report has no penalty or planned minutes");
    const firstOccurrence = day.rows.find(r => r.assignment_id === firstManualId);
    const secondOccurrence = day.rows.find(r => r.assignment_id === secondManualId);
    assert(firstOccurrence?.revision === 0 && secondOccurrence?.revision === 0, "on-demand occurrences start at revision zero");
    await rejected(client, "select public.report_activity_done($1,$2,now()+interval '1 hour')", [firstOccurrence.occurrence_id, randomUUID()], "22023", "future occurred_at is rejected");
    await rejected(client, "select public.report_activity_done($1,$2,now()-interval '1 day')", [firstOccurrence.occurrence_id, randomUUID()], "22023", "occurred_at from another family business date is rejected");
    const reportKey = randomUUID();
    await client.query("select public.report_activity_done($1,$2,null)", [firstOccurrence.occurrence_id, reportKey]);
    await client.query("select public.report_activity_done($1,$2,null)", [firstOccurrence.occurrence_id, reportKey]);
    day = await client.query("select * from public.list_activity_day($1,$2::date)", [fixture.childProfileId, dates.today]);
    let first = day.rows.find(r => r.occurrence_id === firstOccurrence.occurrence_id);
    assert(first?.verification_status === "HELD" && first.child_recorded_at && first.revision === 1, "child report is held pending parent confirmation and records server time separately");
    await rejected(client, "select public.verify_activity_occurrence($1,50,'child cannot evaluate',1,$2)", [firstOccurrence.occurrence_id, randomUUID()], "42501", "child cannot evaluate an occurrence");

    await setUser(client, fixture.parentAuthId);
    const verifySql = "select public.verify_activity_occurrence($1,$2,$3,$4,$5)";
    await rejected(client, verifySql, [firstOccurrence.occurrence_id, 0, "stale revision", 0, randomUUID()], "40001", "stale optimistic revision is rejected");
    const verifyKey = randomUUID();
    await client.query(verifySql, [firstOccurrence.occurrence_id, 0, "공개 피드백: 다시 확인", 1, verifyKey]);
    await client.query(verifySql, [firstOccurrence.occurrence_id, 0, "공개 피드백: 다시 확인", 1, verifyKey]);
    await rejected(client, verifySql, [firstOccurrence.occurrence_id, 0, "changed feedback", 1, verifyKey], "22023", "changed verification payload with same idempotency key is rejected");
    day = await client.query("select * from public.list_activity_day($1,$2::date)", [fixture.childProfileId, dates.today]);
    first = day.rows.find(r => r.occurrence_id === firstOccurrence.occurrence_id);
    assert(first?.verification_status === "CONFIRMED" && Number(first.parent_score) === 0 && first.confirmed_minutes === -15 && first.parent_reason === "공개 피드백: 다시 확인" && first.parent_verified_at, "score 0 confirms signed planned penalty and publicly visible reason (not a ledger)");

    for (const [score, expectedMinutes] of [[50, 0], [79.9, 0], [80, 30], [100, 30]] as const) {
      await client.query(verifySql, [firstOccurrence.occurrence_id, score, `score ${score} public feedback`, first.revision, randomUUID()]);
      day = await client.query("select * from public.list_activity_day($1,$2::date)", [fixture.childProfileId, dates.today]);
      first = day.rows.find(r => r.occurrence_id === firstOccurrence.occurrence_id);
      assert(Number(first?.parent_score) === score && first?.confirmed_minutes === expectedMinutes, `score ${score} uses the exact frozen 0–100 band`);
    }
    const lateReportKey = randomUUID();
    await setUser(client, fixture.childAuthId);
    await client.query("select public.report_activity_done($1,$2,null)", [firstOccurrence.occurrence_id, lateReportKey]);
    day = await client.query("select * from public.list_activity_day($1,$2::date)", [fixture.childProfileId, dates.today]);
    first = day.rows.find(r => r.occurrence_id === firstOccurrence.occurrence_id);
    assert(Number(first?.parent_score) === 100 && first?.confirmed_minutes === 30 && first?.revision === 7, "late child report appends history without changing a confirmed result");
    await rejected(client, "select public.report_activity_done($1,$2,null)", [secondOccurrence.occurrence_id, lateReportKey], "22023", "idempotency key cannot be reused for another occurrence");

    await setUser(client, fixture.parentAuthId);
    await client.query(verifySql, [secondOccurrence.occurrence_id, 50, "parent may assess before report", 0, randomUUID()]);
    day = await client.query("select * from public.list_activity_day($1,$2::date)", [fixture.childProfileId, dates.today]);
    const second = day.rows.find(r => r.occurrence_id === secondOccurrence.occurrence_id);
    assert(second?.child_reported === false && second.verification_status === "CONFIRMED" && second.confirmed_minutes === 0, "parent-only neutral assessment is allowed and missing is not failure");

    const newerRule = await saveAndPublishRule(client, fixture, "Frozen Math");
    await setUser(client, fixture.parentAuthId);
    const assignments = await client.query("select * from public.list_parent_activity_assignments($1)", [fixture.familyId]);
    assert(assignments.rows.some(r => r.assignment_id === dailyAssignmentId && r.policy_rule_id === oldRule.policy_rule_id), "existing assignment remains pinned to its original rule after a newer config publishes");
    await rejected(client, createSql, [fixture.familyId, fixture.childProfileId, oldRule.policy_rule_id, dates.tomorrow, dates.tomorrow, [spareDow], "DAILY"], "22023", "superseded rule cannot create a new assignment");
    assert(newerRule.policy_rule_id !== oldRule.policy_rule_id, "new version has a distinct immutable rule id");

    await client.query("select public.end_activity_assignment($1,$2::date)", [dailyAssignmentId, dates.tomorrow]);
    const ended = await client.query("select * from public.list_parent_activity_assignments($1)", [fixture.familyId]);
    assert(ended.rows.some(r => r.assignment_id === dailyAssignmentId && (r.ends_on instanceof Date ? `${r.ends_on.getFullYear()}-${String(r.ends_on.getMonth()+1).padStart(2,'0')}-${String(r.ends_on.getDate()).padStart(2,'0')}` : String(r.ends_on).slice(0,10)) === dates.tomorrow), "parent can audibly terminate an open schedule on/after today without deleting history");
    await client.query("select public.end_activity_assignment($1,$2::date)", [dailyAssignmentId, dates.tomorrow]);
    await client.query("reset role");
    const endEvents = await client.query("select count(*)::int as n from public.activity_assignment_end_events where assignment_id=$1", [dailyAssignmentId]);
    assert(endEvents.rows[0]?.n === 1, "assignment end has an append-only audit event");
    await rejected(client, "update public.activity_occurrence_events set reason='overwrite' where occurrence_id=$1", [firstOccurrence.occurrence_id], "55000", "raw events remain immutable even under the database owner");
    await client.query("alter table public.family_config_versions disable trigger family_config_versions_immutable_after_publish");
    await client.query("update public.family_config_versions set effective_from=$2::date-1 where id=$1",[oldRule.config_version_id,dates.today]);
    await client.query("alter table public.family_config_versions enable trigger family_config_versions_immutable_after_publish");
    await client.query(`insert into public.activity_assignments(family_id,child_profile_id,policy_rule_id,activity_template_id,starts_on,ends_on,weekdays,repeat_kind,created_by_principal_id)
      values($1,$2,$3,$4,$5::date-1,$5::date-1,array[extract(isodow from $5::date-1)::integer],'ONCE',$6)`,[fixture.familyId,fixture.childProfileId,oldRule.policy_rule_id,templateId,dates.today,fixture.parentPrincipalId]);
    await setUser(client,fixture.childAuthId);
    const pastDay=await client.query("select * from public.list_activity_day($1,$2::date-1)",[fixture.childProfileId,dates.today]);
    const past=pastDay.rows[0];
    assert(past&&past.verification_status==='MISSING',"yesterday schedule materializes without assuming failure");
    await client.query("select public.report_activity_done($1,$2,null)",[past.occurrence_id,randomUUID()]);
    await setUser(client,fixture.parentAuthId);
    await client.query(verifySql,[past.occurrence_id,80,"어제 수행한 활동을 오늘 확인",1,randomUUID()]);
    await client.query("reset role");
    const retro=await client.query(`select o.business_date::text as source_date,
      (e.recorded_at at time zone 'Asia/Seoul')::date::text as input_date,o.confirmed_minutes
      from public.activity_occurrences o join public.activity_occurrence_events e on e.occurrence_id=o.id
      where o.id=$1 and e.event_kind='PARENT_VERIFIED'`,[past.occurrence_id]);
    assert(retro.rows[0]?.source_date!==dates.today&&retro.rows[0]?.input_date===dates.today&&retro.rows[0]?.confirmed_minutes===30,"late parent confirmation keeps past source date and current recording date distinct");

    await setUser(client, fixture.guardianAuthId);
    await rejected(client, verifySql, [firstOccurrence.occurrence_id, 100, "guardian rejected", first.revision, randomUUID()], "42501", "guardian cannot confirm activity");
    await rejected(client, "select public.report_activity_done($1,$2,null)", [firstOccurrence.occurrence_id, randomUUID()], "42501", "guardian cannot report as a child");
    await rejected(client, "select public.end_activity_assignment($1,$2::date)", [dailyAssignmentId,dates.tomorrow], "42501", "guardian cannot end schedules");
    await rejected(client, "select * from public.list_activity_day($1,$2::date)", [fixture.childProfileId, dates.today], "42501", "guardian cannot view activity day even with child profile id");
    await rejected(client, "select * from public.list_parent_activity_assignments($1)", [fixture.familyId], "42501", "guardian cannot view assignments");
    await rejected(client, "select * from public.activity_occurrences", [], "42501", "direct occurrence table access is revoked");
    await rejected(client, "insert into public.activity_occurrence_events(family_id,occurrence_id,actor_principal_id,event_kind,idempotency_key) values($1,$2,public.current_principal_id(),'CHILD_REPORTED',$3)", [fixture.familyId, firstOccurrence.occurrence_id, randomUUID()], "42501", "direct raw event insertion is revoked");

    await setUser(client, fixture.crossParentAuthId);
    await rejected(client, "select * from public.list_parent_activity_assignments($1)", [fixture.familyId], "42501", "cross-family parent cannot read assignments");
    await rejected(client, "select * from public.list_activity_day($1,$2::date)", [fixture.childProfileId, dates.today], "42501", "cross-family parent cannot read child day");
    await setUser(client, fixture.unverifiedAuthId);
    await rejected(client, "select * from public.list_activity_day($1,$2::date)", [fixture.unverifiedChildProfileId, dates.today], "42501", "unverified active member is denied");
    await setUser(client, null);
    await rejected(client, "select * from public.list_activity_day($1,$2::date)", [fixture.childProfileId, dates.today], "42501", "no authenticated session is denied");

    await client.query("reset role");
    const ledgerTables = await client.query<{ n: number }>(
      `select count(*)::int as n from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relkind='r' and c.relname in ('activity_ledger_entries','activity_balances','activity_time_balances')`,
    );
    assert(ledgerTables.rows[0]?.n === 0, "activity flow creates no ledger or balance tables");
    console.log(`RESULT ${passed} checks; all created auth/family/rule/activity fixtures are rolled back.`);
    console.log("ACTIVITY_FLOW_LIVE_OK");
  } catch (error) {
    console.error("Activity flow validation failed:", sqlState(error) || (error as Error).message);
    process.exitCode = 1;
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  verifyActivityFlowLive();
}
