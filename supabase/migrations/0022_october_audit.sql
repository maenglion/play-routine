begin;
-- 0020은 수정하지 않는다. 신규 October 테이블만 같은 append-only 감사 저장소에 연결한다.
-- reason/metrics/조건·효과 JSON/payload/이름·원문은 사본에 저장하지 않는다.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function play_audit.capture_october_row_change()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare
  v_old jsonb; v_new jsonb; v_row jsonb;
  v_old_safe jsonb; v_new_safe jsonb; v_changed text[];
  v_family uuid; v_row_id uuid;
  v_auth_user uuid := auth.uid(); v_principal uuid;
  v_columns text[] := array[
    'id','family_id','ordinance_id','ordinance_version_id','stable_code','jurisdiction',
    'version','ordinance_kind','rule_identity_id','domain','period','daily_limit',
    'created_by_principal_id','created_at','adopted_by_principal_id','adopted_at',
    'month','effective_from','effective_to','status','school_asset','plan_id',
    'child_profile_id','rule_version_id','adoption_id','business_date','state',
    'self_reported','confirmed_at','recognized_count','current_revision','updated_at',
    'occurrence_id','actor_principal_id','event_kind','event_key','revision_before',
    'revision_after','decision','recorded_at','bucket_type','period_start','period_end',
    'recognized_total','closed_at','source_occurrence_id','bucket_id','source_date',
    'asset','quantity','fulfilled_quantity','issued_by_principal_id','issued_at',
    'right_id','fulfilled_at','action'
  ];
begin
  if tg_table_schema <> 'public' or tg_level <> 'ROW' or tg_when <> 'AFTER'
    or tg_op not in ('INSERT','UPDATE','DELETE')
    or tg_table_name <> all(array[
      'october_ordinances','october_ordinance_versions','october_rule_identities',
      'october_rule_versions','october_plans','october_plan_adoptions',
      'october_occurrences','october_occurrence_events','october_buckets',
      'october_rights','october_fulfillments','october_request_events'
    ]) then
    raise exception 'OCTOBER_AUDIT_CONTEXT_INVALID' using errcode = '55000';
  end if;
  if tg_op in ('UPDATE','DELETE') then v_old := to_jsonb(old); end if;
  if tg_op in ('INSERT','UPDATE') then v_new := to_jsonb(new); end if;
  if tg_op = 'UPDATE' and v_old = v_new then return null; end if;
  if tg_op = 'UPDATE' and (v_old->'id' is distinct from v_new->'id'
    or v_old->'family_id' is distinct from v_new->'family_id') then
    raise exception 'AUDIT_IDENTITY_CHANGE_FORBIDDEN' using errcode = '55000';
  end if;
  v_row := coalesce(v_new,v_old);
  v_family := (v_row->>'family_id')::uuid;
  v_row_id := (v_row->>'id')::uuid;
  if v_family is null or v_row_id is null then
    raise exception 'AUDIT_TARGET_ID_REQUIRED' using errcode = '55000';
  end if;
  select p.id into v_principal from public.principals p where p.auth_user_id = v_auth_user;
  select coalesce(array_agg(k order by k),'{}'::text[]) into v_changed
  from (select jsonb_object_keys(coalesce(v_old,'{}'::jsonb)) as k
        union select jsonb_object_keys(coalesce(v_new,'{}'::jsonb)) as k) keys
  where v_old->k is distinct from v_new->k;
  if v_old is not null then
    select coalesce(jsonb_object_agg(e.key,e.value),'{}'::jsonb) into v_old_safe
    from jsonb_each(v_old) e where e.key = any(v_columns);
  end if;
  if v_new is not null then
    select coalesce(jsonb_object_agg(e.key,e.value),'{}'::jsonb) into v_new_safe
    from jsonb_each(v_new) e where e.key = any(v_columns);
  end if;
  insert into play_audit.events (
    family_id,table_schema,table_name,row_id,operation,transaction_id,
    actor_auth_user_id,actor_principal_id,actor_kind,db_session_user,jwt_role,
    changed_columns,old_values,new_values,old_fingerprint,new_fingerprint
  ) values (
    v_family,tg_table_schema,tg_table_name,v_row_id,tg_op,pg_current_xact_id()::text,
    v_auth_user,v_principal,case when v_auth_user is null then 'DATABASE_SESSION' else 'AUTH_USER' end,
    session_user::text,auth.role(),v_changed,v_old_safe,v_new_safe,
    case when v_old_safe is null then null else encode(sha256(convert_to(v_old_safe::text,'UTF8')),'hex') end,
    case when v_new_safe is null then null else encode(sha256(convert_to(v_new_safe::text,'UTF8')),'hex') end
  );
  return null;
end;
$function$;
revoke all on function play_audit.capture_october_row_change() from public,anon,authenticated,service_role;

do $install$
declare v_table text;
begin
  if to_regclass('play_audit.events') is null then
    raise exception 'OCTOBER_AUDIT_PREREQUISITES_MISSING' using errcode = '55000';
  end if;
  foreach v_table in array array[
    'october_ordinances','october_ordinance_versions','october_rule_identities',
    'october_rule_versions','october_plans','october_plan_adoptions',
    'october_occurrences','october_occurrence_events','october_buckets',
    'october_rights','october_fulfillments','october_request_events'
  ] loop
    if to_regclass(format('public.%I',v_table)) is null then
      raise exception 'OCTOBER_AUDIT_TARGET_MISSING: %',v_table using errcode = '55000';
    end if;
    execute format('drop trigger if exists play_audit_october_row_change on public.%I',v_table);
    execute format('create trigger play_audit_october_row_change after insert or update or delete on public.%I for each row execute function play_audit.capture_october_row_change()',v_table);
  end loop;
end;
$install$;
notify pgrst, 'reload schema';
commit;
