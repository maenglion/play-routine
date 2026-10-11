begin;

-- UNION 정렬은 TABLE 반환 변수 대신 출력 열 번호를 사용한다.
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
  order by 13 desc, 2 desc;
end;
$$;
commit;
