begin;

-- RETURNS TABLE의 config_version_id와 실제 policy_sets 컬럼이 충돌하지 않게 별칭을 명시한다.
create or replace function public.publish_parent_rule_draft(p_config_version_id uuid)
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
  update public.policy_sets as ps
  set status = 'PUBLISHED', published_at = now()
  where ps.config_version_id = v_config.id;
  update public.family_config_versions as fcv
  set status = 'PUBLISHED', effective_from = v_effective_from,
      published_at = now(), published_by_principal_id = v_actor
  where fcv.id = v_config.id;
  return query select v_config.id, v_rule_id, v_effective_from, 'PUBLISHED'::text;
end;
$$;
revoke all on function public.publish_parent_rule_draft(uuid) from public, anon, authenticated;
grant execute on function public.publish_parent_rule_draft(uuid) to authenticated;

commit;
