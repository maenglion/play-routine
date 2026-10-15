import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { getSupabaseConnectionString } from "../server/supabaseConnection";
import {
  createEmptyRoutinePayload,
  normalizeRoutinePayload,
  stableRoutineJson,
} from "../client/src/lib/routine-v2-form";

type Fixture = {
  familyId: string;
  parentAuthId: string;
  parentPrincipalId: string;
  childAuthId: string;
  childProfileId: string;
  guardianAuthId: string;
  otherAuthId: string;
};

type Json = Record<string, unknown>;

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

function asJson(value: unknown): Json {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    "RPC returns a JSON object, not a table-array shim"
  );
  return value as Json;
}

function jsonId(value: Json, field = "id") {
  const id = value[field];
  assert(
    typeof id === "string" && id.length > 0,
    `RPC result contains ${field}`
  );
  return id;
}

function iso(value: unknown) {
  return String(value).slice(0, 10);
}

async function setUser(client: Client, authUserId: string | null) {
  await client.query("reset role");
  await client.query(
    "select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', 'authenticated', true)",
    [authUserId ?? ""]
  );
  await client.query("set local role authenticated");
}

async function rejected(
  client: Client,
  sql: string,
  values: unknown[],
  expected: string,
  label: string
) {
  await client.query("savepoint expected_failure");
  let actual = "";
  try {
    await client.query(sql, values);
  } catch (error) {
    actual = sqlState(error);
  }
  await client.query("rollback to savepoint expected_failure");
  assert(
    actual === expected,
    `${label} (expected ${expected}, got ${actual || "success"})`
  );
}

async function addAuthUser(client: Client, email: string) {
  const id = randomUUID();
  await client.query(
    `insert into auth.users(
       id, aud, role, email, encrypted_password, email_confirmed_at,
       raw_app_meta_data, raw_user_meta_data, created_at, updated_at
     ) values ($1, 'authenticated', 'authenticated', $2, '', now(),
       '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now())`,
    [id, email]
  );
  return id;
}

async function principalId(client: Client, authUserId: string) {
  const result = await client.query<{ id: string }>(
    "select id from public.principals where auth_user_id=$1",
    [authUserId]
  );
  const id = result.rows[0]?.id;
  assert(id, "auth fixture bootstraps an application principal");
  return id;
}

async function createFixtures(client: Client): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 12);
  const parentAuthId = await addAuthUser(
    client,
    `routine-v2-parent-${suffix}@example.invalid`
  );
  const childAuthId = await addAuthUser(
    client,
    `routine-v2-child-${suffix}@example.invalid`
  );
  const guardianAuthId = await addAuthUser(
    client,
    `routine-v2-guardian-${suffix}@example.invalid`
  );
  const otherAuthId = await addAuthUser(
    client,
    `routine-v2-other-${suffix}@example.invalid`
  );

  await setUser(client, parentAuthId);
  const family = await client.query<{
    family_id: string;
    principal_id: string;
  }>(
    "select * from public.bootstrap_parent_family($1, 'Asia/Seoul', 'Routine v2 rollback parent')",
    [`Routine v2 rollback ${suffix}`]
  );
  const familyId = family.rows[0]?.family_id;
  const parentPrincipalId = family.rows[0]?.principal_id;
  assert(
    familyId && parentPrincipalId,
    "parent creates a rollback-only v2 family"
  );

  await client.query("reset role");
  const childPrincipalId = await principalId(client, childAuthId);
  const child = await client.query<{ id: string }>(
    `insert into public.child_profiles(
       family_id, principal_id, display_name, status, created_by_principal_id, linked_at
     ) values ($1, $2, 'Routine v2 rollback child', 'ACTIVE', $3, now()) returning id`,
    [familyId, childPrincipalId, parentPrincipalId]
  );
  const childProfileId = child.rows[0]?.id;
  assert(childProfileId, "linked active v2 child fixture exists");
  await client.query(
    `insert into public.family_memberships(family_id, principal_id, role, status, created_by_principal_id)
     values ($1, $2, 'CHILD', 'ACTIVE', $3)`,
    [familyId, childPrincipalId, parentPrincipalId]
  );

  await setUser(client, parentAuthId);
  const invitation = await client.query<{ invitation_id: string }>(
    "select * from public.create_guardian_invitation($1, $2)",
    [familyId, `routine-v2-guardian-${suffix}@example.invalid`]
  );
  assert(
    invitation.rows[0]?.invitation_id,
    "guardian fixture invitation is created without sending a real email"
  );
  await setUser(client, guardianAuthId);
  const guardian = await client.query<{ status: string }>(
    "select * from public.complete_guardian_invitation($1)",
    [invitation.rows[0]!.invitation_id]
  );
  assert(
    guardian.rows[0]?.status === "ACTIVE",
    "guardian fixture joins as an active read-only member"
  );

  return {
    familyId,
    parentAuthId,
    parentPrincipalId,
    childAuthId,
    childProfileId,
    guardianAuthId,
    otherAuthId,
  };
}

async function familyCalendar(client: Client, familyId: string) {
  const result = await client.query<{
    today: string;
    week_start: string;
    week_end: string;
    prior_week_start: string;
    prior_week_end: string;
    dow: number;
  }>(
    `select private.routine_family_today($1)::text as today,
       private.routine_period_start('WEEKLY'::public.routine_period, private.routine_family_today($1))::text as week_start,
       private.routine_period_end('WEEKLY'::public.routine_period, private.routine_family_today($1))::text as week_end,
       private.routine_period_start('WEEKLY'::public.routine_period, private.routine_family_today($1) - 7)::text as prior_week_start,
       private.routine_period_end('WEEKLY'::public.routine_period, private.routine_family_today($1) - 7)::text as prior_week_end,
       extract(isodow from private.routine_family_today($1))::int as dow`,
    [familyId]
  );
  const row = result.rows[0];
  assert(
    row?.today &&
      row.week_start &&
      row.week_end &&
      row.prior_week_start &&
      row.prior_week_end &&
      row.dow,
    "family-local v2 calendar is available"
  );
  return row;
}

function fullDailyPayload(name: string, wonId: string, minId: string) {
  return {
    schemaVersion: 1,
    flow: "DAILY",
    name,
    category: "DAILY_STUDY",
    childLabel: "숙제 도장",
    criteria: "부모가 수행 여부를 확인합니다.",
    stickerIcon: "STAR",
    measurement: "STICKER",
    period: "WEEKLY",
    penaltyLimit: null,
    penaltyMinutes: 0,
    tiers: [
      {
        id: randomUUID(),
        label: "기본 5개",
        threshold: 5,
        operator: "GTE",
        rewards: [
          { id: randomUUID(), reinforcerId: wonId, amount: 1000, text: "" },
        ],
      },
      {
        id: randomUUID(),
        label: "추가 8개",
        threshold: 8,
        operator: "GTE",
        rewards: [
          { id: randomUUID(), reinforcerId: wonId, amount: 2000, text: "" },
          { id: randomUUID(), reinforcerId: minId, amount: 30, text: "" },
        ],
      },
    ],
  };
}

function fullQuestPayload(name: string, wonId: string, minId: string) {
  return {
    ...createEmptyRoutinePayload("QUEST"),
    schemaVersion: 1,
    flow: "QUEST",
    name,
    category: "DAILY_STUDY",
    childLabel: "시험 결과",
    criteria: "부모가 점수를 확인합니다.",
    stickerIcon: "STAMP",
    measurement: "PERCENT",
    penaltyLimit: null,
    penaltyMinutes: 0,
    tiers: [
      {
        id: randomUUID(),
        label: "90점 초과",
        threshold: 90,
        operator: "GT",
        rewards: [
          { id: randomUUID(), reinforcerId: wonId, amount: 3000, text: "" },
          { id: randomUUID(), reinforcerId: minId, amount: 45, text: "" },
        ],
      },
    ],
  };
}

function partialPayload() {
  return {
    schemaVersion: 1,
    flow: "DAILY",
    name: "",
    category: "DAILY_STUDY",
    childLabel: "",
    criteria: "",
    stickerIcon: "STAR",
    measurement: "STICKER",
    period: "WEEKLY",
    penaltyLimit: null,
    penaltyMinutes: 0,
    tiers: [
      {
        id: "",
        label: "",
        threshold: null,
        operator: "",
        rewards: [{ id: "", reinforcerId: "", amount: "", text: "" }],
      },
    ],
  };
}

async function saveDraft(
  client: Client,
  familyId: string,
  draftId: string | null,
  payload: unknown,
  revision: number,
  sourceRuleId: string | null = null
) {
  const result = await client.query<{ save_routine_draft: Json }>(
    "select public.save_routine_draft($1,$2,$3,$4,$5::jsonb,$6,$7) as save_routine_draft",
    [
      familyId,
      draftId,
      sourceRuleId,
      1,
      JSON.stringify(payload),
      revision,
      randomUUID(),
    ]
  );
  return asJson(result.rows[0]?.save_routine_draft);
}

async function publishDraft(client: Client, draftId: string, revision: number) {
  const result = await client.query<{ publish_routine_draft: Json }>(
    "select public.publish_routine_draft($1,$2,$3) as publish_routine_draft",
    [draftId, revision, randomUUID()]
  );
  return asJson(result.rows[0]?.publish_routine_draft);
}

async function listDay(client: Client, childId: string, date: string) {
  const result = await client.query<{ list_routine_day: unknown }>(
    "select public.list_routine_day($1,$2::date) as list_routine_day",
    [childId, date]
  );
  const rows = result.rows[0]?.list_routine_day;
  assert(Array.isArray(rows), "day RPC returns a JSON array");
  return rows as Json[];
}

async function listEntitlements(client: Client, childId: string) {
  const result = await client.query<{ list_routine_entitlements: unknown }>(
    "select public.list_routine_entitlements($1) as list_routine_entitlements",
    [childId]
  );
  const rows = result.rows[0]?.list_routine_entitlements;
  assert(Array.isArray(rows), "entitlement RPC returns a JSON array");
  return rows as Json[];
}

async function verify(
  client: Client,
  occurrenceId: string,
  score: number | null,
  pass: boolean | null,
  praise: boolean,
  reason: string,
  revision: number,
  key = randomUUID()
) {
  const result = await client.query<{ verify_routine_occurrence: Json }>(
    "select public.verify_routine_occurrence($1,$2,$3,$4,$5,$6,$7) as verify_routine_occurrence",
    [occurrenceId, score, pass, praise, reason, revision, key]
  );
  return { value: asJson(result.rows[0]?.verify_routine_occurrence), key };
}

/**
 * Real Supabase verification after migrations 0017 and 0018 have been applied. It never applies
 * migrations, sends no mail, never reads existing user fixtures, and rolls back all inserted auth,
 * family, rule, assignment, occurrence, and entitlement rows in finally.
 */
export async function verifyRoutineV2Live() {
  const client = new Client({
    connectionString: getSupabaseConnectionString(),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
  });

  try {
    await client.connect();
    await client.query("begin");
    await client.query(
      "select pg_advisory_xact_lock(hashtext('play-routine-live-fixtures'))"
    );

    const ready = await client.query<{ ready: boolean }>(
      `select to_regprocedure('public.save_routine_draft(uuid,uuid,uuid,integer,jsonb,integer,uuid)') is not null
          and to_regprocedure('public.publish_routine_draft(uuid,integer,uuid)') is not null
          and to_regprocedure('public.create_routine_assignment(uuid,uuid,uuid,date,date,integer[],text,uuid)') is not null
          and to_regprocedure('public.verify_routine_occurrence(uuid,numeric,boolean,boolean,text,integer,uuid)') is not null
          and to_regprocedure('public.confirm_routine_period(uuid,uuid,date,uuid)') is not null
          and to_regprocedure('public.fulfill_routine_entitlement(uuid,uuid)') is not null
          and to_regprocedure('private.guard_cross_registry_assignment()') is not null
          and exists (select 1 from pg_trigger where tgname='cross_registry_assignment_guard' and not tgisinternal) as ready`
    );
    assert(
      ready.rows[0]?.ready,
      "0017/0018 are applied before v2 live verification (the script never applies migrations)"
    );

    const fixture = await createFixtures(client);
    await client.query("reset role");
    const calendar = await familyCalendar(client, fixture.familyId);
    const tomorrow = await client.query<{ d: string }>(
      "select (private.routine_family_today($1)+1)::text d",
      [fixture.familyId]
    );
    const futureDate = tomorrow.rows[0]?.d;
    assert(futureDate, "family-local next assignment date is available");

    await setUser(client, fixture.parentAuthId);
    const won = asJson(
      (
        await client.query<{ value: Json }>(
          "select public.create_routine_reinforcer($1,'용돈','WON','원',$2) as value",
          [fixture.familyId, randomUUID()]
        )
      ).rows[0]?.value
    );
    const min = asJson(
      (
        await client.query<{ value: Json }>(
          "select public.create_routine_reinforcer($1,'게임 시간','MIN','분',$2) as value",
          [fixture.familyId, randomUUID()]
        )
      ).rows[0]?.value
    );
    const stringReward = asJson(
      (
        await client.query<{ value: Json }>(
          "select public.create_routine_reinforcer($1,'소원','STRING','내용',$2) as value",
          [fixture.familyId, randomUUID()]
        )
      ).rows[0]?.value
    );
    const wonId = jsonId(won);
    const minId = jsonId(min);
    assert(
      won.unit === "WON" &&
        min.unit === "MIN" &&
        stringReward.unit === "STRING",
      "immutable family reinforcer catalogue preserves explicit units"
    );
    await rejected(
      client,
      "update public.routine_reinforcers set name='client bypass' where id=$1",
      [wonId],
      "42501",
      "authenticated parent has no raw immutable-catalogue write privilege"
    );
    await client.query("reset role");
    await rejected(
      client,
      "update public.routine_reinforcers set name='privileged bypass' where id=$1",
      [wonId],
      "55000",
      "immutable-catalogue trigger blocks direct privileged mutation"
    );
    await setUser(client, fixture.parentAuthId);
    const reinforcers = await client.query<{ value: unknown }>(
      "select public.list_routine_reinforcers($1) as value",
      [fixture.familyId]
    );
    assert(
      Array.isArray(reinforcers.rows[0]?.value) &&
        reinforcers.rows[0]!.value.length === 3,
      "parent lists three catalogue entries through JSON-array RPC"
    );
    await rejected(
      client,
      "select public.create_routine_reinforcer($1,'bad','WON','',$2)",
      [fixture.familyId, randomUUID()],
      "22023",
      "catalogue rejects a missing/blank unit label only when invalid"
    );
    await setUser(client, fixture.otherAuthId);
    const otherFamily = await client.query<{ family_id: string }>(
      "select * from public.bootstrap_parent_family('Routine v2 other family', 'Asia/Seoul')"
    );
    const otherFamilyId = otherFamily.rows[0]?.family_id;
    assert(
      otherFamilyId,
      "separate rollback-only family exists for catalogue-family isolation"
    );
    const foreignWon = asJson(
      (
        await client.query<{ value: Json }>(
          "select public.create_routine_reinforcer($1,'외부 용돈','WON','원',$2) as value",
          [otherFamilyId, randomUUID()]
        )
      ).rows[0]?.value
    );
    await setUser(client, fixture.parentAuthId);

    // UI 자체의 기본값을 그대로 저장·게시한다. 손으로 period='DAILY'를 넣으면 실제 UI 오류를 놓친다.
    const browserQuest = createEmptyRoutinePayload("QUEST");
    Object.assign(browserQuest, {
      name: `UI Quest ${randomUUID().slice(0, 8)}`,
      childLabel: "Quest 확인",
      criteria: "부모가 수행 건의 점수를 확인합니다.",
      measurement: "QUANTITY",
      penaltyLimit: 60,
      penaltyMinutes: 80,
    });
    browserQuest.tiers[0]!.threshold = 80;
    browserQuest.tiers[0]!.rewards = [
      { id: randomUUID(), reinforcerId: minId, amount: 120, text: "" },
    ];
    assert(
      browserQuest.period === "DAILY",
      "UI factory gives QUANTITY Quest a per-occurrence period without hidden weekly metadata"
    );
    const browserSaved = await saveDraft(
      client,
      fixture.familyId,
      null,
      browserQuest,
      0
    );
    const browserPublished = await publishDraft(
      client,
      jsonId(browserSaved),
      Number(browserSaved.revision)
    );
    assert(
      asJson(browserPublished.payload).period === "DAILY" &&
        asJson(browserPublished.payload).measurement === "QUANTITY",
      "UI-created Quest with 60/80/80/120 inputs publishes through actual RPC"
    );
    const legacyQuest = {
      ...browserQuest,
      name: `Old UI Quest ${randomUUID().slice(0, 8)}`,
      period: "WEEKLY" as const,
    };
    const legacySaved = await saveDraft(
      client,
      fixture.familyId,
      null,
      legacyQuest,
      0
    );
    await rejected(
      client,
      "select public.publish_routine_draft($1,0,$2)",
      [jsonId(legacySaved), randomUUID()],
      "22023",
      "legacy UI weekly Quest is rejected without weakening server invariants"
    );
    const repairedQuest = normalizeRoutinePayload(legacyQuest);
    assert(
      stableRoutineJson({ ...repairedQuest, period: legacyQuest.period }) ===
        stableRoutineJson(legacyQuest),
      "legacy draft normalization changes only the hidden period and preserves all inputs"
    );
    const repairedSaved = await saveDraft(
      client,
      fixture.familyId,
      jsonId(legacySaved),
      repairedQuest,
      Number(legacySaved.revision)
    );
    assert(
      jsonId(repairedSaved) === jsonId(legacySaved) &&
        Number(repairedSaved.revision) === Number(legacySaved.revision) + 1,
      "legacy repair saves the same draft with revision CAS rather than making a duplicate"
    );
    const repairedPublished = await publishDraft(
      client,
      jsonId(repairedSaved),
      Number(repairedSaved.revision)
    );
    assert(
      asJson(repairedPublished.payload).period === "DAILY",
      "repaired old Quest publishes successfully with original reward and thresholds"
    );

    const partial = partialPayload();
    const partialKey = randomUUID();
    const partialSaved = asJson(
      (
        await client.query<{ value: Json }>(
          "select public.save_routine_draft($1,null,null,1,$2::jsonb,0,$3) as value",
          [fixture.familyId, JSON.stringify(partial), partialKey]
        )
      ).rows[0]?.value
    );
    const partialDraftId = jsonId(partialSaved);
    assert(
      partialSaved.revision === 0 && partialSaved.status === "DRAFT",
      "stage-one empty draft saves typed NULL/blank threshold, blank reinforcer, and blank amount"
    );
    const partialReplay = asJson(
      (
        await client.query<{ value: Json }>(
          "select public.save_routine_draft($1,null,null,1,$2::jsonb,0,$3) as value",
          [fixture.familyId, JSON.stringify(partial), partialKey]
        )
      ).rows[0]?.value
    );
    assert(
      jsonId(partialReplay) === partialDraftId && partialReplay.revision === 0,
      "exact partial-draft idempotency replay returns the original draft"
    );
    await rejected(
      client,
      "select public.save_routine_draft($1,null,null,null,$2::jsonb,0,$3)",
      [fixture.familyId, JSON.stringify(partial), randomUUID()],
      "22023",
      "draft save explicitly rejects a NULL wizard step"
    );
    await rejected(
      client,
      "select public.save_routine_draft($1,null,null,1,$2::jsonb,0,$3)",
      [
        fixture.familyId,
        JSON.stringify({ ...partial, unexpected: true }),
        randomUUID(),
      ],
      "22023",
      "draft save rejects an unknown top-level field"
    );
    await rejected(
      client,
      "select public.save_routine_draft($1,null,null,1,$2::jsonb,0,$3)",
      [
        fixture.familyId,
        JSON.stringify({
          ...partial,
          tiers: [{ ...partial.tiers[0], unknown: true }],
        }),
        randomUUID(),
      ],
      "22023",
      "draft save rejects an unknown nested tier field"
    );
    await rejected(
      client,
      "select public.publish_routine_draft($1,0,$2)",
      [partialDraftId, randomUUID()],
      "22023",
      "partial draft cannot publish before required text, tiers, and rewards are completed"
    );
    const resumedPartial = await saveDraft(
      client,
      fixture.familyId,
      partialDraftId,
      partial,
      0
    );
    assert(
      resumedPartial.revision === 1,
      "partial draft resumes through revision-CAS without requiring completed fields"
    );
    await rejected(
      client,
      "select public.save_routine_draft($1,$2,null,1,$3::jsonb,0,$4)",
      [fixture.familyId, partialDraftId, JSON.stringify(partial), randomUUID()],
      "40001",
      "partial draft rejects a stale revision-CAS update"
    );

    const invalidThree = fullDailyPayload(
      `Too many rewards ${randomUUID().slice(0, 6)}`,
      wonId,
      minId
    );
    invalidThree.tiers[0]!.rewards.push({
      id: randomUUID(),
      reinforcerId: wonId,
      amount: 1,
      text: "",
    });
    invalidThree.tiers[0]!.rewards.push({
      id: randomUUID(),
      reinforcerId: minId,
      amount: 1,
      text: "",
    });
    await rejected(
      client,
      "select public.save_routine_draft($1,null,null,2,$2::jsonb,0,$3)",
      [fixture.familyId, JSON.stringify(invalidThree), randomUUID()],
      "22023",
      "one condition rejects a third reward slot even for a draft"
    );
    const invalidGt = fullQuestPayload(
      `Impossible GT ${randomUUID().slice(0, 6)}`,
      wonId,
      minId
    );
    invalidGt.tiers[0]!.threshold = 100;
    const invalidGtDraft = await saveDraft(
      client,
      fixture.familyId,
      null,
      invalidGt,
      0
    );
    await rejected(
      client,
      "select public.publish_routine_draft($1,0,$2)",
      [jsonId(invalidGtDraft), randomUUID()],
      "22023",
      "QUEST rejects impossible >100 condition at publication"
    );
    const invalidPenalty = fullQuestPayload(
      `Impossible penalty ${randomUUID().slice(0, 6)}`,
      wonId,
      minId
    );
    invalidPenalty.penaltyLimit = 0;
    invalidPenalty.penaltyMinutes = 10;
    const invalidPenaltyDraft = await saveDraft(
      client,
      fixture.familyId,
      null,
      invalidPenalty,
      0
    );
    await rejected(
      client,
      "select public.publish_routine_draft($1,0,$2)",
      [jsonId(invalidPenaltyDraft), randomUUID()],
      "22023",
      "QUEST rejects an impossible below-zero penalty with limit 0 and nonzero minutes"
    );
    const invalidMin = fullQuestPayload(
      `Long minutes ${randomUUID().slice(0, 6)}`,
      wonId,
      minId
    );
    invalidMin.tiers[0]!.rewards[1]!.amount = 241;
    const invalidMinDraft = await saveDraft(
      client,
      fixture.familyId,
      null,
      invalidMin,
      0
    );
    await rejected(
      client,
      "select public.publish_routine_draft($1,0,$2)",
      [jsonId(invalidMinDraft), randomUUID()],
      "22023",
      "numeric MIN reward preserves the existing 240-minute per-action maximum"
    );
    const foreignCatalogue = fullQuestPayload(
      `Foreign catalogue ${randomUUID().slice(0, 6)}`,
      jsonId(foreignWon),
      minId
    );
    const foreignCatalogueDraft = await saveDraft(
      client,
      fixture.familyId,
      null,
      foreignCatalogue,
      0
    );
    await rejected(
      client,
      "select public.publish_routine_draft($1,0,$2)",
      [jsonId(foreignCatalogueDraft), randomUUID()],
      "22023",
      "publication rejects a reinforcer from another family's immutable catalogue"
    );

    const dailyName = `Daily stickers ${randomUUID().slice(0, 8)}`;
    const dailySaved = await saveDraft(
      client,
      fixture.familyId,
      null,
      fullDailyPayload(dailyName, wonId, minId),
      0
    );
    const dailyDraftId = jsonId(dailySaved);
    const dailyRule = await publishDraft(
      client,
      dailyDraftId,
      Number(dailySaved.revision)
    );
    const dailyRuleId = jsonId(dailyRule);
    assert(
      dailyRule.name === dailyName &&
        dailyRule.version === 1 &&
        iso(dailyRule.effective_from) === futureDate,
      "completed DAILY draft publishes immutable version 1 effective tomorrow"
    );
    await rejected(
      client,
      "update public.routine_rules set name='client bypass' where id=$1",
      [dailyRuleId],
      "42501",
      "authenticated parent has no raw published-rule update privilege"
    );
    await client.query("reset role");
    await rejected(
      client,
      "update public.routine_rules set name='root bypass' where id=$1",
      [dailyRuleId],
      "55000",
      "published rule trigger prevents direct privileged mutation"
    );

    await setUser(client, fixture.parentAuthId);
    const dailyAssignment = asJson(
      (
        await client.query<{ value: Json }>(
          "select public.create_routine_assignment($1,$2,$3,$4::date,$4::date,array[1,2,3,4,5,6,7]::int[],'DAILY',$5) as value",
          [
            fixture.familyId,
            dailyRuleId,
            fixture.childProfileId,
            futureDate,
            randomUUID(),
          ]
        )
      ).rows[0]?.value
    );
    assert(
      dailyAssignment.rule_id === dailyRuleId &&
        dailyAssignment.repeat === "DAILY",
      "parent creates a future v2 assignment through its RPC"
    );
    await rejected(
      client,
      "select public.confirm_routine_period($1,$2,$3::date,$4)",
      [fixture.childProfileId, dailyRuleId, calendar.today, randomUUID()],
      "22023",
      "current unclosed DAILY period cannot issue rewards"
    );
    await setUser(client, fixture.childAuthId);
    await rejected(
      client,
      "select public.list_routine_day($1,$2::date)",
      [fixture.childProfileId, futureDate],
      "42501",
      "child cannot materialize or view a future routine day"
    );
    await setUser(client, fixture.parentAuthId);
    await rejected(
      client,
      "select public.create_routine_assignment($1,$2,$3,$4::date,$4::date,array[1]::int[],'DAILY',$5)",
      [
        fixture.familyId,
        dailyRuleId,
        fixture.childProfileId,
        calendar.today,
        randomUUID(),
      ],
      "22023",
      "routine assignment cannot begin today or in the past"
    );

    // Backdating is fixture-only, occurs under the privileged connection while the immutable trigger
    // is disabled, and the outer transaction always rolls it back. The prior Mon-Sun week is
    // closed in every timezone, so it exercises the actual close-period gate without waiting.
    await client.query("reset role");
    await client.query(
      "alter table public.routine_rules disable trigger routine_rules_immutable"
    );
    try {
      await client.query(
        "update public.routine_rules set effective_from=$2::date where id=$1",
        [dailyRuleId, calendar.prior_week_start]
      );
    } finally {
      await client.query(
        "alter table public.routine_rules enable trigger routine_rules_immutable"
      );
    }
    await client.query(
      `insert into public.routine_assignments(family_id,rule_id,child_profile_id,starts_on,ends_on,weekdays,repeat_kind,created_by_principal_id)
       values ($1,$2,$3,$4::date,$5::date,array[1,2,3,4,5,6,7]::int[],'DAILY',$6)`,
      [
        fixture.familyId,
        dailyRuleId,
        fixture.childProfileId,
        calendar.prior_week_start,
        calendar.prior_week_end,
        fixture.parentPrincipalId,
      ]
    );
    assert(
      true,
      "rollback fixture directly schedules the backdated published DAILY rule for a closed prior week"
    );

    await setUser(client, fixture.childAuthId);
    const monday = calendar.prior_week_start;
    let dailyDay = await listDay(client, fixture.childProfileId, monday);
    let dailyOccurrence = dailyDay.find(row => row.rule_id === dailyRuleId);
    assert(
      dailyOccurrence?.verification_status === "MISSING" &&
        dailyOccurrence.stickers === null &&
        Number(dailyOccurrence.sticker_total) === 0,
      "unverified DAILY occurrence is missing/hold-compatible, never zero stickers"
    );
    const dailyOccurrenceId = String(dailyOccurrence?.id);
    const reportKey = randomUUID();
    const reported = asJson(
      (
        await client.query<{ value: Json }>(
          "select public.report_routine_done($1,$2,$3) as value",
          [dailyOccurrenceId, dailyOccurrence?.revision, reportKey]
        )
      ).rows[0]?.value
    );
    assert(
      reported.ok === true,
      "child reports the actual scheduled DAILY occurrence through RPC"
    );
    const reportReplay = asJson(
      (
        await client.query<{ value: Json }>(
          "select public.report_routine_done($1,$2,$3) as value",
          [dailyOccurrenceId, dailyOccurrence?.revision, reportKey]
        )
      ).rows[0]?.value
    );
    assert(
      reportReplay.ok === true,
      "child done-report exact replay is idempotent"
    );
    dailyDay = await listDay(client, fixture.childProfileId, monday);
    dailyOccurrence = dailyDay.find(row => row.rule_id === dailyRuleId);
    assert(
      dailyOccurrence?.verification_status === "HELD" &&
        dailyOccurrence.stickers === null,
      "child report remains HELD with null stickers until parent verification"
    );
    await rejected(
      client,
      "select public.verify_routine_occurrence($1,null,true,false,'child cannot verify',$2,$3)",
      [dailyOccurrenceId, dailyOccurrence?.revision, randomUUID()],
      "42501",
      "child cannot parent-verify a v2 occurrence"
    );

    await setUser(client, fixture.parentAuthId);
    await verify(
      client,
      dailyOccurrenceId,
      null,
      true,
      false,
      "Monday PASS confirmed",
      Number(dailyOccurrence!.revision)
    );
    await rejected(
      client,
      "select public.verify_routine_occurrence($1,null,true,false,'stale parent revision',$2,$3)",
      [dailyOccurrenceId, dailyOccurrence?.revision, randomUUID()],
      "40001",
      "parent verification retains optimistic revision CAS after a successful write"
    );
    const passDates = await client.query<{ d: string }>(
      "select (generate_series($1::date + 1, $1::date + 4, interval '1 day'))::date::text d",
      [calendar.prior_week_start]
    );
    for (const row of passDates.rows) {
      const rows = await listDay(client, fixture.childProfileId, row.d);
      const occurrence = rows.find(value => value.rule_id === dailyRuleId);
      assert(
        occurrence?.id,
        `scheduled DAILY occurrence materializes for ${row.d}`
      );
      await verify(
        client,
        String(occurrence!.id),
        null,
        true,
        false,
        "weekly PASS confirmed",
        Number(occurrence!.revision)
      );
    }
    dailyDay = await listDay(
      client,
      fixture.childProfileId,
      calendar.prior_week_end
    );
    const sundayDaily = dailyDay.find(row => row.rule_id === dailyRuleId);
    assert(
      Number(sundayDaily?.sticker_total) === 5,
      "five verified base PASS records produce exactly five weekly stickers"
    );

    const closedReference = passDates.rows.at(-1)!.d;
    const periodKey = randomUUID();
    const periodFirst = asJson(
      (
        await client.query<{ value: Json }>(
          "select public.confirm_routine_period($1,$2,$3::date,$4) as value",
          [fixture.childProfileId, dailyRuleId, closedReference, periodKey]
        )
      ).rows[0]?.value
    );
    assert(
      periodFirst.ok === true && Number(periodFirst.issued) === 1,
      "closed week at exactly 5 stickers issues only the base condition's one reward"
    );
    const periodReplay = asJson(
      (
        await client.query<{ value: Json }>(
          "select public.confirm_routine_period($1,$2,$3::date,$4) as value",
          [fixture.childProfileId, dailyRuleId, closedReference, periodKey]
        )
      ).rows[0]?.value
    );
    assert(
      Number(periodReplay.issued) === 1,
      "closed-period exact replay returns original issuance result"
    );
    let entitlements = await listEntitlements(client, fixture.childProfileId);
    let dailyEntitlements = entitlements.filter(
      row => row.rule_id === dailyRuleId
    );
    assert(
      dailyEntitlements.length === 1 &&
        dailyEntitlements[0]?.status === "AVAILABLE",
      "base entitlement is present exactly once and is not a money transfer"
    );
    const baseEntitlementId = String(dailyEntitlements[0]?.id);
    await client.query("select public.fulfill_routine_entitlement($1,$2)", [
      baseEntitlementId,
      randomUUID(),
    ]);
    assert(
      (await listEntitlements(client, fixture.childProfileId)).find(
        row => row.id === baseEntitlementId
      )?.status === "FULFILLED",
      "parent may record base fulfillment without creating a payment transfer"
    );

    const correctionRows = await listDay(
      client,
      fixture.childProfileId,
      passDates.rows[0]!.d
    );
    const correctionOccurrence = correctionRows.find(
      row => row.rule_id === dailyRuleId
    )!;
    await verify(
      client,
      String(correctionOccurrence.id),
      null,
      false,
      false,
      "performance corrected",
      Number(correctionOccurrence.revision)
    );
    entitlements = await listEntitlements(client, fixture.childProfileId);
    assert(
      entitlements.find(row => row.id === baseEntitlementId)?.status ===
        "FULFILLED" &&
        entitlements.find(row => row.id === baseEntitlementId)
          ?.requires_review === true,
      "5-to-4 DAILY correction never erases a fulfilled reward and flags review"
    );

    const restoreOccurrence = (
      await listDay(client, fixture.childProfileId, passDates.rows[0]!.d)
    ).find(row => row.rule_id === dailyRuleId)!;
    await verify(
      client,
      String(restoreOccurrence.id),
      null,
      true,
      false,
      "performance restored",
      Number(restoreOccurrence.revision)
    );
    const restoredPeriod = asJson(
      (
        await client.query<{ value: Json }>(
          "select public.confirm_routine_period($1,$2,$3::date,$4) as value",
          [fixture.childProfileId, dailyRuleId, closedReference, randomUUID()]
        )
      ).rows[0]?.value
    );
    assert(
      Number(restoredPeriod.issued) === 0,
      "5 restored after correction does not duplicate the already-issued base entitlement"
    );
    entitlements = await listEntitlements(client, fixture.childProfileId);
    assert(
      entitlements.filter(row => row.rule_id === dailyRuleId).length === 1 &&
        entitlements.find(row => row.id === baseEntitlementId)
          ?.requires_review === false,
      "5 restored clears review on the same fulfilled DAILY entitlement ID"
    );
    await client.query("reset role");
    const dailyResolutionEvents = await client.query<{ n: number }>(
      "select count(*)::int as n from public.routine_entitlement_events where entitlement_id=$1 and event_kind='REVIEW_RESOLVED'",
      [baseEntitlementId]
    );
    assert(
      Number(dailyResolutionEvents.rows[0]?.n) === 1,
      "DAILY restoration appends REVIEW_RESOLVED audit rather than a replacement payment"
    );
    await setUser(client, fixture.parentAuthId);

    for (const offset of [5, 6]) {
      const dateRows = await client.query<{ d: string }>(
        "select ($1::date + $2::integer)::text d",
        [calendar.prior_week_start, offset]
      );
      const rows = await listDay(
        client,
        fixture.childProfileId,
        dateRows.rows[0]!.d
      );
      const occurrence = rows.find(row => row.rule_id === dailyRuleId)!;
      await verify(
        client,
        String(occurrence.id),
        null,
        true,
        false,
        "weekend PASS confirmed",
        Number(occurrence.revision)
      );
    }
    const praiseNow = (
      await listDay(client, fixture.childProfileId, passDates.rows[0]!.d)
    ).find(row => row.rule_id === dailyRuleId)!;
    await verify(
      client,
      String(praiseNow.id),
      null,
      true,
      true,
      "praise sticker added",
      Number(praiseNow.revision)
    );
    const afterPraise = (
      await listDay(client, fixture.childProfileId, calendar.prior_week_end)
    ).find(row => row.rule_id === dailyRuleId);
    assert(
      Number(afterPraise?.sticker_total) === 8,
      "PASS+praise with weekend PASS records produces the additional eight-sticker tier"
    );
    const periodSecond = asJson(
      (
        await client.query<{ value: Json }>(
          "select public.confirm_routine_period($1,$2,$3::date,$4) as value",
          [fixture.childProfileId, dailyRuleId, closedReference, randomUUID()]
        )
      ).rows[0]?.value
    );
    assert(
      Number(periodSecond.issued) === 2,
      "8 stickers atomically issues both independent rewards attached to the additional condition"
    );
    entitlements = await listEntitlements(client, fixture.childProfileId);
    dailyEntitlements = entitlements.filter(row => row.rule_id === dailyRuleId);
    assert(
      dailyEntitlements.length === 3,
      "5/8 progression preserves original base and adds exactly two high-tier entitlements"
    );

    const extraEntitlements = dailyEntitlements.filter(
      row => Number(row.amount) === 2000 || Number(row.amount) === 30
    );
    assert(
      extraEntitlements.length === 2 &&
        extraEntitlements.every(row => row.status === "AVAILABLE"),
      "same condition's two reward slots are separate available entitlements, not a user choice"
    );
    const firstExtraId = String(extraEntitlements[0]?.id);
    const secondExtraId = String(extraEntitlements[1]?.id);
    const fulfillKey = randomUUID();
    const fulfilled = asJson(
      (
        await client.query<{ value: Json }>(
          "select public.fulfill_routine_entitlement($1,$2) as value",
          [firstExtraId, fulfillKey]
        )
      ).rows[0]?.value
    );
    assert(
      fulfilled.ok === true,
      "parent independently fulfills one of two same-condition entitlements"
    );
    const fulfillReplay = asJson(
      (
        await client.query<{ value: Json }>(
          "select public.fulfill_routine_entitlement($1,$2) as value",
          [firstExtraId, fulfillKey]
        )
      ).rows[0]?.value
    );
    assert(
      fulfillReplay.ok === true,
      "entitlement fulfillment exact replay is idempotent"
    );
    entitlements = await listEntitlements(client, fixture.childProfileId);
    assert(
      entitlements.find(row => row.id === firstExtraId)?.status ===
        "FULFILLED" &&
        entitlements.find(row => row.id === secondExtraId)?.status ===
          "AVAILABLE",
      "fulfilling one reward neither fulfills nor consumes the sibling reward"
    );

    const lowerExtra = (
      await listDay(client, fixture.childProfileId, passDates.rows[0]!.d)
    ).find(row => row.rule_id === dailyRuleId)!;
    await verify(
      client,
      String(lowerExtra.id),
      null,
      true,
      false,
      "praise corrected",
      Number(lowerExtra.revision)
    );
    entitlements = await listEntitlements(client, fixture.childProfileId);
    assert(
      entitlements.find(row => row.id === firstExtraId)?.status ===
        "FULFILLED" &&
        entitlements.find(row => row.id === firstExtraId)?.requires_review ===
          true,
      "8-to-7 DAILY correction preserves a fulfilled high-tier reward and flags review"
    );
    assert(
      entitlements.find(row => row.id === secondExtraId)?.status ===
        "AVAILABLE" &&
        entitlements.find(row => row.id === secondExtraId)?.requires_review ===
          true,
      "8-to-7 DAILY correction flags the unpaid sibling for review rather than auto-fulfilling it"
    );
    await rejected(
      client,
      "select public.fulfill_routine_entitlement($1,$2)",
      [secondExtraId, randomUUID()],
      "22023",
      "review-required DAILY entitlement cannot be automatically fulfilled"
    );

    const questName = `Quest score ${randomUUID().slice(0, 8)}`;
    const questSaved = await saveDraft(
      client,
      fixture.familyId,
      null,
      fullQuestPayload(questName, wonId, minId),
      0
    );
    const questRule = await publishDraft(
      client,
      jsonId(questSaved),
      Number(questSaved.revision)
    );
    const questRuleId = jsonId(questRule);
    assert(
      questRule.version === 1 && questRule.name === questName,
      "QUEST with exactly two rewards publishes without requiring a duplicate activity"
    );
    await client.query("reset role");
    await client.query(
      "alter table public.routine_rules disable trigger routine_rules_immutable"
    );
    try {
      await client.query(
        "update public.routine_rules set effective_from=$2::date where id=$1",
        [questRuleId, calendar.today]
      );
    } finally {
      await client.query(
        "alter table public.routine_rules enable trigger routine_rules_immutable"
      );
    }
    await client.query(
      `insert into public.routine_assignments(family_id,rule_id,child_profile_id,starts_on,ends_on,weekdays,repeat_kind,created_by_principal_id)
       values ($1,$2,$3,$4::date,$4::date,array[$5]::int[],'ONCE',$6)`,
      [
        fixture.familyId,
        questRuleId,
        fixture.childProfileId,
        calendar.today,
        calendar.dow,
        fixture.parentPrincipalId,
      ]
    );
    await setUser(client, fixture.childAuthId);
    const todayRows = await listDay(
      client,
      fixture.childProfileId,
      calendar.today
    );
    let questOccurrence = todayRows.find(row => row.rule_id === questRuleId);
    assert(
      questOccurrence?.flow === "QUEST" &&
        questOccurrence.verification_status === "MISSING",
      "actual current-day QUEST occurrence materializes for its own date"
    );
    await setUser(client, fixture.parentAuthId);
    await verify(
      client,
      String(questOccurrence!.id),
      90,
      null,
      false,
      "90점은 초과가 아닙니다",
      Number(questOccurrence!.revision)
    );
    entitlements = await listEntitlements(client, fixture.childProfileId);
    assert(
      entitlements.filter(row => row.rule_id === questRuleId).length === 0,
      "QUEST >90 does not issue entitlement at exactly 90"
    );
    questOccurrence = (
      await listDay(client, fixture.childProfileId, calendar.today)
    ).find(row => row.rule_id === questRuleId)!;
    await verify(
      client,
      String(questOccurrence.id),
      91,
      null,
      false,
      "91점 확인",
      Number(questOccurrence.revision)
    );
    entitlements = await listEntitlements(client, fixture.childProfileId);
    const questEntitlements = entitlements.filter(
      row => row.rule_id === questRuleId
    );
    assert(
      questEntitlements.length === 2 &&
        questEntitlements.every(row => row.status === "AVAILABLE"),
      "QUEST >90 atomically creates both condition rewards for one occurrence"
    );
    const questFirstId = String(questEntitlements[0]?.id);
    const questSecondId = String(questEntitlements[1]?.id);
    await client.query("select public.fulfill_routine_entitlement($1,$2)", [
      questFirstId,
      randomUUID(),
    ]);
    entitlements = await listEntitlements(client, fixture.childProfileId);
    assert(
      entitlements.find(row => row.id === questFirstId)?.status ===
        "FULFILLED" &&
        entitlements.find(row => row.id === questSecondId)?.status ===
          "AVAILABLE",
      "QUEST money/time outcomes remain independently fulfillable"
    );
    questOccurrence = (
      await listDay(client, fixture.childProfileId, calendar.today)
    ).find(row => row.rule_id === questRuleId)!;
    await verify(
      client,
      String(questOccurrence.id),
      80,
      null,
      false,
      "점수 정정",
      Number(questOccurrence.revision)
    );
    entitlements = await listEntitlements(client, fixture.childProfileId);
    assert(
      entitlements
        .filter(row => row.rule_id === questRuleId)
        .every(row => row.requires_review === true),
      "lower QUEST correction flags all prior rewards for review without deleting them"
    );
    await client.query("reset role");
    const correctionEvents = await client.query<{ n: number }>(
      `select count(*)::int as n from public.routine_entitlement_events
       where entitlement_id = any($1::uuid[]) and event_kind='REVIEW_REQUIRED'`,
      [[questFirstId, questSecondId]]
    );
    assert(
      correctionEvents.rows[0]?.n === 2,
      "correction review creates append-only audit events for each affected QUEST reward"
    );
    await setUser(client, fixture.parentAuthId);
    questOccurrence = (
      await listDay(client, fixture.childProfileId, calendar.today)
    ).find(row => row.rule_id === questRuleId)!;
    await verify(
      client,
      String(questOccurrence.id),
      95,
      null,
      false,
      "score restored",
      Number(questOccurrence.revision)
    );
    entitlements = await listEntitlements(client, fixture.childProfileId);
    assert(
      entitlements.filter(row => row.rule_id === questRuleId).length === 2 &&
        entitlements.find(row => row.id === questFirstId)?.status ===
          "FULFILLED" &&
        entitlements
          .filter(row => row.rule_id === questRuleId)
          .every(row => row.requires_review === false),
      "QUEST 95 restoration clears review on the same two IDs while preserving fulfilled status"
    );
    await client.query("reset role");
    const questResolutionEvents = await client.query<{ n: number }>(
      `select count(*)::int as n from public.routine_entitlement_events
       where entitlement_id = any($1::uuid[]) and event_kind='REVIEW_RESOLVED'`,
      [[questFirstId, questSecondId]]
    );
    assert(
      Number(questResolutionEvents.rows[0]?.n) === 2,
      "QUEST restoration adds one REVIEW_RESOLVED audit event per existing entitlement without new issuance"
    );
    await setUser(client, fixture.parentAuthId);

    // 0018 protects both assignment insert directions under the same family advisory lock.
    // Rules are first created against a common legacy ref; then each case reverses only the
    // insertion order, so both outcomes exercise the actual same-child/same-ref overlap guard.
    const v2FirstName = `V2 first assignment ${randomUUID().slice(0, 8)}`;
    const v2FirstLegacy = await client.query<{
      config_version_id: string;
      policy_rule_id: string;
    }>(
      `select * from public.save_parent_pass_rule_draft($1,$2,'DAILY_STUDY'::public.activity_category_code,
         'cross-registry fixture','PASS confirmation',0)`,
      [fixture.familyId, v2FirstName]
    );
    await client.query("select * from public.publish_parent_rule_draft($1)", [
      v2FirstLegacy.rows[0]!.config_version_id,
    ]);
    const v2FirstDraft = await saveDraft(
      client,
      fixture.familyId,
      null,
      fullDailyPayload(v2FirstName, wonId, minId),
      0
    );
    const v2FirstRule = await publishDraft(
      client,
      jsonId(v2FirstDraft),
      Number(v2FirstDraft.revision)
    );
    const crossOneDate = await client.query<{ d: string }>(
      "select ($1::date+8)::text d",
      [calendar.today]
    );
    await client.query(
      "select public.create_routine_assignment($1,$2,$3,$4::date,$4::date,array[1,2,3,4,5,6,7]::int[],'DAILY',$5)",
      [
        fixture.familyId,
        jsonId(v2FirstRule),
        fixture.childProfileId,
        crossOneDate.rows[0]!.d,
        randomUUID(),
      ]
    );
    await rejected(
      client,
      "select public.create_activity_assignment($1,$2,$3,$4::date,$4::date,array[1,2,3,4,5,6,7]::int[],'DAILY')",
      [
        fixture.familyId,
        fixture.childProfileId,
        v2FirstLegacy.rows[0]!.policy_rule_id,
        crossOneDate.rows[0]!.d,
      ],
      "23P01",
      "0018 rejects legacy assignment after overlapping v2 assignment (v2-to-v1)"
    );

    const legacyFirstName = `Legacy first assignment ${randomUUID().slice(0, 8)}`;
    const legacyFirst = await client.query<{
      config_version_id: string;
      policy_rule_id: string;
    }>(
      `select * from public.save_parent_pass_rule_draft($1,$2,'DAILY_STUDY'::public.activity_category_code,
         'cross-registry fixture','PASS confirmation',0)`,
      [fixture.familyId, legacyFirstName]
    );
    await client.query("select * from public.publish_parent_rule_draft($1)", [
      legacyFirst.rows[0]!.config_version_id,
    ]);
    const legacyFuture = await client.query<{ d: string }>(
      "select ($1::date+15)::text d",
      [calendar.today]
    );
    await client.query(
      "select public.create_activity_assignment($1,$2,$3,$4::date,$4::date,array[1,2,3,4,5,6,7]::int[],'DAILY')",
      [
        fixture.familyId,
        fixture.childProfileId,
        legacyFirst.rows[0]!.policy_rule_id,
        legacyFuture.rows[0]!.d,
      ]
    );
    const sameRefV2 = await saveDraft(
      client,
      fixture.familyId,
      null,
      fullDailyPayload(legacyFirstName, wonId, minId),
      0
    );
    const sameRefV2Rule = await publishDraft(
      client,
      jsonId(sameRefV2),
      Number(sameRefV2.revision)
    );
    await rejected(
      client,
      "select public.create_routine_assignment($1,$2,$3,$4::date,$4::date,array[1,2,3,4,5,6,7]::int[],'DAILY',$5)",
      [
        fixture.familyId,
        jsonId(sameRefV2Rule),
        fixture.childProfileId,
        legacyFuture.rows[0]!.d,
        randomUUID(),
      ],
      "23P01",
      "0018 rejects v2 assignment after legacy overlap on same child/activity ref (v1-to-v2)"
    );

    await setUser(client, fixture.guardianAuthId);
    await rejected(
      client,
      "select public.list_routine_reinforcers($1)",
      [fixture.familyId],
      "42501",
      "guardian cannot read parent-only reinforcer catalogue"
    );
    await rejected(
      client,
      "select public.save_routine_draft($1,null,null,1,$2::jsonb,0,$3)",
      [fixture.familyId, JSON.stringify(partial), randomUUID()],
      "42501",
      "guardian cannot save a routine draft"
    );
    await rejected(
      client,
      "select id from public.routine_entitlements where child_profile_id=$1",
      [fixture.childProfileId],
      "42501",
      "guardian has no direct entitlement table privilege"
    );
    await setUser(client, fixture.parentAuthId);
    await client.query(
      "select set_config('private.routine_draft_write','on',true)"
    );
    await rejected(
      client,
      "update public.routine_drafts set step=2 where id=$1",
      [partialDraftId],
      "42501",
      "untrusted transaction-local GUC cannot bypass raw draft-write privilege"
    );
    await setUser(client, fixture.otherAuthId);
    await rejected(
      client,
      "select public.list_routine_day($1,$2::date)",
      [fixture.childProfileId, calendar.today],
      "42501",
      "other-family account cannot read the child's routine day"
    );

    await client.query("reset role");
    const requestEvents = await client.query<{ n: number }>(
      "select count(*)::int as n from public.routine_request_events where actor_principal_id=$1",
      [fixture.parentPrincipalId]
    );
    assert(
      Number(requestEvents.rows[0]?.n) > 0,
      "successful mutating RPCs leave idempotency/audit request records"
    );
    const realTransferRows = await client.query<{ n: number }>(
      `select count(*)::int as n from public.manual_money_rewards mr
       join public.child_profiles cp on cp.id=mr.child_profile_id
       where cp.family_id=$1`,
      [fixture.familyId]
    );
    assert(
      Number(realTransferRows.rows[0]?.n) === 0,
      "routine entitlements create no automatic real-money reward or transfer record"
    );

    console.log(
      `RESULT ${passed} checks; all Routine v2 fixtures are rolled back.`
    );
    console.log("ROUTINE_V2_LIVE_OK");
  } catch (error) {
    const diagnostic = error as { message?: string; where?: string };
    console.error(
      "Routine v2 live validation failed:",
      sqlState(error),
      diagnostic.message || "FIXTURE_VALIDATION_ERROR"
    );
    if (diagnostic.where) console.error(diagnostic.where);
    process.exitCode = 1;
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  verifyRoutineV2Live();
}
