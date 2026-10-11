import { randomUUID } from "node:crypto";
import { Client, type QueryResult } from "pg";
import { getSupabaseConnectionString } from "../server/supabaseConnection";

type Fixture = {
  familyId: string;
  childProfileId: string;
  parentAuthUserId: string;
  guardianAuthUserId: string;
  wrongEmailAuthUserId: string;
  alreadyParentAuthUserId: string;
  guardianEmail: string;
  alreadyParentEmail: string;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function queryAs(
  client: Client,
  authUserId: string,
  sql: string,
  values: unknown[] = [],
): Promise<QueryResult> {
  await client.query("savepoint guardian_operation");
  await client.query("select set_config('request.jwt.claim.sub', $1, true)", [authUserId]);
  await client.query("set local role authenticated");
  try {
    const result = await client.query(sql, values);
    await client.query("reset role");
    await client.query("release savepoint guardian_operation");
    return result;
  } catch (error) {
    await client.query("rollback to savepoint guardian_operation");
    await client.query("release savepoint guardian_operation");
    throw error;
  } finally {
    // Restore the privileged fixture role before the next setup/assertion query.
    await client.query("reset role");
  }
}

async function expectSqlState(
  operation: () => Promise<unknown>, acceptedCodes: string[], label: string) {
  try {
    await operation();
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    assert(acceptedCodes.includes(code), `${label}: expected ${acceptedCodes.join("/")}, got ${code || "unknown"}`);
    return;
  }
  throw new Error(`${label}: operation unexpectedly succeeded`);
}

async function insertVerifiedAuthUser(client: Client, email: string) {
  const id = randomUUID();
  await client.query(
    `insert into auth.users (
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
    `select id from public.principals where auth_user_id = $1`,
    [authUserId],
  );
  const id = result.rows[0]?.id;
  assert(id, "auth user fixture did not bootstrap a principal");
  return id;
}

async function createFixtures(client: Client): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const parentAuthUserId = await insertVerifiedAuthUser(client, `guardian-parent-${suffix}@example.test`);
  const guardianEmail = `guardian-viewer-${suffix}@example.test`;
  const guardianAuthUserId = await insertVerifiedAuthUser(client, guardianEmail);
  const wrongEmailAuthUserId = await insertVerifiedAuthUser(client, `guardian-wrong-${suffix}@example.test`);
  const alreadyParentEmail = `guardian-parent-role-${suffix}@example.test`;
  const alreadyParentAuthUserId = await insertVerifiedAuthUser(client, alreadyParentEmail);
  const parentPrincipalId = await principalId(client, parentAuthUserId);

  const familyResult = await client.query<{ id: string }>(
    `insert into public.families(name, timezone, created_by_principal_id)
     values ($1, 'Asia/Seoul', $2) returning id`,
    [`Guardian RLS ${suffix}`, parentPrincipalId],
  );
  const familyId = familyResult.rows[0]?.id;
  assert(familyId, "family fixture was not created");

  await client.query(
    `insert into public.family_memberships(
       family_id, principal_id, role, status, created_by_principal_id
     ) values ($1, $2, 'OWNER_PARENT', 'ACTIVE', $2)`,
    [familyId, parentPrincipalId],
  );

  const childProfileResult = await client.query<{ id: string }>(
    `insert into public.child_profiles(
       family_id, display_name, status, created_by_principal_id
     ) values ($1, '상태 확인 자녀', 'PENDING_LINK', $2) returning id`,
    [familyId, parentPrincipalId],
  );
  const childProfileId = childProfileResult.rows[0]?.id;
  assert(childProfileId, "child profile fixture was not created");

  return {
    familyId,
    childProfileId,
    parentAuthUserId,
    guardianAuthUserId,
    wrongEmailAuthUserId,
    alreadyParentAuthUserId,
    guardianEmail,
    alreadyParentEmail,
  };
}

async function assertMigrationReady(client: Client) {
  const result = await client.query<{ ready: boolean }>(
    `select to_regclass('public.guardian_invitations') is not null as ready`,
  );
  assert(result.rows[0]?.ready, "guardian migration is not applied; review/apply 0006_guardian_viewers.sql before live verification");
}

/**
 * Runs against the real Supabase PostgreSQL database inside one transaction and always rolls it back.
 * It does not apply a migration and does not send email.
 */
export async function verifyGuardianLiveAccess() {
  const client = new Client({
    connectionString: getSupabaseConnectionString(),
    connectionTimeoutMillis: 10_000,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext('play-routine-live-fixtures'))");
    await assertMigrationReady(client);
    const fixture = await createFixtures(client);

    const created = await queryAs(
      client,
      fixture.parentAuthUserId,
      `select * from public.create_guardian_invitation($1, $2, interval '7 days')`,
      [fixture.familyId, fixture.guardianEmail],
    );
    const invitationId = created.rows[0]?.invitation_id as string | undefined;
    assert(invitationId, "parent could not create a guardian invitation");

    await expectSqlState(
      () => queryAs(
        client,
        fixture.parentAuthUserId,
        `select * from public.create_guardian_invitation($1, $2, interval '7 days')`,
        [fixture.familyId, fixture.guardianEmail],
      ),
      ["23505"],
      "duplicate guardian invitation",
    );

    await expectSqlState(
      () => queryAs(
        client,
        fixture.wrongEmailAuthUserId,
        `select * from public.complete_guardian_invitation($1)`,
        [invitationId],
      ),
      ["P0001"],
      "wrong-email guardian acceptance",
    );

    // Force the parent-created invitation past its allowed period while preserving the
    // table's expires_at > created_at invariant; acceptance stays deliberately generic.
    await client.query(
      `update public.guardian_invitations
       set created_at = now() - interval '2 days', expires_at = now() - interval '1 day'
       where id = $1`,
      [invitationId],
    );
    await expectSqlState(
      () => queryAs(
        client,
        fixture.guardianAuthUserId,
        `select * from public.complete_guardian_invitation($1)`,
        [invitationId],
      ),
      ["P0001"],
      "expired guardian acceptance",
    );

    const fresh = await queryAs(
      client,
      fixture.parentAuthUserId,
      `select * from public.create_guardian_invitation($1, $2, interval '7 days')`,
      [fixture.familyId, fixture.guardianEmail],
    );
    const freshInvitationId = fresh.rows[0]?.invitation_id as string | undefined;
    assert(freshInvitationId, "parent could not recreate an expired guardian invitation");

    const elevationInvite = await queryAs(
      client,
      fixture.parentAuthUserId,
      `select * from public.create_guardian_invitation($1, $2, interval '7 days')`,
      [fixture.familyId, fixture.alreadyParentEmail],
    );
    const elevationInvitationId = elevationInvite.rows[0]?.invitation_id as string | undefined;
    assert(elevationInvitationId, "parent could not create the role-elevation fixture invitation");
    const alreadyParentPrincipalId = await principalId(client, fixture.alreadyParentAuthUserId);
    const fixtureOwnerPrincipalId = await principalId(client, fixture.parentAuthUserId);
    await client.query(
      `insert into public.family_memberships(
         family_id, principal_id, role, status, created_by_principal_id
       ) values ($1, $2, 'PARENT', 'ACTIVE', $3)`,
      [fixture.familyId, alreadyParentPrincipalId, fixtureOwnerPrincipalId],
    );
    await expectSqlState(
      () => queryAs(
        client,
        fixture.alreadyParentAuthUserId,
        `select * from public.complete_guardian_invitation($1)`,
        [elevationInvitationId],
      ),
      ["P0001"],
      "parent role elevation through guardian invitation",
    );

    const invitations = await queryAs(
      client,
      fixture.guardianAuthUserId,
      "select * from public.list_my_active_guardian_invitations()",
    );
    assert(invitations.rows.length === 1, "verified exact-email guardian could not discover exactly one active invitation");
    assert(invitations.rows[0]?.invitation_id === freshInvitationId, "guardian invitation discovery returned an unexpected invitation");

    const accepted = await queryAs(
      client,
      fixture.guardianAuthUserId,
      `select * from public.complete_guardian_invitation($1)`,
      [freshInvitationId],
    );
    assert(accepted.rows[0]?.status === "ACTIVE", "guardian invitation was not accepted");

    const membership = await client.query<{ role: string; status: string }>(
      `select fm.role::text, fm.status::text
       from public.family_memberships fm
       join public.principals p on p.id = fm.principal_id
       where fm.family_id = $1 and p.auth_user_id = $2`,
      [fixture.familyId, fixture.guardianAuthUserId],
    );
    assert(membership.rows.length === 1 && membership.rows[0]?.role === "GUARDIAN" && membership.rows[0]?.status === "ACTIVE", "accepted invitation did not create an active GUARDIAN membership");

    await expectSqlState(
      () => queryAs(
        client,
        fixture.guardianAuthUserId,
        `select * from public.bootstrap_parent_family('읽기 전용 보호자 가족', 'Asia/Seoul', null)`,
      ),
      ["42501"],
      "guardian-only parent workspace bootstrap",
    );

    const directChildren = await queryAs(
      client,
      fixture.guardianAuthUserId,
      "select id, display_name, avatar_url, status from public.child_profiles where family_id = $1",
      [fixture.familyId],
    );
    assert(directChildren.rows.length === 0, "guardian directly selected child_profiles");

    const directFamily = await queryAs(
      client,
      fixture.guardianAuthUserId,
      "select id, name, timezone from public.families where id = $1",
      [fixture.familyId],
    );
    assert(directFamily.rows.length === 0, "guardian directly selected the family row instead of the status projection");

    const directInvitations = await queryAs(
      client,
      fixture.guardianAuthUserId,
      "select id, email_masked from public.guardian_invitations where family_id = $1",
      [fixture.familyId],
    );
    assert(directInvitations.rows.length === 0, "guardian directly selected guardian invitation records");

    const status = await queryAs(
      client,
      fixture.guardianAuthUserId,
      "select * from public.guardian_family_status($1)",
      [fixture.familyId],
    );
    assert(
      status.rows.length === 1 && status.rows[0]?.child_display_name === null && status.rows[0]?.child_status === null,
      "pending child appeared in an active-only guardian status projection",
    );

    await client.query(
      `update public.child_profiles set status = 'UNLINKED', unlinked_at = now() where id = $1`,
      [fixture.childProfileId],
    );
    const guardedChildPrincipalId = await principalId(client, fixture.guardianAuthUserId);
    await client.query(
      `update public.child_profiles
       set principal_id = $2, status = 'ACTIVE', linked_at = now(), unlinked_at = null, avatar_url = '/manus-storage/guardian-fixture.png', avatar_storage_key = 'guardian-fixture.png', avatar_updated_at = now()
       where id = $1`,
      [fixture.childProfileId, guardedChildPrincipalId],
    );

    const projectedStatus = await queryAs(
      client,
      fixture.guardianAuthUserId,
      "select * from public.guardian_family_status($1)",
      [fixture.familyId],
    );
    const statusRow = projectedStatus.rows[0];
    assert(statusRow, "guardian status RPC did not return the active child");
    assert(statusRow.child_display_name === "상태 확인 자녀" && statusRow.child_avatar_url === "/manus-storage/guardian-fixture.png" && statusRow.child_status === "ACTIVE", "guardian status RPC projection is incomplete");
    assert(statusRow.current_score === null && statusRow.score_availability === "UNAVAILABLE_LEDGER_ABSENT", "guardian status exposed an unexpected score");

    const profileWrite = await queryAs(
      client,
      fixture.guardianAuthUserId,
      "update public.child_profiles set display_name = '권한 없는 변경' where id = $1",
      [fixture.childProfileId],
    );
    assert(profileWrite.rowCount === 0, "guardian updated child profile data");

    await expectSqlState(
      () => queryAs(
        client,
        fixture.guardianAuthUserId,
        `insert into public.child_profiles(family_id, display_name, status, created_by_principal_id)
         values ($1, '권한 없는 자녀', 'PENDING_LINK', public.current_principal_id())`,
        [fixture.familyId],
      ),
      ["42501"],
      "guardian child profile insert",
    );

    await expectSqlState(
      () => queryAs(
        client,
        fixture.guardianAuthUserId,
        `insert into public.auth_link_events(family_id, child_profile_id, principal_id, event_type)
         values ($1, $2, public.current_principal_id(), 'LINKED')`,
        [fixture.familyId, fixture.childProfileId],
      ),
      ["42501"],
      "guardian audit event insert",
    );

    await expectSqlState(
      () => queryAs(
        client,
        fixture.guardianAuthUserId,
        `insert into public.child_invitations(
           family_id, child_profile_id, invited_by_principal_id, email_fingerprint, email_masked, expires_at
         ) values ($1, $2, public.current_principal_id(), decode(repeat('00', 32), 'hex'), 'x***@example.test', now() + interval '1 day')`,
        [fixture.familyId, fixture.childProfileId],
      ),
      ["42501"],
      "guardian child invitation insert",
    );

    const ruleWriteRpc = await client.query<{ exists: boolean }>(
      `select to_regprocedure(
         'public.save_parent_rule_draft(uuid,text,public.activity_category_code,text,public.policy_measurement_kind,text,numeric,numeric,integer,integer)'
       ) is not null as exists`,
    );
    if (ruleWriteRpc.rows[0]?.exists) {
      await expectSqlState(
        () => queryAs(
          client,
          fixture.guardianAuthUserId,
          `select * from public.save_parent_rule_draft(
             $1,
             '권한 없는 보호자 규칙',
             'DAILY_STUDY'::public.activity_category_code,
             null,
             'PERCENT'::public.policy_measurement_kind,
             '완료율',
             20,
             80,
             10,
             10
           )`,
          [fixture.familyId],
        ),
        ["42501"],
        "guardian parent-rule write",
      );
    } else {
      console.log("Rule registry is not applied; rule-write denial is covered when its parent RPC is present.");
    }

    console.log("Guardian live RLS verification passed (all fixture writes rolled back).");
  } finally {
    try {
      await client.query("rollback");
    } finally {
      await client.end();
    }
  }
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  verifyGuardianLiveAccess().catch(error => {
    console.error(error instanceof Error ? error.message : "Guardian live RLS verification failed");
    process.exitCode = 1;
  });
}
