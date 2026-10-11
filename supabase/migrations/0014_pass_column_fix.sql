begin;

-- TABLE 반환 변수 policy_rule_id와 실제 컬럼의 이름 충돌을 명시적 별칭으로 제거한다.
create or replace function public.save_parent_pass_rule_draft(
  p_family_id uuid,
  p_name text,
  p_category_code public.activity_category_code,
  p_description text,
  p_metric_label text,
  p_reward_minutes integer
)
returns table(config_version_id uuid, policy_rule_id uuid, status text)
language plpgsql security definer set search_path = ''
as $$
declare
  v_config_version_id uuid;
  v_policy_rule_id uuid;
begin
  if p_reward_minutes is null or p_reward_minutes not between 0 and 240 then
    raise exception 'INVALID_PASS_REWARD_MINUTES' using errcode = '22023';
  end if;
  select saved.config_version_id, saved.policy_rule_id
    into v_config_version_id, v_policy_rule_id
  from public.save_parent_rule_draft(
    p_family_id, p_name, p_category_code, p_description,
    'PERCENT'::public.policy_measurement_kind, p_metric_label,
    1, 99, p_reward_minutes, 0
  ) saved;
  update public.policy_dimensions pd
  set measurement_kind = 'PASS_FAIL'::public.policy_measurement_kind,
      unit = 'PASS_FAIL'
  where pd.policy_rule_id = v_policy_rule_id;
  return query select v_config_version_id, v_policy_rule_id, 'DRAFT'::text;
end;
$$;

revoke all on function public.save_parent_pass_rule_draft(uuid,text,public.activity_category_code,text,text,integer) from public,anon,authenticated;
grant execute on function public.save_parent_pass_rule_draft(uuid,text,public.activity_category_code,text,text,integer) to authenticated;
commit;
