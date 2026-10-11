begin;

-- 0010 commits the enum value before this transaction. PASS_FAIL is intentionally a
-- binary parent confirmation, not a score range and never an automatic inference.
alter table public.policy_dimensions
  drop constraint if exists policy_dimensions_unit_check;
alter table public.policy_dimensions
  add constraint policy_dimensions_unit_check
  check (unit in ('PERCENT', 'QUANTITY', 'PASS_FAIL'));

-- PASS drafts reuse the proven immutable numeric three-band writer internally, but the
-- stored dimension is changed while the config is still DRAFT. Only 0 and 100 can later
-- be written for this measurement kind; 0 is NO_REWARD and 100 reaches the reward band.
create or replace function public.save_parent_pass_rule_draft(
  p_family_id uuid,
  p_name text,
  p_category_code public.activity_category_code,
  p_description text,
  p_metric_label text,
  p_reward_minutes integer
)
returns table(config_version_id uuid, policy_rule_id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_config_version_id uuid;
  v_policy_rule_id uuid;
begin
  if p_reward_minutes is null or p_reward_minutes not between 0 and 240 then
    raise exception 'INVALID_PASS_REWARD_MINUTES' using errcode = '22023';
  end if;

  -- [0,1), [1,99), [99,100] remains the existing exhaustive three-band shape.
  -- Its thresholds are private implementation details; PASS UI never exposes them.
  select saved.config_version_id, saved.policy_rule_id
    into v_config_version_id, v_policy_rule_id
  from public.save_parent_rule_draft(
    p_family_id,
    p_name,
    p_category_code,
    p_description,
    'PERCENT'::public.policy_measurement_kind,
    p_metric_label,
    1,
    99,
    p_reward_minutes,
    0
  ) saved;

  update public.policy_dimensions
  set measurement_kind = 'PASS_FAIL'::public.policy_measurement_kind,
      unit = 'PASS_FAIL'
  where policy_rule_id = v_policy_rule_id;

  return query select v_config_version_id, v_policy_rule_id, 'DRAFT'::text;
end;
$$;

-- Keep the generic numeric RPC for PERCENT/QUANTITY, but close the direct-RPC bypass:
-- a PASS_FAIL occurrence may only be confirmed as score 0 (not pass) or 100 (PASS).
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
  v_measurement_kind public.policy_measurement_kind;
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

  select pd.measurement_kind into v_measurement_kind
  from public.policy_dimensions pd
  where pd.policy_rule_id = v_occurrence.policy_rule_id;
  if v_measurement_kind is null then
    raise exception 'POLICY_RULE_NOT_EXHAUSTIVE' using errcode = '55000';
  end if;
  if v_measurement_kind = 'PASS_FAIL'::public.policy_measurement_kind
     and p_score not in (0, 100) then
    raise exception 'PASS_ACTIVITY_REQUIRES_BINARY_SCORE' using errcode = '22023';
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
     -- Endpoint NO_REWARD bands may carry an explicit zero-minute CREDIT/DEBIT
     -- effect. The middle band has no effect row. Neither shape may create an
     -- effect, but both must remain verifiable (including zero-minute PASS).
     or (v_outcome = 'NO_REWARD' and v_amount is not null and v_amount <> 0) then
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

-- PASS has a purpose-built client RPC. It checks that the frozen assigned policy is PASS_FAIL,
-- then delegates to the same append-only audit/revision/idempotency path as numeric reviews.
create or replace function public.verify_activity_pass(
  p_occurrence_id uuid,
  p_pass boolean,
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
  v_measurement_kind public.policy_measurement_kind;
begin
  if p_occurrence_id is null or p_pass is null or p_expected_revision is null
     or p_expected_revision < 0 or p_idempotency_key is null or v_actor is null then
    raise exception 'INVALID_ACTIVITY_PASS_VERIFICATION' using errcode = '22023';
  end if;

  select o.* into v_occurrence
  from public.activity_occurrences o
  where o.id = p_occurrence_id
  for update;
  if v_occurrence.id is null
     or not private.activity_actor_is_verified_parent(v_actor, v_occurrence.family_id) then
    raise exception 'ACTIVITY_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  select pd.measurement_kind into v_measurement_kind
  from public.policy_dimensions pd
  where pd.policy_rule_id = v_occurrence.policy_rule_id;
  if v_measurement_kind <> 'PASS_FAIL'::public.policy_measurement_kind then
    raise exception 'PASS_ACTIVITY_REQUIRED' using errcode = '22023';
  end if;

  perform public.verify_activity_occurrence(
    p_occurrence_id,
    case when p_pass then 100 else 0 end,
    p_reason,
    p_expected_revision,
    p_idempotency_key
  );
end;
$$;

-- Appending one column changes a PostgreSQL TABLE-return function's row type. Preflight refuses
-- to hide an unexpected database dependent; DROP without CASCADE is the second protection.
-- The RPC name and its original argument list remain unchanged, so Home hooks and review callers
-- continue to call list_activity_day; ActivityDayRow keeps this field optional for old fixtures.
do $$
declare
  v_dependents text;
begin
  select string_agg(pg_describe_object(d.classid, d.objid, d.objsubid), '; ')
    into v_dependents
  from pg_depend d
  where d.refclassid = 'pg_proc'::regclass
    and d.refobjid = 'public.list_activity_day(uuid,date)'::regprocedure
    and d.deptype in ('n', 'a');
  if v_dependents is not null then
    raise exception 'LIST_ACTIVITY_DAY_DEPENDENCY_BLOCKS_RETURN_SHAPE_CHANGE: %', v_dependents
      using errcode = '2BP01';
  end if;
end;
$$;

drop function public.list_activity_day(uuid, date);

create function public.list_activity_day(
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
  revision integer,
  measurement_kind text
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
    o.current_revision,
    pd.measurement_kind::text
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

revoke all on function public.save_parent_pass_rule_draft(
  uuid, text, public.activity_category_code, text, text, integer
) from public, anon, authenticated;
revoke all on function public.verify_activity_pass(uuid, boolean, text, integer, uuid) from public, anon, authenticated;
revoke all on function public.verify_activity_occurrence(uuid, numeric, text, integer, uuid) from public, anon, authenticated;
revoke all on function public.list_activity_day(uuid, date) from public, anon, authenticated;

grant execute on function public.save_parent_pass_rule_draft(
  uuid, text, public.activity_category_code, text, text, integer
) to authenticated;
grant execute on function public.verify_activity_pass(uuid, boolean, text, integer, uuid) to authenticated;
grant execute on function public.verify_activity_occurrence(uuid, numeric, text, integer, uuid) to authenticated;
grant execute on function public.list_activity_day(uuid, date) to authenticated;

comment on function public.save_parent_pass_rule_draft(uuid, text, public.activity_category_code, text, text, integer) is
  'Creates an immutable PASS_FAIL draft. Parent-confirmed PASS maps to planned time only; no ledger posting is created.';
comment on function public.verify_activity_pass(uuid, boolean, text, integer, uuid) is
  'Records parent PASS/not-pass through the append-only verification audit path. Not-pass has no reward and no automatic penalty.';
comment on function public.list_activity_day(uuid, date) is
  'Activity-day RPC; measurement_kind was appended in 0011 while keeping the same name and arguments for existing callers.';

commit;
