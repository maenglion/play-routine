import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { getSupabaseConnectionString } from "../server/supabaseConnection";

type Fixture = {
  familyId: string;
  parentAuthId: string;
  childAuthId: string;
  childProfileId: string;
  guardianAuthId: string;
  crossParentAuthId: string;
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

function dateText(value: unknown) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
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
  const result = await client.query<{ id: string }>("select id from public.principals where auth_user_id=$1", [authUserId]);
  const id = result.rows[0]?.id;
  assert(id, "auth fixture bootstraps an application principal");
  return id;
}

async function createFixtures(client: Client): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 10);
  const parentAuthId = await addAuthUser(client, `manual-parent-${suffix}@example.invalid`);
  const childAuthId = await addAuthUser(client, `manual-child-${suffix}@example.invalid`);
  const guardianAuthId = await addAuthUser(client, `manual-guardian-${suffix}@example.invalid`);
  const crossParentAuthId = await addAuthUser(client, `manual-cross-${suffix}@example.invalid`);

  await setUser(client, parentAuthId);
  const family = await client.query<{ family_id: string; principal_id: string }>(
    "select * from public.bootstrap_parent_family($1, 'Asia/Seoul', 'manual rollback parent')",
    [`Manual rewards rollback ${suffix}`],
  );
  const familyId = family.rows[0]?.family_id;
  const parentPrincipalId = family.rows[0]?.principal_id;
  assert(familyId && parentPrincipalId, "parent creates rollback-only family");

  await client.query("reset role");
  const childPrincipalId = await principalId(client, childAuthId);
  const guardianPrincipalId = await principalId(client, guardianAuthId);
  const child = await client.query<{ id: string }>(
    `insert into public.child_profiles(
       family_id, principal_id, display_name, status, created_by_principal_id, linked_at
     ) values ($1, $2, '수동 보상 자녀', 'ACTIVE', $3, now()) returning id`,
    [familyId, childPrincipalId, parentPrincipalId],
  );
  const childProfileId = child.rows[0]?.id;
  assert(childProfileId, "linked active child fixture exists");
  await client.query(
    `insert into public.family_memberships(family_id, principal_id, role, status, created_by_principal_id)
     values ($1, $2, 'CHILD', 'ACTIVE', $3), ($1, $4, 'GUARDIAN', 'ACTIVE', $3)`,
    [familyId, childPrincipalId, parentPrincipalId, guardianPrincipalId],
  );

  await setUser(client, crossParentAuthId);
  const cross = await client.query("select * from public.bootstrap_parent_family($1, 'Asia/Seoul', 'cross parent')", [`Manual cross ${suffix}`]);
  assert(cross.rows.length === 1, "cross-family parent fixture exists");
  return { familyId, parentAuthId, childAuthId, childProfileId, guardianAuthId, crossParentAuthId };
}

async function familyDates(client: Client) {
  const result = await client.query<{ today: string; ended_monday: string; ended_sunday: string; prior_ended_monday: string }>(
    `with d as (select (now() at time zone 'Asia/Seoul')::date as today)
     select today::text,
       (date_trunc('week', today::timestamp)::date - 7)::text as ended_monday,
       (date_trunc('week', today::timestamp)::date - 1)::text as ended_sunday,
       (date_trunc('week', today::timestamp)::date - 14)::text as prior_ended_monday
     from d`,
  );
  const row = result.rows[0];
  assert(row && row.ended_monday < row.today && row.ended_sunday < row.today, "family-local past completed week is available");
  return row;
}

/**
 * Real Supabase verification. It takes the common fixture advisory transaction lock and always
 * rolls back: it never applies migrations, sends money, calls a payment provider, or persists data.
 */
export async function verifyManualRewardsLive() {
  const client = new Client({
    connectionString: getSupabaseConnectionString(),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
  });
  try {
    await client.connect();
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext('play-routine-live-fixtures'))");
    const readiness = await client.query<{ ready: boolean }>(
      `select
        to_regprocedure('public.upsert_weekly_money_reward(uuid,uuid,date,boolean,integer,integer,integer,integer,uuid)') is not null
        and to_regprocedure('public.create_period_money_reward(uuid,uuid,text,date,text,text,integer,uuid)') is not null
        and to_regprocedure('public.mark_manual_money_reward_paid(uuid,date,uuid)') is not null
        and to_regprocedure('public.issue_manual_bonus_coupon(uuid,uuid,text,text,text,integer,date,uuid)') is not null
        and to_regprocedure('public.list_child_manual_rewards(uuid)') is not null as ready`,
    );
    assert(readiness.rows[0]?.ready, "0012_manual_rewards is applied before live verification (this script never applies it)");

    const fixture = await createFixtures(client);
    const dates = await familyDates(client);
    const weeklySql = "select * from public.upsert_weekly_money_reward($1,$2,$3::date,$4,$5,$6,$7,$8,$9)";

    await setUser(client, fixture.parentAuthId);
    const draftKey = randomUUID();
    let weekly = await client.query(weeklySql, [
      fixture.familyId, fixture.childProfileId, dates.ended_monday, false, 0, 10_000, 5, 15_000, draftKey,
    ]);
    assert(weekly.rows[0]?.status === "PENDING" && weekly.rows[0]?.scheduled_amount_krw === null, "unchecked weekly review is a null-amount pending draft, never zero payout");
    const draftId = weekly.rows[0]?.reward_id as string;
    const exactDraftRetry = await client.query(weeklySql, [
      fixture.familyId, fixture.childProfileId, dates.ended_monday, false, 0, 10_000, 5, 15_000, draftKey,
    ]);
    assert(exactDraftRetry.rows[0]?.reward_id === draftId && exactDraftRetry.rows[0]?.status === "PENDING", "exact weekly retry returns the same pending record");
    await rejected(client, weeklySql, [
      fixture.familyId, fixture.childProfileId, dates.ended_monday, false, 1, 10_000, 5, 15_000, draftKey,
    ], "22023", "same weekly idempotency key with a different payload is rejected");

    const currentWeek = await client.query(weeklySql, [fixture.familyId, fixture.childProfileId, dates.today, true, 0, 7000, 1, 7000, randomUUID()]);
    assert(currentWeek.rows[0]?.status === "PENDING" && currentWeek.rows[0]?.scheduled_amount_krw === null, "unfinished week stays pending even when parent checked good-this-week");
    const flatWeek = await client.query(weeklySql, [fixture.familyId, fixture.childProfileId, dates.ended_monday, true, 0, 7000, 1, 7000, randomUUID()]);
    assert(flatWeek.rows[0]?.reward_id === draftId && flatWeek.rows[0]?.scheduled_amount_krw === 7000, "current UI flat weekly amount schedules exactly parent-entered 7000 with praise separate");

    weekly = await client.query(weeklySql, [
      fixture.familyId, fixture.childProfileId, dates.prior_ended_monday, true, 4, 10_000, 5, 15_000, randomUUID(),
    ]);
    const scheduledId = weekly.rows[0]?.reward_id as string;
    assert(
      weekly.rows[0]?.status === "SCHEDULED" && Number(weekly.rows[0]?.scheduled_amount_krw) === 10_000
        && Number(weekly.rows[0]?.base_amount_snapshot_krw) === 10_000
        && Number(weekly.rows[0]?.praise_threshold_snapshot) === 5
        && Number(weekly.rows[0]?.praise_total_amount_snapshot_krw) === 15_000,
      "ended checked week is scheduled with its current 10000 KRW snapshot before the praise threshold",
    );
    weekly = await client.query(weeklySql, [
      fixture.familyId, fixture.childProfileId, dates.prior_ended_monday, true, 5, 10_000, 5, 15_000, randomUUID(),
    ]);
    await client.query("reset role");
    const weeklyAudit = await client.query<{ rows: number; events: number }>(
      `select count(*)::int as rows,
        (select count(*)::int from public.manual_reward_events where money_reward_id=$1) as events
       from public.manual_money_rewards where id=$1`, [scheduledId],
    );
    assert(
      weekly.rows[0]?.reward_id === scheduledId && Number(weekly.rows[0]?.scheduled_amount_krw) === 15_000
        && weeklyAudit.rows[0]?.rows === 1 && weeklyAudit.rows[0]?.events === 2,
      "scheduled praise 4→5 updates one reward to 15000 KRW and preserves two append-only events",
    );

    await setUser(client, fixture.parentAuthId);
    const payKey = randomUUID();
    const paid = await client.query("select * from public.mark_manual_money_reward_paid($1,$2::date,$3)", [scheduledId, dates.today, payKey]);
    assert(paid.rows[0]?.status === "PAID" && dateText(paid.rows[0]?.paid_on) === dates.today, "parent marks scheduled record paid once after external payment acknowledgement");
    const paidRetry = await client.query("select * from public.mark_manual_money_reward_paid($1,$2::date,$3)", [scheduledId, dates.today, payKey]);
    assert(paidRetry.rows[0]?.reward_id === scheduledId && paidRetry.rows[0]?.status === "PAID", "exact paid retry returns the same PAID record");
    await rejected(client, weeklySql, [
      fixture.familyId, fixture.childProfileId, dates.prior_ended_monday, true, 4, 10_000, 5, 15_000, randomUUID(),
    ], "22023", "PAID weekly reward cannot be modified");
    await rejected(client, "select * from public.void_scheduled_money_reward($1,$2,$3)", [scheduledId, "already paid cannot be silently undone", randomUUID()], "22023", "PAID reward cannot be voided");

    const dailyKey = randomUUID();
    const daily = await client.query(
      "select * from public.create_period_money_reward($1,$2,'DAILY',$3::date,null,null,$4,$5)",
      [fixture.familyId, fixture.childProfileId, dates.ended_sunday, 3_000, dailyKey],
    );
    const dailyId = daily.rows[0]?.reward_id as string;
    assert(daily.rows[0]?.status === "SCHEDULED" && Number(daily.rows[0]?.scheduled_amount_krw) === 3_000, "parent creates a separate daily scheduled KRW record");
    const dailyRetry = await client.query(
      "select * from public.create_period_money_reward($1,$2,'DAILY',$3::date,null,null,$4,$5)",
      [fixture.familyId, fixture.childProfileId, dates.ended_sunday, 3_000, dailyKey],
    );
    assert(dailyRetry.rows[0]?.reward_id === dailyId, "exact period-money retry returns its original record");
    await rejected(client,
      "select * from public.create_period_money_reward($1,$2,'DAILY',$3::date,null,null,$4,$5)",
      [fixture.familyId, fixture.childProfileId, dates.ended_sunday, 3_000, randomUUID()],
      "22023", "same family-child-daily period permits only one money record",
    );
    const voidDaily = await client.query("select * from public.void_scheduled_money_reward($1,$2,$3)", [dailyId, "지급 계획 변경", randomUUID()]);
    assert(voidDaily.rows[0]?.status === "VOID", "scheduled money reward is voided as an audit state event, not deleted");

    const special = await client.query(
      "select * from public.create_period_money_reward($1,$2,'SPECIAL_EVENT',$3::date,$4,$5,$6,$7)",
      [fixture.familyId, fixture.childProfileId, dates.ended_sunday, "science-fair-rollback", "과학 발표회", 5_000, randomUUID()],
    );
    assert(special.rows[0]?.event_title === "과학 발표회", "special event retains a title and independent event key");
    await rejected(client,
      "select * from public.create_period_money_reward($1,$2,'SPECIAL_EVENT',$3::date,$4,$5,$6,$7)",
      [fixture.familyId, fixture.childProfileId, dates.ended_sunday, "science-fair-rollback", "다른 제목", 6_000, randomUUID()],
      "22023", "same special-event key cannot collide with a second unrelated record",
    );

    const couponKey = randomUUID();
    const coupon = await client.query(
      "select * from public.issue_manual_bonus_coupon($1,$2,$3,$4,'TIME_MINUTES',$5,$6::date,$7)",
      [fixture.familyId, fixture.childProfileId, "발표 자유시간", "선생님이 발표를 칭찬해 주셨어요", 30, dates.today, couponKey],
    );
    const couponId = coupon.rows[0]?.coupon_id as string;
    assert(coupon.rows[0]?.status === "ISSUED" && Number(coupon.rows[0]?.amount) === 30, "parent issues a teacher-praise time coupon without a threshold policy");
    const couponRetry = await client.query(
      "select * from public.issue_manual_bonus_coupon($1,$2,$3,$4,'TIME_MINUTES',$5,$6::date,$7)",
      [fixture.familyId, fixture.childProfileId, "발표 자유시간", "선생님이 발표를 칭찬해 주셨어요", 30, dates.today, couponKey],
    );
    assert(couponRetry.rows[0]?.coupon_id === couponId, "exact coupon issue retry returns the original coupon");
    await rejected(client,
      "select * from public.issue_manual_bonus_coupon($1,$2,$3,$4,'MONEY_KRW',$5,$6::date,$7)",
      [fixture.familyId, fixture.childProfileId, "잘못된 쿠폰", "0원은 불가", 0, dates.today, randomUUID()],
      "22023", "zero/negative coupon amount is rejected server-side",
    );
    await rejected(client,
      "select * from public.issue_manual_bonus_coupon($1,$2,$3,$4,'CUSTOM',null,$5::date,$6)",
      [fixture.familyId, fixture.childProfileId, "미래 쿠폰", "미래 발행일은 불가", "2999-01-01", randomUUID()],
      "22023", "malformed coupon RPC input is rejected",
    );

    await setUser(client, fixture.childAuthId);
    await rejected(client, "select * from public.redeem_manual_bonus_coupon($1,$2)", [couponId, randomUUID()], "42501", "child cannot redeem their coupon through direct RPC");
    await rejected(client, "select * from public.mark_manual_money_reward_paid($1,$2::date,$3)", [scheduledId, dates.today, randomUUID()], "42501", "child cannot mark money paid through direct RPC");
    const childRows = await client.query("select * from public.list_child_manual_rewards($1)", [fixture.childProfileId]);
    assert(
      childRows.rows.some(row => row.record_type === "MONEY" && Number(row.scheduled_amount_krw) === 15_000)
        && childRows.rows.some(row => row.record_type === "BONUS_COUPON" && row.record_id === couponId && row.unit === "TIME_MINUTES"),
      "linked child can view own scheduled KRW record and coupon as separate projections",
    );

    await setUser(client, fixture.parentAuthId);
    const redeemKey = randomUUID();
    const redeemed = await client.query("select * from public.redeem_manual_bonus_coupon($1,$2)", [couponId, redeemKey]);
    assert(redeemed.rows[0]?.status === "REDEEMED", "parent atomically redeems ISSUED coupon once");
    const redeemedRetry = await client.query("select * from public.redeem_manual_bonus_coupon($1,$2)", [couponId, redeemKey]);
    assert(redeemedRetry.rows[0]?.coupon_id === couponId && redeemedRetry.rows[0]?.status === "REDEEMED", "exact coupon redemption retry is idempotent");
    await rejected(client, "select * from public.void_manual_bonus_coupon($1,$2,$3)", [couponId, "redeemed cannot void", randomUUID()], "22023", "redeemed coupon cannot be voided");

    const voidCoupon = await client.query(
      "select * from public.issue_manual_bonus_coupon($1,$2,$3,$4,'CUSTOM',null,$5::date,$6)",
      [fixture.familyId, fixture.childProfileId, "자유 쿠폰", "칭찬 보너스", dates.today, randomUUID()],
    );
    const voidCouponId = voidCoupon.rows[0]?.coupon_id as string;
    const voidCouponResult = await client.query("select * from public.void_manual_bonus_coupon($1,$2,$3)", [voidCouponId, "보너스 계획 변경", randomUUID()]);
    assert(voidCouponResult.rows[0]?.status === "VOID", "unredeemed coupon may be voided without deletion");

    await setUser(client, fixture.guardianAuthId);
    await rejected(client, weeklySql, [fixture.familyId, fixture.childProfileId, dates.ended_monday, true, 5, 10_000, 5, 15_000, randomUUID()], "42501", "guardian cannot create weekly money reward");
    await rejected(client, "select * from public.list_parent_manual_rewards($1)", [fixture.familyId], "42501", "guardian cannot read parent reward records");
    await rejected(client, "select * from public.list_child_manual_rewards($1)", [fixture.childProfileId], "42501", "guardian cannot read child manual reward records");
    await rejected(client, "select * from public.manual_money_rewards", [], "42501", "guardian direct raw money table access is revoked");
    await rejected(client, "select * from public.manual_reward_events", [], "42501", "guardian direct audit table access is revoked");

    await setUser(client, fixture.crossParentAuthId);
    await rejected(client, "select * from public.list_parent_manual_rewards($1)", [fixture.familyId], "42501", "cross-family parent cannot read reward records");
    await rejected(client, "select * from public.issue_manual_bonus_coupon($1,$2,$3,$4,'CUSTOM',null,$5::date,$6)", [fixture.familyId, fixture.childProfileId, "침해", "타 가족", dates.today, randomUUID()], "42501", "cross-family parent cannot issue a coupon");

    await setUser(client, null);
    await rejected(client, "select * from public.list_child_manual_rewards($1)", [fixture.childProfileId], "42501", "anonymous session is denied child reward projection");

    await client.query("reset role");
    const noTimeLedger = await client.query<{ n: number }>(
      `select count(*)::int as n from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relkind='r' and c.relname in ('manual_reward_time_balances', 'manual_reward_time_ledger_entries')`,
    );
    assert(noTimeLedger.rows[0]?.n === 0, "manual bonus coupons create no normal-time balance or ledger table");
    const events = await client.query<{ n: number }>("select count(*)::int as n from public.manual_reward_events where family_id=$1", [fixture.familyId]);
    assert((events.rows[0]?.n ?? 0) >= 8, "manual reward transitions retain immutable audit/provenance events");

    console.log(`RESULT ${passed} checks; all fixture users/families/rewards are rolled back.`);
    console.log("MANUAL_REWARDS_LIVE_OK");
  } catch (error) {
    console.error("Manual rewards live validation failed:", sqlState(error) || (error as Error).message);
    const diagnostic = error as { message?: string; where?: string };
    console.error(diagnostic.message, diagnostic.where);
    process.exitCode = 1;
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  verifyManualRewardsLive();
}
