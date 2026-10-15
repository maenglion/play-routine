begin;

-- 이름·종류 변경과 이미 사용된 강화물의 삭제는 계속 금지한다.
-- 잘못 등록한 미사용 항목의 관리 삭제만 허용한다. 클라이언트 DELETE 권한은 부여하지 않는다.
create or replace function private.guard_routine_reinforcer()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := private.current_verified_principal_id();
begin
  if tg_op <> 'DELETE' then
    raise exception 'ROUTINE_IMMUTABLE_AUDIT_OR_PUBLISHED_RECORD' using errcode='55000';
  end if;
  if v_actor is null or not private.activity_actor_is_verified_parent(v_actor,old.family_id) then
    raise exception 'ROUTINE_ACCESS_REQUIRED' using errcode='42501';
  end if;
  if exists(select 1 from public.routine_reward_items i where i.reinforcer_id=old.id)
     or exists(select 1 from public.routine_drafts d where d.payload::text like '%'||old.id::text||'%')
     or exists(select 1 from public.routine_rules r where r.payload::text like '%'||old.id::text||'%') then
    raise exception 'ROUTINE_REINFORCER_IN_USE' using errcode='55000';
  end if;
  perform private.routine_record_request(v_actor,extensions.gen_random_uuid(),'REMOVE_UNUSED_REINFORCER',
    jsonb_build_object('family_id',old.family_id,'reinforcer_id',old.id,'name',old.name),
    jsonb_build_object('removed',true,'reinforcer_id',old.id));
  return old;
end $$;
revoke all on function private.guard_routine_reinforcer() from public,anon,authenticated;
drop trigger if exists routine_reinforcers_immutable on public.routine_reinforcers;
create trigger routine_reinforcers_immutable before update or delete on public.routine_reinforcers
  for each row execute function private.guard_routine_reinforcer();

commit;
