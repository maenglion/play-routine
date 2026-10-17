begin;
-- October runtime: standalone operational enforcement layer.  It deliberately does not alter
-- legacy activity/routine/manual-reward tables or their historical facts.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Fail closed if this is pointed at an incomplete or non-Play-Routine database.
do $preflight$
begin
  if to_regclass('public.families') is null
     or to_regclass('public.child_profiles') is null
     or to_regclass('public.principals') is null
     or to_regclass('public.family_memberships') is null
     or to_regclass('play_audit.events') is null
     or to_regprocedure('auth.uid()') is null
     or to_regprocedure('private.current_verified_principal_id()') is null then
    raise exception 'OCTOBER_RUNTIME_PREREQUISITES_MISSING' using errcode = '55000';
  end if;
end;
$preflight$;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create extension if not exists btree_gist with schema extensions;

do $$ begin create type public.october_jurisdiction as enum ('FAMILY'); exception when duplicate_object then null; end $$;
do $$ begin create type public.october_ordinance_kind as enum ('OCTOBER_ENFORCEMENT'); exception when duplicate_object then null; end $$;
do $$ begin create type public.october_rule_domain as enum ('TASK','QUEST','LIFESTYLE'); exception when duplicate_object then null; end $$;
do $$ begin create type public.october_rule_period as enum ('DAILY','WEEKLY','MONTHLY','EVENT'); exception when duplicate_object then null; end $$;
do $$ begin create type public.october_plan_status as enum ('ACTIVE','ENDED'); exception when duplicate_object then null; end $$;
do $$ begin create type public.october_school_asset as enum ('MINUTES','COUPAY_KRW','PENDING'); exception when duplicate_object then null; end $$;
do $$ begin create type public.october_occurrence_state as enum ('UNCONFIRMED','SELF_REPORTED','PASS','NO_PASS','PENALTY','NO_VIOLATION','LIMIT_EXCEEDED','REVIEW_REQUIRED'); exception when duplicate_object then null; end $$;
do $$ begin create type public.october_occurrence_event_kind as enum ('SUBMITTED','CONFIRMED'); exception when duplicate_object then null; end $$;
do $$ begin create type public.october_bucket_type as enum ('SCHOOL','RULE_ROUND'); exception when duplicate_object then null; end $$;
do $$ begin create type public.october_right_asset as enum ('MINUTES','CASH_KRW','COUPAY_KRW'); exception when duplicate_object then null; end $$;
do $$ begin create type public.october_right_status as enum ('ISSUED','REVIEW_REQUIRED','VOIDED'); exception when duplicate_object then null; end $$;

-- Identity/version separation makes published regulation text and adopted snapshots immutable.
create table if not exists public.october_ordinances (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  stable_code text not null,
  title text not null,
  jurisdiction public.october_jurisdiction not null,
  created_by_principal_id uuid not null references public.principals(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (id, family_id),
  unique (family_id, stable_code),
  check (stable_code ~ '^[A-Z0-9_]{3,80}$'),
  check (char_length(btrim(title)) between 1 and 160)
);

create table if not exists public.october_ordinance_versions (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  ordinance_id uuid not null,
  version integer not null check (version > 0),
  ordinance_kind public.october_ordinance_kind not null,
  source_label text not null,
  source_snapshot jsonb not null default '{}'::jsonb,
  adopted_by_principal_id uuid not null references public.principals(id) on delete restrict,
  adopted_at timestamptz not null default now(),
  unique (id, family_id),
  unique (ordinance_id, version),
  foreign key (ordinance_id, family_id) references public.october_ordinances(id, family_id) on delete restrict,
  check (char_length(btrim(source_label)) between 1 and 200),
  check (jsonb_typeof(source_snapshot) = 'object' and octet_length(source_snapshot::text) <= 4096)
);

create table if not exists public.october_rule_identities (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  ordinance_id uuid not null,
  stable_code text not null,
  created_by_principal_id uuid not null references public.principals(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (id, family_id),
  unique (ordinance_id, stable_code),
  foreign key (ordinance_id, family_id) references public.october_ordinances(id, family_id) on delete restrict,
  check (stable_code ~ '^[QTL]-[0-9]{3}$')
);

create table if not exists public.october_rule_versions (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  rule_identity_id uuid not null,
  ordinance_version_id uuid not null,
  version integer not null check (version > 0),
  domain public.october_rule_domain not null,
  name text not null,
  criteria text not null,
  period public.october_rule_period not null,
  daily_limit integer,
  condition_spec jsonb not null,
  effect_spec jsonb not null,
  created_by_principal_id uuid not null references public.principals(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (id, family_id),
  unique (rule_identity_id, version),
  foreign key (rule_identity_id, family_id) references public.october_rule_identities(id, family_id) on delete restrict,
  foreign key (ordinance_version_id, family_id) references public.october_ordinance_versions(id, family_id) on delete restrict,
  check (char_length(btrim(name)) between 1 and 160),
  check (char_length(btrim(criteria)) between 1 and 1200),
  check ((daily_limit is null) or daily_limit between 1 and 20),
  check (jsonb_typeof(condition_spec) = 'object' and octet_length(condition_spec::text) <= 8192),
  check (jsonb_typeof(effect_spec) = 'object' and octet_length(effect_spec::text) <= 4096)
);

create table if not exists public.october_plans (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  ordinance_version_id uuid not null,
  month date not null,
  effective_from date not null,
  effective_to date not null,
  status public.october_plan_status not null default 'ACTIVE',
  school_asset public.october_school_asset not null default 'PENDING',
  created_by_principal_id uuid not null references public.principals(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (id, family_id),
  foreign key (ordinance_version_id, family_id) references public.october_ordinance_versions(id, family_id) on delete restrict,
  check (month = date_trunc('month', month::timestamp)::date),
  check (effective_to > effective_from),
  check (effective_from >= month and effective_to <= (month + interval '1 month')::date)
);
create unique index if not exists october_one_active_plan_per_family_month
  on public.october_plans(family_id, month) where status = 'ACTIVE';

create table if not exists public.october_plan_adoptions (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  plan_id uuid not null,
  child_profile_id uuid not null,
  rule_version_id uuid not null,
  adopted_by_principal_id uuid not null references public.principals(id) on delete restrict,
  adopted_at timestamptz not null default now(),
  unique (id, family_id),
  unique (plan_id, child_profile_id, rule_version_id),
  foreign key (plan_id, family_id) references public.october_plans(id, family_id) on delete restrict,
  foreign key (child_profile_id, family_id) references public.child_profiles(id, family_id) on delete restrict,
  foreign key (rule_version_id, family_id) references public.october_rule_versions(id, family_id) on delete restrict
);

-- occurrence is a guarded current snapshot.  Submission/confirmation facts are append-only below.
create table if not exists public.october_occurrences (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  adoption_id uuid not null,
  child_profile_id uuid not null,
  rule_version_id uuid not null,
  business_date date not null,
  slot text not null default 'daily',
  state public.october_occurrence_state not null default 'UNCONFIRMED',
  self_reported boolean not null default false,
  confirmed_at timestamptz,
  reason text,
  metrics jsonb not null default '{}'::jsonb,
  effects jsonb not null default '[]'::jsonb,
  recognized_count integer not null default 0,
  current_revision integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, family_id),
  unique (adoption_id, business_date, slot),
  foreign key (adoption_id, family_id) references public.october_plan_adoptions(id, family_id) on delete restrict,
  foreign key (child_profile_id, family_id) references public.child_profiles(id, family_id) on delete restrict,
  foreign key (rule_version_id, family_id) references public.october_rule_versions(id, family_id) on delete restrict,
  check (slot = 'daily' or slot ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  check (char_length(slot) <= 64),
  check (current_revision >= 0 and recognized_count >= 0 and recognized_count <= 3),
  check (reason is null or char_length(btrim(reason)) between 1 and 240),
  check (jsonb_typeof(metrics) = 'object' and octet_length(metrics::text) <= 4096),
  check (jsonb_typeof(effects) = 'array' and octet_length(effects::text) <= 1024),
  check ((confirmed_at is null and reason is null and state in ('UNCONFIRMED','SELF_REPORTED'))
      or (confirmed_at is not null and state not in ('UNCONFIRMED','SELF_REPORTED')))
);
create index if not exists october_occurrences_board_idx on public.october_occurrences(child_profile_id, business_date, rule_version_id, slot);

create table if not exists public.october_occurrence_events (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  occurrence_id uuid not null,
  actor_principal_id uuid not null references public.principals(id) on delete restrict,
  event_kind public.october_occurrence_event_kind not null,
  event_key uuid not null,
  revision_before integer not null check (revision_before >= 0),
  revision_after integer not null check (revision_after > revision_before),
  decision text,
  request_payload jsonb not null,
  reason text,
  recorded_at timestamptz not null default now(),
  unique (id, family_id),
  unique (actor_principal_id, event_key),
  foreign key (occurrence_id, family_id) references public.october_occurrences(id, family_id) on delete restrict,
  check (decision is null or decision in ('PASS','NO_PASS','PENALTY','NO_VIOLATION')),
  check (jsonb_typeof(request_payload) = 'object' and octet_length(request_payload::text) <= 8192),
  check (reason is null or char_length(btrim(reason)) between 1 and 240),
  check ((event_kind='SUBMITTED' and decision is null and reason is null)
      or (event_kind='CONFIRMED' and decision is not null))
);

-- SCHOOL close and EVENT highest-total rounds both use a bucket. School ranges are explicitly
-- half-open and may not overlap for the same adoption, including under concurrent closes.
create table if not exists public.october_buckets (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  adoption_id uuid not null,
  child_profile_id uuid not null,
  rule_version_id uuid not null,
  bucket_type public.october_bucket_type not null,
  period_start date not null,
  period_end date not null,
  recognized_total integer not null default 0,
  target_effects jsonb not null default '[]'::jsonb,
  closed_at timestamptz,
  created_by_principal_id uuid not null references public.principals(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, family_id),
  unique (adoption_id, bucket_type, period_start, period_end),
  foreign key (adoption_id, family_id) references public.october_plan_adoptions(id, family_id) on delete restrict,
  foreign key (child_profile_id, family_id) references public.child_profiles(id, family_id) on delete restrict,
  foreign key (rule_version_id, family_id) references public.october_rule_versions(id, family_id) on delete restrict,
  check (period_end > period_start),
  check (recognized_total >= 0),
  check (jsonb_typeof(target_effects) = 'array' and octet_length(target_effects::text) <= 1024)
);
alter table public.october_buckets drop constraint if exists october_school_bucket_no_overlap;
alter table public.october_buckets add constraint october_school_bucket_no_overlap
  exclude using gist (adoption_id with =, daterange(period_start, period_end, '[)') with &&)
  where (bucket_type = 'SCHOOL');
create index if not exists october_buckets_child_rule_range_idx
  on public.october_buckets(child_profile_id, rule_version_id, period_start, period_end);

-- A right is an externally fulfilled entitlement/pending deduction, never a payment, balance,
-- coupon redemption, or automatic clawback. Positive rights can be fulfilled in one server-set amount.
create table if not exists public.october_rights (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  child_profile_id uuid not null,
  rule_version_id uuid not null,
  source_occurrence_id uuid,
  bucket_id uuid,
  source_date date not null,
  asset public.october_right_asset not null,
  quantity integer not null check (quantity <> 0 and abs(quantity) <= 1000000000),
  fulfilled_quantity integer not null default 0,
  status public.october_right_status not null default 'ISSUED',
  issued_by_principal_id uuid not null references public.principals(id) on delete restrict,
  issued_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, family_id),
  foreign key (child_profile_id, family_id) references public.child_profiles(id, family_id) on delete restrict,
  foreign key (rule_version_id, family_id) references public.october_rule_versions(id, family_id) on delete restrict,
  foreign key (source_occurrence_id, family_id) references public.october_occurrences(id, family_id) on delete restrict,
  foreign key (bucket_id, family_id) references public.october_buckets(id, family_id) on delete restrict,
  check (num_nonnulls(source_occurrence_id, bucket_id) = 1),
  check ((quantity > 0 and fulfilled_quantity between 0 and quantity)
      or (quantity < 0 and fulfilled_quantity = 0))
);
create index if not exists october_rights_child_issued_idx on public.october_rights(child_profile_id, issued_at desc, id);
create index if not exists october_rights_occurrence_idx on public.october_rights(source_occurrence_id, asset) where source_occurrence_id is not null;
create index if not exists october_rights_bucket_idx on public.october_rights(bucket_id, asset) where bucket_id is not null;
create unique index if not exists october_rights_occurrence_exact_effect_uq
  on public.october_rights(source_occurrence_id, asset, quantity)
  where source_occurrence_id is not null;

create table if not exists public.october_fulfillments (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  right_id uuid not null,
  actor_principal_id uuid not null references public.principals(id) on delete restrict,
  event_key uuid not null,
  quantity integer not null check (quantity > 0),
  reason text not null,
  fulfilled_at timestamptz not null default now(),
  unique (id, family_id),
  unique (actor_principal_id, event_key),
  foreign key (right_id, family_id) references public.october_rights(id, family_id) on delete restrict,
  check (char_length(btrim(reason)) between 1 and 240)
);

-- Request payload retains the complete bounded RPC request solely for exact idempotent replay.
-- It is not exposed directly and is intentionally excluded from the audit allow-list.
create table if not exists public.october_request_events (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  actor_principal_id uuid not null references public.principals(id) on delete restrict,
  event_key uuid not null,
  action text not null,
  request_payload jsonb not null,
  response_payload jsonb not null,
  recorded_at timestamptz not null default now(),
  unique (id, family_id),
  unique (actor_principal_id, event_key),
  check (action in ('SUBMIT_OCCURRENCE','CONFIRM_OCCURRENCE','CLOSE_SCHOOL_WEEK','FULFILL_RIGHT')),
  check (jsonb_typeof(request_payload) = 'object' and octet_length(request_payload::text) <= 8192),
  check (jsonb_typeof(response_payload) = 'object' and octet_length(response_payload::text) <= 8192)
);

-- auth.uid()-based authorization is private and independently checks confirmed auth identity,
-- active principal/family and the membership validity interval. Guardians are deliberately not parents.
create or replace function private.october_current_verified_principal_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select p.id
  from public.principals p
  join auth.users u on u.id = p.auth_user_id and u.email_confirmed_at is not null
  where p.auth_user_id = auth.uid() and p.status = 'ACTIVE'
  limit 1
$$;

create or replace function
 private.october_actor_is_verified_parent(p_principal_id uuid, p_family_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.families f
    join public.family_memberships fm on fm.family_id=f.id and fm.principal_id=p_principal_id
      and fm.role in ('OWNER_PARENT','PARENT') and fm.status='ACTIVE'
      and fm.valid_from <= statement_timestamp() and (fm.valid_to is null or fm.valid_to > statement_timestamp())
    join public.principals p on p.id=fm.principal_id and p.status='ACTIVE'
    join auth.users u on u.id=p.auth_user_id and u.email_confirmed_at is not null
    where f.id=p_family_id and f.status='ACTIVE'
  )
$$;

create or replace function private.october_actor_is_verified_child_self(p_principal_id uuid, p_child_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.child_profiles cp
    join public.families f on f.id=cp.family_id and f.status='ACTIVE'
    join public.family_memberships fm on fm.family_id=cp.family_id and fm.principal_id=p_principal_id
      and fm.role='CHILD' and fm.status='ACTIVE'
      and fm.valid_from <= statement_timestamp() and (fm.valid_to is null or fm.valid_to > statement_timestamp())
    join public.principals p on p.id=cp.principal_id and p.id=p_principal_id and p.status='ACTIVE'
    join auth.users u on u.id=p.auth_user_id and u.email_confirmed_at is not null
    where cp.id=p_child_id and cp.status='ACTIVE'
  )
$$;

create or replace function private.october_family_today(p_family_id uuid)
returns date language sql stable security definer set search_path = '' as $$
  select (now() at time zone f.timezone)::date from public.families f where f.id=p_family_id and f.status='ACTIVE'
$$;

create or replace function private.october_effects_valid(p_effects jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare v jsonb; v_asset text; v_quantity numeric;
begin
  if jsonb_typeof(p_effects) <> 'array' or jsonb_array_length(p_effects) > 2 then return false; end if;
  for v in select value from jsonb_array_elements(p_effects) loop
    if jsonb_typeof(v) <> 'object' or (select count(*) from jsonb_object_keys(v)) <> 2
       or not (v ? 'asset' and v ? 'quantity') or jsonb_typeof(v->'asset') <> 'string' then return false; end if;
    v_asset:=v->>'asset';
    if v_asset not in ('MINUTES','CASH_KRW','COUPAY_KRW') then return false; end if;
    if v->'quantity' <> 'null'::jsonb then
      if jsonb_typeof(v->'quantity') <> 'number' then return false; end if;
      v_quantity:=(v->>'quantity')::numeric;
      if v_quantity = 0 or trunc(v_quantity) <> v_quantity or abs(v_quantity)>1000000000 then return false; end if;
    end if;
  end loop;
  return true;
end $$;

-- Rule seed is a privileged install operation; ordinary post-install direct writes are blocked.
create or replace function private.october_seed_write_allowed()
returns boolean language sql stable set search_path = '' as $$
  select current_setting('private.october_seed_write', true) = 'on'
$$;

create or replace function private.october_guard_immutable()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if private.october_seed_write_allowed() then
    if tg_op='DELETE' then return old; end if;
    return new;
  end if;
  raise exception 'OCTOBER_IMMUTABLE_RECORD' using errcode='55000';
end $$;

create or replace function private.october_guard_occurrence()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op='INSERT' and current_setting('private.october_occurrence_write',true)='on' then return new; end if;
  if tg_op='UPDATE' and current_setting('private.october_occurrence_write',true)='on'
    and new.id=old.id and new.family_id=old.family_id and new.adoption_id=old.adoption_id
    and new.child_profile_id=old.child_profile_id and new.rule_version_id=old.rule_version_id
    and new.business_date=old.business_date and new.slot=old.slot and new.created_at=old.created_at
    and new.current_revision=old.current_revision+1 then
    new.updated_at:=now(); return new;
  end if;
  raise exception 'OCTOBER_OCCURRENCE_RPC_ONLY' using errcode='55000';
end $$;

create or replace function private.october_guard_bucket()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op='INSERT' and current_setting('private.october_bucket_write',true)='on' then return new; end if;
  if tg_op='UPDATE' and current_setting('private.october_bucket_write',true)='on'
    and new.id=old.id and new.family_id=old.family_id and new.adoption_id=old.adoption_id
    and new.child_profile_id=old.child_profile_id and new.rule_version_id=old.rule_version_id
    and new.bucket_type=old.bucket_type and new.period_start=old.period_start and new.period_end=old.period_end then
    new.updated_at:=now(); return new;
  end if;
  raise exception 'OCTOBER_BUCKET_RPC_ONLY' using errcode='55000';
end $$;

create or replace function private.october_guard_right()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op='INSERT' and current_setting('private.october_right_write',true)='on' then return new; end if;
  if tg_op='UPDATE' and current_setting('private.october_right_write',true)='on'
    and new.id=old.id and new.family_id=old.family_id and new.child_profile_id=old.child_profile_id
    and new.rule_version_id=old.rule_version_id and new.source_occurrence_id is not distinct from old.source_occurrence_id
    and new.bucket_id is not distinct from old.bucket_id and new.source_date=old.source_date
    and new.asset=old.asset and new.quantity=old.quantity and new.issued_by_principal_id=old.issued_by_principal_id
    and new.issued_at=old.issued_at then
    new.updated_at:=now(); return new;
  end if;
  raise exception 'OCTOBER_RIGHT_RPC_ONLY' using errcode='55000';
end $$;

create or replace function private.october_guard_fulfillment()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op='INSERT' and current_setting('private.october_fulfillment_write',true)='on' then return new; end if;
  raise exception 'OCTOBER_FULFILLMENT_APPEND_ONLY' using errcode='55000';
end $$;

create or replace function private.october_guard_request_event()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op='INSERT' and current_setting('private.october_request_write',true)='on' then return new; end if;
  raise exception 'OCTOBER_REQUEST_EVENT_APPEND_ONLY' using errcode='55000';
end $$;

create or replace function private.october_guard_occurrence_event()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op='INSERT' and current_setting('private.october_event_write',true)='on' then return new; end if;
  raise exception 'OCTOBER_EVENT_APPEND_ONLY' using errcode='55000';
end $$;

-- Published seed entities are immutable. Their exact duplicate inserts remain impossible by unique keys.
drop trigger if exists october_ordinances_immutable on public.october_ordinances;
create trigger october_ordinances_immutable before update or delete on public.october_ordinances for each row execute function private.october_guard_immutable();
drop trigger if exists october_ordinance_versions_immutable on public.october_ordinance_versions;
create trigger october_ordinance_versions_immutable before update or delete on public.october_ordinance_versions for each row execute function private.october_guard_immutable();
drop trigger if exists october_rule_identities_immutable on public.october_rule_identities;
create trigger october_rule_identities_immutable before update or delete on public.october_rule_identities for each row execute function private.october_guard_immutable();
drop trigger if exists october_rule_versions_immutable on public.october_rule_versions;
create trigger october_rule_versions_immutable before update or delete on public.october_rule_versions for each row execute function private.october_guard_immutable();
drop trigger if exists october_plans_immutable on public.october_plans;
create trigger october_plans_immutable before update or delete on public.october_plans for each row execute function private.october_guard_immutable();
drop trigger if exists october_plan_adoptions_immutable on public.october_plan_adoptions;
create trigger october_plan_adoptions_immutable before update or delete on public.october_plan_adoptions for each row execute function private.october_guard_immutable();
drop trigger if exists october_occurrences_guard on public.october_occurrences;
create trigger october_occurrences_guard before insert or update or delete on public.october_occurrences for each row execute function private.october_guard_occurrence();
drop trigger if exists october_occurrence_events_guard on public.october_occurrence_events;
create trigger october_occurrence_events_guard before insert or update or delete on public.october_occurrence_events for each row execute function private.october_guard_occurrence_event();
drop trigger if exists october_buckets_guard on public.october_buckets;
create trigger october_buckets_guard before insert or update or delete on public.october_buckets for each row execute function private.october_guard_bucket();
drop trigger if exists october_rights_guard on public.october_rights;
create trigger october_rights_guard before insert or update or delete on public.october_rights for each row execute function private.october_guard_right();
drop trigger if exists october_fulfillments_guard on public.october_fulfillments;
create trigger october_fulfillments_guard before insert or update or delete on public.october_fulfillments for each row execute function private.october_guard_fulfillment();
drop trigger if exists october_request_events_guard on public.october_request_events;
create trigger october_request_events_guard before insert or update or delete on public.october_request_events for each row execute function private.october_guard_request_event();

-- Exact replay is by actor + event key + complete normalized payload. The advisory lock makes
-- concurrent duplicate requests deterministic before the unique constraint is reached.
create or replace function private.october_replay(p_actor uuid,p_key uuid,p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.october_request_events%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('october-key:'||p_actor::text||':'||p_key::text,21021));
  select * into v from public.october_request_events where actor_principal_id=p_actor and event_key=p_key for update;
  if v.id is null then return null; end if;
  if v.action=p_action and v.request_payload=p_payload then return v.response_payload; end if;
  raise exception 'OCTOBER_IDEMPOTENCY_KEY_REUSED' using errcode='22023';
end $$;
create or replace function private.october_record_request(p_family uuid,p_actor uuid,p_key uuid,p_action text,p_payload jsonb,p_response jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform set_config('private.october_request_write','on',true);
  insert into public.october_request_events(family_id,actor_principal_id,event_key,action,request_payload,response_payload)
  values(p_family,p_actor,p_key,p_action,p_payload,p_response);
end $$;

-- Both source canonical spellings are accepted for read compatibility. New importer writes
-- supportDays/excludedDates/eventDates/deadline; rules are still immutable snapshots.
create or replace function private.october_rule_is_scheduled(p_rule public.october_rule_versions,p_date date)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare s jsonb:=coalesce(p_rule.condition_spec->'schedule','{}'::jsonb); v_days jsonb; v_events jsonb;
begin
  if p_rule.domain='LIFESTYLE' and p_rule.period='EVENT' then return true; end if;
  v_events:=coalesce(s->'eventDates',case when s ? 'date' then jsonb_build_array(s->'date') else null end);
  if v_events is not null then return exists(select 1 from jsonb_array_elements_text(v_events) x where x::date=p_date); end if;
  if (s ? 'from' and p_date < (s->>'from')::date) or (s ? 'to' and p_date >= (s->>'to')::date) then return false; end if;
  if exists(select 1 from jsonb_array_elements_text(coalesce(s->'excludedDates',s->'excluded_dates','[]'::jsonb)) x where x::date=p_date) then return false; end if;
  v_days:=coalesce(s->'supportDays',s->'weekdays');
  if v_days is null then return true; end if;
  return exists(select 1 from jsonb_array_elements_text(v_days) x where x::integer=extract(isodow from p_date)::integer);
exception when others then
  raise exception 'OCTOBER_INVALID_RULE_SCHEDULE' using errcode='22023';
end $$;

create or replace function private.october_assert_active_adoption(p_family uuid,p_child uuid,p_rule uuid,p_date date)
returns public.october_plan_adoptions language plpgsql stable security definer set search_path = '' as $$
declare v public.october_plan_adoptions%rowtype;
begin
  select a.* into v from public.october_plan_adoptions a
  join public.october_plans p on p.id=a.plan_id and p.family_id=a.family_id and p.status='ACTIVE'
  join public.child_profiles c on c.id=a.child_profile_id and c.family_id=a.family_id and c.status='ACTIVE'
  where a.family_id=p_family and a.child_profile_id=p_child and a.rule_version_id=p_rule
    and p_date>=p.effective_from and p_date<p.effective_to;
  if v.id is null then raise exception 'OCTOBER_ACTIVE_ADOPTION_REQUIRED' using errcode='42501'; end if;
  return v;
end $$;

create or replace function private.october_materialize(p_adoption public.october_plan_adoptions,p_date date,p_slot text)
returns public.october_occurrences language plpgsql security definer set search_path = '' as $$
declare v public.october_occurrences%rowtype; r public.october_rule_versions%rowtype;
begin
  select * into r from public.october_rule_versions where id=p_adoption.rule_version_id and family_id=p_adoption.family_id;
  if r.id is null or (not private.october_rule_is_scheduled(r,p_date) and not (r.domain='LIFESTYLE' and r.period='EVENT')) then
    raise exception 'OCTOBER_DATE_NOT_SCHEDULED' using errcode='22023';
  end if;
  if p_slot<>'daily' and r.period<>'EVENT' and r.domain<>'LIFESTYLE' then raise exception 'OCTOBER_SLOT_ONLY_FOR_EVENT_RULE' using errcode='22023'; end if;
  perform set_config('private.october_occurrence_write','on',true);
  insert into public.october_occurrences(family_id,adoption_id,child_profile_id,rule_version_id,business_date,slot)
  values(p_adoption.family_id,p_adoption.id,p_adoption.child_profile_id,p_adoption.rule_version_id,p_date,p_slot)
  on conflict(adoption_id,business_date,slot) do nothing;
  select * into v from public.october_occurrences where adoption_id=p_adoption.id and business_date=p_date and slot=p_slot for update;
  return v;
end $$;

-- Client metrics are intentionally a small data shape. Any unsanctioned/long/free JSON is rejected.
create or replace function private.october_metrics_are_valid(p_code text,p_metrics jsonb,p_decision text)
returns boolean language plpgsql immutable set search_path = '' as $$
declare q jsonb; n integer; subj text; score numeric;
begin
  if p_metrics is null or jsonb_typeof(p_metrics)<>'object' then return false; end if;
  if p_code='Q-001' then
    if exists(select 1 from jsonb_object_keys(p_metrics) k where k not in ('passed','problemCount','seconds')) then return false; end if;
    if p_decision='PASS' then return p_metrics ?& array['passed','problemCount','seconds'] and p_metrics->'passed'='true'::jsonb and p_metrics->>'problemCount'='20' and jsonb_typeof(p_metrics->'seconds')='number' and (p_metrics->>'seconds')::numeric between 0 and 240 and trunc((p_metrics->>'seconds')::numeric)=(p_metrics->>'seconds')::numeric; end if;
    return true;
  elsif p_code='Q-003' then
    if exists(select 1 from jsonb_object_keys(p_metrics) k where k <> 'scores') or not (p_metrics ? 'scores') or jsonb_typeof(p_metrics->'scores')<>'array' or jsonb_array_length(p_metrics->'scores') not between 1 and 20 then return false; end if;
    for q in select value from jsonb_array_elements(p_metrics->'scores') loop
      if jsonb_typeof(q)<>'object' or (select count(*) from jsonb_object_keys(q))<>2 or not(q ?& array['subject','score']) or jsonb_typeof(q->'subject')<>'string' or char_length(btrim(q->>'subject')) not between 1 and 40 or jsonb_typeof(q->'score')<>'number' then return false; end if;
      score:=(q->>'score')::numeric; if score<0 or score>100 or trunc(score)<>score then return false; end if;
    end loop;
    return not exists(select 1 from (select lower(btrim(value->>'subject')) s from jsonb_array_elements(p_metrics->'scores')) x group by s having count(*)>1);
  elsif p_code='T-007' then
    return not exists(select 1 from jsonb_object_keys(p_metrics) k where k not in ('feedback','praised'))
      and p_metrics ?& array['feedback','praised'] and p_metrics->>'feedback' in ('NO_PROBLEM','PROBLEM') and jsonb_typeof(p_metrics->'praised')='boolean';
  elsif p_code='T-005' then
    return not exists(select 1 from jsonb_object_keys(p_metrics) k where k<>'noGiftedClass')
      and (extract(isodow from coalesce(nullif(current_setting('private.october_metrics_date',true),''),'2000-01-01')::date)::integer <> 6 or p_metrics->'noGiftedClass'='true'::jsonb);
  elsif p_code='L-013' then
    return not exists(select 1 from jsonb_object_keys(p_metrics) k where k<>'verifiedDirectly') and p_metrics->'verifiedDirectly'='true'::jsonb;
  elsif p_code in ('L-015','L-016') then
    return not exists(select 1 from jsonb_object_keys(p_metrics) k where k<>'incidentKey')
      and jsonb_typeof(p_metrics->'incidentKey')='string'
      and p_metrics->>'incidentKey' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  end if;
  return p_metrics='{}'::jsonb;
end $$;

-- The state projection is generated only from server-side rule snapshots and validated metrics.
create or replace function private.october_effects_for_confirmation(
  p_rule public.october_rule_versions,p_date date,p_decision text,p_metrics jsonb,p_school_asset public.october_school_asset
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_count integer; v_tier jsonb; v_best integer:=0; v_effect jsonb; v_asset text;
begin
  if p_decision not in ('PASS','PENALTY') then return '[]'::jsonb; end if;
  if p_rule.period='WEEKLY' then
    if p_rule.domain='TASK' and p_rule.condition_spec->>'kind'='SCHOOL_STICKERS' and p_decision='PASS' then
      if p_metrics->>'feedback'='NO_PROBLEM' then return jsonb_build_array(jsonb_build_object('asset','SCHOOL_BASIC','quantity',1)) || case when p_metrics->'praised'='true'::jsonb then jsonb_build_array(jsonb_build_object('asset','SCHOOL_PRAISE','quantity',1)) else '[]'::jsonb end; end if;
      if p_metrics->>'feedback'='PROBLEM' and p_metrics->'praised'='true'::jsonb then return jsonb_build_array(jsonb_build_object('asset','SCHOOL_PRAISE','quantity',1)); end if;
      return '[]'::jsonb;
    end if;
    return '[]'::jsonb;
  end if;
  if p_rule.condition_spec->>'kind'='SCHOOL_STICKERS' and p_school_asset='PENDING' then return '[]'::jsonb; end if;
  if p_rule.condition_spec->>'kind'='EXAM_HIGHEST' and p_decision='PASS' then
    select count(*) into v_count from jsonb_array_elements(p_metrics->'scores') x where (x->>'score')::integer >= 90;
    for v_tier in select value from jsonb_array_elements(p_rule.condition_spec->'tiers') loop
      if (select count(*) from jsonb_array_elements(p_metrics->'scores') x where (x->>'score')::integer >= (v_tier->>'min_score')::integer) >= (v_tier->>'min_subjects')::integer then
        v_best:=greatest(v_best,(v_tier->>'quantity')::integer);
      end if;
    end loop;
    if v_best=0 then return '[]'::jsonb; end if;
    return jsonb_build_array(jsonb_build_object('asset','MINUTES','quantity',v_best));
  end if;
  if not private.october_effects_valid(coalesce(p_rule.effect_spec->'effects','[]'::jsonb)) then
    raise exception 'OCTOBER_INVALID_SEEDED_EFFECTS' using errcode='55000';
  end if;
  if exists(select 1 from jsonb_array_elements(coalesce(p_rule.effect_spec->'effects','[]'::jsonb)) e where e->'quantity'='null'::jsonb) then return '[]'::jsonb; end if;
  if p_decision='PASS' then
    return coalesce((select jsonb_agg(e order by e->>'asset') from jsonb_array_elements(p_rule.effect_spec->'effects') e where (e->>'quantity')::integer>0),'[]'::jsonb);
  end if;
  return coalesce((select jsonb_agg(e order by e->>'asset') from jsonb_array_elements(p_rule.effect_spec->'effects') e where (e->>'quantity')::integer<0),'[]'::jsonb);
end $$;

create or replace function private.october_issue_occurrence_rights(p_occ public.october_occurrences,p_actor uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare e jsonb; n integer:=0; q integer; v_issue integer; v_already integer; v_code text;
begin
  if p_occ.state not in ('PASS','PENALTY') then return 0; end if;
  -- Q-003 is one 10/19..22 highest-total scope. Its entitlement is reconciled
  -- through one RULE_ROUND bucket, never issued by an individual event day/slot.
  select i.stable_code into v_code
  from public.october_rule_versions r
  join public.october_rule_identities i on i.id=r.rule_identity_id and i.family_id=r.family_id
  where r.id=p_occ.rule_version_id and r.family_id=p_occ.family_id;
  if v_code='Q-003' then return 0; end if;
  for e in select value from jsonb_array_elements(p_occ.effects) loop
    if e->>'asset' not in ('MINUTES','CASH_KRW','COUPAY_KRW') then continue; end if;
    q:=(e->>'quantity')::integer;
    if q=0 or (p_occ.state='PASS' and q<0) or (p_occ.state='PENALTY' and q>0) then continue; end if;
    -- Highest-total rewards (notably Q-003) are corrected by the positive net difference.
    -- Review-held lower corrections do not count as a current entitlement and are never clawed back.
    if q > 0 then
      select coalesce(sum(quantity),0)::integer into v_already from public.october_rights
        where source_occurrence_id=p_occ.id and asset=(e->>'asset')::public.october_right_asset and status='ISSUED';
      v_issue:=greatest(0,q-v_already);
    else
      if exists(select 1 from public.october_rights where source_occurrence_id=p_occ.id and asset=(e->>'asset')::public.october_right_asset and quantity=q and status='ISSUED') then
        v_issue:=0;
      else v_issue:=q; end if;
    end if;
    if v_issue=0 then continue; end if;
    perform set_config('private.october_right_write','on',true);
    insert into public.october_rights(family_id,child_profile_id,rule_version_id,source_occurrence_id,source_date,asset,quantity,issued_by_principal_id)
    values(p_occ.family_id,p_occ.child_profile_id,p_occ.rule_version_id,p_occ.id,p_occ.business_date,(e->>'asset')::public.october_right_asset,v_issue,p_actor)
    on conflict do nothing;
    if found then n:=n+1; end if;
  end loop;
  return n;
end $$;

-- A lower correction never deletes nor adjusts an issued right; it only puts affected rights in review.
create or replace function private.october_mark_lower_rights_review(p_occ public.october_occurrences,p_actor uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.october_rights%rowtype;
begin
  for r in select * from public.october_rights where source_occurrence_id=p_occ.id and status='ISSUED' loop
    if (r.quantity > 0 and coalesce((select max((e->>'quantity')::integer) from jsonb_array_elements(p_occ.effects) e where e->>'asset'=r.asset::text and e->'quantity'<>'null'::jsonb),0) < r.quantity)
       or (r.quantity < 0 and coalesce((select min((e->>'quantity')::integer) from jsonb_array_elements(p_occ.effects) e where e->>'asset'=r.asset::text and e->'quantity'<>'null'::jsonb),0) > r.quantity) then
      perform set_config('private.october_right_write','on',true);
      update public.october_rights set status='REVIEW_REQUIRED' where id=r.id;
    end if;
  end loop;
end $$;

create or replace function private.october_incident_conflict(p_occ public.october_occurrences,p_rule public.october_rule_versions,p_key uuid,p_metrics jsonb)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_rule.condition_spec ? 'exclusive_incident_group' and exists(
    select 1 from public.october_occurrences o
    join public.october_rule_versions r on r.id=o.rule_version_id and r.family_id=o.family_id
    where o.family_id=p_occ.family_id and o.child_profile_id=p_occ.child_profile_id
      and o.id<>p_occ.id and o.state in ('PENALTY','REVIEW_REQUIRED')
      and r.rule_identity_id<>p_rule.rule_identity_id
      and r.condition_spec->>'exclusive_incident_group'=p_rule.condition_spec->>'exclusive_incident_group'
      and o.metrics->>'incidentKey'=p_metrics->>'incidentKey'
  )
$$;

-- A same-incident L-015/L-016 decision is never resolved by retaining the first penalty.
-- The earlier row becomes a revisioned hold; any issued entitlement remains historically
-- preserved but review-held, with no automatic recovery or deletion.
create or replace function private.october_hold_incident_peers(p_occ public.october_occurrences,p_rule public.october_rule_versions,p_actor uuid,p_metrics jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_peer public.october_occurrences%rowtype;
begin
  for v_peer in
    select o.*
    from public.october_occurrences o
    join public.october_rule_versions r on r.id=o.rule_version_id and r.family_id=o.family_id
    where o.family_id=p_occ.family_id and o.child_profile_id=p_occ.child_profile_id
      and o.id<>p_occ.id and o.state='PENALTY'
      and r.rule_identity_id<>p_rule.rule_identity_id
      and r.condition_spec->>'exclusive_incident_group'=p_rule.condition_spec->>'exclusive_incident_group'
      and o.metrics->>'incidentKey'=p_metrics->>'incidentKey'
    for update of o
  loop
    perform set_config('private.october_occurrence_write','on',true);
    update public.october_occurrences
       set state='REVIEW_REQUIRED', effects='[]'::jsonb, recognized_count=0,
           current_revision=current_revision+1
     where id=v_peer.id
     returning * into v_peer;
    perform set_config('private.october_event_write','on',true);
    insert into public.october_occurrence_events
      (family_id,occurrence_id,actor_principal_id,event_kind,event_key,revision_before,revision_after,decision,request_payload,reason)
    values
      (v_peer.family_id,v_peer.id,p_actor,'CONFIRMED',extensions.gen_random_uuid(),
       v_peer.current_revision-1,v_peer.current_revision,'PENALTY',
       jsonb_build_object('action','INCIDENT_CONFLICT_HOLD','incident_key',p_metrics->>'incidentKey','peer_occurrence_id',p_occ.id),
       '같은 사건의 일반/기기 파손 중복 패널티 검토 보류');
    perform set_config('private.october_right_write','on',true);
    update public.october_rights
       set status='REVIEW_REQUIRED'
     where source_occurrence_id=v_peer.id and status='ISSUED';
  end loop;
end $$;

-- Q-003 has exactly one 2026-10-19..22 highest-total scope for a child and stable
-- rule ID. Revisions update that bucket and issue only target-minus-historical-rights.
-- On a lower correction, all retained positive increments are review-held: no delete,
-- no automatic recovery, and no reissue after excluding a reviewed increment.
create or replace function private.october_reconcile_q003_bucket(
  p_adoption public.october_plan_adoptions,p_rule public.october_rule_versions,p_actor uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_bucket public.october_buckets%rowtype; v_start date; v_end date;
  v_target_quantity integer:=0; v_historical_quantity integer:=0; v_diff integer:=0;
  v_target jsonb:='[]'::jsonb; v_right_id uuid;
begin
  select min(x.value::date),max(x.value::date)+1 into v_start,v_end
  from jsonb_array_elements_text(coalesce(p_rule.condition_spec->'schedule'->'eventDates','[]'::jsonb)) x;
  if v_start is null or v_end is null then raise exception 'OCTOBER_Q003_SCOPE_INVALID' using errcode='55000'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'october-q003:'||p_adoption.family_id::text||':'||p_adoption.child_profile_id::text||':'||p_rule.rule_identity_id::text||':'||v_start::text||':'||v_end::text,21021));
  select coalesce(max((e->>'quantity')::integer),0) into v_target_quantity
  from public.october_occurrences o
  join public.october_rule_versions r on r.id=o.rule_version_id and r.family_id=o.family_id
  join public.october_rule_identities i on i.id=r.rule_identity_id and i.family_id=r.family_id
  cross join lateral jsonb_array_elements(private.october_effects_for_confirmation(
    r,o.business_date,'PASS',o.metrics,'PENDING'::public.october_school_asset)) e
  where o.family_id=p_adoption.family_id and o.child_profile_id=p_adoption.child_profile_id
    and i.id=p_rule.rule_identity_id and o.business_date>=v_start and o.business_date<v_end
    and o.state='PASS' and e->>'asset'='MINUTES' and e->'quantity'<>'null'::jsonb;
  if v_target_quantity>0 then v_target:=jsonb_build_array(jsonb_build_object('asset','MINUTES','quantity',v_target_quantity)); end if;
  select b.* into v_bucket
  from public.october_buckets b
  join public.october_rule_versions r on r.id=b.rule_version_id and r.family_id=b.family_id
  where b.family_id=p_adoption.family_id and b.child_profile_id=p_adoption.child_profile_id
    and b.bucket_type='RULE_ROUND' and b.period_start=v_start and b.period_end=v_end
    and r.rule_identity_id=p_rule.rule_identity_id
  for update of b;
  perform set_config('private.october_bucket_write','on',true);
  if v_bucket.id is null then
    insert into public.october_buckets
      (family_id,adoption_id,child_profile_id,rule_version_id,bucket_type,period_start,period_end,recognized_total,target_effects,closed_at,created_by_principal_id)
    values
      (p_adoption.family_id,p_adoption.id,p_adoption.child_profile_id,p_rule.id,'RULE_ROUND',v_start,v_end,v_target_quantity,v_target,now(),p_actor)
    returning * into v_bucket;
  else
    update public.october_buckets set recognized_total=v_target_quantity,target_effects=v_target,closed_at=now()
    where id=v_bucket.id returning * into v_bucket;
  end if;
  select coalesce(sum(quantity),0)::integer into v_historical_quantity
  from public.october_rights
  where bucket_id=v_bucket.id and asset='MINUTES' and quantity>0 and status in ('ISSUED','REVIEW_REQUIRED');
  if v_historical_quantity>v_target_quantity then
    perform set_config('private.october_right_write','on',true);
    update public.october_rights set status='REVIEW_REQUIRED'
    where bucket_id=v_bucket.id and asset='MINUTES' and quantity>0 and status='ISSUED';
  elsif v_target_quantity>v_historical_quantity then
    v_diff:=v_target_quantity-v_historical_quantity;
    perform set_config('private.october_right_write','on',true);
    insert into public.october_rights
      (family_id,child_profile_id,rule_version_id,bucket_id,source_date,asset,quantity,issued_by_principal_id)
    values
      (p_adoption.family_id,p_adoption.child_profile_id,p_rule.id,v_bucket.id,v_end-1,'MINUTES',v_diff,p_actor)
    returning id into v_right_id;
  end if;
  return jsonb_build_object('bucket_id',v_bucket.id,'target_effects',v_target,'issued_difference',v_diff,
    'right_id',v_right_id,'historical_issued_total',v_historical_quantity);
end $$;

create or replace function public.submit_october_occurrence(
  p_family_id uuid,p_child_id uuid,p_rule_id uuid,p_date date,p_event_key uuid,p_slot text default 'daily'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid:=private.october_current_verified_principal_id(); v_adoption public.october_plan_adoptions%rowtype; v_occ public.october_occurrences%rowtype;
  v_payload jsonb; v_response jsonb; v_replay jsonb; v_slot text:=coalesce(nullif(btrim(p_slot),''),'daily'); v_is_child boolean;
begin
  if p_family_id is null or p_child_id is null or p_rule_id is null or p_date is null or p_event_key is null or char_length(v_slot)>64 or v_actor is null then raise exception 'OCTOBER_INVALID_SUBMISSION' using errcode='22023'; end if;
  v_is_child:=private.october_actor_is_verified_child_self(v_actor,p_child_id);
  if not (v_is_child or private.october_actor_is_verified_parent(v_actor,p_family_id)) then raise exception 'OCTOBER_SUBMISSION_ACCESS_REQUIRED' using errcode='42501'; end if;
  v_adoption:=private.october_assert_active_adoption(p_family_id,p_child_id,p_rule_id,p_date);
  if p_date>private.october_family_today(p_family_id) then raise exception 'OCTOBER_FUTURE_OCCURRENCE' using errcode='22023'; end if;
  v_payload:=jsonb_build_object('family_id',p_family_id,'child_id',p_child_id,'rule_id',p_rule_id,'date',p_date,'slot',v_slot);
  v_replay:=private.october_replay(v_actor,p_event_key,'SUBMIT_OCCURRENCE',v_payload); if v_replay is not null then return v_replay; end if;
  perform pg_advisory_xact_lock(hashtextextended('october-occ:'||v_adoption.id::text||':'||p_date::text||':'||v_slot,21021));
  v_occ:=private.october_materialize(v_adoption,p_date,v_slot);
  if v_occ.state not in ('UNCONFIRMED','SELF_REPORTED') then raise exception 'OCTOBER_OCCURRENCE_ALREADY_CONFIRMED' using errcode='22023'; end if;
  perform set_config('private.october_occurrence_write','on',true);
  update public.october_occurrences set self_reported=(self_reported or v_is_child),state=case when self_reported or v_is_child then 'SELF_REPORTED'::public.october_occurrence_state else 'UNCONFIRMED'::public.october_occurrence_state end,current_revision=current_revision+1 where id=v_occ.id returning * into v_occ;
  perform set_config('private.october_event_write','on',true);
  insert into public.october_occurrence_events(family_id,occurrence_id,actor_principal_id,event_kind,event_key,revision_before,revision_after,request_payload,reason)
  values(v_occ.family_id,v_occ.id,v_actor,'SUBMITTED',p_event_key,v_occ.current_revision-1,v_occ.current_revision,v_payload,null);
  v_response:=jsonb_build_object('id',v_occ.id,'revision',v_occ.current_revision,'state',v_occ.state::text);
  perform private.october_record_request(v_occ.family_id,v_actor,p_event_key,'SUBMIT_OCCURRENCE',v_payload,v_response);
  return v_response;
end $$;

create or replace function public.confirm_october_occurrence(
  p_family_id uuid,p_child_id uuid,p_rule_id uuid,p_date date,p_event_key uuid,p_decision text,p_metrics jsonb,p_reason text,
  p_slot text default 'daily',p_expected_revision integer default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid:=private.october_current_verified_principal_id(); v_adoption public.october_plan_adoptions%rowtype; v_occ public.october_occurrences%rowtype;
  v_rule public.october_rule_versions%rowtype; v_payload jsonb; v_response jsonb; v_replay jsonb; v_reason text:=nullif(btrim(p_reason),''); v_decision text:=upper(btrim(p_decision));
  v_state public.october_occurrence_state; v_effects jsonb; v_issued integer:=0; v_slot text:=coalesce(nullif(btrim(p_slot),''),'daily'); v_old_effects jsonb; v_code text; v_q003 jsonb;
begin
  if p_family_id is null or p_child_id is null or p_rule_id is null or p_date is null or p_event_key is null or v_actor is null
    or v_decision not in ('PASS','NO_PASS','PENALTY','NO_VIOLATION') or char_length(coalesce(v_reason,''))>240 or p_expected_revision is null or p_expected_revision<0 or char_length(v_slot)>64 then
    raise exception 'OCTOBER_INVALID_CONFIRMATION' using errcode='22023'; end if;
  if not private.october_actor_is_verified_parent(v_actor,p_family_id) then raise exception 'OCTOBER_PARENT_REQUIRED' using errcode='42501'; end if;
  v_adoption:=private.october_assert_active_adoption(p_family_id,p_child_id,p_rule_id,p_date);
  if p_date>private.october_family_today(p_family_id) then raise exception 'OCTOBER_FUTURE_OCCURRENCE' using errcode='22023'; end if;
  select * into v_rule from public.october_rule_versions where id=p_rule_id and family_id=p_family_id;
  if v_rule.id is null then raise exception 'OCTOBER_ACTIVE_ADOPTION_REQUIRED' using errcode='42501'; end if;
  if v_rule.condition_spec->>'kind'='ORIGAMI_COMPLETE' then
    perform pg_advisory_xact_lock(hashtextextended('october-month-cap:'||p_family_id::text||':'||p_child_id::text||':'||v_rule.rule_identity_id::text||':'||date_trunc('month',p_date::timestamp)::date::text,21021));
  end if;
  -- One lock key deliberately spans every slot and every version of the same stable rule on
  -- the family/child/business day. It serializes 3rd/4th lifestyle and daily task attempts.
  perform pg_advisory_xact_lock(hashtextextended('october-cap:'||p_family_id::text||':'||p_child_id::text||':'||v_rule.rule_identity_id::text||':'||p_date::text,21021));
  if (v_rule.effect_spec->>'kind'='PENALTY' and v_decision not in ('PENALTY','NO_VIOLATION')) or (v_rule.effect_spec->>'kind' in ('REWARD','SCHOOL') and v_decision not in ('PASS','NO_PASS')) then raise exception 'OCTOBER_DECISION_RULE_MISMATCH' using errcode='22023'; end if;
  perform set_config('private.october_metrics_date',p_date::text,true);
  if private.october_metrics_are_valid((select stable_code from public.october_rule_identities where id=v_rule.rule_identity_id),p_metrics,v_decision) is distinct from true then raise exception 'OCTOBER_INVALID_METRICS' using errcode='22023'; end if;
  select stable_code into v_code from public.october_rule_identities where id=v_rule.rule_identity_id and family_id=p_family_id;
  if v_code='L-013'
    and v_decision='PENALTY' and p_date=private.october_family_today(p_family_id)
    and (now() at time zone (select timezone from public.families where id=p_family_id))::time < time '19:30' then
    raise exception 'OCTOBER_L013_CUTOFF_NOT_REACHED' using errcode='22023';
  end if;
  v_payload:=jsonb_build_object('family_id',p_family_id,'child_id',p_child_id,'rule_id',p_rule_id,'date',p_date,'slot',v_slot,'decision',v_decision,'metrics',p_metrics,'reason',v_reason,'expected_revision',p_expected_revision);
  v_replay:=private.october_replay(v_actor,p_event_key,'CONFIRM_OCCURRENCE',v_payload); if v_replay is not null then return v_replay; end if;
  perform pg_advisory_xact_lock(hashtextextended('october-occ:'||v_adoption.id::text||':'||p_date::text||':'||v_slot,21021));
  v_occ:=private.october_materialize(v_adoption,p_date,v_slot);
  if v_occ.current_revision<>p_expected_revision then raise exception 'OCTOBER_OCCURRENCE_REVISION_CONFLICT' using errcode='40001'; end if;
  if (v_decision='PENALTY' or v_occ.confirmed_at is not null) and v_reason is null then raise exception 'OCTOBER_CONFIRMATION_REASON_REQUIRED' using errcode='22023'; end if;
  v_old_effects:=v_occ.effects;
  v_state:=case v_decision when 'PASS' then 'PASS'::public.october_occurrence_state when 'NO_PASS' then 'NO_PASS'::public.october_occurrence_state when 'PENALTY' then 'PENALTY'::public.october_occurrence_state else 'NO_VIOLATION'::public.october_occurrence_state end;
  v_effects:=private.october_effects_for_confirmation(v_rule,p_date,v_decision,p_metrics,(select school_asset from public.october_plans where id=v_adoption.plan_id));
  if v_decision='PENALTY' and private.october_incident_conflict(v_occ,v_rule,p_event_key,p_metrics) then v_state:='REVIEW_REQUIRED'; v_effects:='[]'::jsonb; end if;
  if v_code='T-007' and p_metrics->>'feedback'='PROBLEM' and p_metrics->'praised'='true'::jsonb then v_state:='REVIEW_REQUIRED'; v_effects:='[]'::jsonb; end if;
  -- Limits apply to the stable rule—not a plan version or a UI slot—and original excess
  -- events are retained with no effect. This covers reward, penalty, and daily TASK limits.
  if v_state in ('PASS','PENALTY') and v_rule.daily_limit is not null then
    if (select count(*) from public.october_occurrences o join public.october_rule_versions r on r.id=o.rule_version_id
        where o.family_id=p_family_id and o.child_profile_id=p_child_id and o.business_date=p_date and o.id<>v_occ.id
          and r.rule_identity_id=v_rule.rule_identity_id and o.state in ('PASS','PENALTY') and jsonb_array_length(o.effects)>0) >= v_rule.daily_limit then
      v_state:='LIMIT_EXCEEDED'; v_effects:='[]'::jsonb;
    end if;
  end if;
  if v_state='PASS' and v_rule.condition_spec->>'kind'='ORIGAMI_COMPLETE' and exists(
    select 1 from public.october_occurrences o join public.october_rule_versions r on r.id=o.rule_version_id and r.family_id=o.family_id
    where o.family_id=p_family_id and o.child_profile_id=p_child_id and o.id<>v_occ.id and r.rule_identity_id=v_rule.rule_identity_id
      and date_trunc('month',o.business_date::timestamp)=date_trunc('month',p_date::timestamp) and o.state='PASS' and jsonb_array_length(o.effects)>0
  ) then v_state:='LIMIT_EXCEEDED'; v_effects:='[]'::jsonb; end if;
  perform set_config('private.october_occurrence_write','on',true);
  update public.october_occurrences set state=v_state,confirmed_at=now(),reason=v_reason,metrics=p_metrics,effects=v_effects,
    recognized_count=case when v_state in ('PASS','PENALTY') and jsonb_array_length(v_effects)>0 then 1 else 0 end,
    current_revision=current_revision+1 where id=v_occ.id returning * into v_occ;
  perform set_config('private.october_event_write','on',true);
  insert into public.october_occurrence_events(family_id,occurrence_id,actor_principal_id,event_kind,event_key,revision_before,revision_after,decision,request_payload,reason)
  values(v_occ.family_id,v_occ.id,v_actor,'CONFIRMED',p_event_key,v_occ.current_revision-1,v_occ.current_revision,v_decision,v_payload,v_reason);
  if v_state='REVIEW_REQUIRED' and v_rule.condition_spec ? 'exclusive_incident_group' then
    perform private.october_hold_incident_peers(v_occ,v_rule,v_actor,p_metrics);
  end if;
  perform private.october_mark_lower_rights_review(v_occ,v_actor);
  if v_code='Q-003' and v_occ.state in ('PASS','NO_PASS','LIMIT_EXCEEDED','REVIEW_REQUIRED') then
    v_q003:=private.october_reconcile_q003_bucket(v_adoption,v_rule,v_actor);
    v_issued:=coalesce((v_q003->>'issued_difference')::integer,0);
  elsif v_occ.state in ('PASS','PENALTY') then
    v_issued:=private.october_issue_occurrence_rights(v_occ,v_actor);
  end if;
  v_response:=jsonb_build_object('id',v_occ.id,'revision',v_occ.current_revision,'state',v_occ.state::text,'issued',v_issued,'effects',v_occ.effects)
    || coalesce(jsonb_build_object('round',v_q003),'{}'::jsonb);
  perform private.october_record_request(v_occ.family_id,v_actor,p_event_key,'CONFIRM_OCCURRENCE',v_payload,v_response);
  return v_response;
end $$;

create or replace function private.october_school_target_effects(p_rule public.october_rule_versions,p_asset public.october_school_asset,p_total integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare t jsonb; v_quantity integer:=0;
begin
  if p_asset='PENDING' then return '[]'::jsonb; end if;
  for t in select value from jsonb_array_elements(coalesce(p_rule.condition_spec->'tiers'->p_asset::text,'[]'::jsonb)) loop
    if p_total >= (t->>'min')::integer then v_quantity:=greatest(v_quantity,(t->>'quantity')::integer); end if;
  end loop;
  if v_quantity=0 then return '[]'::jsonb; end if;
  return jsonb_build_array(jsonb_build_object('asset',p_asset::text,'quantity',v_quantity));
end $$;

create or replace function public.close_october_school_week(
  p_family_id uuid,p_child_id uuid,p_start date,p_end date,p_event_key uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid:=private.october_current_verified_principal_id(); v_adoption public.october_plan_adoptions%rowtype; v_rule public.october_rule_versions%rowtype;
  v_plan public.october_plans%rowtype; v_bucket public.october_buckets%rowtype; v_payload jsonb; v_response jsonb; v_replay jsonb;
  v_total integer; v_target jsonb; v_target_quantity integer:=0; v_existing_quantity integer:=0; v_diff integer:=0; v_right_id uuid; v_code text;
begin
  if p_family_id is null or p_child_id is null or p_start is null or p_end is null or p_event_key is null or v_actor is null or p_end<=p_start then raise exception 'OCTOBER_INVALID_SCHOOL_RANGE' using errcode='22023'; end if;
  if not private.october_actor_is_verified_parent(v_actor,p_family_id) then raise exception 'OCTOBER_PARENT_REQUIRED' using errcode='42501'; end if;
  select a.* into v_adoption from public.october_plan_adoptions a
  join public.october_rule_versions r on r.id=a.rule_version_id and r.family_id=a.family_id
  join public.october_rule_identities i on i.id=r.rule_identity_id and i.family_id=r.family_id
  where a.family_id=p_family_id and a.child_profile_id=p_child_id and i.stable_code='T-007';
  select * into v_rule from public.october_rule_versions where id=v_adoption.rule_version_id and family_id=p_family_id;
  if v_adoption.id is null or v_rule.id is null then raise exception 'OCTOBER_SCHOOL_ADOPTION_REQUIRED' using errcode='42501'; end if;
  select * into v_plan from public.october_plans where id=v_adoption.plan_id and family_id=p_family_id and status='ACTIVE';
  if p_start<v_plan.effective_from or p_end>v_plan.effective_to or p_end>private.october_family_today(p_family_id)+1 then raise exception 'OCTOBER_SCHOOL_RANGE_OUT_OF_BOUNDS' using errcode='22023'; end if;
  v_payload:=jsonb_build_object('family_id',p_family_id,'child_id',p_child_id,'start',p_start,'end',p_end);
  v_replay:=private.october_replay(v_actor,p_event_key,'CLOSE_SCHOOL_WEEK',v_payload); if v_replay is not null then return v_replay; end if;
  perform pg_advisory_xact_lock(hashtextextended('october-school:'||v_adoption.id::text,21021));
  -- Every scheduled school day must have a parent decision. Unreported/self reports are never zero stickers.
  if exists (
    select 1 from generate_series(p_start,p_end-1,interval '1 day') d
    where private.october_rule_is_scheduled(v_rule,d::date)
      and not exists(select 1 from public.october_occurrences o where o.adoption_id=v_adoption.id and o.business_date=d::date and o.slot='daily' and o.confirmed_at is not null)
  ) then raise exception 'OCTOBER_SCHOOL_UNCONFIRMED' using errcode='22023'; end if;
  select coalesce(sum(case when o.state='PASS' then jsonb_array_length(o.effects) when o.state='NO_PASS' then 0 else 0 end),0)::integer into v_total
  from public.october_occurrences o where o.adoption_id=v_adoption.id and o.business_date>=p_start and o.business_date<p_end;
  -- School effects each represent one recognized sticker (basic/praise); an unresolved problem+praise holds the close.
  if exists(select 1 from public.october_occurrences o where o.adoption_id=v_adoption.id and o.business_date>=p_start and o.business_date<p_end and o.state='REVIEW_REQUIRED') then raise exception 'OCTOBER_SCHOOL_REVIEW_REQUIRED' using errcode='22023'; end if;
  v_target:=private.october_school_target_effects(v_rule,v_plan.school_asset,v_total);
  if jsonb_array_length(v_target)>0 then v_target_quantity:=(v_target->0->>'quantity')::integer; end if;
  -- A correction closes the exact same half-open period in the same locked bucket.
  -- Any distinct overlap is still rejected by october_school_bucket_no_overlap.
  select * into v_bucket from public.october_buckets
  where adoption_id=v_adoption.id and bucket_type='SCHOOL' and period_start=p_start and period_end=p_end
  for update;
  perform set_config('private.october_bucket_write','on',true);
  if v_bucket.id is null then
    insert into public.october_buckets(family_id,adoption_id,child_profile_id,rule_version_id,bucket_type,period_start,period_end,recognized_total,target_effects,closed_at,created_by_principal_id)
    values(p_family_id,v_adoption.id,p_child_id,v_rule.id,'SCHOOL',p_start,p_end,v_total,v_target,now(),v_actor)
    returning * into v_bucket;
  else
    update public.october_buckets set recognized_total=v_total,target_effects=v_target,closed_at=now()
    where id=v_bucket.id returning * into v_bucket;
  end if;
  -- Highest-total entitlement belongs to this exact period only. Prior issued/review-held
  -- increments remain part of the historical total, so a review exclusion cannot cause reissue.
  if v_plan.school_asset<>'PENDING' then
    select coalesce(sum(quantity),0)::integer into v_existing_quantity from public.october_rights r
    where r.bucket_id=v_bucket.id and r.asset=v_plan.school_asset::text::public.october_right_asset
      and r.quantity>0 and r.status in ('ISSUED','REVIEW_REQUIRED');
    if v_existing_quantity>v_target_quantity then
      perform set_config('private.october_right_write','on',true);
      update public.october_rights set status='REVIEW_REQUIRED'
      where bucket_id=v_bucket.id and asset=v_plan.school_asset::text::public.october_right_asset
        and quantity>0 and status='ISSUED';
    elsif v_target_quantity>v_existing_quantity then
      v_diff:=v_target_quantity-v_existing_quantity;
      perform set_config('private.october_right_write','on',true);
      insert into public.october_rights(family_id,child_profile_id,rule_version_id,bucket_id,source_date,asset,quantity,issued_by_principal_id)
      values(p_family_id,p_child_id,v_rule.id,v_bucket.id,p_end-1,v_plan.school_asset::text::public.october_right_asset,v_diff,v_actor) returning id into v_right_id;
    end if;
  end if;
  v_response:=jsonb_build_object('bucket_id',v_bucket.id,'recognized_total',v_total,'target_effects',v_target,'issued_difference',v_diff,'right_id',v_right_id,'school_asset',v_plan.school_asset::text);
  perform private.october_record_request(p_family_id,v_actor,p_event_key,'CLOSE_SCHOOL_WEEK',v_payload,v_response);
  return v_response;
end $$;

create or replace function public.fulfill_october_right(
  p_family_id uuid,p_right_id uuid,p_event_key uuid,p_reason text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid:=private.october_current_verified_principal_id(); v_right public.october_rights%rowtype; v_payload jsonb; v_response jsonb; v_replay jsonb; v_reason text:=nullif(btrim(p_reason),''); v_remaining integer;
begin
  if p_family_id is null or p_right_id is null or p_event_key is null or v_actor is null or v_reason is null or char_length(v_reason)>240 then raise exception 'OCTOBER_INVALID_RIGHT_FULFILLMENT' using errcode='22023'; end if;
  if not private.october_actor_is_verified_parent(v_actor,p_family_id) then raise exception 'OCTOBER_PARENT_REQUIRED' using errcode='42501'; end if;
  select * into v_right from public.october_rights where id=p_right_id and family_id=p_family_id for update;
  if v_right.id is null then raise exception 'OCTOBER_RIGHT_NOT_FOUND' using errcode='42501'; end if;
  v_payload:=jsonb_build_object('family_id',p_family_id,'right_id',p_right_id,'reason',v_reason);
  v_replay:=private.october_replay(v_actor,p_event_key,'FULFILL_RIGHT',v_payload); if v_replay is not null then return v_replay; end if;
  if v_right.status<>'ISSUED' or v_right.quantity<=0 then raise exception 'OCTOBER_RIGHT_NOT_FULFILLABLE' using errcode='22023'; end if;
  v_remaining:=v_right.quantity-v_right.fulfilled_quantity;
  if v_remaining<=0 then raise exception 'OCTOBER_RIGHT_NOT_FULFILLABLE' using errcode='22023'; end if;
  perform set_config('private.october_fulfillment_write','on',true);
  insert into public.october_fulfillments(family_id,right_id,actor_principal_id,event_key,quantity,reason) values(p_family_id,p_right_id,v_actor,p_event_key,v_remaining,v_reason);
  perform set_config('private.october_right_write','on',true);
  update public.october_rights set fulfilled_quantity=fulfilled_quantity+v_remaining where id=p_right_id returning * into v_right;
  v_response:=jsonb_build_object('id',v_right.id,'fulfilled_quantity',v_right.fulfilled_quantity,'quantity',v_right.quantity,'status',v_right.status::text);
  perform private.october_record_request(p_family_id,v_actor,p_event_key,'FULFILL_RIGHT',v_payload,v_response);
  return v_response;
end $$;

create or replace function public.get_october_board(p_family_id uuid,p_child_id uuid,p_date date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid:=private.october_current_verified_principal_id(); v_plan public.october_plans%rowtype; v_rules jsonb; v_rows jsonb; v_rights jsonb; v_summary jsonb;
begin
  if p_family_id is null or p_child_id is null or p_date is null or v_actor is null or not (private.october_actor_is_verified_parent(v_actor,p_family_id) or private.october_actor_is_verified_child_self(v_actor,p_child_id)) then raise exception 'OCTOBER_BOARD_ACCESS_REQUIRED' using errcode='42501'; end if;
  if not exists(select 1 from public.child_profiles c where c.id=p_child_id and c.family_id=p_family_id and c.status='ACTIVE') then raise exception 'OCTOBER_BOARD_ACCESS_REQUIRED' using errcode='42501'; end if;
  if p_date>private.october_family_today(p_family_id) then raise exception 'OCTOBER_FUTURE_BOARD' using errcode='22023'; end if;
  select * into v_plan from public.october_plans p where p.family_id=p_family_id and p.status='ACTIVE' and p_date>=p.effective_from and p_date<p.effective_to order by p.effective_from desc limit 1;
  if v_plan.id is null then return jsonb_build_object('plan',null,'rules','[]'::jsonb,'rows','[]'::jsonb,'rights','[]'::jsonb,'summary',jsonb_build_object('pending_minutes',0,'penalty_minutes',0,'unconfirmed',0)); end if;
  -- Safe read-time materialization exposes scheduled rows including never-reported lifestyle work.
  perform set_config('private.october_occurrence_write','on',true);
  insert into public.october_occurrences(family_id,adoption_id,child_profile_id,rule_version_id,business_date,slot)
  select a.family_id,a.id,a.child_profile_id,a.rule_version_id,p_date,'daily'
  from public.october_plan_adoptions a join public.october_rule_versions r on r.id=a.rule_version_id and r.family_id=a.family_id
  where a.plan_id=v_plan.id and a.child_profile_id=p_child_id and private.october_rule_is_scheduled(r,p_date)
  on conflict(adoption_id,business_date,slot) do nothing;
  select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'code',i.stable_code,'domain',r.domain::text,'name',r.name,'criteria',r.criteria,'schedule_label',coalesce(r.effect_spec->>'schedule_label',''),'effect_kind',coalesce(r.effect_spec->>'kind','REWARD'),'daily_limit',r.daily_limit,'period',r.period::text,'effects',coalesce(r.effect_spec->'effects','[]'::jsonb),'pending_fields',coalesce(r.effect_spec->'pending_fields','[]'::jsonb),'condition_spec',r.condition_spec) order by i.stable_code),'[]'::jsonb) into v_rules
  from public.october_plan_adoptions a join public.october_rule_versions r on r.id=a.rule_version_id and r.family_id=a.family_id join public.october_rule_identities i on i.id=r.rule_identity_id and i.family_id=r.family_id where a.plan_id=v_plan.id and a.child_profile_id=p_child_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'rule_id',o.rule_version_id,'code',i.stable_code,'date',o.business_date,'slot',o.slot,'revision',o.current_revision,'state',o.state::text,'self_reported',o.self_reported,'confirmed_at',o.confirmed_at,'reason',o.reason,'metrics',o.metrics,'effects',o.effects,'recognized_count',o.recognized_count) order by i.stable_code,o.slot),'[]'::jsonb) into v_rows
  from public.october_occurrences o join public.october_rule_versions r on r.id=o.rule_version_id and r.family_id=o.family_id join public.october_rule_identities i on i.id=r.rule_identity_id and i.family_id=r.family_id where o.family_id=p_family_id and o.child_profile_id=p_child_id and o.business_date=p_date;
  select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'code',i.stable_code,'rule_name',r.name,'asset',x.asset::text,'quantity',x.quantity,'fulfilled_quantity',x.fulfilled_quantity,'status',x.status::text,'source_date',x.source_date,'issued_at',x.issued_at) order by x.issued_at desc,x.id),'[]'::jsonb) into v_rights
  from public.october_rights x join public.october_rule_versions r on r.id=x.rule_version_id and r.family_id=x.family_id join public.october_rule_identities i on i.id=r.rule_identity_id and i.family_id=r.family_id where x.family_id=p_family_id and x.child_profile_id=p_child_id;
  select jsonb_build_object(
    'pending_minutes',coalesce(sum(case when e->>'asset'='MINUTES' and (e->>'quantity')::integer>0 then (e->>'quantity')::integer else 0 end),0),
    'penalty_minutes',coalesce(sum(case when e->>'asset'='MINUTES' and (e->>'quantity')::integer<0 then (e->>'quantity')::integer else 0 end),0),
    'unconfirmed',(select count(*) from public.october_occurrences o where o.family_id=p_family_id and o.child_profile_id=p_child_id and o.business_date=p_date and o.state in ('UNCONFIRMED','SELF_REPORTED'))
  ) into v_summary
  from public.october_occurrences o
  cross join lateral jsonb_array_elements(o.effects) e
  where o.family_id=p_family_id and o.child_profile_id=p_child_id and o.business_date=p_date
    and o.state in ('PASS','PENALTY');
  return jsonb_build_object('plan',jsonb_build_object('id',v_plan.id,'month',v_plan.month,'effective_from',v_plan.effective_from,'status',v_plan.status::text,'school_asset',v_plan.school_asset::text),'rules',v_rules,'rows',v_rows,'rights',v_rights,'summary',v_summary);
end $$;

-- REST table writes are closed; only the five named browser RPCs are callable by authenticated users.
alter table public.october_ordinances enable row level security;
alter table public.october_ordinance_versions enable row level security;
alter table public.october_rule_identities enable row level security;
alter table public.october_rule_versions enable row level security;
alter table public.october_plans enable row level security;
alter table public.october_plan_adoptions enable row level security;
alter table public.october_occurrences enable row level security;
alter table public.october_occurrence_events enable row level security;
alter table public.october_buckets enable row level security;
alter table public.october_rights enable row level security;
alter table public.october_fulfillments enable row level security;
alter table public.october_request_events enable row level security;
revoke all on table public.october_ordinances,public.october_ordinance_versions,public.october_rule_identities,public.october_rule_versions,public.october_plans,public.october_plan_adoptions,public.october_occurrences,public.october_occurrence_events,public.october_buckets,public.october_rights,public.october_fulfillments,public.october_request_events from public,anon,authenticated;
revoke all on all functions in schema private from public,anon,authenticated;
revoke all on function public.get_october_board(uuid,uuid,date),public.submit_october_occurrence(uuid,uuid,uuid,date,uuid,text),public.confirm_october_occurrence(uuid,uuid,uuid,date,uuid,text,jsonb,text,text,integer),public.close_october_school_week(uuid,uuid,date,date,uuid),public.fulfill_october_right(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.get_october_board(uuid,uuid,date),public.submit_october_occurrence(uuid,uuid,uuid,date,uuid,text),public.confirm_october_occurrence(uuid,uuid,uuid,date,uuid,text,jsonb,text,text,integer),public.close_october_school_week(uuid,uuid,date,date,uuid),public.fulfill_october_right(uuid,uuid,uuid,text) to authenticated;
notify pgrst, 'reload schema';
commit;
