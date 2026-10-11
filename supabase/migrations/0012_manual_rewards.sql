begin;

-- 수동 보상은 PASS 활동의 예정 시간과 별개다. 이 migration은 시간 원장·잔액·자동 송금이나
-- 외부 결제를 만들지 않는다. 금전 행은 부모가 실제로 지급하기 전의 장부상 "지급 예정" 기록이며,
-- 선생님 칭찬 보너스는 독립 쿠폰 발행이다.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

do $$ begin
  create type public.manual_money_reward_kind as enum ('DAILY', 'WEEKLY', 'MONTHLY', 'SPECIAL_EVENT');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.manual_money_reward_status as enum ('PENDING', 'SCHEDULED', 'PAID', 'VOID');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.manual_bonus_unit as enum ('TIME_MINUTES', 'MONEY_KRW', 'ACTIVITY', 'CUSTOM', 'TEXT');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.manual_bonus_coupon_status as enum ('ISSUED', 'REDEEMED', 'VOID');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.manual_reward_event_kind as enum (
    'MONEY_DRAFTED', 'MONEY_SCHEDULED', 'MONEY_PAID', 'MONEY_VOIDED',
    'BONUS_ISSUED', 'BONUS_REDEEMED', 'BONUS_VOIDED'
  );
exception when duplicate_object then null;
end $$;

-- WEEKLY의 PENDING은 "0원"이 아니다. 아직 주간이 끝나지 않았거나 부모가 잘했음을
-- 확정하지 않은 초안이며, planned_amount_krw가 NULL인 상태로 보존한다.
create table if not exists public.manual_money_rewards (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  child_profile_id uuid not null,
  reward_kind public.manual_money_reward_kind not null,
  period_start date not null,
  period_end date not null,
  event_key text,
  event_title text,
  status public.manual_money_reward_status not null default 'PENDING',
  planned_amount_krw integer,
  good_this_week boolean,
  praise_count integer,
  base_amount_snapshot_krw integer,
  praise_threshold_snapshot integer,
  praise_total_amount_snapshot_krw integer,
  created_by_principal_id uuid not null references public.principals(id) on delete restrict,
  created_at timestamptz not null default now(),
  paid_by_principal_id uuid references public.principals(id) on delete restrict,
  paid_at timestamptz,
  paid_on date,
  voided_by_principal_id uuid references public.principals(id) on delete restrict,
  voided_at timestamptz,
  void_reason text,
  unique (id, family_id),
  foreign key (child_profile_id, family_id)
    references public.child_profiles(id, family_id) on delete restrict,
  check (period_end >= period_start),
  check (
    (reward_kind = 'DAILY' and period_start = period_end and event_key is null and event_title is null)
    or (reward_kind = 'WEEKLY' and extract(isodow from period_start) = 1 and period_end = period_start + 6 and event_key is null and event_title is null)
    or (reward_kind = 'MONTHLY'
      and period_start = date_trunc('month', period_start::timestamp)::date
      and period_end = (date_trunc('month', period_start::timestamp) + interval '1 month - 1 day')::date
      and event_key is null and event_title is null)
    or (reward_kind = 'SPECIAL_EVENT' and period_start = period_end
      and char_length(btrim(coalesce(event_key, ''))) between 1 and 100
      and char_length(btrim(coalesce(event_title, ''))) between 1 and 160)
  ),
  check (
    (reward_kind = 'WEEKLY')
    or (good_this_week is null and praise_count is null and base_amount_snapshot_krw is null
      and praise_threshold_snapshot is null and praise_total_amount_snapshot_krw is null)
  ),
  check (praise_count is null or praise_count >= 0),
  check (base_amount_snapshot_krw is null or base_amount_snapshot_krw > 0),
  check (praise_threshold_snapshot is null or praise_threshold_snapshot > 0),
  check (praise_total_amount_snapshot_krw is null or praise_total_amount_snapshot_krw > 0),
  check (
    (status = 'PENDING' and planned_amount_krw is null
      and paid_by_principal_id is null and paid_at is null and paid_on is null
      and voided_by_principal_id is null and voided_at is null and void_reason is null)
    or (status = 'SCHEDULED' and planned_amount_krw > 0
      and paid_by_principal_id is null and paid_at is null and paid_on is null
      and voided_by_principal_id is null and voided_at is null and void_reason is null)
    or (status = 'PAID' and planned_amount_krw > 0
      and paid_by_principal_id is not null and paid_at is not null and paid_on is not null
      and voided_by_principal_id is null and voided_at is null and void_reason is null)
    or (status = 'VOID' and planned_amount_krw > 0
      and paid_by_principal_id is null and paid_at is null and paid_on is null
      and voided_by_principal_id is not null and voided_at is not null
      and char_length(btrim(coalesce(void_reason, ''))) between 1 and 240)
  ),
  check (
    reward_kind <> 'WEEKLY'
    or status = 'PENDING'
    or (good_this_week is true and base_amount_snapshot_krw is not null
      and praise_threshold_snapshot is not null and praise_total_amount_snapshot_krw is not null)
  )
);

-- A calendar period has one money record per family/child. SPECIAL_EVENT deliberately keys on a
-- parent-supplied event key, so two unrelated school events on the same day cannot collide.
create unique index if not exists manual_money_rewards_child_calendar_period_uq
  on public.manual_money_rewards(family_id, child_profile_id, reward_kind, period_start)
  where reward_kind in ('DAILY', 'WEEKLY', 'MONTHLY');
create unique index if not exists manual_money_rewards_child_special_event_uq
  on public.manual_money_rewards(family_id, child_profile_id, reward_kind, event_key)
  where reward_kind = 'SPECIAL_EVENT';
create index if not exists manual_money_rewards_child_created_idx
  on public.manual_money_rewards(child_profile_id, created_at desc);

-- A praise bonus is a grant/coupon. TIME_MINUTES here is a coupon entitlement, intentionally not a
-- future normal-time ledger credit or balance entry.
create table if not exists public.manual_bonus_coupons (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  child_profile_id uuid not null,
  title text not null,
  reason text not null,
  unit public.manual_bonus_unit not null,
  amount integer,
  issued_on date not null,
  status public.manual_bonus_coupon_status not null default 'ISSUED',
  issued_by_principal_id uuid not null references public.principals(id) on delete restrict,
  issued_at timestamptz not null default now(),
  redeemed_by_principal_id uuid references public.principals(id) on delete restrict,
  redeemed_at timestamptz,
  voided_by_principal_id uuid references public.principals(id) on delete restrict,
  voided_at timestamptz,
  void_reason text,
  unique (id, family_id),
  foreign key (child_profile_id, family_id)
    references public.child_profiles(id, family_id) on delete restrict,
  check (char_length(btrim(title)) between 1 and 120),
  check (char_length(btrim(reason)) between 1 and 240),
  check (
    (unit in ('TIME_MINUTES', 'MONEY_KRW') and amount is not null and amount > 0)
    or (unit in ('ACTIVITY', 'CUSTOM', 'TEXT') and (amount is null or amount > 0))
  ),
  check (
    (status = 'ISSUED' and redeemed_by_principal_id is null and redeemed_at is null
      and voided_by_principal_id is null and voided_at is null and void_reason is null)
    or (status = 'REDEEMED' and redeemed_by_principal_id is not null and redeemed_at is not null
      and voided_by_principal_id is null and voided_at is null and void_reason is null)
    or (status = 'VOID' and redeemed_by_principal_id is null and redeemed_at is null
      and voided_by_principal_id is not null and voided_at is not null
      and char_length(btrim(coalesce(void_reason, ''))) between 1 and 240)
  )
);
create index if not exists manual_bonus_coupons_child_issued_idx
  on public.manual_bonus_coupons(child_profile_id, issued_at desc);

-- This append-only event log carries actor, original request payload, and idempotency provenance.
-- Exact retry has the same actor/key/payload; changing a payload under a used key is rejected.
create table if not exists public.manual_reward_events (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  money_reward_id uuid,
  bonus_coupon_id uuid,
  actor_principal_id uuid not null references public.principals(id) on delete restrict,
  event_kind public.manual_reward_event_kind not null,
  idempotency_key uuid not null,
  request_payload jsonb not null,
  provenance text not null default 'PARENT_MANUAL',
  recorded_at timestamptz not null default now(),
  unique (actor_principal_id, idempotency_key),
  foreign key (money_reward_id, family_id)
    references public.manual_money_rewards(id, family_id) on delete restrict,
  foreign key (bonus_coupon_id, family_id)
    references public.manual_bonus_coupons(id, family_id) on delete restrict,
  check (num_nonnulls(money_reward_id, bonus_coupon_id) = 1),
  check (provenance = 'PARENT_MANUAL')
);
create index if not exists manual_reward_events_money_recorded_idx
  on public.manual_reward_events(money_reward_id, recorded_at, id);
create index if not exists manual_reward_events_bonus_recorded_idx
  on public.manual_reward_events(bonus_coupon_id, recorded_at, id);

create or replace function private.manual_reward_family_today(p_family_id uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select (now() at time zone f.timezone)::date
  from public.families f
  where f.id = p_family_id and f.status = 'ACTIVE'
$$;

-- Parent actions require a confirmed authenticated account, ACTIVE principal/family/membership,
-- and a parent role. GUARDIAN is deliberately absent from this predicate.
create or replace function private.manual_reward_actor_is_verified_parent(
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
    where f.id = p_family_id and f.status = 'ACTIVE'
  )
$$;

create or replace function private.manual_reward_child_is_active(
  p_family_id uuid,
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
    join public.families f on f.id = cp.family_id and f.status = 'ACTIVE'
    join public.principals p on p.id = cp.principal_id and p.status = 'ACTIVE'
    join public.family_memberships fm
      on fm.family_id = cp.family_id
     and fm.principal_id = cp.principal_id
     and fm.role = 'CHILD'
     and fm.status = 'ACTIVE'
    where cp.id = p_child_profile_id
      and cp.family_id = p_family_id
      and cp.status = 'ACTIVE'
  )
$$;

create or replace function private.manual_reward_actor_is_verified_child_self(
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
    join public.families f on f.id = cp.family_id and f.status = 'ACTIVE'
    join public.principals p
      on p.id = cp.principal_id
     and p.id = p_principal_id
     and p.status = 'ACTIVE'
    join auth.users u on u.id = p.auth_user_id and u.email_confirmed_at is not null
    join public.family_memberships fm
      on fm.family_id = cp.family_id
     and fm.principal_id = p_principal_id
     and fm.role = 'CHILD'
     and fm.status = 'ACTIVE'
    where cp.id = p_child_profile_id and cp.status = 'ACTIVE'
  )
$$;

create or replace function private.guard_manual_reward_event_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'MANUAL_REWARD_EVENT_APPEND_ONLY' using errcode = '55000';
end;
$$;

drop trigger if exists manual_reward_events_append_only on public.manual_reward_events;
create trigger manual_reward_events_append_only
before update or delete on public.manual_reward_events
for each row execute function private.guard_manual_reward_event_append_only();

-- Returns the same projection shape for create/update/transition RPCs.
create or replace function public.upsert_weekly_money_reward(
  p_family_id uuid,
  p_child_profile_id uuid,
  p_week_reference_date date,
  p_good_this_week boolean,
  p_praise_count integer,
  p_base_amount_krw integer default 10000,
  p_praise_threshold integer default 5,
  p_praise_total_amount_krw integer default 15000,
  p_idempotency_key uuid default extensions.gen_random_uuid()
)
returns table(
  reward_id uuid,
  child_profile_id uuid,
  reward_kind text,
  period_start date,
  period_end date,
  status text,
  scheduled_amount_krw integer,
  good_this_week boolean,
  praise_count integer,
  base_amount_snapshot_krw integer,
  praise_threshold_snapshot integer,
  praise_total_amount_snapshot_krw integer,
  paid_on date,
  event_title text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.current_verified_principal_id();
  v_week_start date;
  v_week_end date;
  v_today date;
  v_status public.manual_money_reward_status;
  v_amount integer;
  v_reward public.manual_money_rewards%rowtype;
  v_event public.manual_reward_events%rowtype;
  v_payload jsonb;
begin
  if p_family_id is null or p_child_profile_id is null or p_week_reference_date is null
     or p_good_this_week is null or p_praise_count is null or p_idempotency_key is null
     or p_praise_count < 0 or p_base_amount_krw is null or p_base_amount_krw <= 0
     or p_praise_threshold is null or p_praise_threshold <= 0
     or p_praise_total_amount_krw is null or p_praise_total_amount_krw <= 0
     or v_actor is null then
    raise exception 'INVALID_WEEKLY_MONEY_REWARD' using errcode = '22023';
  end if;
  if not private.manual_reward_actor_is_verified_parent(v_actor, p_family_id)
     or not private.manual_reward_child_is_active(p_family_id, p_child_profile_id) then
    raise exception 'MANUAL_REWARD_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  v_week_start := p_week_reference_date - (extract(isodow from p_week_reference_date)::integer - 1);
  v_week_end := v_week_start + 6;
  v_today := private.manual_reward_family_today(p_family_id);
  if v_today is null then
    raise exception 'MANUAL_REWARD_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  v_payload := jsonb_build_object(
    'operation', 'WEEKLY_UPSERT', 'family_id', p_family_id,
    'child_profile_id', p_child_profile_id, 'week_reference_date', p_week_reference_date,
    'good_this_week', p_good_this_week, 'praise_count', p_praise_count,
    'base_amount_krw', p_base_amount_krw, 'praise_threshold', p_praise_threshold,
    'praise_total_amount_krw', p_praise_total_amount_krw
  );

  -- Serialize the full actor/key replay path, not only the final unique insert. Without this,
  -- two simultaneous exact retries could both miss the event and make the second call fail after
  -- the first commits instead of returning its original record.
  perform pg_advisory_xact_lock(hashtextextended(v_actor::text || ':' || p_idempotency_key::text, 1209));
  select e.* into v_event
  from public.manual_reward_events e
  where e.actor_principal_id = v_actor and e.idempotency_key = p_idempotency_key
  for update;
  if v_event.id is not null then
    if v_event.money_reward_id is not null
       and v_event.request_payload = v_payload then
      return query
      select r.id, r.child_profile_id, r.reward_kind::text, r.period_start, r.period_end,
             r.status::text, r.planned_amount_krw, r.good_this_week, r.praise_count,
             r.base_amount_snapshot_krw, r.praise_threshold_snapshot,
             r.praise_total_amount_snapshot_krw, r.paid_on, r.event_title, r.created_at
      from public.manual_money_rewards r where r.id = v_event.money_reward_id;
      return;
    end if;
    raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = '22023';
  end if;

  -- Serializes the family/child/week uniqueness check before the partial unique index is reached.
  perform pg_advisory_xact_lock(hashtextextended(
    p_family_id::text || ':' || p_child_profile_id::text || ':' || v_week_start::text, 1212
  ));
  select r.* into v_reward
  from public.manual_money_rewards r
  where r.family_id = p_family_id and r.child_profile_id = p_child_profile_id
    and r.reward_kind = 'WEEKLY' and r.period_start = v_week_start
  for update;

  -- An unchecked parent assessment and any non-ended week remain a NULL-amount draft. A checked,
  -- fully ended week is manually scheduled at the frozen base/threshold/total snapshot.
  if p_good_this_week and v_today > v_week_end then
    v_status := 'SCHEDULED';
    v_amount := case when p_praise_count >= p_praise_threshold
      then p_praise_total_amount_krw else p_base_amount_krw end;
  else
    v_status := 'PENDING';
    v_amount := null;
  end if;

  if v_reward.id is null then
    insert into public.manual_money_rewards(
      family_id, child_profile_id, reward_kind, period_start, period_end, status,
      planned_amount_krw, good_this_week, praise_count,
      base_amount_snapshot_krw, praise_threshold_snapshot, praise_total_amount_snapshot_krw,
      created_by_principal_id
    ) values (
      p_family_id, p_child_profile_id, 'WEEKLY', v_week_start, v_week_end, v_status,
      v_amount, p_good_this_week, p_praise_count,
      case when v_status = 'SCHEDULED' then p_base_amount_krw else null end,
      case when v_status = 'SCHEDULED' then p_praise_threshold else null end,
      case when v_status = 'SCHEDULED' then p_praise_total_amount_krw else null end,
      v_actor
    ) returning * into v_reward;
  elsif v_reward.status = 'PENDING' then
    update public.manual_money_rewards r
    set good_this_week = p_good_this_week,
        praise_count = p_praise_count,
        status = v_status,
        planned_amount_krw = v_amount,
        base_amount_snapshot_krw = case when v_status = 'SCHEDULED' then p_base_amount_krw else null end,
        praise_threshold_snapshot = case when v_status = 'SCHEDULED' then p_praise_threshold else null end,
        praise_total_amount_snapshot_krw = case when v_status = 'SCHEDULED' then p_praise_total_amount_krw else null end
    where r.id = v_reward.id
    returning * into v_reward;
  else
    -- Once a planned/paid/voided record exists, its snapshot is history. Use a correction record,
    -- not a mutation or deletion, if real-world bookkeeping needs adjustment.
    raise exception 'WEEKLY_MONEY_REWARD_ALREADY_FINALIZED' using errcode = '22023';
  end if;

  insert into public.manual_reward_events(
    family_id, money_reward_id, actor_principal_id, event_kind, idempotency_key, request_payload
  ) values (
    p_family_id, v_reward.id, v_actor,
    case when v_status = 'SCHEDULED' then 'MONEY_SCHEDULED' else 'MONEY_DRAFTED' end,
    p_idempotency_key, v_payload
  );

  return query
  select r.id, r.child_profile_id, r.reward_kind::text, r.period_start, r.period_end,
         r.status::text, r.planned_amount_krw, r.good_this_week, r.praise_count,
         r.base_amount_snapshot_krw, r.praise_threshold_snapshot,
         r.praise_total_amount_snapshot_krw, r.paid_on, r.event_title, r.created_at
  from public.manual_money_rewards r where r.id = v_reward.id;
end;
$$;

-- Daily/monthly/special-event amounts are also parent-confirmed records. This is deliberately
-- separate from the weekly preset; no threshold policy is inferred for these categories.
create or replace function public.create_period_money_reward(
  p_family_id uuid,
  p_child_profile_id uuid,
  p_reward_kind text,
  p_reference_date date,
  p_event_key text,
  p_event_title text,
  p_amount_krw integer,
  p_idempotency_key uuid
)
returns table(
  reward_id uuid,
  child_profile_id uuid,
  reward_kind text,
  period_start date,
  period_end date,
  status text,
  scheduled_amount_krw integer,
  good_this_week boolean,
  praise_count integer,
  base_amount_snapshot_krw integer,
  praise_threshold_snapshot integer,
  praise_total_amount_snapshot_krw integer,
  paid_on date,
  event_title text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.current_verified_principal_id();
  v_kind public.manual_money_reward_kind;
  v_start date;
  v_end date;
  v_event_key text := nullif(btrim(coalesce(p_event_key, '')), '');
  v_event_title text := nullif(btrim(coalesce(p_event_title, '')), '');
  v_reward public.manual_money_rewards%rowtype;
  v_event public.manual_reward_events%rowtype;
  v_payload jsonb;
begin
  if p_family_id is null or p_child_profile_id is null or p_reference_date is null
     or p_amount_krw is null or p_amount_krw <= 0 or p_idempotency_key is null
     or p_reward_kind is null or upper(btrim(p_reward_kind)) not in ('DAILY', 'MONTHLY', 'SPECIAL_EVENT')
     or v_actor is null then
    raise exception 'INVALID_PERIOD_MONEY_REWARD' using errcode = '22023';
  end if;
  if not private.manual_reward_actor_is_verified_parent(v_actor, p_family_id)
     or not private.manual_reward_child_is_active(p_family_id, p_child_profile_id) then
    raise exception 'MANUAL_REWARD_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  v_kind := upper(btrim(p_reward_kind))::public.manual_money_reward_kind;
  if v_kind = 'DAILY' then
    v_start := p_reference_date; v_end := p_reference_date;
    v_event_key := null; v_event_title := null;
  elsif v_kind = 'MONTHLY' then
    v_start := date_trunc('month', p_reference_date::timestamp)::date;
    v_end := (date_trunc('month', p_reference_date::timestamp) + interval '1 month - 1 day')::date;
    v_event_key := null; v_event_title := null;
  else
    v_start := p_reference_date; v_end := p_reference_date;
    if char_length(coalesce(v_event_key, '')) not between 1 and 100
       or char_length(coalesce(v_event_title, '')) not between 1 and 160 then
      raise exception 'INVALID_SPECIAL_EVENT_KEY_OR_TITLE' using errcode = '22023';
    end if;
  end if;
  v_payload := jsonb_build_object(
    'operation', 'PERIOD_CREATE', 'family_id', p_family_id, 'child_profile_id', p_child_profile_id,
    'reward_kind', v_kind::text, 'reference_date', p_reference_date, 'event_key', v_event_key,
    'event_title', v_event_title, 'amount_krw', p_amount_krw
  );
  perform pg_advisory_xact_lock(hashtextextended(v_actor::text || ':' || p_idempotency_key::text, 1209));
  select e.* into v_event from public.manual_reward_events e
  where e.actor_principal_id = v_actor and e.idempotency_key = p_idempotency_key for update;
  if v_event.id is not null then
    if v_event.money_reward_id is not null and v_event.request_payload = v_payload then
      return query select r.id, r.child_profile_id, r.reward_kind::text, r.period_start, r.period_end,
        r.status::text, r.planned_amount_krw, r.good_this_week, r.praise_count,
        r.base_amount_snapshot_krw, r.praise_threshold_snapshot, r.praise_total_amount_snapshot_krw,
        r.paid_on, r.event_title, r.created_at from public.manual_money_rewards r where r.id = v_event.money_reward_id;
      return;
    end if;
    raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    p_family_id::text || ':' || p_child_profile_id::text || ':' || v_kind::text || ':' || coalesce(v_event_key, v_start::text), 1213
  ));
  select r.* into v_reward from public.manual_money_rewards r
  where r.family_id = p_family_id and r.child_profile_id = p_child_profile_id and r.reward_kind = v_kind
    and ((v_kind = 'SPECIAL_EVENT' and r.event_key = v_event_key) or (v_kind <> 'SPECIAL_EVENT' and r.period_start = v_start))
  for update;
  if v_reward.id is not null then
    raise exception 'PERIOD_MONEY_REWARD_ALREADY_EXISTS' using errcode = '22023';
  end if;
  insert into public.manual_money_rewards(
    family_id, child_profile_id, reward_kind, period_start, period_end, event_key, event_title,
    status, planned_amount_krw, created_by_principal_id
  ) values (
    p_family_id, p_child_profile_id, v_kind, v_start, v_end, v_event_key, v_event_title,
    'SCHEDULED', p_amount_krw, v_actor
  ) returning * into v_reward;
  insert into public.manual_reward_events(
    family_id, money_reward_id, actor_principal_id, event_kind, idempotency_key, request_payload
  ) values (p_family_id, v_reward.id, v_actor, 'MONEY_SCHEDULED', p_idempotency_key, v_payload);
  return query select r.id, r.child_profile_id, r.reward_kind::text, r.period_start, r.period_end,
    r.status::text, r.planned_amount_krw, r.good_this_week, r.praise_count,
    r.base_amount_snapshot_krw, r.praise_threshold_snapshot, r.praise_total_amount_snapshot_krw,
    r.paid_on, r.event_title, r.created_at from public.manual_money_rewards r where r.id = v_reward.id;
end;
$$;

-- Marking PAID is an atomic, once-only bookkeeping acknowledgement after the parent completed an
-- outside payment. It never initiates a transfer and PAID records cannot be voided.
create or replace function public.mark_manual_money_reward_paid(
  p_reward_id uuid,
  p_actual_paid_on date,
  p_idempotency_key uuid
)
returns table(
  reward_id uuid,
  child_profile_id uuid,
  reward_kind text,
  period_start date,
  period_end date,
  status text,
  scheduled_amount_krw integer,
  good_this_week boolean,
  praise_count integer,
  base_amount_snapshot_krw integer,
  praise_threshold_snapshot integer,
  praise_total_amount_snapshot_krw integer,
  paid_on date,
  event_title text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.current_verified_principal_id();
  v_reward public.manual_money_rewards%rowtype;
  v_event public.manual_reward_events%rowtype;
  v_today date;
  v_payload jsonb;
begin
  if p_reward_id is null or p_actual_paid_on is null or p_idempotency_key is null or v_actor is null then
    raise exception 'INVALID_MONEY_PAID_CONFIRMATION' using errcode = '22023';
  end if;
  select r.* into v_reward from public.manual_money_rewards r where r.id = p_reward_id for update;
  if v_reward.id is null or not private.manual_reward_actor_is_verified_parent(v_actor, v_reward.family_id) then
    raise exception 'MANUAL_REWARD_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  v_today := private.manual_reward_family_today(v_reward.family_id);
  if v_today is null or p_actual_paid_on > v_today then
    raise exception 'INVALID_MONEY_PAID_DATE' using errcode = '22023';
  end if;
  v_payload := jsonb_build_object('operation', 'MONEY_PAID', 'reward_id', p_reward_id, 'actual_paid_on', p_actual_paid_on);
  perform pg_advisory_xact_lock(hashtextextended(v_actor::text || ':' || p_idempotency_key::text, 1209));
  select e.* into v_event from public.manual_reward_events e
  where e.actor_principal_id = v_actor and e.idempotency_key = p_idempotency_key for update;
  if v_event.id is not null then
    if v_event.money_reward_id = p_reward_id and v_event.request_payload = v_payload then
      return query select r.id, r.child_profile_id, r.reward_kind::text, r.period_start, r.period_end,
        r.status::text, r.planned_amount_krw, r.good_this_week, r.praise_count,
        r.base_amount_snapshot_krw, r.praise_threshold_snapshot, r.praise_total_amount_snapshot_krw,
        r.paid_on, r.event_title, r.created_at from public.manual_money_rewards r where r.id = p_reward_id;
      return;
    end if;
    raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = '22023';
  end if;
  if v_reward.status <> 'SCHEDULED' then
    raise exception 'MONEY_REWARD_NOT_SCHEDULED' using errcode = '22023';
  end if;
  update public.manual_money_rewards r
  set status = 'PAID', paid_by_principal_id = v_actor, paid_at = now(), paid_on = p_actual_paid_on
  where r.id = p_reward_id returning * into v_reward;
  insert into public.manual_reward_events(
    family_id, money_reward_id, actor_principal_id, event_kind, idempotency_key, request_payload
  ) values (v_reward.family_id, v_reward.id, v_actor, 'MONEY_PAID', p_idempotency_key, v_payload);
  return query select r.id, r.child_profile_id, r.reward_kind::text, r.period_start, r.period_end,
    r.status::text, r.planned_amount_krw, r.good_this_week, r.praise_count,
    r.base_amount_snapshot_krw, r.praise_threshold_snapshot, r.praise_total_amount_snapshot_krw,
    r.paid_on, r.event_title, r.created_at from public.manual_money_rewards r where r.id = v_reward.id;
end;
$$;

create or replace function public.void_scheduled_money_reward(
  p_reward_id uuid,
  p_reason text,
  p_idempotency_key uuid
)
returns table(reward_id uuid, status text, voided_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.current_verified_principal_id();
  v_reward public.manual_money_rewards%rowtype;
  v_event public.manual_reward_events%rowtype;
  v_reason text := nullif(btrim(p_reason), '');
  v_payload jsonb;
begin
  if p_reward_id is null or p_idempotency_key is null or v_reason is null
     or char_length(v_reason) > 240 or v_actor is null then
    raise exception 'INVALID_MONEY_VOID' using errcode = '22023';
  end if;
  select r.* into v_reward from public.manual_money_rewards r where r.id = p_reward_id for update;
  if v_reward.id is null or not private.manual_reward_actor_is_verified_parent(v_actor, v_reward.family_id) then
    raise exception 'MANUAL_REWARD_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  v_payload := jsonb_build_object('operation', 'MONEY_VOID', 'reward_id', p_reward_id, 'reason', v_reason);
  perform pg_advisory_xact_lock(hashtextextended(v_actor::text || ':' || p_idempotency_key::text, 1209));
  select e.* into v_event from public.manual_reward_events e
  where e.actor_principal_id = v_actor and e.idempotency_key = p_idempotency_key for update;
  if v_event.id is not null then
    if v_event.money_reward_id = p_reward_id and v_event.request_payload = v_payload then
      return query select r.id, r.status::text, r.voided_at from public.manual_money_rewards r where r.id = p_reward_id;
      return;
    end if;
    raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = '22023';
  end if;
  if v_reward.status <> 'SCHEDULED' then
    -- PAID is intentionally excluded: an actual external payment cannot be silently cancelled.
    raise exception 'ONLY_SCHEDULED_MONEY_REWARD_CAN_BE_VOIDED' using errcode = '22023';
  end if;
  update public.manual_money_rewards r
  set status = 'VOID', voided_by_principal_id = v_actor, voided_at = now(), void_reason = v_reason
  where r.id = p_reward_id returning * into v_reward;
  insert into public.manual_reward_events(
    family_id, money_reward_id, actor_principal_id, event_kind, idempotency_key, request_payload
  ) values (v_reward.family_id, v_reward.id, v_actor, 'MONEY_VOIDED', p_idempotency_key, v_payload);
  return query select v_reward.id, v_reward.status::text, v_reward.voided_at;
end;
$$;

create or replace function public.issue_manual_bonus_coupon(
  p_family_id uuid,
  p_child_profile_id uuid,
  p_title text,
  p_reason text,
  p_unit text,
  p_amount integer,
  p_issued_on date,
  p_idempotency_key uuid
)
returns table(
  coupon_id uuid,
  child_profile_id uuid,
  title text,
  reason text,
  unit text,
  amount integer,
  issued_on date,
  status text,
  redeemed_at timestamptz,
  voided_at timestamptz,
  issued_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.current_verified_principal_id();
  v_title text := nullif(btrim(p_title), '');
  v_reason text := nullif(btrim(p_reason), '');
  v_unit public.manual_bonus_unit;
  v_today date;
  v_coupon public.manual_bonus_coupons%rowtype;
  v_event public.manual_reward_events%rowtype;
  v_payload jsonb;
begin
  if p_family_id is null or p_child_profile_id is null or p_issued_on is null
     or p_idempotency_key is null or v_title is null or v_reason is null
     or char_length(v_title) > 120 or char_length(v_reason) > 240 or p_unit is null
     or upper(btrim(p_unit)) not in ('TIME_MINUTES', 'MONEY_KRW', 'ACTIVITY', 'CUSTOM', 'TEXT')
     or p_amount is not null and p_amount <= 0 or v_actor is null then
    raise exception 'INVALID_MANUAL_BONUS_COUPON' using errcode = '22023';
  end if;
  v_unit := upper(btrim(p_unit))::public.manual_bonus_unit;
  if v_unit in ('TIME_MINUTES', 'MONEY_KRW') and p_amount is null then
    raise exception 'BONUS_AMOUNT_REQUIRED_FOR_UNIT' using errcode = '22023';
  end if;
  if not private.manual_reward_actor_is_verified_parent(v_actor, p_family_id)
     or not private.manual_reward_child_is_active(p_family_id, p_child_profile_id) then
    raise exception 'MANUAL_REWARD_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  v_today := private.manual_reward_family_today(p_family_id);
  if v_today is null or p_issued_on > v_today then
    raise exception 'INVALID_BONUS_ISSUE_DATE' using errcode = '22023';
  end if;
  v_payload := jsonb_build_object(
    'operation', 'BONUS_ISSUE', 'family_id', p_family_id, 'child_profile_id', p_child_profile_id,
    'title', v_title, 'reason', v_reason, 'unit', v_unit::text, 'amount', p_amount, 'issued_on', p_issued_on
  );
  perform pg_advisory_xact_lock(hashtextextended(v_actor::text || ':' || p_idempotency_key::text, 1209));
  select e.* into v_event from public.manual_reward_events e
  where e.actor_principal_id = v_actor and e.idempotency_key = p_idempotency_key for update;
  if v_event.id is not null then
    if v_event.bonus_coupon_id is not null and v_event.request_payload = v_payload then
      return query select c.id, c.child_profile_id, c.title, c.reason, c.unit::text, c.amount,
        c.issued_on, c.status::text, c.redeemed_at, c.voided_at, c.issued_at
      from public.manual_bonus_coupons c where c.id = v_event.bonus_coupon_id;
      return;
    end if;
    raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = '22023';
  end if;
  insert into public.manual_bonus_coupons(
    family_id, child_profile_id, title, reason, unit, amount, issued_on, issued_by_principal_id
  ) values (
    p_family_id, p_child_profile_id, v_title, v_reason, v_unit, p_amount, p_issued_on, v_actor
  ) returning * into v_coupon;
  insert into public.manual_reward_events(
    family_id, bonus_coupon_id, actor_principal_id, event_kind, idempotency_key, request_payload
  ) values (p_family_id, v_coupon.id, v_actor, 'BONUS_ISSUED', p_idempotency_key, v_payload);
  return query select v_coupon.id, v_coupon.child_profile_id, v_coupon.title, v_coupon.reason,
    v_coupon.unit::text, v_coupon.amount, v_coupon.issued_on, v_coupon.status::text,
    v_coupon.redeemed_at, v_coupon.voided_at, v_coupon.issued_at;
end;
$$;

-- A coupon can make only its one atomic ISSUED -> REDEEMED transition. It does not post a time
-- entry even if its unit says TIME_MINUTES; it remains a separate coupon grant and audit trail.
create or replace function public.redeem_manual_bonus_coupon(
  p_coupon_id uuid,
  p_idempotency_key uuid
)
returns table(coupon_id uuid, status text, redeemed_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.current_verified_principal_id();
  v_coupon public.manual_bonus_coupons%rowtype;
  v_event public.manual_reward_events%rowtype;
  v_payload jsonb;
begin
  if p_coupon_id is null or p_idempotency_key is null or v_actor is null then
    raise exception 'INVALID_BONUS_REDEMPTION' using errcode = '22023';
  end if;
  select c.* into v_coupon from public.manual_bonus_coupons c where c.id = p_coupon_id for update;
  if v_coupon.id is null or not private.manual_reward_actor_is_verified_parent(v_actor, v_coupon.family_id) then
    raise exception 'MANUAL_REWARD_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  v_payload := jsonb_build_object('operation', 'BONUS_REDEEM', 'coupon_id', p_coupon_id);
  perform pg_advisory_xact_lock(hashtextextended(v_actor::text || ':' || p_idempotency_key::text, 1209));
  select e.* into v_event from public.manual_reward_events e
  where e.actor_principal_id = v_actor and e.idempotency_key = p_idempotency_key for update;
  if v_event.id is not null then
    if v_event.bonus_coupon_id = p_coupon_id and v_event.request_payload = v_payload then
      return query select c.id, c.status::text, c.redeemed_at from public.manual_bonus_coupons c where c.id = p_coupon_id;
      return;
    end if;
    raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = '22023';
  end if;
  if v_coupon.status <> 'ISSUED' then
    raise exception 'BONUS_COUPON_NOT_ISSUED' using errcode = '22023';
  end if;
  update public.manual_bonus_coupons c
  set status = 'REDEEMED', redeemed_by_principal_id = v_actor, redeemed_at = now()
  where c.id = p_coupon_id returning * into v_coupon;
  insert into public.manual_reward_events(
    family_id, bonus_coupon_id, actor_principal_id, event_kind, idempotency_key, request_payload
  ) values (v_coupon.family_id, v_coupon.id, v_actor, 'BONUS_REDEEMED', p_idempotency_key, v_payload);
  return query select v_coupon.id, v_coupon.status::text, v_coupon.redeemed_at;
end;
$$;

create or replace function public.void_manual_bonus_coupon(
  p_coupon_id uuid,
  p_reason text,
  p_idempotency_key uuid
)
returns table(coupon_id uuid, status text, voided_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.current_verified_principal_id();
  v_coupon public.manual_bonus_coupons%rowtype;
  v_event public.manual_reward_events%rowtype;
  v_reason text := nullif(btrim(p_reason), '');
  v_payload jsonb;
begin
  if p_coupon_id is null or p_idempotency_key is null or v_reason is null
     or char_length(v_reason) > 240 or v_actor is null then
    raise exception 'INVALID_BONUS_VOID' using errcode = '22023';
  end if;
  select c.* into v_coupon from public.manual_bonus_coupons c where c.id = p_coupon_id for update;
  if v_coupon.id is null or not private.manual_reward_actor_is_verified_parent(v_actor, v_coupon.family_id) then
    raise exception 'MANUAL_REWARD_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  v_payload := jsonb_build_object('operation', 'BONUS_VOID', 'coupon_id', p_coupon_id, 'reason', v_reason);
  perform pg_advisory_xact_lock(hashtextextended(v_actor::text || ':' || p_idempotency_key::text, 1209));
  select e.* into v_event from public.manual_reward_events e
  where e.actor_principal_id = v_actor and e.idempotency_key = p_idempotency_key for update;
  if v_event.id is not null then
    if v_event.bonus_coupon_id = p_coupon_id and v_event.request_payload = v_payload then
      return query select c.id, c.status::text, c.voided_at from public.manual_bonus_coupons c where c.id = p_coupon_id;
      return;
    end if;
    raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = '22023';
  end if;
  if v_coupon.status <> 'ISSUED' then
    raise exception 'ONLY_UNREDEEMED_BONUS_COUPON_CAN_BE_VOIDED' using errcode = '22023';
  end if;
  update public.manual_bonus_coupons c
  set status = 'VOID', voided_by_principal_id = v_actor, voided_at = now(), void_reason = v_reason
  where c.id = p_coupon_id returning * into v_coupon;
  insert into public.manual_reward_events(
    family_id, bonus_coupon_id, actor_principal_id, event_kind, idempotency_key, request_payload
  ) values (v_coupon.family_id, v_coupon.id, v_actor, 'BONUS_VOIDED', p_idempotency_key, v_payload);
  return query select v_coupon.id, v_coupon.status::text, v_coupon.voided_at;
end;
$$;

create or replace function public.list_parent_manual_rewards(p_family_id uuid)
returns table(
  reward_id uuid,
  child_profile_id uuid,
  child_name text,
  reward_kind text,
  period_start date,
  period_end date,
  event_title text,
  status text,
  scheduled_amount_krw integer,
  good_this_week boolean,
  praise_count integer,
  base_amount_snapshot_krw integer,
  praise_threshold_snapshot integer,
  praise_total_amount_snapshot_krw integer,
  paid_on date,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.current_verified_principal_id();
begin
  if p_family_id is null or v_actor is null
     or not private.manual_reward_actor_is_verified_parent(v_actor, p_family_id) then
    raise exception 'MANUAL_REWARD_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  return query
  select r.id, r.child_profile_id, cp.display_name, r.reward_kind::text, r.period_start, r.period_end,
    r.event_title, r.status::text, r.planned_amount_krw, r.good_this_week, r.praise_count,
    r.base_amount_snapshot_krw, r.praise_threshold_snapshot, r.praise_total_amount_snapshot_krw,
    r.paid_on, r.created_at
  from public.manual_money_rewards r
  join public.child_profiles cp on cp.id = r.child_profile_id
  where r.family_id = p_family_id
  order by r.created_at desc, r.id desc;
end;
$$;

-- Parent sees the complete child reward projection; the linked active child sees only their own
-- projection. Guardians are denied rather than being given an apparently harmless balance view.
create or replace function public.list_child_manual_rewards(p_child_profile_id uuid)
returns table(
  record_type text,
  record_id uuid,
  title text,
  reason text,
  state text,
  unit text,
  amount integer,
  scheduled_amount_krw integer,
  period_start date,
  period_end date,
  issued_on date,
  paid_on date,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.current_verified_principal_id();
  v_family_id uuid;
begin
  select cp.family_id into v_family_id from public.child_profiles cp where cp.id = p_child_profile_id;
  if p_child_profile_id is null or v_actor is null or v_family_id is null
     or not (
       private.manual_reward_actor_is_verified_parent(v_actor, v_family_id)
       or private.manual_reward_actor_is_verified_child_self(v_actor, p_child_profile_id)
     ) then
    raise exception 'MANUAL_REWARD_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  return query
  select 'MONEY'::text, r.id,
    coalesce(r.event_title, case r.reward_kind
      when 'DAILY' then '일 보상' when 'WEEKLY' then '주간 보상' when 'MONTHLY' then '월 보상' else '특별 이벤트 보상' end),
    case when r.reward_kind = 'WEEKLY' and r.good_this_week is false then '이번 주 잘했음 미확정/아니오: 지급 예정 없음'
         when r.status = 'PENDING' then '아직 지급 대기 중'
         when r.status = 'SCHEDULED' then '부모가 실제로 지급하기 전의 지급 예정 기록'
         when r.status = 'PAID' then '부모가 외부 지급 완료로 표시한 기록'
         else '지급 예정 취소 기록' end,
    r.status::text, 'MONEY_KRW'::text, null::integer, r.planned_amount_krw,
    r.period_start, r.period_end, null::date, r.paid_on, r.created_at
  from public.manual_money_rewards r
  where r.child_profile_id = p_child_profile_id
  union all
  select 'BONUS_COUPON'::text, c.id, c.title, c.reason, c.status::text, c.unit::text,
    c.amount, null::integer, null::date, null::date, c.issued_on, null::date, c.issued_at
  from public.manual_bonus_coupons c
  where c.child_profile_id = p_child_profile_id
  order by created_at desc, record_id desc;
end;
$$;

alter table public.manual_money_rewards enable row level security;
alter table public.manual_bonus_coupons enable row level security;
alter table public.manual_reward_events enable row level security;

-- RPC-only surface: no client may read/insert/update/delete the raw records or audit evidence.
revoke all on table
  public.manual_money_rewards,
  public.manual_bonus_coupons,
  public.manual_reward_events
from public, anon, authenticated;

revoke all on function private.manual_reward_family_today(uuid) from public, anon, authenticated;
revoke all on function private.manual_reward_actor_is_verified_parent(uuid, uuid) from public, anon, authenticated;
revoke all on function private.manual_reward_child_is_active(uuid, uuid) from public, anon, authenticated;
revoke all on function private.manual_reward_actor_is_verified_child_self(uuid, uuid) from public, anon, authenticated;
revoke all on function private.guard_manual_reward_event_append_only() from public, anon, authenticated;
revoke all on function public.upsert_weekly_money_reward(uuid, uuid, date, boolean, integer, integer, integer, integer, uuid) from public, anon, authenticated;
revoke all on function public.create_period_money_reward(uuid, uuid, text, date, text, text, integer, uuid) from public, anon, authenticated;
revoke all on function public.mark_manual_money_reward_paid(uuid, date, uuid) from public, anon, authenticated;
revoke all on function public.void_scheduled_money_reward(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.issue_manual_bonus_coupon(uuid, uuid, text, text, text, integer, date, uuid) from public, anon, authenticated;
revoke all on function public.redeem_manual_bonus_coupon(uuid, uuid) from public, anon, authenticated;
revoke all on function public.void_manual_bonus_coupon(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.list_parent_manual_rewards(uuid) from public, anon, authenticated;
revoke all on function public.list_child_manual_rewards(uuid) from public, anon, authenticated;

grant execute on function public.upsert_weekly_money_reward(uuid, uuid, date, boolean, integer, integer, integer, integer, uuid) to authenticated;
grant execute on function public.create_period_money_reward(uuid, uuid, text, date, text, text, integer, uuid) to authenticated;
grant execute on function public.mark_manual_money_reward_paid(uuid, date, uuid) to authenticated;
grant execute on function public.void_scheduled_money_reward(uuid, text, uuid) to authenticated;
grant execute on function public.issue_manual_bonus_coupon(uuid, uuid, text, text, text, integer, date, uuid) to authenticated;
grant execute on function public.redeem_manual_bonus_coupon(uuid, uuid) to authenticated;
grant execute on function public.void_manual_bonus_coupon(uuid, text, uuid) to authenticated;
grant execute on function public.list_parent_manual_rewards(uuid) to authenticated;
grant execute on function public.list_child_manual_rewards(uuid) to authenticated;

comment on table public.manual_money_rewards is
  'Parent-confirmed manual KRW records only. SCHEDULED is not a transfer; PAID is a once-only external-payment acknowledgement.';
comment on table public.manual_bonus_coupons is
  'Teacher-praise bonus coupon grants. TIME_MINUTES is not linked to normal time balances or any ledger.';
comment on table public.manual_reward_events is
  'Immutable manual reward audit/provenance event log with actor-scoped idempotency keys.';
comment on function public.upsert_weekly_money_reward(uuid, uuid, date, boolean, integer, integer, integer, integer, uuid) is
  'Weekly preset: base 10000, threshold 5, total 15000 by default. The full family-local Mon-Sun period must end before SCHEDULED can be recorded.';
comment on function public.mark_manual_money_reward_paid(uuid, date, uuid) is
  'Records that a parent completed an external payment; this RPC never sends money or calls a payment provider.';

commit;
