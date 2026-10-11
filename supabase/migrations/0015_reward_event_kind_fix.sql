begin;

-- CASE의 text 결과를 감사 이벤트 enum으로 명시해 주간 저장을 보정한다.
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
  v_event_payload jsonb;
begin
  if p_family_id is null or p_child_profile_id is null or p_week_reference_date is null
     or p_good_this_week is null or p_praise_count is null or p_idempotency_key is null
     or p_praise_count < 0 or p_base_amount_krw is null or p_base_amount_krw <= 0
     or p_praise_threshold is null or p_praise_threshold <= 0
     or p_praise_total_amount_krw is null or p_praise_total_amount_krw <= 0
     or p_praise_total_amount_krw < p_base_amount_krw
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

  perform pg_advisory_xact_lock(hashtextextended(v_actor::text || ':' || p_idempotency_key::text, 1209));
  select e.* into v_event
  from public.manual_reward_events e
  where e.actor_principal_id = v_actor and e.idempotency_key = p_idempotency_key
  for update;
  if v_event.id is not null then
    if v_event.money_reward_id is not null
       and (v_event.request_payload = v_payload or v_event.request_payload -> 'request' = v_payload) then
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

  perform pg_advisory_xact_lock(hashtextextended(
    p_family_id::text || ':' || p_child_profile_id::text || ':' || v_week_start::text, 1212
  ));
  select r.* into v_reward
  from public.manual_money_rewards r
  where r.family_id = p_family_id and r.child_profile_id = p_child_profile_id
    and r.reward_kind = 'WEEKLY' and r.period_start = v_week_start
  for update;

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
    v_event_payload := v_payload;
  elsif v_reward.status in ('PENDING', 'SCHEDULED') then
    -- Keep the before-image in immutable event evidence; there is still only one reward row.
    v_event_payload := jsonb_build_object(
      'request', v_payload,
      'previous_reward', jsonb_build_object(
        'status', v_reward.status::text,
        'planned_amount_krw', v_reward.planned_amount_krw,
        'good_this_week', v_reward.good_this_week,
        'praise_count', v_reward.praise_count,
        'base_amount_snapshot_krw', v_reward.base_amount_snapshot_krw,
        'praise_threshold_snapshot', v_reward.praise_threshold_snapshot,
        'praise_total_amount_snapshot_krw', v_reward.praise_total_amount_snapshot_krw
      )
    );
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
    raise exception 'WEEKLY_MONEY_REWARD_ALREADY_FINALIZED' using errcode = '22023';
  end if;

  insert into public.manual_reward_events(
    family_id, money_reward_id, actor_principal_id, event_kind, idempotency_key, request_payload
  ) values (
    p_family_id, v_reward.id, v_actor,
    (case when v_status = 'SCHEDULED' then 'MONEY_SCHEDULED' else 'MONEY_DRAFTED' end)::public.manual_reward_event_kind,
    p_idempotency_key, v_event_payload
  );

  return query
  select r.id, r.child_profile_id, r.reward_kind::text, r.period_start, r.period_end,
         r.status::text, r.planned_amount_krw, r.good_this_week, r.praise_count,
         r.base_amount_snapshot_krw, r.praise_threshold_snapshot,
         r.praise_total_amount_snapshot_krw, r.paid_on, r.event_title, r.created_at
  from public.manual_money_rewards r where r.id = v_reward.id;
end;
$$;

commit;
