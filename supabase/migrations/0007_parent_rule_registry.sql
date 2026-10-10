begin;

-- 이 단계는 사건·평가·원장 없이 부모가 향후 적용할 활동 규칙을 등록하는 최소 구조다.
-- 금전·물품·약 복용은 의도적으로 이 migration의 입력/효과 대상이 아니다.
create extension if not exists btree_gist with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

do $$ begin
  create type public.ref_concept_scope as enum ('FAMILY');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.ref_concept_status as enum ('APPROVED');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.family_config_status as enum ('DRAFT', 'PUBLISHED');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.activity_category_code as enum (
    'DAILY_STUDY', 'SPECIAL_SCHEDULE', 'LIFE_HABIT', 'OTHER'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.policy_measurement_kind as enum ('PERCENT', 'QUANTITY');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.policy_outcome_code as enum ('PENALTY', 'NO_REWARD', 'REWARD');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.policy_effect_direction as enum ('CREDIT', 'DEBIT');
exception when duplicate_object then null;
end $$;

-- Ref는 활동 자체를 나타낼 뿐, 보상 분·차감 분·잔액 같은 정책값을 담지 않는다.
create table if not exists public.ref_concept_types (
  id uuid primary key default extensions.gen_random_uuid(),
  code text not null unique,
  name text not null,
  created_at timestamptz not null default now(),
  check (code = 'ACTIVITY'),
  check (char_length(btrim(name)) between 1 and 100)
);

insert into public.ref_concept_types(code, name)
values ('ACTIVITY', '활동')
on conflict (code) do nothing;

create table if not exists public.ref_concepts (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  concept_type_id uuid not null references public.ref_concept_types(id) on delete restrict,
  stable_key text not null,
  label text not null,
  scope public.ref_concept_scope not null default 'FAMILY',
  status public.ref_concept_status not null default 'APPROVED',
  created_by_principal_id uuid not null references public.principals(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (id, family_id),
  unique (family_id, stable_key),
  check (scope = 'FAMILY'),
  check (status = 'APPROVED'),
  check (char_length(btrim(stable_key)) between 1 and 160),
  check (char_length(btrim(label)) between 1 and 100)
);

create unique index if not exists ref_concepts_family_activity_label_unique
  on public.ref_concepts(family_id, lower(btrim(label)))
  where status = 'APPROVED';

-- config 하나는 앞으로 적용할 등록 묶음이다. 게시되면 과거/오늘을 다시 쓰지 않는다.
create table if not exists public.family_config_versions (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  version integer not null,
  status public.family_config_status not null default 'DRAFT',
  effective_from date,
  created_by_principal_id uuid not null references public.principals(id) on delete restrict,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  published_by_principal_id uuid references public.principals(id) on delete restrict,
  unique (id, family_id),
  unique (family_id, version),
  check (version > 0),
  check (
    (status = 'DRAFT' and effective_from is null and published_at is null and published_by_principal_id is null)
    or (status = 'PUBLISHED' and effective_from is not null and published_at is not null and published_by_principal_id is not null)
  )
);

create table if not exists public.activity_templates (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  subject_ref_id uuid not null,
  stable_key text not null,
  category_code public.activity_category_code not null,
  created_by_principal_id uuid not null references public.principals(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (id, family_id),
  unique (family_id, subject_ref_id),
  unique (family_id, stable_key),
  foreign key (subject_ref_id, family_id)
    references public.ref_concepts(id, family_id) on delete restrict,
  check (char_length(btrim(stable_key)) between 1 and 160)
);

create table if not exists public.activity_versions (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  activity_template_id uuid not null,
  config_version_id uuid not null,
  version integer not null,
  name text not null,
  description text,
  created_by_principal_id uuid not null references public.principals(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (id, family_id),
  unique (activity_template_id, version),
  unique (activity_template_id, config_version_id),
  foreign key (activity_template_id, family_id)
    references public.activity_templates(id, family_id) on delete restrict,
  foreign key (config_version_id, family_id)
    references public.family_config_versions(id, family_id) on delete restrict,
  check (version > 0),
  check (char_length(btrim(name)) between 1 and 100),
  check (description is null or char_length(btrim(description)) <= 1000)
);

create table if not exists public.policy_sets (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  config_version_id uuid not null,
  version integer not null,
  status public.family_config_status not null default 'DRAFT',
  created_by_principal_id uuid not null references public.principals(id) on delete restrict,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (id, family_id),
  unique (config_version_id),
  foreign key (config_version_id, family_id)
    references public.family_config_versions(id, family_id) on delete restrict,
  check (version > 0),
  check (
    (status = 'DRAFT' and published_at is null)
    or (status = 'PUBLISHED' and published_at is not null)
  )
);

create table if not exists public.policy_rules (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  policy_set_id uuid not null,
  subject_ref_id uuid not null,
  activity_version_id uuid not null,
  priority integer not null default 100,
  -- v1 등록 플로우는 자녀 자기보고만으로 패널티가 확정되지 않도록 부모 확인만 사용한다.
  verification_mode text not null default 'PARENT_VERIFY',
  created_by_principal_id uuid not null references public.principals(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (id, family_id),
  unique (policy_set_id, subject_ref_id),
  foreign key (policy_set_id, family_id)
    references public.policy_sets(id, family_id) on delete restrict,
  foreign key (subject_ref_id, family_id)
    references public.ref_concepts(id, family_id) on delete restrict,
  foreign key (activity_version_id, family_id)
    references public.activity_versions(id, family_id) on delete restrict,
  check (priority between 1 and 100000),
  check (verification_mode = 'PARENT_VERIFY')
);

create table if not exists public.policy_dimensions (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  policy_rule_id uuid not null,
  measurement_kind public.policy_measurement_kind not null,
  metric_label text not null,
  unit text not null,
  minimum_value numeric not null default 0,
  maximum_value numeric not null default 100,
  required boolean not null default true,
  created_at timestamptz not null default now(),
  unique (id, family_id),
  unique (policy_rule_id),
  foreign key (policy_rule_id, family_id)
    references public.policy_rules(id, family_id) on delete restrict,
  check (char_length(btrim(metric_label)) between 1 and 100),
  check (unit in ('PERCENT', 'QUANTITY')),
  check (minimum_value::text not in ('NaN', 'Infinity', '-Infinity')),
  check (maximum_value::text not in ('NaN', 'Infinity', '-Infinity')),
  check (minimum_value = 0 and maximum_value = 100)
);

create table if not exists public.policy_bands (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  policy_dimension_id uuid not null,
  value_range numrange not null,
  outcome_code public.policy_outcome_code not null,
  created_at timestamptz not null default now(),
  unique (id, family_id),
  foreign key (policy_dimension_id, family_id)
    references public.policy_dimensions(id, family_id) on delete restrict,
  check (not isempty(value_range)),
  check (not lower_inf(value_range) and not upper_inf(value_range)),
  check (lower(value_range)::text not in ('NaN', 'Infinity', '-Infinity')),
  check (upper(value_range)::text not in ('NaN', 'Infinity', '-Infinity')),
  check (lower_inc(value_range)),
  check (lower(value_range) >= 0 and upper(value_range) <= 100),
  check (lower(value_range) < upper(value_range))
);

-- UUID equality용 btree_gist와 numeric range overlap으로 같은 차원의 구간 중복을 물리 차단한다.
alter table public.policy_bands
  drop constraint if exists policy_bands_no_overlapping_ranges;
alter table public.policy_bands
  add constraint policy_bands_no_overlapping_ranges
  exclude using gist (policy_dimension_id with =, value_range with &&);

create table if not exists public.policy_effects (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  policy_band_id uuid not null,
  effect_kind text not null default 'TIME_DELTA',
  asset_code text not null default 'TIME_MINUTES',
  effect_direction public.policy_effect_direction not null,
  amount_minutes integer not null,
  created_at timestamptz not null default now(),
  unique (id, family_id),
  unique (policy_band_id, effect_kind),
  foreign key (policy_band_id, family_id)
    references public.policy_bands(id, family_id) on delete restrict,
  -- 돈·물품·잔액전액/비율 차감은 이 단계에서 표현할 수 없도록 고정한다.
  check (effect_kind = 'TIME_DELTA'),
  check (asset_code = 'TIME_MINUTES'),
  -- 0분은 명시적 무효과로 허용하되, 음수/전액몰수/배수 표현은 허용하지 않는다.
  check (amount_minutes between 0 and 240)
);

create index if not exists family_config_versions_family_created_idx
  on public.family_config_versions(family_id, created_at desc);
create index if not exists activity_versions_config_idx
  on public.activity_versions(config_version_id, family_id);
create index if not exists policy_rules_policy_set_idx
  on public.policy_rules(policy_set_id, family_id);

-- 게시된 config 및 그 구성요소는 변경·삭제할 수 없다. 수정은 새 DRAFT 등록으로만 한다.
create or replace function private.assert_registry_config_draft(p_config_version_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.family_config_status;
begin
  select fcv.status into v_status
  from public.family_config_versions fcv
  where fcv.id = p_config_version_id;

  if v_status is null then
    raise exception 'RULE_CONFIG_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_status <> 'DRAFT' then
    raise exception 'PUBLISHED_RULE_CONFIG_IMMUTABLE' using errcode = '55000';
  end if;
end;
$$;

create or replace function private.guard_family_config_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'PUBLISHED' then
      raise exception 'PUBLISHED_RULE_CONFIG_IMMUTABLE' using errcode = '55000';
    end if;
    return old;
  end if;

  if old.status = 'PUBLISHED' then
    raise exception 'PUBLISHED_RULE_CONFIG_IMMUTABLE' using errcode = '55000';
  end if;

  if new.status = 'PUBLISHED'
     and old.status = 'DRAFT'
     and new.effective_from is not null
     and new.published_at is not null
     and new.published_by_principal_id is not null then
    return new;
  end if;

  raise exception 'DRAFT_RULE_CONFIGS_ARE_CREATE_ONLY' using errcode = '55000';
end;
$$;

create or replace function private.guard_registry_component_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_config_version_id uuid;
begin
  if tg_table_name = 'activity_versions' then
    v_config_version_id := case when tg_op = 'DELETE' then old.config_version_id else new.config_version_id end;
  elsif tg_table_name = 'policy_sets' then
    v_config_version_id := case when tg_op = 'DELETE' then old.config_version_id else new.config_version_id end;
  elsif tg_table_name = 'policy_rules' then
    select ps.config_version_id into v_config_version_id
    from public.policy_sets ps
    where ps.id = case when tg_op = 'DELETE' then old.policy_set_id else new.policy_set_id end;
  elsif tg_table_name = 'policy_dimensions' then
    select ps.config_version_id into v_config_version_id
    from public.policy_rules pr
    join public.policy_sets ps on ps.id = pr.policy_set_id
    where pr.id = case when tg_op = 'DELETE' then old.policy_rule_id else new.policy_rule_id end;
  elsif tg_table_name = 'policy_bands' then
    select ps.config_version_id into v_config_version_id
    from public.policy_dimensions pd
    join public.policy_rules pr on pr.id = pd.policy_rule_id
    join public.policy_sets ps on ps.id = pr.policy_set_id
    where pd.id = case when tg_op = 'DELETE' then old.policy_dimension_id else new.policy_dimension_id end;
  elsif tg_table_name = 'policy_effects' then
    select ps.config_version_id into v_config_version_id
    from public.policy_bands pb
    join public.policy_dimensions pd on pd.id = pb.policy_dimension_id
    join public.policy_rules pr on pr.id = pd.policy_rule_id
    join public.policy_sets ps on ps.id = pr.policy_set_id
    where pb.id = case when tg_op = 'DELETE' then old.policy_band_id else new.policy_band_id end;
  else
    raise exception 'UNEXPECTED_REGISTRY_TABLE' using errcode = 'XX000';
  end if;

  perform private.assert_registry_config_draft(v_config_version_id);
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create or replace function private.guard_ref_concept_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'APPROVED_ACTIVITY_REF_IMMUTABLE' using errcode = '55000';
end;
$$;

create or replace function private.guard_activity_template_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'ACTIVITY_TEMPLATE_IMMUTABLE' using errcode = '55000';
end;
$$;

create or replace function private.guard_policy_effect_matches_band()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_outcome public.policy_outcome_code;
begin
  select pb.outcome_code into v_outcome
  from public.policy_bands pb
  where pb.id = new.policy_band_id
    and pb.family_id = new.family_id;

  if v_outcome is null then
    raise exception 'POLICY_BAND_NOT_FOUND' using errcode = 'P0002';
  end if;
  if (v_outcome = 'PENALTY' and (new.effect_direction <> 'DEBIT' or new.amount_minutes <= 0))
     or (v_outcome = 'REWARD' and (new.effect_direction <> 'CREDIT' or new.amount_minutes <= 0))
     or (v_outcome = 'NO_REWARD' and new.amount_minutes <> 0) then
    raise exception 'INVALID_EFFECT_FOR_OUTCOME' using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists family_config_versions_immutable_after_publish on public.family_config_versions;
create trigger family_config_versions_immutable_after_publish
before update or delete on public.family_config_versions
for each row execute function private.guard_family_config_transition();

drop trigger if exists ref_concepts_approved_immutable on public.ref_concepts;
create trigger ref_concepts_approved_immutable
before update or delete on public.ref_concepts
for each row execute function private.guard_ref_concept_immutable();

drop trigger if exists activity_templates_immutable on public.activity_templates;
create trigger activity_templates_immutable
before update or delete on public.activity_templates
for each row execute function private.guard_activity_template_immutable();

drop trigger if exists activity_versions_config_guard on public.activity_versions;
create trigger activity_versions_config_guard
before insert or update or delete on public.activity_versions
for each row execute function private.guard_registry_component_mutation();

drop trigger if exists policy_sets_config_guard on public.policy_sets;
create trigger policy_sets_config_guard
before insert or update or delete on public.policy_sets
for each row execute function private.guard_registry_component_mutation();

drop trigger if exists policy_rules_config_guard on public.policy_rules;
create trigger policy_rules_config_guard
before insert or update or delete on public.policy_rules
for each row execute function private.guard_registry_component_mutation();

drop trigger if exists policy_dimensions_config_guard on public.policy_dimensions;
create trigger policy_dimensions_config_guard
before insert or update or delete on public.policy_dimensions
for each row execute function private.guard_registry_component_mutation();

drop trigger if exists policy_bands_config_guard on public.policy_bands;
create trigger policy_bands_config_guard
before insert or update or delete on public.policy_bands
for each row execute function private.guard_registry_component_mutation();

drop trigger if exists policy_effects_config_guard on public.policy_effects;
create trigger policy_effects_config_guard
before insert or update or delete on public.policy_effects
for each row execute function private.guard_registry_component_mutation();

drop trigger if exists policy_effects_match_band on public.policy_effects;
create trigger policy_effects_match_band
before insert or update on public.policy_effects
for each row execute function private.guard_policy_effect_matches_band();

create or replace function private.next_family_local_rule_date(p_family_id uuid)
returns date
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_timezone text;
  v_status public.family_status;
begin
  select f.timezone, f.status into v_timezone, v_status
  from public.families f
  where f.id = p_family_id;
  if v_timezone is null or v_status <> 'ACTIVE' then
    raise exception 'ACTIVE_FAMILY_REQUIRED' using errcode = '42501';
  end if;
  -- 이 제품의 local business day는 가족 timezone 기준 다음 날이다. 주말/공휴일 일정 엔진은 아직 없다.
  return ((now() at time zone v_timezone)::date + 1);
end;
$$;

create or replace function private.score_input_is_finite(p_value numeric)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_value is not null
     and p_value::text not in ('NaN', 'Infinity', '-Infinity')
$$;

create or replace function private.policy_rule_is_publishable(p_policy_rule_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dimension_id uuid;
  v_band_count integer;
  v_lower_1 numeric;
  v_upper_1 numeric;
  v_outcome_1 public.policy_outcome_code;
  v_upper_1_inclusive boolean;
  v_lower_2 numeric;
  v_upper_2 numeric;
  v_outcome_2 public.policy_outcome_code;
  v_upper_2_inclusive boolean;
  v_lower_3 numeric;
  v_upper_3 numeric;
  v_outcome_3 public.policy_outcome_code;
  v_upper_3_inclusive boolean;
  v_lower_effect integer;
  v_upper_effect integer;
begin
  select pd.id into v_dimension_id
  from public.policy_dimensions pd
  where pd.policy_rule_id = p_policy_rule_id;
  if v_dimension_id is null then
    return false;
  end if;

  select count(*) into v_band_count
  from public.policy_bands pb
  where pb.policy_dimension_id = v_dimension_id;
  if v_band_count <> 3 then
    return false;
  end if;

  select lower(s.value_range), upper(s.value_range), s.outcome_code, upper_inc(s.value_range)
    into v_lower_1, v_upper_1, v_outcome_1, v_upper_1_inclusive
  from (
    select pb.value_range, pb.outcome_code from public.policy_bands pb
    where pb.policy_dimension_id = v_dimension_id
    order by lower(pb.value_range) limit 1 offset 0
  ) s;
  select lower(s.value_range), upper(s.value_range), s.outcome_code, upper_inc(s.value_range)
    into v_lower_2, v_upper_2, v_outcome_2, v_upper_2_inclusive
  from (
    select pb.value_range, pb.outcome_code from public.policy_bands pb
    where pb.policy_dimension_id = v_dimension_id
    order by lower(pb.value_range) limit 1 offset 1
  ) s;
  select lower(s.value_range), upper(s.value_range), s.outcome_code, upper_inc(s.value_range)
    into v_lower_3, v_upper_3, v_outcome_3, v_upper_3_inclusive
  from (
    select pb.value_range, pb.outcome_code from public.policy_bands pb
    where pb.policy_dimension_id = v_dimension_id
    order by lower(pb.value_range) limit 1 offset 2
  ) s;

  -- 정확히 [0, penalty), [penalty, reward), [reward, 100] 세 밴드만 게시 가능하다.
  if v_lower_1 <> 0 or v_upper_1_inclusive
     or v_outcome_2 <> 'NO_REWARD' or v_upper_2_inclusive
     or not v_upper_3_inclusive or v_upper_3 <> 100
     or v_upper_1 <> v_lower_2 or v_upper_2 <> v_lower_3
     or v_lower_1 >= v_upper_1 or v_lower_2 >= v_upper_2 or v_lower_3 >= v_upper_3 then
    return false;
  end if;

  select pe.amount_minutes into v_lower_effect
  from public.policy_bands pb
  join public.policy_effects pe on pe.policy_band_id = pb.id
  where pb.policy_dimension_id = v_dimension_id
    and lower(pb.value_range) = 0
    and pe.effect_direction = 'DEBIT'
    and pe.effect_kind = 'TIME_DELTA'
    and pe.asset_code = 'TIME_MINUTES';
  select pe.amount_minutes into v_upper_effect
  from public.policy_bands pb
  join public.policy_effects pe on pe.policy_band_id = pb.id
  where pb.policy_dimension_id = v_dimension_id
    and upper(pb.value_range) = 100
    and pe.effect_direction = 'CREDIT'
    and pe.effect_kind = 'TIME_DELTA'
    and pe.asset_code = 'TIME_MINUTES';

  return v_lower_effect is not null
     and v_upper_effect is not null
     and ((v_lower_effect > 0 and v_outcome_1 = 'PENALTY') or (v_lower_effect = 0 and v_outcome_1 = 'NO_REWARD'))
     and ((v_upper_effect > 0 and v_outcome_3 = 'REWARD') or (v_upper_effect = 0 and v_outcome_3 = 'NO_REWARD'));
end;
$$;

-- 모든 입력은 authenticated 부모가 명시적인 등록 흐름으로 호출할 때만 받아들인다.
-- 같은 활동 ref에 대해 별도 규칙 수를 붙이지 않고, 하나의 config 안에 하나의 rule만 만든다.
create or replace function public.save_parent_rule_draft(
  p_family_id uuid,
  p_name text,
  p_category_code public.activity_category_code,
  p_description text,
  p_measurement_kind public.policy_measurement_kind,
  p_metric_label text,
  p_penalty_limit numeric,
  p_reward_limit numeric,
  p_reward_minutes integer,
  p_penalty_minutes integer
)
returns table(config_version_id uuid, policy_rule_id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.current_principal_id();
  v_config_id uuid;
  v_subject_ref_id uuid;
  v_template_id uuid;
  v_activity_version_id uuid;
  v_policy_set_id uuid;
  v_rule_id uuid;
  v_dimension_id uuid;
  v_penalty_band_id uuid;
  v_no_reward_band_id uuid;
  v_reward_band_id uuid;
  v_config_version integer;
  v_activity_version integer;
  v_stable_key text;
  v_existing_category public.activity_category_code;
begin
  if v_actor is null or not public.is_active_parent(p_family_id) then
    raise exception 'PARENT_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  -- family 단위 직렬화: max(version)+1, ref 재사용, activity version 증가를 동시에 안전하게 한다.
  perform pg_advisory_xact_lock(hashtextextended(p_family_id::text, 0));
  if char_length(btrim(p_name)) not between 1 and 100 then
    raise exception 'INVALID_RULE_NAME' using errcode = '22023';
  end if;
  if p_description is not null and char_length(btrim(p_description)) > 1000 then
    raise exception 'INVALID_RULE_DESCRIPTION' using errcode = '22023';
  end if;
  if p_measurement_kind not in ('PERCENT', 'QUANTITY') then
    raise exception 'UNSUPPORTED_MEASUREMENT_KIND' using errcode = '22023';
  end if;
  if char_length(btrim(p_metric_label)) not between 1 and 100 then
    raise exception 'EXPLICIT_PARENT_METRIC_REQUIRED' using errcode = '22023';
  end if;
  if not private.score_input_is_finite(p_penalty_limit)
     or not private.score_input_is_finite(p_reward_limit)
     or p_penalty_limit <= 0
     or p_penalty_limit >= p_reward_limit
     or p_reward_limit >= 100 then
    raise exception 'INVALID_SCORE_THRESHOLDS' using errcode = '22023';
  end if;
  if p_reward_minutes is null or p_penalty_minutes is null
     or p_reward_minutes not between 0 and 240
     or p_penalty_minutes not between 0 and 240 then
    raise exception 'INVALID_TIME_MINUTES' using errcode = '22023';
  end if;

  -- 같은 DRAFT를 덮어쓰지 않는다. 새 등록마다 새 immutable-when-published config다.
  select coalesce(max(fcv.version), 0) + 1 into v_config_version
  from public.family_config_versions fcv
  where fcv.family_id = p_family_id;

  -- 같은 이름의 승인 ACTIVITY ref는 새 버전에서 재사용한다. 분류 변경은 이름을
  -- 재사용해 의미를 바꾸지 않고 명확히 새 이름으로 등록하도록 차단한다.
  select rc.id, at.id, at.category_code into v_subject_ref_id, v_template_id, v_existing_category
  from public.ref_concepts rc
  join public.ref_concept_types rct on rct.id = rc.concept_type_id and rct.code = 'ACTIVITY'
  left join public.activity_templates at
    on at.subject_ref_id = rc.id and at.family_id = rc.family_id
  where rc.family_id = p_family_id
    and rc.status = 'APPROVED'
    and lower(btrim(rc.label)) = lower(btrim(p_name))
  limit 1;

  if v_subject_ref_id is not null and v_template_id is null then
    raise exception 'ACTIVITY_REF_TEMPLATE_MISSING' using errcode = 'P0002';
  end if;
  if v_template_id is not null and v_existing_category <> p_category_code then
    raise exception 'ACTIVITY_CATEGORY_CHANGE_REQUIRES_NEW_NAME' using errcode = '22023';
  end if;

  if v_subject_ref_id is null then
    v_stable_key := lower(regexp_replace(btrim(p_name), '[^[:alnum:]]+', '-', 'g'))
      || '-' || left(replace(extensions.gen_random_uuid()::text, '-', ''), 10);
    insert into public.ref_concepts(
      family_id, concept_type_id, stable_key, label, created_by_principal_id
    )
    select p_family_id, rct.id, v_stable_key, btrim(p_name), v_actor
    from public.ref_concept_types rct
    where rct.code = 'ACTIVITY'
    returning id into v_subject_ref_id;

    insert into public.activity_templates(
      family_id, subject_ref_id, stable_key, category_code, created_by_principal_id
    ) values (
      p_family_id, v_subject_ref_id, v_stable_key, p_category_code, v_actor
    ) returning id into v_template_id;
  end if;

  insert into public.family_config_versions(
    family_id, version, status, created_by_principal_id
  ) values (
    p_family_id, v_config_version, 'DRAFT', v_actor
  ) returning id into v_config_id;

  select coalesce(max(av.version), 0) + 1 into v_activity_version
  from public.activity_versions av
  where av.activity_template_id = v_template_id;

  insert into public.activity_versions(
    family_id, activity_template_id, config_version_id, version, name, description, created_by_principal_id
  ) values (
    p_family_id, v_template_id, v_config_id, v_activity_version, btrim(p_name),
    nullif(btrim(p_description), ''), v_actor
  ) returning id into v_activity_version_id;

  insert into public.policy_sets(
    family_id, config_version_id, version, status, created_by_principal_id
  ) values (
    p_family_id, v_config_id, v_config_version, 'DRAFT', v_actor
  ) returning id into v_policy_set_id;

  insert into public.policy_rules(
    family_id, policy_set_id, subject_ref_id, activity_version_id, created_by_principal_id
  ) values (
    p_family_id, v_policy_set_id, v_subject_ref_id, v_activity_version_id, v_actor
  ) returning id into v_rule_id;

  insert into public.policy_dimensions(
    family_id, policy_rule_id, measurement_kind, metric_label, unit
  ) values (
    p_family_id, v_rule_id, p_measurement_kind, btrim(p_metric_label), p_measurement_kind::text
  ) returning id into v_dimension_id;

  insert into public.policy_bands(family_id, policy_dimension_id, value_range, outcome_code)
  values
    (p_family_id, v_dimension_id, numrange(0, p_penalty_limit, '[)'),
      case when p_penalty_minutes > 0 then 'PENALTY'::public.policy_outcome_code else 'NO_REWARD'::public.policy_outcome_code end),
    (p_family_id, v_dimension_id, numrange(p_penalty_limit, p_reward_limit, '[)'), 'NO_REWARD'),
    (p_family_id, v_dimension_id, numrange(p_reward_limit, 100, '[]'),
      case when p_reward_minutes > 0 then 'REWARD'::public.policy_outcome_code else 'NO_REWARD'::public.policy_outcome_code end);

  -- outcome은 0분이면 NO_REWARD가 될 수 있으므로 경계값으로 각 밴드를 다시 읽는다.
  select pb.id into v_penalty_band_id from public.policy_bands pb
  where pb.policy_dimension_id = v_dimension_id and lower(pb.value_range) = 0;
  select pb.id into v_reward_band_id from public.policy_bands pb
  where pb.policy_dimension_id = v_dimension_id and upper(pb.value_range) = 100;

  insert into public.policy_effects(
    family_id, policy_band_id, effect_direction, amount_minutes
  ) values
    (p_family_id, v_penalty_band_id, 'DEBIT', p_penalty_minutes),
    (p_family_id, v_reward_band_id, 'CREDIT', p_reward_minutes);

  return query select v_config_id, v_rule_id, 'DRAFT'::text;
end;
$$;

create or replace function public.publish_parent_rule_draft(
  p_config_version_id uuid
)
returns table(config_version_id uuid, policy_rule_id uuid, effective_from date, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.current_principal_id();
  v_config public.family_config_versions%rowtype;
  v_rule_id uuid;
  v_effective_from date;
begin
  select fcv.* into v_config
  from public.family_config_versions fcv
  where fcv.id = p_config_version_id
  for update;

  if v_config.id is null then
    raise exception 'RULE_CONFIG_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_actor is null or not public.is_active_parent(v_config.family_id) then
    raise exception 'PARENT_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  if v_config.status <> 'DRAFT' then
    raise exception 'RULE_CONFIG_NOT_DRAFT' using errcode = '55000';
  end if;

  select pr.id into v_rule_id
  from public.policy_sets ps
  join public.policy_rules pr on pr.policy_set_id = ps.id
  where ps.config_version_id = v_config.id;

  if v_rule_id is null or not private.policy_rule_is_publishable(v_rule_id) then
    raise exception 'RULE_PUBLICATION_REQUIRES_EXHAUSTIVE_TIME_BANDS' using errcode = '22023';
  end if;

  v_effective_from := private.next_family_local_rule_date(v_config.family_id);

  update public.policy_sets
  set status = 'PUBLISHED', published_at = now()
  where config_version_id = v_config.id;

  -- 구성요소 트리거는 DRAFT인 config에서만 전이를 허용한다. set을 먼저 잠근 뒤
  -- config를 게시해 이후의 모든 수정·삭제를 불변으로 만든다.
  update public.family_config_versions
  set status = 'PUBLISHED',
      effective_from = v_effective_from,
      published_at = now(),
      published_by_principal_id = v_actor
  where id = v_config.id;

  return query select v_config.id, v_rule_id, v_effective_from, 'PUBLISHED'::text;
end;
$$;

-- 부모에게는 draft와 게시 항목, 자녀에게는 게시된 항목만 보인다.
-- GUARDIAN은 0006의 status-only 보기에 포함되더라도 이 RPC에서 규칙을 읽거나 쓰지 못한다.
create or replace function public.list_parent_rule_registry(p_family_id uuid)
returns table(
  config_version_id uuid,
  policy_rule_id uuid,
  activity_template_id uuid,
  status text,
  effective_from date,
  name text,
  category_code text,
  description text,
  measurement_kind text,
  metric_label text,
  penalty_limit numeric,
  reward_limit numeric,
  penalty_minutes integer,
  reward_minutes integer,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    fcv.id,
    pr.id,
    at.id,
    fcv.status::text,
    fcv.effective_from,
    av.name,
    at.category_code::text,
    av.description,
    pd.measurement_kind::text,
    pd.metric_label,
    upper(lower_band.value_range),
    lower(upper_band.value_range),
    penalty_effect.amount_minutes,
    reward_effect.amount_minutes,
    fcv.created_at
  from public.family_config_versions fcv
  join public.policy_sets ps on ps.config_version_id = fcv.id
  join public.policy_rules pr on pr.policy_set_id = ps.id
  join public.activity_versions av on av.id = pr.activity_version_id
  join public.activity_templates at on at.id = av.activity_template_id
  join public.policy_dimensions pd on pd.policy_rule_id = pr.id
  join public.policy_bands lower_band
    on lower_band.policy_dimension_id = pd.id and lower(lower_band.value_range) = 0
  join public.policy_bands upper_band
    on upper_band.policy_dimension_id = pd.id and upper(upper_band.value_range) = 100
  join public.policy_effects penalty_effect
    on penalty_effect.policy_band_id = lower_band.id and penalty_effect.effect_direction = 'DEBIT'
  join public.policy_effects reward_effect
    on reward_effect.policy_band_id = upper_band.id and reward_effect.effect_direction = 'CREDIT'
  where fcv.family_id = p_family_id
    and public.is_active_parent(p_family_id)
  order by fcv.created_at desc
$$;

create or replace function public.list_published_family_rules(p_family_id uuid)
returns table(
  policy_rule_id uuid,
  name text,
  category_code text,
  description text,
  metric_label text,
  effective_from date
)
language sql
stable
security definer
set search_path = ''
as $$
  -- 게시 예정·과거 버전을 한꺼번에 평가하지 않는다. 같은 활동은 오늘 유효한 최신 하나만.
  select distinct on (at.id)
    pr.id,
    av.name,
    at.category_code::text,
    av.description,
    pd.metric_label,
    fcv.effective_from
  from public.family_config_versions fcv
  join public.policy_sets ps on ps.config_version_id = fcv.id and ps.status = 'PUBLISHED'
  join public.policy_rules pr on pr.policy_set_id = ps.id
  join public.activity_versions av on av.id = pr.activity_version_id
  join public.activity_templates at on at.id = av.activity_template_id
  join public.policy_dimensions pd on pd.policy_rule_id = pr.id
  join public.families f on f.id = fcv.family_id and f.status = 'ACTIVE'
  where fcv.family_id = p_family_id
    and fcv.status = 'PUBLISHED'
    and fcv.effective_from <= (now() at time zone f.timezone)::date
    and exists (
      select 1
      from public.family_memberships fm
      where fm.family_id = p_family_id
        and fm.principal_id = public.current_principal_id()
        and fm.status = 'ACTIVE'
        and fm.role in ('CHILD', 'OWNER_PARENT', 'PARENT')
    )
  order by at.id, fcv.effective_from desc, fcv.version desc, av.version desc
$$;

alter table public.ref_concept_types enable row level security;
alter table public.ref_concepts enable row level security;
alter table public.family_config_versions enable row level security;
alter table public.activity_templates enable row level security;
alter table public.activity_versions enable row level security;
alter table public.policy_sets enable row level security;
alter table public.policy_rules enable row level security;
alter table public.policy_dimensions enable row level security;
alter table public.policy_bands enable row level security;
alter table public.policy_effects enable row level security;

-- 민감 정책 테이블은 직접 table API를 열지 않는다. 안전한 SECURITY DEFINER RPC만 공개한다.
revoke all on table
  public.ref_concept_types,
  public.ref_concepts,
  public.family_config_versions,
  public.activity_templates,
  public.activity_versions,
  public.policy_sets,
  public.policy_rules,
  public.policy_dimensions,
  public.policy_bands,
  public.policy_effects
from anon, authenticated;

revoke all on function private.assert_registry_config_draft(uuid) from public, anon, authenticated;
revoke all on function private.guard_family_config_transition() from public, anon, authenticated;
revoke all on function private.guard_registry_component_mutation() from public, anon, authenticated;
revoke all on function private.guard_ref_concept_immutable() from public, anon, authenticated;
revoke all on function private.guard_activity_template_immutable() from public, anon, authenticated;
revoke all on function private.guard_policy_effect_matches_band() from public, anon, authenticated;
revoke all on function private.next_family_local_rule_date(uuid) from public, anon, authenticated;
revoke all on function private.score_input_is_finite(numeric) from public, anon, authenticated;
revoke all on function private.policy_rule_is_publishable(uuid) from public, anon, authenticated;
revoke all on function public.save_parent_rule_draft(
  uuid, text, public.activity_category_code, text, public.policy_measurement_kind,
  text, numeric, numeric, integer, integer
) from public, anon, authenticated;
revoke all on function public.publish_parent_rule_draft(uuid) from public, anon, authenticated;
revoke all on function public.list_parent_rule_registry(uuid) from public, anon, authenticated;
revoke all on function public.list_published_family_rules(uuid) from public, anon, authenticated;

grant execute on function public.save_parent_rule_draft(
  uuid, text, public.activity_category_code, text, public.policy_measurement_kind,
  text, numeric, numeric, integer, integer
) to authenticated;
grant execute on function public.publish_parent_rule_draft(uuid) to authenticated;
grant execute on function public.list_parent_rule_registry(uuid) to authenticated;
grant execute on function public.list_published_family_rules(uuid) to authenticated;

commit;
