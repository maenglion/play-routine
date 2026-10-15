begin;

-- Routine v2는 기존 0001~0016의 규칙·활동·수동 보상을 변경하지 않는다.
-- 아래 테이블은 전부 RPC 전용이며, 초안/게시/배정/수행/권리의 새 경계를 독립적으로 보존한다.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- 숫자 Quest와 PASS 스티커 Daily의 값은 기존 v1 enum에 억지로 섞지 않는다.
do $$ begin create type public.routine_flow as enum ('DAILY', 'QUEST'); exception when duplicate_object then null; end $$;
do $$ begin create type public.routine_period as enum ('DAILY', 'WEEKLY', 'MONTHLY', 'SPECIAL_EVENT'); exception when duplicate_object then null; end $$;
do $$ begin create type public.routine_reinforcer_unit as enum ('WON', 'MIN', 'POINT', 'STRING'); exception when duplicate_object then null; end $$;
do $$ begin create type public.routine_draft_status as enum ('DRAFT', 'PUBLISHED'); exception when duplicate_object then null; end $$;
do $$ begin create type public.routine_repeat_kind as enum ('DAILY', 'ONCE'); exception when duplicate_object then null; end $$;
do $$ begin create type public.routine_entitlement_status as enum ('AVAILABLE', 'FULFILLED'); exception when duplicate_object then null; end $$;
do $$ begin create type public.routine_occurrence_event_kind as enum ('CHILD_REPORTED', 'PARENT_VERIFIED'); exception when duplicate_object then null; end $$;
do $$ begin create type public.routine_entitlement_event_kind as enum ('ISSUED', 'REVIEW_REQUIRED', 'REVIEW_RESOLVED', 'FULFILLED'); exception when duplicate_object then null; end $$;

-- 강화물은 가족별 부모가 정한 불변 카탈로그다. 이름에서 통화/시간을 추론하지 않고 unit을 명시한다.
create table if not exists public.routine_reinforcers (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  name text not null,
  unit public.routine_reinforcer_unit not null,
  unit_label text not null,
  created_by_principal_id uuid not null references public.principals(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (id, family_id),
  check (char_length(btrim(name)) between 1 and 100),
  check (char_length(btrim(unit_label)) between 1 and 40)
);
create unique index if not exists routine_reinforcers_family_name_unit_uq
  on public.routine_reinforcers(family_id, lower(btrim(name)), unit, lower(btrim(unit_label)));

-- 초안은 3단계 중 어느 단계에서나 저장할 수 있다. payload는 게시본이 아니라 편집 중 JSON이다.
create table if not exists public.routine_drafts (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  source_rule_id uuid,
  step integer not null check (step between 1 and 3),
  revision integer not null default 0 check (revision >= 0),
  payload jsonb not null,
  status public.routine_draft_status not null default 'DRAFT',
  published_rule_id uuid,
  effective_from date,
  created_by_principal_id uuid not null references public.principals(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, family_id),
  check ((status = 'DRAFT' and published_rule_id is null and effective_from is null)
      or (status = 'PUBLISHED' and published_rule_id is not null and effective_from is not null))
);

-- 게시 규칙은 immutable snapshot이다. source_rule_id는 새 버전이 바로 직전 버전을 기반으로 했음을,
-- rule_group_id는 동일 활동의 안정적인 버전 계보임을 나타낸다.
create table if not exists public.routine_rules (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  subject_ref_id uuid not null,
  source_rule_id uuid,
  rule_group_id uuid not null,
  name text not null,
  category_code public.activity_category_code not null,
  flow public.routine_flow not null,
  measurement text not null check (measurement in ('STICKER', 'PERCENT', 'QUANTITY')),
  period public.routine_period not null,
  payload jsonb not null,
  effective_from date not null,
  version integer not null check (version > 0),
  published_by_principal_id uuid not null references public.principals(id) on delete restrict,
  published_at timestamptz not null default now(),
  unique (id, family_id),
  unique (rule_group_id, version),
  foreign key (subject_ref_id, family_id) references public.ref_concepts(id, family_id) on delete restrict,
  foreign key (source_rule_id, family_id) references public.routine_rules(id, family_id) on delete restrict,
  check (char_length(btrim(name)) between 1 and 100),
  check ((flow = 'DAILY' and measurement = 'STICKER')
      or (flow = 'QUEST' and measurement in ('PERCENT', 'QUANTITY'))),
  check ((flow = 'QUEST' and period = 'DAILY') or flow = 'DAILY')
);
create index if not exists routine_rules_family_group_effective_idx
  on public.routine_rules(family_id, rule_group_id, effective_from desc, version desc);

alter table public.routine_drafts
  drop constraint if exists routine_drafts_source_rule_fk;
alter table public.routine_drafts
  add constraint routine_drafts_source_rule_fk
  foreign key (source_rule_id, family_id) references public.routine_rules(id, family_id) on delete restrict;
alter table public.routine_drafts
  drop constraint if exists routine_drafts_published_rule_fk;
alter table public.routine_drafts
  add constraint routine_drafts_published_rule_fk
  foreign key (published_rule_id, family_id) references public.routine_rules(id, family_id) on delete restrict;

-- 조건은 tier 1~5, 보상은 조건마다 1~2개다. 카탈로그 값은 게시 시점에 snapshot으로 동결한다.
create table if not exists public.routine_conditions (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  rule_id uuid not null,
  source_tier_id uuid not null,
  tier_no integer not null check (tier_no between 1 and 5),
  label text not null,
  threshold numeric not null,
  operator text not null check (operator in ('GTE', 'GT')),
  created_at timestamptz not null default now(),
  unique (id, family_id),
  unique (rule_id, tier_no),
  unique (rule_id, source_tier_id),
  foreign key (rule_id, family_id) references public.routine_rules(id, family_id) on delete restrict,
  check (char_length(btrim(label)) between 1 and 100),
  check (threshold::text not in ('NaN', 'Infinity', '-Infinity'))
);

create table if not exists public.routine_reward_items (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  condition_id uuid not null,
  source_reward_id uuid not null,
  reinforcer_id uuid not null,
  name_snapshot text not null,
  unit_snapshot public.routine_reinforcer_unit not null,
  unit_label_snapshot text not null,
  amount numeric,
  text_value text,
  created_at timestamptz not null default now(),
  unique (id, family_id),
  unique (condition_id, source_reward_id),
  foreign key (condition_id, family_id) references public.routine_conditions(id, family_id) on delete restrict,
  foreign key (reinforcer_id, family_id) references public.routine_reinforcers(id, family_id) on delete restrict,
  check (char_length(btrim(name_snapshot)) between 1 and 100),
  check (char_length(btrim(unit_label_snapshot)) between 1 and 40),
  -- Won·point·minute value is whole-unit only. MIN keeps the existing v1 per-action 240-minute ceiling;
  -- no balance, transfer, or automatic payment is implied by this immutable entitlement source.
  check (amount is null or (amount::text not in ('NaN', 'Infinity', '-Infinity')
    and amount = trunc(amount) and amount > 0 and amount <= 1000000000
    and (unit_snapshot <> 'MIN' or amount <= 240))),
  check ((unit_snapshot = 'STRING' and amount is null and char_length(btrim(coalesce(text_value, ''))) between 1 and 240)
      or (unit_snapshot in ('WON', 'MIN', 'POINT') and amount is not null and btrim(coalesce(text_value, '')) = ''))
);
create index if not exists routine_reward_items_condition_idx on public.routine_reward_items(condition_id, id);

-- 배정은 규칙 버전을 고정한다. 종료일만 RPC를 통해 짧아질 수 있으며 이력은 삭제하지 않는다.
create table if not exists public.routine_assignments (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  rule_id uuid not null,
  child_profile_id uuid not null,
  starts_on date not null,
  ends_on date,
  weekdays integer[] not null,
  repeat_kind public.routine_repeat_kind not null,
  schedule_range daterange generated always as (
    daterange(starts_on, case when ends_on is null then null else ends_on + 1 end, '[)')
  ) stored,
  created_by_principal_id uuid not null references public.principals(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (id, family_id),
  foreign key (rule_id, family_id) references public.routine_rules(id, family_id) on delete restrict,
  foreign key (child_profile_id, family_id) references public.child_profiles(id, family_id) on delete restrict,
  check (cardinality(weekdays) between 1 and 7),
  check ((repeat_kind = 'DAILY' and (ends_on is null or ends_on >= starts_on))
      or (repeat_kind = 'ONCE' and ends_on = starts_on)),
  check (not isempty(schedule_range))
);
create index if not exists routine_assignments_child_rule_range_idx
  on public.routine_assignments using gist (child_profile_id, rule_id, schedule_range);
create index if not exists routine_assignments_family_child_dates_idx
  on public.routine_assignments(family_id, child_profile_id, starts_on, ends_on);

create table if not exists public.routine_assignment_end_events (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  assignment_id uuid not null,
  actor_principal_id uuid not null references public.principals(id) on delete restrict,
  prior_ends_on date,
  ends_on date not null,
  recorded_at timestamptz not null default now(),
  unique (id, family_id),
  foreign key (assignment_id, family_id) references public.routine_assignments(id, family_id) on delete restrict,
  check (prior_ends_on is null or ends_on <= prior_ends_on)
);

-- occurrence는 현재 projection이고, report/verification은 아래 append-only event에 원문으로 남는다.
create table if not exists public.routine_occurrences (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  child_profile_id uuid not null,
  assignment_id uuid not null,
  rule_id uuid not null,
  business_date date not null,
  materialized_at timestamptz not null default now(),
  child_reported_at timestamptz,
  parent_verified_at timestamptz,
  score numeric,
  pass boolean,
  praise boolean not null default false,
  stickers integer,
  parent_reason text,
  current_revision integer not null default 0,
  unique (id, family_id),
  unique (assignment_id, business_date),
  foreign key (child_profile_id, family_id) references public.child_profiles(id, family_id) on delete restrict,
  foreign key (assignment_id, family_id) references public.routine_assignments(id, family_id) on delete restrict,
  foreign key (rule_id, family_id) references public.routine_rules(id, family_id) on delete restrict,
  check (current_revision >= 0),
  check (score is null or (score::text not in ('NaN', 'Infinity', '-Infinity') and score between 0 and 100)),
  check (stickers is null or stickers between 0 and 2),
  check ((parent_verified_at is null and score is null and pass is null and praise = false and stickers is null and parent_reason is null)
      or (parent_verified_at is not null and char_length(btrim(parent_reason)) between 1 and 1000))
);
create index if not exists routine_occurrences_child_date_idx on public.routine_occurrences(child_profile_id, business_date, rule_id);
create index if not exists routine_occurrences_rule_period_idx on public.routine_occurrences(child_profile_id, rule_id, business_date) where parent_verified_at is not null;

create table if not exists public.routine_occurrence_events (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  occurrence_id uuid not null,
  actor_principal_id uuid not null references public.principals(id) on delete restrict,
  event_kind public.routine_occurrence_event_kind not null,
  idempotency_key uuid not null,
  expected_revision integer not null check (expected_revision >= 0),
  score numeric,
  pass boolean,
  praise boolean,
  stickers integer,
  reason text,
  recorded_at timestamptz not null default now(),
  unique (id, family_id),
  unique (actor_principal_id, idempotency_key),
  foreign key (occurrence_id, family_id) references public.routine_occurrences(id, family_id) on delete restrict,
  check (score is null or (score::text not in ('NaN', 'Infinity', '-Infinity') and score between 0 and 100)),
  check (stickers is null or stickers between 0 and 2),
  check ((event_kind = 'CHILD_REPORTED' and score is null and pass is null and praise is null and stickers is null and reason is null)
      or (event_kind = 'PARENT_VERIFIED' and char_length(btrim(coalesce(reason, ''))) between 1 and 1000))
);
create index if not exists routine_occurrence_events_occurrence_idx on public.routine_occurrence_events(occurrence_id, recorded_at, id);

-- 지급 권리는 외부 지급/시간 사용과 분리된다. requires_review는 낮춘 정정 후 자동 회수 대신 사람 검토를 요구한다.
create table if not exists public.routine_entitlements (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  child_profile_id uuid not null,
  rule_id uuid not null,
  condition_id uuid not null,
  reward_item_id uuid not null,
  source_occurrence_id uuid,
  source_date date not null,
  period_start date not null,
  period_end date not null,
  status public.routine_entitlement_status not null default 'AVAILABLE',
  requires_review boolean not null default false,
  created_by_principal_id uuid not null references public.principals(id) on delete restrict,
  created_at timestamptz not null default now(),
  fulfilled_by_principal_id uuid references public.principals(id) on delete restrict,
  fulfilled_at timestamptz,
  unique (id, family_id),
  foreign key (child_profile_id, family_id) references public.child_profiles(id, family_id) on delete restrict,
  foreign key (rule_id, family_id) references public.routine_rules(id, family_id) on delete restrict,
  foreign key (condition_id, family_id) references public.routine_conditions(id, family_id) on delete restrict,
  foreign key (reward_item_id, family_id) references public.routine_reward_items(id, family_id) on delete restrict,
  foreign key (source_occurrence_id, family_id) references public.routine_occurrences(id, family_id) on delete restrict,
  check (period_end >= period_start),
  check ((source_occurrence_id is not null and source_date between period_start and period_end)
      or (source_occurrence_id is null and source_date = period_end)),
  check ((status = 'AVAILABLE' and fulfilled_by_principal_id is null and fulfilled_at is null)
      or (status = 'FULFILLED' and fulfilled_by_principal_id is not null and fulfilled_at is not null))
);
-- Quest는 occurrence 단위, Daily는 rule/child/calendar period 단위로 정확히 한 번씩만 권리를 만든다.
create unique index if not exists routine_entitlements_quest_origin_uq
  on public.routine_entitlements(child_profile_id, rule_id, source_occurrence_id, condition_id, reward_item_id)
  where source_occurrence_id is not null;
create unique index if not exists routine_entitlements_daily_period_uq
  on public.routine_entitlements(child_profile_id, rule_id, period_start, period_end, condition_id, reward_item_id)
  where source_occurrence_id is null;
create index if not exists routine_entitlements_child_created_idx on public.routine_entitlements(child_profile_id, created_at desc);

create table if not exists public.routine_entitlement_events (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  entitlement_id uuid not null,
  actor_principal_id uuid not null references public.principals(id) on delete restrict,
  event_kind public.routine_entitlement_event_kind not null,
  request_payload jsonb not null,
  recorded_at timestamptz not null default now(),
  unique (id, family_id),
  foreign key (entitlement_id, family_id) references public.routine_entitlements(id, family_id) on delete restrict
);
create index if not exists routine_entitlement_events_entitlement_idx on public.routine_entitlement_events(entitlement_id, recorded_at, id);

-- 모든 변경 RPC의 actor/key/payload를 한 표에 기록한다. 다른 RPC나 다른 payload의 key 재사용을 막는다.
create table if not exists public.routine_request_events (
  id uuid primary key default extensions.gen_random_uuid(),
  actor_principal_id uuid not null references public.principals(id) on delete restrict,
  idempotency_key uuid not null,
  action text not null,
  request_payload jsonb not null,
  response_payload jsonb not null,
  recorded_at timestamptz not null default now(),
  unique (actor_principal_id, idempotency_key),
  check (char_length(action) between 1 and 80)
);

-- 공용 인증/날짜/JSON helper. 기존 verified principal 및 parent/child helper를 그대로 재사용한다.
create or replace function private.routine_family_today(p_family_id uuid)
returns date language sql stable security definer set search_path = '' as $$
  select (now() at time zone f.timezone)::date
  from public.families f where f.id = p_family_id and f.status = 'ACTIVE'
$$;

create or replace function private.routine_weekdays_are_valid(p_weekdays integer[])
returns boolean language sql immutable set search_path = '' as $$
  select p_weekdays is not null
    and cardinality(p_weekdays) between 1 and 7
    and p_weekdays <@ array[1,2,3,4,5,6,7]::integer[]
    and cardinality(p_weekdays) = (select count(distinct d)::integer from unnest(p_weekdays) u(d))
$$;

create or replace function private.routine_schedules_share_date(
  p_left_starts_on date, p_left_ends_on date, p_left_weekdays integer[],
  p_right_starts_on date, p_right_ends_on date, p_right_weekdays integer[]
) returns boolean language plpgsql immutable set search_path = '' as $$
declare v_first date; v_last date; v_day integer; v_candidate date;
begin
  v_first := greatest(p_left_starts_on, p_right_starts_on);
  v_last := case when p_left_ends_on is null then p_right_ends_on when p_right_ends_on is null then p_left_ends_on else least(p_left_ends_on, p_right_ends_on) end;
  if v_last is not null and v_first > v_last then return false; end if;
  foreach v_day in array p_left_weekdays loop
    if v_day = any(p_right_weekdays) then
      v_candidate := v_first + ((v_day - extract(isodow from v_first)::integer + 7) % 7);
      if v_last is null or v_candidate <= v_last then return true; end if;
    end if;
  end loop;
  return false;
end $$;

-- The function exists after the table declaration, so add the full structural weekday guard here.
alter table public.routine_assignments drop constraint if exists routine_assignments_weekdays_valid;
alter table public.routine_assignments add constraint routine_assignments_weekdays_valid check (private.routine_weekdays_are_valid(weekdays));

create or replace function private.routine_period_start(p_period public.routine_period, p_reference_date date)
returns date language sql immutable set search_path = '' as $$
  select case p_period
    when 'DAILY' then p_reference_date
    when 'WEEKLY' then p_reference_date - (extract(isodow from p_reference_date)::integer - 1)
    when 'MONTHLY' then date_trunc('month', p_reference_date::timestamp)::date
    when 'SPECIAL_EVENT' then p_reference_date
  end
$$;

create or replace function private.routine_period_end(p_period public.routine_period, p_reference_date date)
returns date language sql immutable set search_path = '' as $$
  select case p_period
    when 'DAILY' then p_reference_date
    when 'WEEKLY' then p_reference_date + (7 - extract(isodow from p_reference_date)::integer)
    when 'MONTHLY' then (date_trunc('month', p_reference_date::timestamp) + interval '1 month - 1 day')::date
    when 'SPECIAL_EVENT' then p_reference_date
  end
$$;

create or replace function private.routine_json_number(p_value jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select jsonb_typeof(p_value) = 'number'
    and p_value #>> '{}' not in ('NaN', 'Infinity', '-Infinity')
$$;

create or replace function private.routine_json_uuid(p_value jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select jsonb_typeof(p_value) = 'string'
    and p_value #>> '{}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;

-- 완성 전 저장은 비어 있는 이름/tiers/rewards를 허용하지만, 이미 들어온 값의 자료형·범위는 즉시 막는다.
-- p_complete=true는 게시 직전에 공유 TypeScript 계약 전체를 강제하고 가족 카탈로그도 검증한다.
create or replace function private.routine_assert_payload(
  p_payload jsonb, p_complete boolean, p_family_id uuid
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_tier jsonb; v_reward jsonb; v_prev numeric; v_threshold numeric; v_amount numeric;
  v_flow text; v_measurement text; v_period text; v_unit public.routine_reinforcer_unit;
  v_tier_count integer; v_reward_count integer;
  v_required text[] := array['schemaVersion','flow','name','category','childLabel','criteria','stickerIcon','measurement','period','penaltyLimit','penaltyMinutes','tiers'];
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text) > 32768 then
    raise exception 'ROUTINE_INVALID_DRAFT_PAYLOAD' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_object_keys(p_payload) k where k not in ('schemaVersion','flow','name','category','childLabel','criteria','stickerIcon','measurement','period','penaltyLimit','penaltyMinutes','tiers')) then
    raise exception 'ROUTINE_UNKNOWN_DRAFT_FIELD' using errcode = '22023';
  end if;
  if p_complete and not (p_payload ?& v_required) then
    raise exception 'ROUTINE_PUBLISH_REQUIRES_COMPLETE_PAYLOAD' using errcode = '22023';
  end if;

  -- A draft can contain only the fields completed so far. It still rejects unknown keys and
  -- malformed JSON containers, but intentionally permits blank labels, blank/NULL thresholds,
  -- a blank reinforcerId, and a zero/blank amount until publishing.
  if p_payload ? 'schemaVersion' and (not private.routine_json_number(p_payload->'schemaVersion') or p_payload->>'schemaVersion' <> '1') then
    raise exception 'ROUTINE_SCHEMA_VERSION_REQUIRED' using errcode = '22023';
  end if;
  if p_complete and not (p_payload ? 'schemaVersion') then raise exception 'ROUTINE_SCHEMA_VERSION_REQUIRED' using errcode = '22023'; end if;
  if p_payload ? 'flow' and (jsonb_typeof(p_payload->'flow') <> 'string' or p_payload->>'flow' not in ('DAILY','QUEST')) then raise exception 'ROUTINE_INVALID_FLOW' using errcode = '22023'; end if;
  if p_payload ? 'category' and (jsonb_typeof(p_payload->'category') <> 'string' or p_payload->>'category' not in ('DAILY_STUDY','SPECIAL_SCHEDULE','LIFE_HABIT','OTHER')) then raise exception 'ROUTINE_INVALID_CATEGORY' using errcode = '22023'; end if;
  if p_payload ? 'stickerIcon' and (jsonb_typeof(p_payload->'stickerIcon') <> 'string' or p_payload->>'stickerIcon' not in ('STAR','SMILE','STAMP')) then raise exception 'ROUTINE_INVALID_STICKER_ICON' using errcode = '22023'; end if;
  if p_payload ? 'measurement' and (jsonb_typeof(p_payload->'measurement') <> 'string' or p_payload->>'measurement' not in ('STICKER','PERCENT','QUANTITY')) then raise exception 'ROUTINE_INVALID_MEASUREMENT' using errcode = '22023'; end if;
  if p_payload ? 'period' and (jsonb_typeof(p_payload->'period') <> 'string' or p_payload->>'period' not in ('DAILY','WEEKLY','MONTHLY','SPECIAL_EVENT')) then raise exception 'ROUTINE_INVALID_PERIOD' using errcode = '22023'; end if;
  foreach v_flow in array array['name','childLabel','criteria'] loop
    if p_payload ? v_flow and (jsonb_typeof(p_payload->v_flow) <> 'string' or char_length(p_payload->>v_flow) > case v_flow when 'name' then 100 when 'childLabel' then 100 else 1000 end) then
      raise exception 'ROUTINE_INVALID_TEXT_FIELD' using errcode = '22023';
    end if;
  end loop;
  -- UI owns the 20-visible-grapheme child-label rule (Intl.Segmenter). PostgreSQL char_length
  -- is code-point based, so the persistence guard is deliberately a 100-code-point safety cap.
  if p_complete and (char_length(btrim(p_payload->>'name')) not between 1 and 100
      or char_length(btrim(p_payload->>'childLabel')) not between 1 and 100
      or char_length(btrim(p_payload->>'criteria')) not between 1 and 1000) then
    raise exception 'ROUTINE_PUBLISH_REQUIRES_TEXT' using errcode = '22023';
  end if;
  if p_payload ? 'penaltyLimit' and p_payload->'penaltyLimit' <> 'null'::jsonb and not private.routine_json_number(p_payload->'penaltyLimit') then raise exception 'ROUTINE_INVALID_PENALTY_LIMIT' using errcode = '22023'; end if;
  if p_payload ? 'penaltyMinutes' and (not private.routine_json_number(p_payload->'penaltyMinutes') or trunc((p_payload->>'penaltyMinutes')::numeric) <> (p_payload->>'penaltyMinutes')::numeric) then raise exception 'ROUTINE_INVALID_PENALTY_MINUTES' using errcode = '22023'; end if;
  if p_complete and (not (p_payload ? 'penaltyMinutes') or not (p_payload ? 'penaltyLimit')) then raise exception 'ROUTINE_PENALTY_FIELDS_REQUIRED' using errcode = '22023'; end if;

  if p_payload ? 'tiers' and jsonb_typeof(p_payload->'tiers') <> 'array' then raise exception 'ROUTINE_INVALID_TIERS' using errcode = '22023'; end if;
  if p_payload ? 'tiers' and jsonb_array_length(p_payload->'tiers') > 5 then raise exception 'ROUTINE_TOO_MANY_TIERS' using errcode = '22023'; end if;
  if p_complete and jsonb_array_length(p_payload->'tiers') not between 1 and 5 then raise exception 'ROUTINE_PUBLISH_REQUIRES_TIERS' using errcode = '22023'; end if;

  v_flow := p_payload->>'flow'; v_measurement := p_payload->>'measurement'; v_period := p_payload->>'period';
  if p_complete and ((v_flow = 'DAILY' and (v_measurement <> 'STICKER' or v_period not in ('DAILY','WEEKLY','MONTHLY','SPECIAL_EVENT')))
      or (v_flow = 'QUEST' and (v_measurement not in ('PERCENT','QUANTITY') or v_period <> 'DAILY'))) then
    raise exception 'ROUTINE_FLOW_MEASUREMENT_PERIOD_MISMATCH' using errcode = '22023';
  end if;
  if p_complete and v_flow = 'QUEST' then
    if (p_payload->'penaltyLimit' <> 'null'::jsonb and ((p_payload->>'penaltyLimit')::numeric < 0 or (p_payload->>'penaltyLimit')::numeric > 100))
       or (p_payload->>'penaltyMinutes')::numeric < 0 or (p_payload->>'penaltyMinutes')::numeric > 240 then
      raise exception 'ROUTINE_INVALID_QUEST_PENALTY' using errcode = '22023';
    end if;
    -- A score cannot be below zero: NULL/0 lower boundary can only mean no penalty.
    if ((p_payload->'penaltyLimit' = 'null'::jsonb or (p_payload->>'penaltyLimit')::numeric = 0)
        and (p_payload->>'penaltyMinutes')::numeric <> 0) then
      raise exception 'ROUTINE_IMPOSSIBLE_QUEST_PENALTY' using errcode = '22023';
    end if;
  end if;
  if p_complete and v_flow = 'DAILY' and (p_payload->'penaltyLimit' <> 'null'::jsonb or (p_payload->>'penaltyMinutes')::numeric <> 0) then
    raise exception 'ROUTINE_DAILY_STICKERS_HAVE_NO_PENALTY' using errcode = '22023';
  end if;

  v_prev := null;
  if p_payload ? 'tiers' then
    for v_tier in select value from jsonb_array_elements(p_payload->'tiers') loop
      if jsonb_typeof(v_tier) <> 'object'
         or exists (select 1 from jsonb_object_keys(v_tier) k where k not in ('id','label','threshold','operator','rewards')) then
        raise exception 'ROUTINE_INVALID_TIER_SHAPE' using errcode = '22023';
      end if;
      if p_complete and not (v_tier ?& array['id','label','threshold','operator','rewards']) then raise exception 'ROUTINE_INVALID_TIER_SHAPE' using errcode = '22023'; end if;
      if v_tier ? 'id' and (jsonb_typeof(v_tier->'id') <> 'string' or char_length(v_tier->>'id') > 64 or (p_complete and not private.routine_json_uuid(v_tier->'id'))) then raise exception 'ROUTINE_INVALID_TIER_SHAPE' using errcode = '22023'; end if;
      if v_tier ? 'label' and (jsonb_typeof(v_tier->'label') <> 'string' or char_length(v_tier->>'label') > 100) then raise exception 'ROUTINE_INVALID_TIER_SHAPE' using errcode = '22023'; end if;
      if v_tier ? 'threshold' and not (v_tier->'threshold' = 'null'::jsonb or private.routine_json_number(v_tier->'threshold') or (not p_complete and jsonb_typeof(v_tier->'threshold') = 'string' and btrim(v_tier->>'threshold') = '')) then raise exception 'ROUTINE_INVALID_TIER_SHAPE' using errcode = '22023'; end if;
      if v_tier ? 'operator' and (jsonb_typeof(v_tier->'operator') <> 'string' or (v_tier->>'operator' <> '' and v_tier->>'operator' not in ('GTE','GT'))) then raise exception 'ROUTINE_INVALID_TIER_SHAPE' using errcode = '22023'; end if;
      if v_tier ? 'rewards' and jsonb_typeof(v_tier->'rewards') <> 'array' then raise exception 'ROUTINE_INVALID_TIER_SHAPE' using errcode = '22023'; end if;
      if p_complete and (not (v_tier ? 'rewards') or jsonb_array_length(v_tier->'rewards') not between 1 and 2) then raise exception 'ROUTINE_PUBLISH_REQUIRES_ONE_OR_TWO_REWARDS' using errcode = '22023'; end if;
      if v_tier ? 'rewards' and jsonb_array_length(v_tier->'rewards') > 2 then raise exception 'ROUTINE_TOO_MANY_REWARDS_PER_TIER' using errcode = '22023'; end if;
      if p_complete and exists (select 1 from jsonb_array_elements(p_payload->'tiers') z where z->>'id' = v_tier->>'id' group by z->>'id' having count(*) > 1) then raise exception 'ROUTINE_DUPLICATE_TIER_ID' using errcode = '22023'; end if;

      if p_complete then
        if char_length(btrim(v_tier->>'label')) not between 1 and 100 or not private.routine_json_number(v_tier->'threshold') or not private.routine_json_uuid(v_tier->'id') or v_tier->>'operator' not in ('GTE','GT') then
          raise exception 'ROUTINE_INVALID_TIER_SHAPE' using errcode = '22023';
        end if;
        v_threshold := (v_tier->>'threshold')::numeric;
        if (v_flow = 'DAILY' and (v_tier->>'operator' <> 'GTE' or v_threshold <= 0 or trunc(v_threshold) <> v_threshold))
           or (v_flow = 'QUEST' and (v_threshold < 0 or v_threshold > 100 or (v_tier->>'operator' = 'GT' and v_threshold >= 100))) then
          raise exception 'ROUTINE_INVALID_TIER_THRESHOLD' using errcode = '22023';
        end if;
        if v_prev is not null and v_threshold <= v_prev then raise exception 'ROUTINE_TIER_THRESHOLDS_MUST_ASCEND' using errcode = '22023'; end if;
        v_prev := v_threshold;
      end if;

      if v_tier ? 'rewards' then
        v_reward_count := jsonb_array_length(v_tier->'rewards');
        for v_reward in select value from jsonb_array_elements(v_tier->'rewards') loop
          if jsonb_typeof(v_reward) <> 'object'
             or exists (select 1 from jsonb_object_keys(v_reward) k where k not in ('id','reinforcerId','amount','text')) then
            raise exception 'ROUTINE_INVALID_REWARD_SHAPE' using errcode = '22023';
          end if;
          if p_complete and not (v_reward ?& array['id','reinforcerId','amount','text']) then raise exception 'ROUTINE_INVALID_REWARD_SHAPE' using errcode = '22023'; end if;
          if v_reward ? 'id' and (jsonb_typeof(v_reward->'id') <> 'string' or char_length(v_reward->>'id') > 64 or (p_complete and not private.routine_json_uuid(v_reward->'id'))) then raise exception 'ROUTINE_INVALID_REWARD_SHAPE' using errcode = '22023'; end if;
          if v_reward ? 'reinforcerId' and (jsonb_typeof(v_reward->'reinforcerId') <> 'string' or char_length(v_reward->>'reinforcerId') > 64 or (p_complete and not private.routine_json_uuid(v_reward->'reinforcerId')) or (not p_complete and v_reward->>'reinforcerId' <> '' and not private.routine_json_uuid(v_reward->'reinforcerId'))) then raise exception 'ROUTINE_INVALID_REWARD_SHAPE' using errcode = '22023'; end if;
          if v_reward ? 'amount' and not (v_reward->'amount' = 'null'::jsonb or private.routine_json_number(v_reward->'amount') or (not p_complete and jsonb_typeof(v_reward->'amount') = 'string' and btrim(v_reward->>'amount') = '')) then raise exception 'ROUTINE_INVALID_REWARD_SHAPE' using errcode = '22023'; end if;
          if v_reward ? 'text' and (jsonb_typeof(v_reward->'text') <> 'string' or char_length(v_reward->>'text') > 240) then raise exception 'ROUTINE_INVALID_REWARD_SHAPE' using errcode = '22023'; end if;
          if p_complete and exists (select 1 from jsonb_array_elements(v_tier->'rewards') z where z->>'id' = v_reward->>'id' group by z->>'id' having count(*) > 1) then raise exception 'ROUTINE_DUPLICATE_REWARD_ID' using errcode = '22023'; end if;
          if p_complete then
            select r.unit into v_unit from public.routine_reinforcers r where r.id = (v_reward->>'reinforcerId')::uuid and r.family_id = p_family_id;
            if v_unit is null then raise exception 'ROUTINE_REINFORCER_NOT_IN_FAMILY_CATALOG' using errcode = '22023'; end if;
            if v_unit = 'STRING' then
              if v_reward->'amount' <> 'null'::jsonb or char_length(btrim(v_reward->>'text')) not between 1 and 240 then raise exception 'ROUTINE_STRING_REWARD_REQUIRES_TEXT_ONLY' using errcode = '22023'; end if;
            else
              if not private.routine_json_number(v_reward->'amount') or btrim(v_reward->>'text') <> '' then raise exception 'ROUTINE_NUMERIC_REWARD_REQUIRES_AMOUNT_ONLY' using errcode = '22023'; end if;
              v_amount := (v_reward->>'amount')::numeric;
              if v_amount <= 0 or v_amount > 1000000000 or trunc(v_amount) <> v_amount or (v_unit = 'MIN' and v_amount > 240) then raise exception 'ROUTINE_NUMERIC_REWARD_REQUIRES_AMOUNT_ONLY' using errcode = '22023'; end if;
            end if;
          end if;
        end loop;
      end if;
    end loop;
  end if;
end $$;

create or replace function private.routine_draft_touch()
returns trigger language plpgsql security definer set search_path = '' as $$ begin new.updated_at := now(); return new; end $$;
create or replace function private.guard_routine_immutable()
returns trigger language plpgsql security definer set search_path = '' as $$ begin raise exception 'ROUTINE_IMMUTABLE_AUDIT_OR_PUBLISHED_RECORD' using errcode = '55000'; end $$;
create or replace function private.guard_routine_draft()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.status = 'PUBLISHED' then raise exception 'ROUTINE_PUBLISHED_DRAFT_IMMUTABLE' using errcode = '55000'; end if;
  if current_setting('private.routine_draft_write', true) = 'on' then return new; end if;
  raise exception 'ROUTINE_DRAFT_RPC_ONLY' using errcode = '55000';
end $$;
create or replace function private.guard_routine_assignment()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and current_setting('private.routine_assignment_end_update', true) = 'on'
     and new.ends_on is not null and new.ends_on >= old.starts_on
     and (old.ends_on is null or new.ends_on <= old.ends_on)
     and (to_jsonb(new) - 'ends_on' - 'schedule_range') = (to_jsonb(old) - 'ends_on' - 'schedule_range') then return new; end if;
  raise exception 'ROUTINE_ASSIGNMENT_APPEND_ONLY' using errcode = '55000';
end $$;

drop trigger if exists routine_reinforcers_immutable on public.routine_reinforcers;
create trigger routine_reinforcers_immutable before update or delete on public.routine_reinforcers for each row execute function private.guard_routine_immutable();
drop trigger if exists routine_drafts_touch on public.routine_drafts;
create trigger routine_drafts_touch before update on public.routine_drafts for each row execute function private.routine_draft_touch();
drop trigger if exists routine_drafts_guard on public.routine_drafts;
create trigger routine_drafts_guard before update or delete on public.routine_drafts for each row execute function private.guard_routine_draft();
drop trigger if exists routine_rules_immutable on public.routine_rules;
create trigger routine_rules_immutable before update or delete on public.routine_rules for each row execute function private.guard_routine_immutable();
drop trigger if exists routine_conditions_immutable on public.routine_conditions;
create trigger routine_conditions_immutable before update or delete on public.routine_conditions for each row execute function private.guard_routine_immutable();
drop trigger if exists routine_reward_items_immutable on public.routine_reward_items;
create trigger routine_reward_items_immutable before update or delete on public.routine_reward_items for each row execute function private.guard_routine_immutable();
drop trigger if exists routine_assignments_guard on public.routine_assignments;
create trigger routine_assignments_guard before update or delete on public.routine_assignments for each row execute function private.guard_routine_assignment();
drop trigger if exists routine_assignment_end_events_immutable on public.routine_assignment_end_events;
create trigger routine_assignment_end_events_immutable before update or delete on public.routine_assignment_end_events for each row execute function private.guard_routine_immutable();
drop trigger if exists routine_occurrence_events_immutable on public.routine_occurrence_events;
create trigger routine_occurrence_events_immutable before update or delete on public.routine_occurrence_events for each row execute function private.guard_routine_immutable();
drop trigger if exists routine_entitlement_events_immutable on public.routine_entitlement_events;
create trigger routine_entitlement_events_immutable before update or delete on public.routine_entitlement_events for each row execute function private.guard_routine_immutable();
drop trigger if exists routine_request_events_immutable on public.routine_request_events;
create trigger routine_request_events_immutable before update or delete on public.routine_request_events for each row execute function private.guard_routine_immutable();

-- retry helper: action/payload가 정확히 같을 때만 저장된 JSON object를 돌려준다.
create or replace function private.routine_replay(
  p_actor uuid, p_key uuid, p_action text, p_payload jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_event public.routine_request_events%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text || ':' || p_key::text, 17017));
  select e.* into v_event from public.routine_request_events e where e.actor_principal_id = p_actor and e.idempotency_key = p_key for update;
  if v_event.id is null then return null; end if;
  if v_event.action = p_action and v_event.request_payload = p_payload then return v_event.response_payload; end if;
  raise exception 'ROUTINE_IDEMPOTENCY_KEY_REUSED' using errcode = '22023';
end $$;
create or replace function private.routine_record_request(
  p_actor uuid, p_key uuid, p_action text, p_payload jsonb, p_response jsonb
) returns void language plpgsql security definer set search_path = '' as $$
begin insert into public.routine_request_events(actor_principal_id,idempotency_key,action,request_payload,response_payload) values(p_actor,p_key,p_action,p_payload,p_response); end $$;

-- 구버전 및 v2 배정의 같은 ref/자녀/실제 요일 날짜 중복을 v2 신규배정에서 막는 공용 판단 함수다.
create or replace function private.routine_assignment_conflicts_legacy(
  p_family_id uuid, p_child_profile_id uuid, p_subject_ref_id uuid, p_starts_on date, p_ends_on date, p_weekdays integer[]
) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.activity_assignments a
    join public.activity_templates t on t.id = a.activity_template_id
    where a.family_id = p_family_id and a.child_profile_id = p_child_profile_id and t.subject_ref_id = p_subject_ref_id
      and private.activity_schedules_share_date(a.starts_on,a.ends_on,a.weekdays,p_starts_on,p_ends_on,p_weekdays)
  )
$$;

-- 공통 JSON projection은 Supabase RPC가 TABLE 반환 배열이 아니라 곧바로 object/array를 받게 한다.
create or replace function private.routine_reinforcer_json(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id',r.id,'name',r.name,'unit',r.unit::text,'unit_label',r.unit_label)
  from public.routine_reinforcers r where r.id=p_id
$$;
create or replace function private.routine_draft_json(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id',d.id,'family_id',d.family_id,'source_rule_id',d.source_rule_id,'step',d.step,
    'revision',d.revision,'payload',d.payload,'status',d.status::text,'published_rule_id',d.published_rule_id,
    'effective_from',d.effective_from,'updated_at',d.updated_at)
  from public.routine_drafts d where d.id=p_id
$$;
create or replace function private.routine_rule_json(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id',r.id,'family_id',r.family_id,'subject_ref_id',r.subject_ref_id,'name',r.name,
    'effective_from',r.effective_from,'version',r.version,'payload',r.payload)
  from public.routine_rules r where r.id=p_id
$$;
create or replace function private.routine_assignment_json(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id',a.id,'rule_id',a.rule_id,'child_profile_id',a.child_profile_id,'child_name',cp.display_name,
    'rule_name',r.name,'flow',r.flow::text,'starts_on',a.starts_on,'ends_on',a.ends_on,'weekdays',to_jsonb(a.weekdays),
    'repeat',a.repeat_kind::text)
  from public.routine_assignments a join public.child_profiles cp on cp.id=a.child_profile_id
  join public.routine_rules r on r.id=a.rule_id where a.id=p_id
$$;

create or replace function public.list_routine_reinforcers(p_family_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_actor uuid := private.current_verified_principal_id();
begin
  if p_family_id is null or v_actor is null or not private.activity_actor_is_verified_parent(v_actor,p_family_id) then
    raise exception 'ROUTINE_ACCESS_REQUIRED' using errcode='42501';
  end if;
  return coalesce((select jsonb_agg(private.routine_reinforcer_json(r.id) order by lower(r.name),r.id)
    from public.routine_reinforcers r where r.family_id=p_family_id),'[]'::jsonb);
end $$;

create or replace function public.create_routine_reinforcer(
  p_family_id uuid, p_name text, p_unit text, p_unit_label text, p_idempotency_key uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := private.current_verified_principal_id(); v_name text := nullif(btrim(p_name),'');
  v_label text := nullif(btrim(p_unit_label),''); v_unit public.routine_reinforcer_unit;
  v_payload jsonb; v_replay jsonb; v_id uuid;
begin
  if p_family_id is null or p_idempotency_key is null or v_actor is null or v_name is null or v_label is null
     or char_length(v_name)>100 or char_length(v_label)>40 or p_unit is null or upper(btrim(p_unit)) not in ('WON','MIN','POINT','STRING') then
    raise exception 'ROUTINE_INVALID_REINFORCER' using errcode='22023';
  end if;
  if not private.activity_actor_is_verified_parent(v_actor,p_family_id) then raise exception 'ROUTINE_ACCESS_REQUIRED' using errcode='42501'; end if;
  v_unit:=upper(btrim(p_unit))::public.routine_reinforcer_unit;
  v_payload:=jsonb_build_object('family_id',p_family_id,'name',v_name,'unit',v_unit::text,'unit_label',v_label);
  v_replay:=private.routine_replay(v_actor,p_idempotency_key,'CREATE_REINFORCER',v_payload);
  if v_replay is not null then return v_replay; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_family_id::text||':'||lower(v_name)||':'||v_unit::text||':'||lower(v_label),17018));
  select r.id into v_id from public.routine_reinforcers r
   where r.family_id=p_family_id and lower(btrim(r.name))=lower(v_name) and r.unit=v_unit and lower(btrim(r.unit_label))=lower(v_label);
  if v_id is null then
    insert into public.routine_reinforcers(family_id,name,unit,unit_label,created_by_principal_id)
    values(p_family_id,v_name,v_unit,v_label,v_actor) returning id into v_id;
  end if;
  v_replay:=private.routine_reinforcer_json(v_id);
  perform private.routine_record_request(v_actor,p_idempotency_key,'CREATE_REINFORCER',v_payload,v_replay);
  return v_replay;
end $$;

create or replace function public.list_routine_registry(p_family_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_actor uuid := private.current_verified_principal_id();
begin
  if p_family_id is null or v_actor is null or not private.activity_actor_is_verified_parent(v_actor,p_family_id) then raise exception 'ROUTINE_ACCESS_REQUIRED' using errcode='42501'; end if;
  return jsonb_build_object(
    'drafts',coalesce((select jsonb_agg(private.routine_draft_json(d.id) order by d.updated_at desc,d.id) from public.routine_drafts d where d.family_id=p_family_id),'[]'::jsonb),
    'rules',coalesce((select jsonb_agg(private.routine_rule_json(r.id) order by r.effective_from desc,r.version desc,r.id) from public.routine_rules r where r.family_id=p_family_id),'[]'::jsonb)
  );
end $$;

create or replace function public.save_routine_draft(
  p_family_id uuid, p_draft_id uuid, p_source_rule_id uuid, p_step integer, p_payload jsonb,
  p_expected_revision integer, p_idempotency_key uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := private.current_verified_principal_id(); v_draft public.routine_drafts%rowtype;
  v_source public.routine_rules%rowtype; v_payload jsonb; v_response jsonb; v_replay jsonb;
begin
  if p_family_id is null or p_step is null or p_step not between 1 and 3 or p_expected_revision is null or p_expected_revision < 0
     or p_idempotency_key is null or v_actor is null then raise exception 'ROUTINE_INVALID_DRAFT_SAVE' using errcode='22023'; end if;
  if not private.activity_actor_is_verified_parent(v_actor,p_family_id) then raise exception 'ROUTINE_ACCESS_REQUIRED' using errcode='42501'; end if;
  perform private.routine_assert_payload(p_payload,false,p_family_id);
  v_payload:=jsonb_build_object('family_id',p_family_id,'draft_id',p_draft_id,'source_rule_id',p_source_rule_id,
    'step',p_step,'payload',p_payload,'expected_revision',p_expected_revision);
  v_replay:=private.routine_replay(v_actor,p_idempotency_key,'SAVE_DRAFT',v_payload);
  if v_replay is not null then return v_replay; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_family_id::text||':'||coalesce(p_draft_id::text,'new'),17019));
  if p_source_rule_id is not null then
    select r.* into v_source from public.routine_rules r where r.id=p_source_rule_id and r.family_id=p_family_id;
    if v_source.id is null then raise exception 'ROUTINE_SOURCE_RULE_NOT_FOUND' using errcode='22023'; end if;
  end if;
  if p_draft_id is null then
    if p_expected_revision <> 0 then raise exception 'ROUTINE_DRAFT_REVISION_CONFLICT' using errcode='40001'; end if;
    insert into public.routine_drafts(family_id,source_rule_id,step,revision,payload,created_by_principal_id)
    values(p_family_id,p_source_rule_id,p_step,0,p_payload,v_actor) returning * into v_draft;
  else
    select d.* into v_draft from public.routine_drafts d where d.id=p_draft_id and d.family_id=p_family_id for update;
    if v_draft.id is null then raise exception 'ROUTINE_DRAFT_NOT_FOUND' using errcode='P0002'; end if;
    if v_draft.status <> 'DRAFT' then raise exception 'ROUTINE_PUBLISHED_DRAFT_IMMUTABLE' using errcode='55000'; end if;
    if v_draft.revision <> p_expected_revision then raise exception 'ROUTINE_DRAFT_REVISION_CONFLICT' using errcode='40001'; end if;
    if p_source_rule_id is distinct from v_draft.source_rule_id then raise exception 'ROUTINE_DRAFT_SOURCE_IMMUTABLE' using errcode='22023'; end if;
    perform set_config('private.routine_draft_write','on',true);
    update public.routine_drafts set step=p_step,payload=p_payload,revision=revision+1 where id=v_draft.id returning * into v_draft;
  end if;
  v_response:=private.routine_draft_json(v_draft.id);
  perform private.routine_record_request(v_actor,p_idempotency_key,'SAVE_DRAFT',v_payload,v_response);
  return v_response;
end $$;

create or replace function public.publish_routine_draft(
  p_draft_id uuid, p_expected_revision integer, p_idempotency_key uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := private.current_verified_principal_id(); v_draft public.routine_drafts%rowtype;
  v_source public.routine_rules%rowtype; v_ref_id uuid; v_ref_type uuid; v_group uuid; v_version integer;
  v_rule_id uuid; v_condition_id uuid; v_tier jsonb; v_reward jsonb; v_reinforcer public.routine_reinforcers%rowtype;
  v_effective date; v_payload jsonb; v_response jsonb; v_replay jsonb; v_stable_key text; v_tier_no integer:=0;
begin
  if p_draft_id is null or p_expected_revision is null or p_expected_revision < 0 or p_idempotency_key is null or v_actor is null then raise exception 'ROUTINE_INVALID_PUBLISH' using errcode='22023'; end if;
  select d.* into v_draft from public.routine_drafts d where d.id=p_draft_id for update;
  if v_draft.id is null then raise exception 'ROUTINE_DRAFT_NOT_FOUND' using errcode='P0002'; end if;
  if not private.activity_actor_is_verified_parent(v_actor,v_draft.family_id) then raise exception 'ROUTINE_ACCESS_REQUIRED' using errcode='42501'; end if;
  v_payload:=jsonb_build_object('draft_id',p_draft_id,'expected_revision',p_expected_revision,'payload',v_draft.payload);
  v_replay:=private.routine_replay(v_actor,p_idempotency_key,'PUBLISH_DRAFT',v_payload);
  if v_replay is not null then return v_replay; end if;
  if v_draft.status <> 'DRAFT' then raise exception 'ROUTINE_DRAFT_NOT_PUBLISHABLE' using errcode='55000'; end if;
  if v_draft.revision <> p_expected_revision then raise exception 'ROUTINE_DRAFT_REVISION_CONFLICT' using errcode='40001'; end if;
  perform private.routine_assert_payload(v_draft.payload,true,v_draft.family_id);
  perform pg_advisory_xact_lock(hashtextextended(v_draft.family_id::text,17020));
  if v_draft.source_rule_id is not null then
    select r.* into v_source from public.routine_rules r where r.id=v_draft.source_rule_id and r.family_id=v_draft.family_id;
    if v_source.id is null or lower(btrim(v_source.name)) <> lower(btrim(v_draft.payload->>'name')) then raise exception 'ROUTINE_SOURCE_MUST_MATCH_ACTIVITY' using errcode='22023'; end if;
    v_ref_id:=v_source.subject_ref_id; v_group:=v_source.rule_group_id;
  else
    -- A new draft reuses its approved activity ref and continues the newest lineage for that ref.
    -- This avoids independent version=1 groups when a parent registers the same activity again.
    select rc.id into v_ref_id from public.ref_concepts rc
      where rc.family_id=v_draft.family_id and rc.status='APPROVED'
        and lower(btrim(rc.label))=lower(btrim(v_draft.payload->>'name'))
      order by rc.created_at, rc.id limit 1;
    if v_ref_id is null then
      select id into v_ref_type from public.ref_concept_types where code='ACTIVITY';
      if v_ref_type is null then raise exception 'ROUTINE_ACTIVITY_REF_TYPE_MISSING' using errcode='55000'; end if;
      v_stable_key:=lower(regexp_replace(btrim(v_draft.payload->>'name'),'[^[:alnum:]]+','-','g'))||'-'||left(replace(extensions.gen_random_uuid()::text,'-',''),10);
      insert into public.ref_concepts(family_id,concept_type_id,stable_key,label,created_by_principal_id)
      values(v_draft.family_id,v_ref_type,v_stable_key,btrim(v_draft.payload->>'name'),v_actor) returning id into v_ref_id;
    else
      select r.rule_group_id into v_group from public.routine_rules r
        where r.family_id=v_draft.family_id and r.subject_ref_id=v_ref_id
        order by r.effective_from desc, r.version desc, r.published_at desc, r.id desc limit 1;
    end if;
  end if;
  if v_group is null then v_group:=extensions.gen_random_uuid(); end if;
  select coalesce(max(r.version),0)+1 into v_version from public.routine_rules r where r.rule_group_id=v_group;
  v_effective:=private.next_family_local_rule_date(v_draft.family_id);
  insert into public.routine_rules(family_id,subject_ref_id,source_rule_id,rule_group_id,name,category_code,flow,measurement,period,payload,effective_from,version,published_by_principal_id)
  values(v_draft.family_id,v_ref_id,v_draft.source_rule_id,v_group,btrim(v_draft.payload->>'name'),(v_draft.payload->>'category')::public.activity_category_code,
    (v_draft.payload->>'flow')::public.routine_flow,v_draft.payload->>'measurement',(v_draft.payload->>'period')::public.routine_period,v_draft.payload,v_effective,v_version,v_actor)
  returning id into v_rule_id;
  for v_tier in select value from jsonb_array_elements(v_draft.payload->'tiers') loop
    v_tier_no:=v_tier_no+1;
    insert into public.routine_conditions(family_id,rule_id,source_tier_id,tier_no,label,threshold,operator)
    values(v_draft.family_id,v_rule_id,(v_tier->>'id')::uuid,v_tier_no,btrim(v_tier->>'label'),(v_tier->>'threshold')::numeric,v_tier->>'operator')
    returning id into v_condition_id;
    for v_reward in select value from jsonb_array_elements(v_tier->'rewards') loop
      select r.* into v_reinforcer from public.routine_reinforcers r where r.id=(v_reward->>'reinforcerId')::uuid and r.family_id=v_draft.family_id;
      insert into public.routine_reward_items(family_id,condition_id,source_reward_id,reinforcer_id,name_snapshot,unit_snapshot,unit_label_snapshot,amount,text_value)
      values(v_draft.family_id,v_condition_id,(v_reward->>'id')::uuid,v_reinforcer.id,v_reinforcer.name,v_reinforcer.unit,v_reinforcer.unit_label,
        case when v_reward->'amount'='null'::jsonb then null else (v_reward->>'amount')::numeric end,nullif(btrim(v_reward->>'text'),''));
    end loop;
  end loop;
  perform set_config('private.routine_draft_write','on',true);
  update public.routine_drafts set status='PUBLISHED',published_rule_id=v_rule_id,effective_from=v_effective where id=v_draft.id;
  v_response:=private.routine_rule_json(v_rule_id);
  perform private.routine_record_request(v_actor,p_idempotency_key,'PUBLISH_DRAFT',v_payload,v_response);
  return v_response;
end $$;

create or replace function public.create_routine_assignment(
  p_family_id uuid, p_rule_id uuid, p_child_profile_id uuid, p_starts_on date, p_ends_on date,
  p_weekdays integer[], p_repeat text, p_idempotency_key uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid:=private.current_verified_principal_id(); v_rule public.routine_rules%rowtype; v_child public.child_profiles%rowtype;
  v_repeat public.routine_repeat_kind; v_days integer[]; v_tomorrow date; v_assignment_id uuid; v_payload jsonb; v_response jsonb; v_replay jsonb;
begin
  if p_family_id is null or p_rule_id is null or p_child_profile_id is null or p_starts_on is null or p_repeat is null or p_idempotency_key is null or v_actor is null
     or upper(btrim(p_repeat)) not in ('DAILY','ONCE') or not private.routine_weekdays_are_valid(p_weekdays) then raise exception 'ROUTINE_INVALID_ASSIGNMENT' using errcode='22023'; end if;
  if not private.activity_actor_is_verified_parent(v_actor,p_family_id) then raise exception 'ROUTINE_ACCESS_REQUIRED' using errcode='42501'; end if;
  v_repeat:=upper(btrim(p_repeat))::public.routine_repeat_kind;
  v_days:=case when v_repeat='ONCE' then array[extract(isodow from p_starts_on)::integer] else p_weekdays end;
  if (v_repeat='ONCE' and p_ends_on is distinct from p_starts_on) or (v_repeat='DAILY' and p_ends_on is not null and p_ends_on<p_starts_on) then raise exception 'ROUTINE_INVALID_ASSIGNMENT' using errcode='22023'; end if;
  v_payload:=jsonb_build_object('family_id',p_family_id,'rule_id',p_rule_id,'child_profile_id',p_child_profile_id,'starts_on',p_starts_on,'ends_on',p_ends_on,'weekdays',to_jsonb(v_days),'repeat',v_repeat::text);
  v_replay:=private.routine_replay(v_actor,p_idempotency_key,'CREATE_ASSIGNMENT',v_payload); if v_replay is not null then return v_replay; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_family_id::text,17021));
  select r.* into v_rule from public.routine_rules r where r.id=p_rule_id and r.family_id=p_family_id;
  select cp.* into v_child from public.child_profiles cp where cp.id=p_child_profile_id and cp.family_id=p_family_id;
  if v_rule.id is null or v_child.id is null or v_child.status<>'ACTIVE' or not exists(select 1 from public.family_memberships fm join public.principals pr on pr.id=fm.principal_id and pr.status='ACTIVE' join auth.users u on u.id=pr.auth_user_id and u.email_confirmed_at is not null where fm.family_id=p_family_id and fm.principal_id=v_child.principal_id and fm.role='CHILD' and fm.status='ACTIVE') then raise exception 'ROUTINE_ACCESS_REQUIRED' using errcode='42501'; end if;
  v_tomorrow:=private.routine_family_today(p_family_id)+1;
  if p_starts_on<v_tomorrow or p_starts_on<v_rule.effective_from or (v_rule.flow='DAILY' and v_rule.period='SPECIAL_EVENT' and v_repeat<>'ONCE') then raise exception 'ROUTINE_RULE_NOT_ASSIGNABLE' using errcode='22023'; end if;
  if exists(select 1 from public.routine_rules r where r.family_id=p_family_id and r.rule_group_id=v_rule.rule_group_id and r.effective_from<=p_starts_on and (r.effective_from>v_rule.effective_from or (r.effective_from=v_rule.effective_from and r.version>v_rule.version))) then raise exception 'ROUTINE_RULE_NOT_LATEST' using errcode='22023'; end if;
  if exists(select 1 from public.routine_assignments a join public.routine_rules r on r.id=a.rule_id where a.family_id=p_family_id and a.child_profile_id=p_child_profile_id and r.subject_ref_id=v_rule.subject_ref_id and a.schedule_range && daterange(p_starts_on,case when p_ends_on is null then null else p_ends_on+1 end,'[)') and private.routine_schedules_share_date(a.starts_on,a.ends_on,a.weekdays,p_starts_on,p_ends_on,v_days))
     or private.routine_assignment_conflicts_legacy(p_family_id,p_child_profile_id,v_rule.subject_ref_id,p_starts_on,p_ends_on,v_days) then raise exception 'ROUTINE_ASSIGNMENT_CONFLICT' using errcode='23P01'; end if;
  insert into public.routine_assignments(family_id,rule_id,child_profile_id,starts_on,ends_on,weekdays,repeat_kind,created_by_principal_id)
  values(p_family_id,p_rule_id,p_child_profile_id,p_starts_on,p_ends_on,v_days,v_repeat,v_actor) returning id into v_assignment_id;
  v_response:=private.routine_assignment_json(v_assignment_id); perform private.routine_record_request(v_actor,p_idempotency_key,'CREATE_ASSIGNMENT',v_payload,v_response); return v_response;
end $$;

create or replace function public.list_routine_assignments(p_family_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_actor uuid:=private.current_verified_principal_id(); begin
  if p_family_id is null or v_actor is null or not private.activity_actor_is_verified_parent(v_actor,p_family_id) then raise exception 'ROUTINE_ACCESS_REQUIRED' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(private.routine_assignment_json(a.id) order by cp.display_name,a.starts_on,r.name,a.id) from public.routine_assignments a join public.child_profiles cp on cp.id=a.child_profile_id join public.routine_rules r on r.id=a.rule_id where a.family_id=p_family_id),'[]'::jsonb);
end $$;

create or replace function public.end_routine_assignment(p_assignment_id uuid,p_ends_on date,p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid:=private.current_verified_principal_id(); v_assignment public.routine_assignments%rowtype; v_payload jsonb; v_response jsonb; v_replay jsonb; v_today date;
begin
  if p_assignment_id is null or p_ends_on is null or p_idempotency_key is null or v_actor is null then raise exception 'ROUTINE_INVALID_ASSIGNMENT_END' using errcode='22023'; end if;
  select a.* into v_assignment from public.routine_assignments a where a.id=p_assignment_id for update;
  if v_assignment.id is null or not private.activity_actor_is_verified_parent(v_actor,v_assignment.family_id) then raise exception 'ROUTINE_ACCESS_REQUIRED' using errcode='42501'; end if;
  v_payload:=jsonb_build_object('assignment_id',p_assignment_id,'ends_on',p_ends_on);
  v_replay:=private.routine_replay(v_actor,p_idempotency_key,'END_ASSIGNMENT',v_payload); if v_replay is not null then return v_replay; end if;
  v_today:=private.routine_family_today(v_assignment.family_id);
  if p_ends_on<v_today or p_ends_on<v_assignment.starts_on or (v_assignment.ends_on is not null and p_ends_on>v_assignment.ends_on) then raise exception 'ROUTINE_INVALID_ASSIGNMENT_END' using errcode='22023'; end if;
  if p_ends_on is distinct from v_assignment.ends_on then
    insert into public.routine_assignment_end_events(family_id,assignment_id,actor_principal_id,prior_ends_on,ends_on) values(v_assignment.family_id,v_assignment.id,v_actor,v_assignment.ends_on,p_ends_on);
    perform set_config('private.routine_assignment_end_update','on',true); update public.routine_assignments set ends_on=p_ends_on where id=v_assignment.id;
  end if;
  v_response:=private.routine_assignment_json(v_assignment.id); perform private.routine_record_request(v_actor,p_idempotency_key,'END_ASSIGNMENT',v_payload,v_response); return v_response;
end $$;

-- 해당 일의 활성 배정만 원자적으로 materialize 한다. 시작일 이전/종료일 이후에는 occurrence를 만들지 않는다.
create or replace function private.materialize_routine_day(p_child_profile_id uuid,p_business_date date)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.routine_occurrences(family_id,child_profile_id,assignment_id,rule_id,business_date)
  select a.family_id,a.child_profile_id,a.id,a.rule_id,p_business_date
  from public.routine_assignments a join public.routine_rules r on r.id=a.rule_id
  where a.child_profile_id=p_child_profile_id and a.starts_on<=p_business_date and (a.ends_on is null or a.ends_on>=p_business_date)
    and r.effective_from<=p_business_date and extract(isodow from p_business_date)::integer=any(a.weekdays)
  on conflict(assignment_id,business_date) do nothing;
end $$;

create or replace function private.routine_tiers_json(
  p_rule_id uuid,p_child_id uuid,p_period_start date,p_period_end date,p_score numeric,p_flow public.routine_flow
) returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'label',c.label,'threshold',c.threshold,'operator',c.operator,
    'reached',case when p_flow='QUEST' then case when c.operator='GT' then p_score>c.threshold else p_score>=c.threshold end
      else coalesce((select sum(o.stickers) from public.routine_occurrences o where o.child_profile_id=p_child_id and o.rule_id=p_rule_id and o.business_date between p_period_start and p_period_end and o.parent_verified_at is not null),0)>=c.threshold end,
    'rewards',coalesce((select jsonb_agg(jsonb_build_object('id',ri.id,'name',ri.name_snapshot,'unit',ri.unit_snapshot::text,'unit_label',ri.unit_label_snapshot,'amount',ri.amount,'text',coalesce(ri.text_value,'')) order by ri.id) from public.routine_reward_items ri where ri.condition_id=c.id),'[]'::jsonb)
  ) order by c.tier_no),'[]'::jsonb) from public.routine_conditions c where c.rule_id=p_rule_id
$$;

create or replace function public.list_routine_day(p_child_profile_id uuid,p_business_date date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid:=private.current_verified_principal_id(); v_family uuid; v_today date;
begin
  select cp.family_id,private.routine_family_today(cp.family_id) into v_family,v_today from public.child_profiles cp where cp.id=p_child_profile_id;
  if p_child_profile_id is null or p_business_date is null or v_actor is null or v_family is null or v_today is null or p_business_date>v_today
     or not (private.activity_actor_is_verified_parent(v_actor,v_family) or private.activity_actor_is_verified_child_self(v_actor,p_child_profile_id)) then raise exception 'ROUTINE_ACCESS_REQUIRED' using errcode='42501'; end if;
  perform private.materialize_routine_day(p_child_profile_id,p_business_date);
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id',o.id,'assignment_id',o.assignment_id,'rule_id',o.rule_id,'business_date',o.business_date,'name',r.name,
    'child_label',r.payload->>'childLabel','criteria',r.payload->>'criteria','category',r.category_code::text,'flow',r.flow::text,
    'measurement',r.measurement,'sticker_icon',r.payload->>'stickerIcon','period',r.period::text,
    'period_start',private.routine_period_start(r.period,o.business_date),'period_end',private.routine_period_end(r.period,o.business_date),
    'period_closed',private.routine_family_today(o.family_id)>private.routine_period_end(r.period,o.business_date),
    'child_reported',o.child_reported_at is not null,'verification_status',case when o.parent_verified_at is not null then 'CONFIRMED' when o.child_reported_at is not null then 'HELD' else 'MISSING' end,
    'score',o.score,'pass',o.pass,'praise',o.praise,'stickers',o.stickers,
    'sticker_total',case when r.flow='DAILY' then coalesce((select sum(x.stickers) from public.routine_occurrences x where x.child_profile_id=o.child_profile_id and x.rule_id=o.rule_id and x.business_date between private.routine_period_start(r.period,o.business_date) and private.routine_period_end(r.period,o.business_date) and x.parent_verified_at is not null),0) else 0 end,
    'revision',o.current_revision,'parent_reason',o.parent_reason,'parent_verified_at',o.parent_verified_at,
    'penalty_minutes',case when r.flow='QUEST' and o.parent_verified_at is not null and r.payload->'penaltyLimit'<>'null'::jsonb and o.score<(r.payload->>'penaltyLimit')::numeric then -((r.payload->>'penaltyMinutes')::integer) else null end,
    'tiers',private.routine_tiers_json(o.rule_id,o.child_profile_id,private.routine_period_start(r.period,o.business_date),private.routine_period_end(r.period,o.business_date),o.score,r.flow)
  ) order by r.name,o.assignment_id) from public.routine_occurrences o join public.routine_rules r on r.id=o.rule_id where o.child_profile_id=p_child_profile_id and o.business_date=p_business_date),'[]'::jsonb);
end $$;

create or replace function private.routine_issue_quest_entitlements(p_occurrence_id uuid,p_actor uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_occ public.routine_occurrences%rowtype; v_rule public.routine_rules%rowtype; v_condition public.routine_conditions%rowtype; v_reward public.routine_reward_items%rowtype; v_count integer:=0; v_reached boolean;
begin
  select o.* into v_occ from public.routine_occurrences o where o.id=p_occurrence_id;
  select r.* into v_rule from public.routine_rules r where r.id=v_occ.rule_id;
  if v_rule.flow<>'QUEST' or v_occ.parent_verified_at is null then return 0; end if;
  for v_condition in select * from public.routine_conditions c where c.rule_id=v_rule.id order by c.tier_no loop
    v_reached:=case when v_condition.operator='GT' then v_occ.score>v_condition.threshold else v_occ.score>=v_condition.threshold end;
    if v_reached then
      for v_reward in select * from public.routine_reward_items ri where ri.condition_id=v_condition.id order by ri.id loop
        insert into public.routine_entitlements(family_id,child_profile_id,rule_id,condition_id,reward_item_id,source_occurrence_id,source_date,period_start,period_end,created_by_principal_id)
        values(v_occ.family_id,v_occ.child_profile_id,v_rule.id,v_condition.id,v_reward.id,v_occ.id,v_occ.business_date,v_occ.business_date,v_occ.business_date,p_actor)
        on conflict(child_profile_id,rule_id,source_occurrence_id,condition_id,reward_item_id) where source_occurrence_id is not null do nothing;
        if found then
          v_count:=v_count+1;
          insert into public.routine_entitlement_events(family_id,entitlement_id,actor_principal_id,event_kind,request_payload)
          select e.family_id,e.id,p_actor,'ISSUED',jsonb_build_object('source','PARENT_VERIFIED','occurrence_id',v_occ.id,'condition_id',v_condition.id,'reward_item_id',v_reward.id)
          from public.routine_entitlements e where e.child_profile_id=v_occ.child_profile_id and e.rule_id=v_rule.id and e.source_occurrence_id=v_occ.id and e.condition_id=v_condition.id and e.reward_item_id=v_reward.id;
        end if;
      end loop;
    end if;
  end loop;
  return v_count;
end $$;

create or replace function private.routine_mark_lower_correction_review(p_occurrence_id uuid,p_actor uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_occ public.routine_occurrences%rowtype; v_rule public.routine_rules%rowtype;
  v_condition public.routine_conditions%rowtype; v_ent public.routine_entitlements%rowtype;
  v_should boolean; v_start date; v_end date; v_total integer;
begin
  select * into v_occ from public.routine_occurrences where id=p_occurrence_id;
  select * into v_rule from public.routine_rules where id=v_occ.rule_id;
  if v_rule.flow='QUEST' then
    for v_ent in select * from public.routine_entitlements where source_occurrence_id=p_occurrence_id and requires_review=false loop
      select * into v_condition from public.routine_conditions where id=v_ent.condition_id;
      v_should:=case when v_condition.operator='GT' then v_occ.score>v_condition.threshold else v_occ.score>=v_condition.threshold end;
      if not v_should then
        update public.routine_entitlements set requires_review=true where id=v_ent.id;
        insert into public.routine_entitlement_events(family_id,entitlement_id,actor_principal_id,event_kind,request_payload)
        values(v_ent.family_id,v_ent.id,p_actor,'REVIEW_REQUIRED',jsonb_build_object('reason','CORRECTION_LOWER_RESULT','occurrence_id',p_occurrence_id));
      end if;
    end loop;
  else
    -- Daily rewards are sourced by a closed calendar period. A later PASS→fail or praise removal
    -- may invalidate a previously issued tier; retain it (including FULFILLED) and require review.
    v_start:=private.routine_period_start(v_rule.period,v_occ.business_date);
    v_end:=private.routine_period_end(v_rule.period,v_occ.business_date);
    select coalesce(sum(o.stickers),0)::integer into v_total from public.routine_occurrences o
      where o.child_profile_id=v_occ.child_profile_id and o.rule_id=v_rule.id
        and o.business_date between v_start and v_end and o.parent_verified_at is not null;
    for v_ent in select * from public.routine_entitlements
      where child_profile_id=v_occ.child_profile_id and rule_id=v_rule.id and source_occurrence_id is null
        and period_start=v_start and period_end=v_end and requires_review=false loop
      select * into v_condition from public.routine_conditions where id=v_ent.condition_id;
      if v_total < v_condition.threshold then
        update public.routine_entitlements set requires_review=true where id=v_ent.id;
        insert into public.routine_entitlement_events(family_id,entitlement_id,actor_principal_id,event_kind,request_payload)
        values(v_ent.family_id,v_ent.id,p_actor,'REVIEW_REQUIRED',jsonb_build_object('reason','CORRECTION_LOWER_STICKER_TOTAL','occurrence_id',p_occurrence_id,'sticker_total',v_total,'period_start',v_start,'period_end',v_end));
      end if;
    end loop;
  end if;
end $$;

-- A later factual verification can restore eligibility for the exact immutable origin facts.
-- It never creates a duplicate entitlement, changes a fulfilled state, or represents a transfer;
-- it only clears a previously raised human-review flag and appends the resolution audit event.
create or replace function private.routine_restore_quest_entitlement_review(p_occurrence_id uuid,p_actor uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_occ public.routine_occurrences%rowtype; v_condition public.routine_conditions%rowtype;
  v_ent public.routine_entitlements%rowtype; v_eligible boolean;
begin
  select * into v_occ from public.routine_occurrences where id=p_occurrence_id;
  for v_ent in select * from public.routine_entitlements where source_occurrence_id=p_occurrence_id and requires_review=true loop
    select * into v_condition from public.routine_conditions where id=v_ent.condition_id;
    v_eligible:=case when v_condition.operator='GT' then v_occ.score>v_condition.threshold else v_occ.score>=v_condition.threshold end;
    if v_eligible then
      update public.routine_entitlements set requires_review=false where id=v_ent.id and requires_review=true;
      if found then
        insert into public.routine_entitlement_events(family_id,entitlement_id,actor_principal_id,event_kind,request_payload)
        values(v_ent.family_id,v_ent.id,p_actor,'REVIEW_RESOLVED',jsonb_build_object('reason','CORRECTION_RESTORED_RESULT','occurrence_id',p_occurrence_id,'status_preserved',v_ent.status::text));
      end if;
    end if;
  end loop;
end $$;

create or replace function private.routine_restore_daily_period_entitlement_review(
  p_child_profile_id uuid,p_rule_id uuid,p_period_start date,p_period_end date,p_total integer,p_actor uuid
) returns void language plpgsql security definer set search_path = '' as $$
declare v_ent public.routine_entitlements%rowtype; v_condition public.routine_conditions%rowtype;
begin
  for v_ent in select * from public.routine_entitlements
    where child_profile_id=p_child_profile_id and rule_id=p_rule_id and source_occurrence_id is null
      and period_start=p_period_start and period_end=p_period_end and requires_review=true loop
    select * into v_condition from public.routine_conditions where id=v_ent.condition_id;
    if p_total >= v_condition.threshold then
      update public.routine_entitlements set requires_review=false where id=v_ent.id and requires_review=true;
      if found then
        insert into public.routine_entitlement_events(family_id,entitlement_id,actor_principal_id,event_kind,request_payload)
        values(v_ent.family_id,v_ent.id,p_actor,'REVIEW_RESOLVED',jsonb_build_object('reason','CORRECTION_RESTORED_STICKER_TOTAL','sticker_total',p_total,'period_start',p_period_start,'period_end',p_period_end,'status_preserved',v_ent.status::text));
      end if;
    end if;
  end loop;
end $$;

create or replace function public.report_routine_done(p_occurrence_id uuid,p_expected_revision integer,p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid:=private.current_verified_principal_id(); v_occ public.routine_occurrences%rowtype; v_payload jsonb; v_response jsonb:=jsonb_build_object('ok',true); v_replay jsonb;
begin
  if p_occurrence_id is null or p_expected_revision is null or p_expected_revision<0 or p_idempotency_key is null or v_actor is null then raise exception 'ROUTINE_INVALID_DONE_REPORT' using errcode='22023'; end if;
  select * into v_occ from public.routine_occurrences where id=p_occurrence_id for update;
  if v_occ.id is null or not private.activity_actor_is_verified_child_self(v_actor,v_occ.child_profile_id) then raise exception 'ROUTINE_ACCESS_REQUIRED' using errcode='42501'; end if;
  if v_occ.business_date > private.routine_family_today(v_occ.family_id) then raise exception 'ROUTINE_FUTURE_OCCURRENCE' using errcode='22023'; end if;
  v_payload:=jsonb_build_object('occurrence_id',p_occurrence_id,'expected_revision',p_expected_revision);
  v_replay:=private.routine_replay(v_actor,p_idempotency_key,'REPORT_DONE',v_payload); if v_replay is not null then return v_replay; end if;
  if v_occ.current_revision<>p_expected_revision then raise exception 'ROUTINE_OCCURRENCE_REVISION_CONFLICT' using errcode='40001'; end if;
  insert into public.routine_occurrence_events(family_id,occurrence_id,actor_principal_id,event_kind,idempotency_key,expected_revision) values(v_occ.family_id,v_occ.id,v_actor,'CHILD_REPORTED',p_idempotency_key,p_expected_revision);
  update public.routine_occurrences set child_reported_at=coalesce(child_reported_at,now()),current_revision=current_revision+1 where id=v_occ.id;
  perform private.routine_record_request(v_actor,p_idempotency_key,'REPORT_DONE',v_payload,v_response); return v_response;
end $$;

create or replace function public.verify_routine_occurrence(
  p_occurrence_id uuid,p_score numeric,p_pass boolean,p_praise boolean,p_reason text,p_expected_revision integer,p_idempotency_key uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid:=private.current_verified_principal_id(); v_occ public.routine_occurrences%rowtype; v_rule public.routine_rules%rowtype;
  v_reason text:=nullif(btrim(p_reason),''); v_stickers integer; v_payload jsonb; v_response jsonb:=jsonb_build_object('ok',true); v_replay jsonb;
  v_period_start date;
begin
  if p_occurrence_id is null or p_expected_revision is null or p_expected_revision<0 or p_idempotency_key is null or v_actor is null or v_reason is null or char_length(v_reason)>1000 or p_praise is null then raise exception 'ROUTINE_INVALID_VERIFICATION' using errcode='22023'; end if;
  -- IDs and published rules are immutable. Read only enough to authorize and acquire the same
  -- child/rule/period lock used by close-period before the projection row is locked.
  select * into v_occ from public.routine_occurrences where id=p_occurrence_id;
  if v_occ.id is null then raise exception 'ROUTINE_ACCESS_REQUIRED' using errcode='42501'; end if;
  select * into v_rule from public.routine_rules where id=v_occ.rule_id;
  if v_rule.id is null or not private.activity_actor_is_verified_parent(v_actor,v_occ.family_id) then raise exception 'ROUTINE_ACCESS_REQUIRED' using errcode='42501'; end if;
  if v_occ.business_date > private.routine_family_today(v_occ.family_id) then raise exception 'ROUTINE_FUTURE_OCCURRENCE' using errcode='22023'; end if;
  v_period_start:=private.routine_period_start(v_rule.period,v_occ.business_date);
  perform pg_advisory_xact_lock(hashtextextended('routine-period:'||v_occ.child_profile_id::text||':'||v_occ.rule_id::text||':'||v_period_start::text,17022));
  select * into v_occ from public.routine_occurrences where id=p_occurrence_id for update;
  select * into v_rule from public.routine_rules where id=v_occ.rule_id;
  if (v_rule.flow='DAILY' and (p_pass is null or p_score is not null)) or (v_rule.flow='QUEST' and (p_score is null or p_score::text in ('NaN','Infinity','-Infinity') or p_score<0 or p_score>100 or p_pass is not null or p_praise)) then raise exception 'ROUTINE_INVALID_FLOW_VERIFICATION' using errcode='22023'; end if;
  if v_rule.flow='DAILY' and not p_pass and p_praise then raise exception 'ROUTINE_PRAISE_REQUIRES_PASS' using errcode='22023'; end if;
  v_stickers:=case when v_rule.flow='DAILY' then case when p_pass then 1+case when p_praise then 1 else 0 end else 0 end else null end;
  v_payload:=jsonb_build_object('occurrence_id',p_occurrence_id,'score',p_score,'pass',p_pass,'praise',p_praise,'reason',v_reason,'expected_revision',p_expected_revision);
  v_replay:=private.routine_replay(v_actor,p_idempotency_key,'VERIFY_OCCURRENCE',v_payload); if v_replay is not null then return v_replay; end if;
  if v_occ.current_revision<>p_expected_revision then raise exception 'ROUTINE_OCCURRENCE_REVISION_CONFLICT' using errcode='40001'; end if;
  insert into public.routine_occurrence_events(family_id,occurrence_id,actor_principal_id,event_kind,idempotency_key,expected_revision,score,pass,praise,stickers,reason)
  values(v_occ.family_id,v_occ.id,v_actor,'PARENT_VERIFIED',p_idempotency_key,p_expected_revision,p_score,p_pass,p_praise,v_stickers,v_reason);
  update public.routine_occurrences set parent_verified_at=now(),score=p_score,pass=p_pass,praise=p_praise,stickers=v_stickers,parent_reason=v_reason,current_revision=current_revision+1 where id=v_occ.id;
  if v_rule.flow='QUEST' then
    perform private.routine_issue_quest_entitlements(v_occ.id,v_actor);
    perform private.routine_restore_quest_entitlement_review(v_occ.id,v_actor);
  end if;
  perform private.routine_mark_lower_correction_review(v_occ.id,v_actor);
  perform private.routine_record_request(v_actor,p_idempotency_key,'VERIFY_OCCURRENCE',v_payload,v_response); return v_response;
end $$;

create or replace function public.confirm_routine_period(
  p_child_profile_id uuid,p_rule_id uuid,p_reference_date date,p_idempotency_key uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid:=private.current_verified_principal_id(); v_rule public.routine_rules%rowtype; v_child public.child_profiles%rowtype;
  v_start date; v_end date; v_total integer; v_issued integer:=0; v_cond public.routine_conditions%rowtype; v_reward public.routine_reward_items%rowtype;
  v_payload jsonb; v_response jsonb; v_replay jsonb;
begin
  if p_child_profile_id is null or p_rule_id is null or p_reference_date is null or p_idempotency_key is null or v_actor is null then raise exception 'ROUTINE_INVALID_PERIOD_CONFIRMATION' using errcode='22023'; end if;
  select * into v_rule from public.routine_rules where id=p_rule_id;
  select * into v_child from public.child_profiles where id=p_child_profile_id;
  if v_rule.id is null or v_child.id is null or v_child.family_id<>v_rule.family_id or v_rule.flow<>'DAILY' or not private.activity_actor_is_verified_parent(v_actor,v_rule.family_id) then raise exception 'ROUTINE_ACCESS_REQUIRED' using errcode='42501'; end if;
  if p_reference_date>private.routine_family_today(v_rule.family_id) then raise exception 'ROUTINE_INVALID_PERIOD_REFERENCE' using errcode='22023'; end if;
  v_start:=private.routine_period_start(v_rule.period,p_reference_date); v_end:=private.routine_period_end(v_rule.period,p_reference_date);
  -- This is intentionally the exact lock key used by verify_routine_occurrence. It serializes
  -- final sticker corrections and a closed-period issue decision without locking immutable rules.
  perform pg_advisory_xact_lock(hashtextextended('routine-period:'||p_child_profile_id::text||':'||p_rule_id::text||':'||v_start::text,17022));
  v_payload:=jsonb_build_object('child_profile_id',p_child_profile_id,'rule_id',p_rule_id,'reference_date',p_reference_date);
  v_replay:=private.routine_replay(v_actor,p_idempotency_key,'CONFIRM_PERIOD',v_payload); if v_replay is not null then return v_replay; end if;
  if private.routine_family_today(v_rule.family_id)<=v_end then raise exception 'ROUTINE_PERIOD_NOT_CLOSED' using errcode='22023'; end if;
  if not exists(select 1 from public.routine_assignments a where a.child_profile_id=p_child_profile_id and a.rule_id=p_rule_id and a.starts_on<=p_reference_date and (a.ends_on is null or a.ends_on>=p_reference_date) and extract(isodow from p_reference_date)::integer=any(a.weekdays)) then raise exception 'ROUTINE_REFERENCE_MUST_BE_ASSIGNED_DATE' using errcode='22023'; end if;
  select coalesce(sum(o.stickers),0)::integer into v_total from public.routine_occurrences o where o.child_profile_id=p_child_profile_id and o.rule_id=p_rule_id and o.business_date between v_start and v_end and o.parent_verified_at is not null;
  for v_cond in select * from public.routine_conditions c where c.rule_id=p_rule_id and v_total>=c.threshold order by c.tier_no loop
    for v_reward in select * from public.routine_reward_items ri where ri.condition_id=v_cond.id order by ri.id loop
      insert into public.routine_entitlements(family_id,child_profile_id,rule_id,condition_id,reward_item_id,source_date,period_start,period_end,created_by_principal_id)
      values(v_rule.family_id,p_child_profile_id,p_rule_id,v_cond.id,v_reward.id,v_end,v_start,v_end,v_actor)
      on conflict(child_profile_id,rule_id,period_start,period_end,condition_id,reward_item_id) where source_occurrence_id is null do nothing;
      if found then
        v_issued:=v_issued+1;
        insert into public.routine_entitlement_events(family_id,entitlement_id,actor_principal_id,event_kind,request_payload)
        select e.family_id,e.id,v_actor,'ISSUED',jsonb_build_object('source','PERIOD_CLOSED_PARENT_VERIFICATION','sticker_total',v_total,'reference_date',p_reference_date,'period_start',v_start,'period_end',v_end)
        from public.routine_entitlements e where e.child_profile_id=p_child_profile_id and e.rule_id=p_rule_id and e.period_start=v_start and e.period_end=v_end and e.condition_id=v_cond.id and e.reward_item_id=v_reward.id;
      end if;
    end loop;
  end loop;
  perform private.routine_restore_daily_period_entitlement_review(p_child_profile_id,p_rule_id,v_start,v_end,v_total,v_actor);
  v_response:=jsonb_build_object('ok',true,'issued',v_issued); perform private.routine_record_request(v_actor,p_idempotency_key,'CONFIRM_PERIOD',v_payload,v_response); return v_response;
end $$;

create or replace function private.routine_entitlement_json(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id',e.id,'child_profile_id',e.child_profile_id,'rule_id',e.rule_id,'rule_name',r.name,'condition_label',c.label,
    'source_date',e.source_date,'period_start',e.period_start,'period_end',e.period_end,'name',ri.name_snapshot,'unit',ri.unit_snapshot::text,
    'unit_label',ri.unit_label_snapshot,'amount',ri.amount,'text',coalesce(ri.text_value,''),'status',e.status::text,
    'requires_review',e.requires_review,'created_at',e.created_at,'fulfilled_at',e.fulfilled_at)
  from public.routine_entitlements e join public.routine_rules r on r.id=e.rule_id join public.routine_conditions c on c.id=e.condition_id join public.routine_reward_items ri on ri.id=e.reward_item_id where e.id=p_id
$$;

create or replace function public.list_routine_entitlements(p_child_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_actor uuid:=private.current_verified_principal_id(); v_family uuid;
begin
  select family_id into v_family from public.child_profiles where id=p_child_profile_id;
  if p_child_profile_id is null or v_actor is null or v_family is null or not (private.activity_actor_is_verified_parent(v_actor,v_family) or private.activity_actor_is_verified_child_self(v_actor,p_child_profile_id)) then raise exception 'ROUTINE_ACCESS_REQUIRED' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(private.routine_entitlement_json(e.id) order by e.created_at desc,e.id) from public.routine_entitlements e where e.child_profile_id=p_child_profile_id),'[]'::jsonb);
end $$;

create or replace function public.fulfill_routine_entitlement(p_entitlement_id uuid,p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid:=private.current_verified_principal_id(); v_ent public.routine_entitlements%rowtype; v_payload jsonb; v_response jsonb:=jsonb_build_object('ok',true); v_replay jsonb;
begin
  if p_entitlement_id is null or p_idempotency_key is null or v_actor is null then raise exception 'ROUTINE_INVALID_ENTITLEMENT_FULFILLMENT' using errcode='22023'; end if;
  select * into v_ent from public.routine_entitlements where id=p_entitlement_id for update;
  if v_ent.id is null or not private.activity_actor_is_verified_parent(v_actor,v_ent.family_id) then raise exception 'ROUTINE_ACCESS_REQUIRED' using errcode='42501'; end if;
  v_payload:=jsonb_build_object('entitlement_id',p_entitlement_id); v_replay:=private.routine_replay(v_actor,p_idempotency_key,'FULFILL_ENTITLEMENT',v_payload); if v_replay is not null then return v_replay; end if;
  if v_ent.requires_review or v_ent.status<>'AVAILABLE' then raise exception 'ROUTINE_ENTITLEMENT_NOT_FULFILLABLE' using errcode='22023'; end if;
  update public.routine_entitlements set status='FULFILLED',fulfilled_by_principal_id=v_actor,fulfilled_at=now() where id=v_ent.id;
  insert into public.routine_entitlement_events(family_id,entitlement_id,actor_principal_id,event_kind,request_payload) values(v_ent.family_id,v_ent.id,v_actor,'FULFILLED',v_payload);
  perform private.routine_record_request(v_actor,p_idempotency_key,'FULFILL_ENTITLEMENT',v_payload,v_response); return v_response;
end $$;

-- raw table surface를 닫고 RPC만 authenticated에게 연다. anon/PUBLIC에는 별도 grant가 없다.
alter table public.routine_reinforcers enable row level security;
alter table public.routine_drafts enable row level security;
alter table public.routine_rules enable row level security;
alter table public.routine_conditions enable row level security;
alter table public.routine_reward_items enable row level security;
alter table public.routine_assignments enable row level security;
alter table public.routine_assignment_end_events enable row level security;
alter table public.routine_occurrences enable row level security;
alter table public.routine_occurrence_events enable row level security;
alter table public.routine_entitlements enable row level security;
alter table public.routine_entitlement_events enable row level security;
alter table public.routine_request_events enable row level security;
revoke all on table public.routine_reinforcers,public.routine_drafts,public.routine_rules,public.routine_conditions,public.routine_reward_items,public.routine_assignments,public.routine_assignment_end_events,public.routine_occurrences,public.routine_occurrence_events,public.routine_entitlements,public.routine_entitlement_events,public.routine_request_events from public,anon,authenticated;
revoke all on all functions in schema private from public,anon,authenticated;
revoke all on function public.list_routine_reinforcers(uuid),public.create_routine_reinforcer(uuid,text,text,text,uuid),public.list_routine_registry(uuid),public.save_routine_draft(uuid,uuid,uuid,integer,jsonb,integer,uuid),public.publish_routine_draft(uuid,integer,uuid),public.create_routine_assignment(uuid,uuid,uuid,date,date,integer[],text,uuid),public.list_routine_assignments(uuid),public.end_routine_assignment(uuid,date,uuid),public.list_routine_day(uuid,date),public.report_routine_done(uuid,integer,uuid),public.verify_routine_occurrence(uuid,numeric,boolean,boolean,text,integer,uuid),public.confirm_routine_period(uuid,uuid,date,uuid),public.list_routine_entitlements(uuid),public.fulfill_routine_entitlement(uuid,uuid) from public,anon,authenticated;
grant execute on function public.list_routine_reinforcers(uuid),public.create_routine_reinforcer(uuid,text,text,text,uuid),public.list_routine_registry(uuid),public.save_routine_draft(uuid,uuid,uuid,integer,jsonb,integer,uuid),public.publish_routine_draft(uuid,integer,uuid),public.create_routine_assignment(uuid,uuid,uuid,date,date,integer[],text,uuid),public.list_routine_assignments(uuid),public.end_routine_assignment(uuid,date,uuid),public.list_routine_day(uuid,date),public.report_routine_done(uuid,integer,uuid),public.verify_routine_occurrence(uuid,numeric,boolean,boolean,text,integer,uuid),public.confirm_routine_period(uuid,uuid,date,uuid),public.list_routine_entitlements(uuid),public.fulfill_routine_entitlement(uuid,uuid) to authenticated;
commit;
