begin;

-- 활동 수행은 규칙 등록(0007)의 다음 단계다. 이 migration은 원장, 잔액, 약 복용,
-- 금전/물품 효과를 만들지 않는다. 아래의 분 값은 부모 확인 전후의 *예정* 시간 변화일 뿐
-- 잔액 또는 차감 실행이 아니다.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

do $$ begin
  create type public.activity_assignment_repeat_kind as enum ('DAILY', 'ONCE');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.activity_occurrence_event_kind as enum ('CHILD_REPORTED', 'PARENT_VERIFIED');
exception when duplicate_object then null;
end $$;

-- CHECK 제약에서 사용할 수 있는 순수 배열 검증이다. ISO 요일은 월=1 ... 일=7이다.
create or replace function private.activity_weekdays_are_valid(p_weekdays integer[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_weekdays is not null
     and cardinality(p_weekdays) between 1 and 7
     and p_weekdays <@ array[1, 2, 3, 4, 5, 6, 7]::integer[]
     and cardinality(p_weekdays) = (
       select count(distinct d)::integer
       from unnest(p_weekdays) as u(d)
     )
$$;

-- 기존 current_principal_id()는 과거 API 호환성을 위해 이메일 확인을 요구하지 않는다.
-- 활동 쓰기/조회 RPC는 확인된 auth 계정 + ACTIVE principal만 받는다.
create or replace function private.current_verified_principal_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
  from public.principals p
  join auth.users u
    on u.id = p.auth_user_id
   and u.email_confirmed_at is not null
  where p.auth_user_id = auth.uid()
    and p.status = 'ACTIVE'
  limit 1
$$;

create or replace function private.activity_family_today(p_family_id uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select (now() at time zone f.timezone)::date
  from public.families f
  where f.id = p_family_id
    and f.status = 'ACTIVE'
$$;

create table if not exists public.activity_assignments (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  child_profile_id uuid not null,
  -- The exact published rule is deliberately stored, never resolved to "latest" on read.
  policy_rule_id uuid not null,
  activity_template_id uuid not null,
  starts_on date not null,
  ends_on date,
  weekdays integer[] not null default array[1, 2, 3, 4, 5, 6, 7]::integer[],
  repeat_kind public.activity_assignment_repeat_kind not null default 'DAILY',
  schedule_range daterange generated always as (
    daterange(starts_on, case when ends_on is null then null else ends_on + 1 end, '[)')
  ) stored,
  created_by_principal_id uuid not null references public.principals(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (id, family_id),
  foreign key (child_profile_id, family_id)
    references public.child_profiles(id, family_id) on delete restrict,
  foreign key (policy_rule_id, family_id)
    references public.policy_rules(id, family_id) on delete restrict,
  foreign key (activity_template_id, family_id)
    references public.activity_templates(id, family_id) on delete restrict,
  check (private.activity_weekdays_are_valid(weekdays)),
  check (
    (repeat_kind = 'DAILY' and (ends_on is null or ends_on >= starts_on))
    or (repeat_kind = 'ONCE' and ends_on = starts_on)
  ),
  check (not isempty(schedule_range))
);

create index if not exists activity_assignments_child_template_range_idx
  on public.activity_assignments using gist (child_profile_id, activity_template_id, schedule_range);
create index if not exists activity_assignments_family_child_starts_idx
  on public.activity_assignments(family_id, child_profile_id, starts_on, ends_on);

-- Ending a schedule is the one intentional mutable projection on an assignment. Every shortening
-- is retained as a raw event below; already materialized historical occurrences are never deleted.
create table if not exists public.activity_assignment_end_events (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  assignment_id uuid not null,
  actor_principal_id uuid not null references public.principals(id) on delete restrict,
  prior_ends_on date,
  ends_on date not null,
  recorded_at timestamptz not null default now(),
  unique (id, family_id),
  foreign key (assignment_id, family_id)
    references public.activity_assignments(id, family_id) on delete restrict,
  check (prior_ends_on is null or ends_on <= prior_ends_on)
);

create index if not exists activity_assignment_end_events_assignment_recorded_idx
  on public.activity_assignment_end_events(assignment_id, recorded_at, id);

-- occurrence는 현재 상태 projection이다. 원본 기록은 아래 activity_occurrence_events만이
-- append-only이며, projection의 revision은 기록 수와 함께 단조 증가한다.
create table if not exists public.activity_occurrences (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  child_profile_id uuid not null,
  assignment_id uuid not null,
  policy_rule_id uuid not null,
  activity_template_id uuid not null,
  business_date date not null,
  materialized_at timestamptz not null default now(),
  child_reported_at timestamptz,
  parent_verified_at timestamptz,
  parent_score numeric,
  -- Public parent feedback shown to the linked child; this is not a private memo field.
  parent_reason text,
  outcome_code public.policy_outcome_code,
  -- Signed, pending planned minutes only: credit positive, debit negative, no reward zero.
  -- This column is explicitly not an account balance or a ledger posting.
  confirmed_minutes integer,
  current_revision integer not null default 0,
  unique (id, family_id),
  unique (assignment_id, business_date),
  foreign key (child_profile_id, family_id)
    references public.child_profiles(id, family_id) on delete restrict,
  foreign key (assignment_id, family_id)
    references public.activity_assignments(id, family_id) on delete restrict,
  foreign key (policy_rule_id, family_id)
    references public.policy_rules(id, family_id) on delete restrict,
  foreign key (activity_template_id, family_id)
    references public.activity_templates(id, family_id) on delete restrict,
  check (current_revision >= 0),
  check (parent_score is null or (private.score_input_is_finite(parent_score) and parent_score between 0 and 100)),
  check (confirmed_minutes is null or confirmed_minutes between -240 and 240),
  check (
    (parent_verified_at is null and parent_score is null and parent_reason is null and outcome_code is null and confirmed_minutes is null)
    or (parent_verified_at is not null and parent_score is not null and char_length(btrim(parent_reason)) between 1 and 1000 and outcome_code is not null and confirmed_minutes is not null)
  )
);

create index if not exists activity_occurrences_child_day_idx
  on public.activity_occurrences(child_profile_id, business_date, family_id);
create index if not exists activity_occurrences_family_day_idx
  on public.activity_occurrences(family_id, business_date);

create table if not exists public.activity_occurrence_events (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  occurrence_id uuid not null,
  actor_principal_id uuid not null references public.principals(id) on delete restrict,
  event_kind public.activity_occurrence_event_kind not null,
  idempotency_key uuid not null,
  -- Client-provided actual performance time is optional and distinct from server record time.
  performed_at timestamptz,
  parent_score numeric,
  reason text,
  -- A verification freezes the selected band and its signed *planned* minutes.
  policy_band_id uuid,
  outcome_code public.policy_outcome_code,
  planned_minutes integer,
  recorded_at timestamptz not null default now(),
  unique (id, family_id),
  -- A key is scoped to its actor, not merely one occurrence. Replaying it against another
  -- occurrence or event kind is rejected by the write RPCs rather than creating another fact.
  unique (actor_principal_id, idempotency_key),
  foreign key (occurrence_id, family_id)
    references public.activity_occurrences(id, family_id) on delete restrict,
  foreign key (policy_band_id, family_id)
    references public.policy_bands(id, family_id) on delete restrict,
  check (parent_score is null or (private.score_input_is_finite(parent_score) and parent_score between 0 and 100)),
  check (planned_minutes is null or planned_minutes between -240 and 240),
  check (
    (event_kind = 'CHILD_REPORTED'
      and parent_score is null
      and reason is null
      and policy_band_id is null
      and outcome_code is null
      and planned_minutes is null)
    or
    (event_kind = 'PARENT_VERIFIED'
      and performed_at is null
      and parent_score is not null
      and char_length(btrim(reason)) between 1 and 1000
      and policy_band_id is not null
      and outcome_code is not null
      and planned_minutes is not null)
  )
);

create index if not exists activity_occurrence_events_occurrence_recorded_idx
  on public.activity_occurrence_events(occurrence_id, recorded_at, id);
create index if not exists activity_occurrence_events_family_recorded_idx
  on public.activity_occurrence_events(family_id, recorded_at);

-- Published rules and activity templates are already immutable. Assignment and raw event rows
-- are also immutable; only the private SECURITY DEFINER RPCs may update occurrence projection.
create or replace function private.guard_activity_assignment_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Only end_activity_assignment sets this transaction-local marker. The table is not granted
  -- to clients, and all other assignment fields remain immutable even for that RPC.
  if tg_op = 'UPDATE'
     and current_setting('private.activity_assignment_end_update', true) = 'on'
     and new.ends_on is not null
     and new.ends_on >= old.starts_on
     and (old.ends_on is null or new.ends_on <= old.ends_on)
     and (to_jsonb(new) - 'ends_on' - 'schedule_range') = (to_jsonb(old) - 'ends_on' - 'schedule_range') then
    return new;
  end if;
  raise exception 'ACTIVITY_ASSIGNMENT_APPEND_ONLY' using errcode = '55000';
end;
$$;

create or replace function private.guard_activity_event_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'ACTIVITY_EVENT_APPEND_ONLY' using errcode = '55000';
end;
$$;

create or replace function private.guard_activity_assignment_end_event_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'ACTIVITY_ASSIGNMENT_END_EVENT_APPEND_ONLY' using errcode = '55000';
end;
$$;

drop trigger if exists activity_assignments_append_only on public.activity_assignments;
create trigger activity_assignments_append_only
before update or delete on public.activity_assignments
for each row execute function private.guard_activity_assignment_append_only();

drop trigger if exists activity_occurrence_events_append_only on public.activity_occurrence_events;
create trigger activity_occurrence_events_append_only
before update or delete on public.activity_occurrence_events
for each row execute function private.guard_activity_event_append_only();

drop trigger if exists activity_assignment_end_events_append_only on public.activity_assignment_end_events;
create trigger activity_assignment_end_events_append_only
before update or delete on public.activity_assignment_end_events
for each row execute function private.guard_activity_assignment_end_event_append_only();

create or replace function private.activity_schedules_share_date(
  p_left_starts_on date,
  p_left_ends_on date,
  p_left_weekdays integer[],
  p_right_starts_on date,
  p_right_ends_on date,
  p_right_weekdays integer[]
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_first date;
  v_last date;
  v_day integer;
  v_candidate date;
begin
  v_first := greatest(p_left_starts_on, p_right_starts_on);
  v_last := case
    when p_left_ends_on is null then p_right_ends_on
    when p_right_ends_on is null then p_left_ends_on
    else least(p_left_ends_on, p_right_ends_on)
  end;
  if v_last is not null and v_first > v_last then
    return false;
  end if;

  foreach v_day in array p_left_weekdays loop
    if v_day = any(p_right_weekdays) then
      v_candidate := v_first + ((v_day - extract(isodow from v_first)::integer + 7) % 7);
      if v_last is null or v_candidate <= v_last then
        return true;
      end if;
    end if;
  end loop;
  return false;
end;
$$;


-- New scheduled work must name its exact immutable published rule. It can only begin on the
-- family-local next day or later. A later config does not rewrite an existing assignment, but a
-- caller cannot intentionally create a new assignment with a rule already superseded at start.
create or replace function public.create_activity_assignment(
  p_family_id uuid,
  p_child_profile_id uuid,
  p_policy_rule_id uuid,
  p_starts_on date,
  p_ends_on date default null,
  p_weekdays integer[] default array[1, 2, 3, 4, 5, 6, 7]::integer[],
  p_repeat text default 'DAILY'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.current_verified_principal_id();
  v_timezone text;
  v_tomorrow date;
  v_rule_effective_from date;
  v_rule_config_version integer;
  v_template_id uuid;
  v_repeat public.activity_assignment_repeat_kind;
  v_weekdays integer[];
  v_period daterange;
  v_assignment_id uuid;
begin
  if v_actor is null then
    raise exception 'ACTIVITY_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  if p_starts_on is null or p_repeat is null then
    raise exception 'INVALID_ACTIVITY_SCHEDULE' using errcode = '22023';
  end if;
  if upper(btrim(p_repeat)) not in ('DAILY', 'ONCE') then
    raise exception 'INVALID_ACTIVITY_SCHEDULE' using errcode = '22023';
  end if;
  if not private.activity_weekdays_are_valid(p_weekdays) then
    raise exception 'INVALID_ACTIVITY_WEEKDAYS' using errcode = '22023';
  end if;

  v_repeat := upper(btrim(p_repeat))::public.activity_assignment_repeat_kind;
  -- An ONCE schedule has exactly one business date. Its returned weekday is canonical even
  -- when callers use the default optional weekday array.
  v_weekdays := case
    when v_repeat = 'ONCE' then array[extract(isodow from p_starts_on)::integer]
    else p_weekdays
  end;
  if (v_repeat = 'ONCE' and p_ends_on is distinct from p_starts_on)
     or (v_repeat = 'DAILY' and p_ends_on is not null and p_ends_on < p_starts_on) then
    raise exception 'INVALID_ACTIVITY_SCHEDULE' using errcode = '22023';
  end if;

  -- Covers rule version selection and same-family schedule conflict checks as one serialization
  -- domain. Direct client writes are revoked below, so this is the authoritative conflict guard.
  perform pg_advisory_xact_lock(hashtextextended(p_family_id::text, 17));

  select f.timezone into v_timezone
  from public.families f
  join public.family_memberships fm
    on fm.family_id = f.id
   and fm.principal_id = v_actor
   and fm.role in ('OWNER_PARENT', 'PARENT')
   and fm.status = 'ACTIVE'
  where f.id = p_family_id
    and f.status = 'ACTIVE'
  for update of f;
  if v_timezone is null then
    raise exception 'ACTIVITY_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.child_profiles cp
    join public.family_memberships child_membership
      on child_membership.family_id = cp.family_id
     and child_membership.principal_id = cp.principal_id
     and child_membership.role = 'CHILD'
     and child_membership.status = 'ACTIVE'
    join public.principals child_principal
      on child_principal.id = cp.principal_id
     and child_principal.status = 'ACTIVE'
    join auth.users child_auth_user
      on child_auth_user.id = child_principal.auth_user_id
     and child_auth_user.email_confirmed_at is not null
    where cp.id = p_child_profile_id
      and cp.family_id = p_family_id
      and cp.status = 'ACTIVE'
      and cp.principal_id is not null
  ) then
    raise exception 'ACTIVITY_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  v_tomorrow := (now() at time zone v_timezone)::date + 1;
  if p_starts_on < v_tomorrow then
    raise exception 'ACTIVITY_ASSIGNMENT_MUST_START_TOMORROW' using errcode = '22023';
  end if;

  select fcv.effective_from, fcv.version, at.id
    into v_rule_effective_from, v_rule_config_version, v_template_id
  from public.policy_rules pr
  join public.policy_sets ps
    on ps.id = pr.policy_set_id
   and ps.family_id = pr.family_id
   and ps.status = 'PUBLISHED'
  join public.family_config_versions fcv
    on fcv.id = ps.config_version_id
   and fcv.family_id = pr.family_id
   and fcv.status = 'PUBLISHED'
  join public.activity_versions av
    on av.id = pr.activity_version_id
   and av.family_id = pr.family_id
  join public.activity_templates at
    on at.id = av.activity_template_id
   and at.family_id = pr.family_id
  where pr.id = p_policy_rule_id
    and pr.family_id = p_family_id;

  if v_template_id is null or v_rule_effective_from is null
     or p_starts_on < v_rule_effective_from then
    raise exception 'RULE_NOT_ASSIGNABLE' using errcode = '22023';
  end if;

  -- "Latest" is checked only when assigning. Stored policy_rule_id is never auto-resolved later.
  if exists (
    select 1
    from public.policy_rules later_rule
    join public.policy_sets later_set
      on later_set.id = later_rule.policy_set_id
     and later_set.family_id = later_rule.family_id
     and later_set.status = 'PUBLISHED'
    join public.family_config_versions later_config
      on later_config.id = later_set.config_version_id
     and later_config.family_id = later_rule.family_id
     and later_config.status = 'PUBLISHED'
    join public.activity_versions later_activity_version
      on later_activity_version.id = later_rule.activity_version_id
     and later_activity_version.family_id = later_rule.family_id
    where later_rule.family_id = p_family_id
      and later_activity_version.activity_template_id = v_template_id
      and later_config.effective_from <= p_starts_on
      and (
        later_config.effective_from > v_rule_effective_from
        or (later_config.effective_from = v_rule_effective_from and later_config.version > v_rule_config_version)
      )
  ) then
    raise exception 'RULE_NOT_LATEST_SCHEDULED' using errcode = '22023';
  end if;

  v_period := daterange(
    p_starts_on,
    case when p_ends_on is null then null else p_ends_on + 1 end,
    '[)'
  );
  if exists (
    select 1
    from public.activity_assignments a
    where a.family_id =
 p_family_id
      and a.child_profile_id = p_child_profile_id
      and a.activity_template_id = v_template_id
      and a.schedule_range && v_period
      and private.activity_schedules_share_date(
        a.starts_on, a.ends_on, a.weekdays, p_starts_on, p_ends_on, v_weekdays
      )
  ) then
    raise exception 'ACTIVITY_ASSIGNMENT_CONFLICT' using errcode = '23P01';
  end if;

  insert into public.activity_assignments(
    family_id, child_profile_id, policy_rule_id, activity_template_id,
    starts_on, ends_on, weekdays, repeat_kind, created_by_principal_id
  ) values (
    p_family_id, p_child_profile_id, p_policy_rule_id, v_template_id,
    p_starts_on, p_ends_on, v_weekdays, v_repeat, v_actor
  ) returning id into v_assignment_id;

  return v_assignment_id;
end;
$$;

-- True only when two date windows have at least one actual common scheduled ISO weekday.
-- This prevents the false conflict that a coarse range-only guard would report for disjoint
-- weekday patterns, including unbounded DAILY assignments.
create or replace function private.activity_actor_is_verified_parent(
  p_principal_id uuid,
  p_family_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.families f
    join public.family_memberships fm
      on fm.family_id = f.id
     and fm.principal_id = p_principal_id
     and fm.role in ('OWNER_PARENT', 'PARENT')
     and fm.status = 'ACTIVE'
    join public.principals p
      on p.id = fm.principal_id
     and p.status = 'ACTIVE'
    join auth.users u
      on u.id = p.auth_user_id
     and u.email_confirmed_at is not null
    where f.id = p_family_id
      and f.status = 'ACTIVE'
  )
$$;

create or replace function private.activity_actor_is_verified_child_self(
  p_principal_id uuid,
  p_child_profile_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.child_profiles cp
    join public.families f
      on f.id = cp.family_id
     and f.status = 'ACTIVE'
    join public.family_memberships fm
      on fm.family_id = cp.family_id
     and fm.principal_id = p_principal_id
     and fm.role = 'CHILD'
     and fm.status = 'ACTIVE'
    join public.principals p
      on p.id = cp.principal_id
     and p.id = p_principal_id
     and p.status = 'ACTIVE'
    join auth.users u
      on u.id = p.auth_user_id
     and u.email_confirmed_at is not null
    where cp.id = p_child_profile_id
      and cp.status = 'ACTIVE'
  )
$$;

-- One requested business date is materialized transactionally on demand. It never creates
-- future work, and past history is not artificially capped; the caller supplies a single date.
create or replace function private.materialize_activity_day(
  p_child_profile_id uuid,
  p_business_date date
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.activity_occurrences(
    family_id, child_profile_id, assignment_id, policy_rule_id,
    activity_template_id, business_date
  )
  select
    a.family_id,
    a.child_profile_id,
    a.id,
    a.policy_rule_id,
    a.activity_template_id,
    p_business_date
  from public.activity_assignments a
  join public.families f
    on f.id = a.family_id
   and f.status = 'ACTIVE'
  join public.family_config_versions fcv
    on fcv.id = (
      select ps.config_version_id
      from public.policy_rules pr
      join public.policy_sets ps on ps.id = pr.policy_set_id
      where pr.id = a.policy_rule_id
        and ps.status = 'PUBLISHED'
    )
   and fcv.status = 'PUBLISHED'
  where a.child_profile_id = p_child_profile_id
    and a.starts_on <= p_business_date
    and (a.ends_on is null or a.ends_on >= p_business_date)
    and fcv.effective_from <= p_business_date
    and extract(isodow from p_business_date)::integer = any(a.weekdays)
  on conflict (assignment_id, business_date) do nothing;
end;
$$;

create or replace function public.list_parent_activity_assignments(p_family_id uuid)
returns table(
  assignment_id uuid,
  child_profile_id uuid,
  child_name text,
  policy_rule_id uuid,
  activity_name text,
  category_code text,
  starts_on date,
  ends_on date,
  weekdays integer[],
  repeat_kind text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.current_verified_principal_id();
begin
  if p_family_id is null
     or v_actor is null
     or not private.activity_actor_is_verified_parent(v_actor, p_family_id) then
    raise exception 'ACTIVITY_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  return query
  select
    a.id,
    cp.id,
    cp.display_name,
    a.policy_rule_id,
    av.name,
    at.category_code::text,
    a.starts_on,
    a.ends_on,
    a.weekdays,
    a.repeat_kind::text
  from public.activity_assignments a
  join public.child_profiles cp on cp.id = a.child_profile_id
  join public.policy_rules pr on pr.id = a.policy_rule_id
  join public.activity_versions av on av.id = pr.activity_version_id
  join public.activity_templates at on at.id = a.activity_template_id
  where a.family_id = p_family_id
  order by cp.display_name, a.starts_on, av.name, a.created_at;
end;
$$;

-- End date is inclusive: ending on family-local today leaves today's occurrence available and
-- prevents tomorrow and later materialization. A future-start schedule may be ended no earlier
-- than its own start (cancellation is intentionally a separate future product decision).
create or replace function public.end_activity_assignment(
  p_assignment_id uuid,
  p_ends_on date
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.current_verified_principal_id();
  v_assignment public.activity_assignments%rowtype;
  v_today date;
begin
  if p_assignment_id is null or p_ends_on is null or v_actor is null then
    raise exception 'ACTIVITY_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  select a.* into v_assignment
  from public.activity_assignments a
  where a.id = p_assignment_id
  for update;
  if v_assignment.id is null
     or not private.activity_actor_is_verified_parent(v_actor, v_assignment.family_id) then
    raise exception 'ACTIVITY_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  v_today := private.activity_family_today(v_assignment.family_id);
  if p_ends_on = v_assignment.ends_on then
    return;
  end if;
  if v_today is null
     or p_ends_on < v_today
     or p_ends_on < v_assignment.starts_on
     or (v_assignment.ends_on is not null and p_ends_on > v_assignment.ends_on) then
    raise exception 'INVALID_ACTIVITY_END_DATE' using errcode = '22023';
  end if;

  insert into public.activity_assignment_end_events(
    family_id, assignment_id, actor_principal_id, prior_ends_on, ends_on
  ) values (
    v_assignment.family_id, v_assignment.id, v_actor, v_assignment.ends_on, p_ends_on
  );

  perform set_config('private.activity_assignment_end_update', 'on', true);
  update public.activity_assignments
  set ends_on = p_ends_on
  where id = v_assignment.id;
end;
$$;

create or replace function public.list_activity_day(
  p_child_profile_id uuid,
  p_business_date date
)
returns table(
  occurrence_id uuid,
  assignment_id uuid,
  policy_rule_id uuid,
  business_date date,
  activity_name text,
  description text,
  category_code text,
  metric_label text,
  reward_minutes integer,
  penalty_minutes integer,
  child_reported boolean,
  verification_status text,
  child_recorded_at timestamptz,
  parent_verified_at timestamptz,
  parent_score numeric,
  parent_reason text,
  outcome_code text,
  confirmed_minutes integer,
  revision integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.current_verified_principal_id();
  v_family_id uuid;
  v_today date;
begin
  if p_child_profile_id is null or p_business_date is null or v_actor is null then
    raise exception 'ACTIVITY_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  select cp.family_id, private.activity_family_today(cp.family_id)
    into v_family_id, v_today
  from public.child_profiles cp
  where cp.id = p_child_profile_id;

  if v_family_id is null
     or v_today is null
     or p_business_date > v_today
     or not (
       private.activity_actor_is_verified_parent(v_actor, v_family_id)
       or private.activity_actor_is_verified_child_self(v_actor, p_child_profile_id)
     ) then
    -- This deliberately has one denial for nonexistent profiles, guardians, cross-family
    -- callers, unverified accounts, and future-date requests.
    raise exception 'ACTIVITY_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  perform private.materialize_activity_day(p_child_profile_id, p_business_date);

  return query
  select
    o.id,
    o.assignment_id,
    o.policy_rule_id,
    o.business_date,
    av.name,
    av.description,
    at.category_code::text,
    pd.metric_label,
    reward_effect.amount_minutes,
    penalty_effect.amount_minutes,
    o.child_reported_at is not null,
    case
      when o.parent_verified_at is not null then 'CONFIRMED'
      when o.child_reported_at is not null then 'HELD'
      else 'MISSING'
    end,
    o.child_reported_at,
    o.parent_verified_at,
    o.parent_score,
    o.parent_reason,
    o.outcome_code::text,
    o.confirmed_minutes,
    o.current_revision
  from public.activity_occurrences o
  join public.policy_rules pr on pr.id = o.policy_rule_id
  join public.activity_versions av on av.id = pr.activity_version_id
  join public.activity_templates at on at.id = o.activity_template_id
  join public.policy_dimensions pd on pd.policy_rule_id = pr.id
  join public.policy_bands lower_band
    on lower_band.policy_dimension_id = pd.id
   and lower(lower_band.value_range) = 0
  join public.policy_bands upper_band
    on upper_band.policy_dimension_id = pd.id
   and upper(upper_band.value_range) = 100
  join public.policy_effects penalty_effect
    on penalty_effect.policy_band_id = lower_band.id
   and penalty_effect.effect_direction = 'DEBIT'
  join public.policy_effects reward_effect
    on reward_effect.policy_band_id = upper_band.id
   and reward_effect.effect_direction = 'CREDIT'
  where o.child_profile_id = p_child_profile_id
    and o.business_date = p_business_date
  order by av.name, o.assignment_id;
end;
$$;

create or replace function public.report_activity_done(
  p_occurrence_id uuid,
  p_idempotency_key uuid,
  p_occurred_at timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.current_verified_principal_id();
  v_occurrence public.activity_occurrences%rowtype;
  v_timezone text;
  v_existing public.activity_occurrence_events%rowtype;
begin
  if p_occurrence_id is null or p_idempotency_key is null or v_actor is null then
    raise exception 'ACTIVITY_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  select o.* into v_occurrence
  from public.activity_occurrences o
  where o.id = p_occurrence_id
  for update of o;

  select f.timezone into v_timezone
  from public.families f
  where f.id = v_occurrence.family_id
    and f.status = 'ACTIVE';

  if v_occurrence.id is null
     or not private.activity_actor_is_verified_child_self(v_actor, v_occurrence.child_profile_id) then
    raise exception 'ACTIVITY_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  select e.* into v_existing
  from public.activity_occurrence_events e
  where e.actor_principal_id = v_actor
    and e.idempotency_key = p_idempotency_key
  for update;
  if v_existing.id is not null then
    if v_existing.occurrence_id = p_occurrence_id
       and v_existing.event_kind = 'CHILD_REPORTED'
       and v_existing.performed_at is not distinct from p_occurred_at then
      return;
    end if;
    raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = '22023';
  end if;

  if p_occurred_at is not null and (
    p_occurred_at > now()
    or (p_occurred_at at time zone v_timezone)::date <> v_occurrence.business_date
  ) then
    raise exception 'INVALID_ACTIVITY_OCCURRED_AT' using errcode = '22023';
  end if;

  insert into public.activity_occurrence_events(
    family_id, occurrence_id, actor_principal_id, event_kind, idempotency_key, performed_at
  ) values (
    v_occurrence.family_id, v_occurrence.id, v_actor, 'CHILD_REPORTED', p_idempotency_key, p_occurred_at
  );

  -- A late self-report supplements audit history but never clears an existing parent decision.
  update public.activity_occurrences
  set child_reported_at = coalesce(child_reported_at, now()),
      current_revision = current_revision + 1
  where id = v_occurrence.id;
end;
$$;

create or replace function public.verify_activity_occurrence(
  p_occurrence_id uuid,
  p_score numeric,
  p_reason text,
  p_expected_revision integer,
  p_idempotency_key uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.current_verified_principal_id();
  v_occurrence public.activity_occurrences%rowtype;
  v_existing public.activity_occurrence_events%rowtype;
  v_band_id uuid;
  v_outcome public.policy_outcome_code;
  v_effect_direction public.policy_effect_direction;
  v_amount integer;
  v_planned_minutes integer;
  v_reason text := nullif(btrim(p_reason), '');
begin
  if p_occurrence_id is null or p_idempotency_key is null or p_expected_revision is null
     or p_expected_revision < 0 or p_score is null
     or not private.score_input_is_finite(p_score)
     or p_score < 0 or p_score > 100
     or v_reason is null or char_length(v_reason) > 1000
     or v_actor is null then
    raise exception 'INVALID_ACTIVITY_VERIFICATION' using errcode = '22023';
  end if;

  select o.* into v_occurrence
  from public.activity_occurrences o
  where o.id = p_occurrence_id
  for update;
  if v_occurrence.id is null
     or not private.activity_actor_is_verified_parent(v_actor, v_occurrence.family_id) then
    raise exception 'ACTIVITY_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  -- Check an exact idempotent replay before checking revision. A network retry after the first
  -- success is safe even though the stored projection has advanced its revision.
  select e.* into v_existing
  from public.activity_occurrence_events e
  where e.actor_principal_id = v_actor
    and e.idempotency_key = p_idempotency_key
  for update;
  if v_existing.id is not null then
    if v_existing.occurrence_id = p_occurrence_id
       and v_existing.event_kind = 'PARENT_VERIFIED'
       and v_existing.parent_score = p_score
       and v_existing.reason = v_reason then
      return;
    end if;
    raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = '22023';
  end if;

  if v_occurrence.current_revision <> p_expected_revision then
    raise exception 'ACTIVITY_REVISION_CONFLICT' using errcode = '40001';
  end if;
  -- This is a defensive exact-three-band/no-gap guard; publish flow already enforces it.
  if not private.policy_rule_is_publishable(v_occurrence.policy_rule_id) then
    raise exception 'POLICY_RULE_NOT_EXHAUSTIVE' using errcode = '55000';
  end if;

  select pb.id, pb.outcome_code, pe.effect_direction, pe.amount_minutes
    into v_band_id, v_outcome, v_effect_direction, v_amount
  from public.policy_dimensions pd
  join public.policy_bands pb
    on pb.policy_dimension_id = pd.id
   and pb.value_range @> p_score
  left join public.policy_effects pe
    on pe.policy_band_id = pb.id
   and pe.effect_kind = 'TIME_DELTA'
   and pe.asset_code = 'TIME_MINUTES'
  where pd.policy_rule_id = v_occurrence.policy_rule_id;

  if v_band_id is null or v_outcome is null
     or (v_outcome = 'PENALTY' and (v_effect_direction <> 'DEBIT' or v_amount is null))
     or (v_outcome = 'REWARD' and (v_effect_direction <> 'CREDIT' or v_amount is null))
     or (v_outcome = 'NO_REWARD' and v_effect_direction is not null) then
    raise exception 'POLICY_RULE_NOT_EXHAUSTIVE' using errcode = '55000';
  end if;
  v_planned_minutes := case
    when v_outcome = 'REWARD' and v_effect_direction = 'CREDIT' then v_amount
    when v_outcome = 'PENALTY' and v_effect_direction = 'DEBIT' then -v_amount
    when v_outcome = 'NO_REWARD' then 0
    else null
  end;
  if v_planned_minutes is null then
    raise exception 'POLICY_RULE_NOT_EXHAUSTIVE' using errcode = '55000';
  end if;

  insert into public.activity_occurrence_events(
    family_id, occurrence_id, actor_principal_id, event_kind, idempotency_key,
    parent_score, reason, policy_band_id, outcome_code, planned_minutes
  ) values (
    v_occurrence.family_id, v_occurrence.id, v_actor, 'PARENT_VERIFIED', p_idempotency_key,
    p_score, v_reason, v_band_id, v_outcome, v_planned_minutes
  );

  -- This is an assessment projection only. No ledger row, balance mutation, or debit execution
  -- is performed by this migration or these RPCs.
  update public.activity_occurrences
  set parent_verified_at = now(),
      parent_score = p_score,
      parent_reason = v_reason,
      outcome_code = v_outcome,
      confirmed_minutes = v_planned_minutes,
      current_revision = current_revision + 1
  where id = v_occurrence.id;
end;
$$;

alter table public.activity_assignments enable row level security;
alter table public.activity_assignment_end_events enable row level security;
alter table public.activity_occurrences enable row level security;
alter table public.activity_occurrence_events enable row level security;

-- No table API surface exists for these records. In particular there are no grants for SELECT,
-- INSERT, UPDATE, DELETE, or TRUNCATE to anonymous/authenticated clients; projections are RPC-only.
revoke all on table
  public.activity_assignments,
  public.activity_assignment_end_events,
  public.activity_occurrences,
  public.activity_occurrence_events
from public, anon, authenticated;

revoke all on function private.activity_weekdays_are_valid(integer[]) from public, anon, authenticated;
revoke all on function private.current_verified_principal_id() from public, anon, authenticated;
revoke all on function private.activity_family_today(uuid) from public, anon, authenticated;
revoke all on function private.guard_activity_assignment_append_only() from public, anon, authenticated;
revoke all on function private.guard_activity_event_append_only() from public, anon, authenticated;
revoke all on function private.guard_activity_assignment_end_event_append_only() from public, anon, authenticated;
revoke all on function private.activity_schedules_share_date(date, date, integer[], date, date, integer[]) from public, anon, authenticated;
revoke all on function private.activity_actor_is_verified_parent(uuid, uuid) from public, anon, authenticated;
revoke all on function private.activity_actor_is_verified_child_self(uuid, uuid) from public, anon, authenticated;
revoke all on function private.materialize_activity_day(uuid, date) from public, anon, authenticated;
revoke all on function public.create_activity_assignment(uuid, uuid, uuid, date, date, integer[], text) from public, anon, authenticated;
revoke all on function public.list_parent_activity_assignments(uuid) from public, anon, authenticated;
revoke all on function public.end_activity_assignment(uuid, date) from public, anon, authenticated;
revoke all on function public.list_activity_day(uuid, date) from public, anon, authenticated;
revoke all on function public.report_activity_done(uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.verify_activity_occurrence(uuid, numeric, text, integer, uuid) from public, anon, authenticated;

grant execute on function public.create_activity_assignment(uuid, uuid, uuid, date, date, integer[], text) to authenticated;
grant execute on function public.list_parent_activity_assignments(uuid) to authenticated;
grant execute on function public.end_activity_assignment(uuid, date) to authenticated;
grant execute on function public.list_activity_day(uuid, date) to authenticated;
grant execute on function public.report_activity_done(uuid, uuid, timestamptz) to authenticated;
grant execute on function public.verify_activity_occurrence(uuid, numeric, text, integer, uuid) to authenticated;

comment on table public.activity_occurrences is
  'Activity-day review projection. confirmed_minutes is signed planned minutes only; it is not a ledger, balance, debit, or entitlement.';
comment on column public.activity_occurrence_events.performed_at is
  'Optional client-asserted actual performance time; recorded_at is always the separate server record time.';
comment on column public.activity_occurrence_events.planned_minutes is
  'Frozen signed planned minutes from the verified band; no ledger posting is created.';

commit;
