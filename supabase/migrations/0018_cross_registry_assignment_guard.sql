begin;

-- 기존 배정 RPC를 남겨 두어도 v1↔v2 양방향으로 같은 실제 날짜가 겹치지 않는다.
-- 기존 create_activity_assignment의 가족 잠금(17)을 그대로 공유한다.
-- 행이나 게시본은 변경하지 않으며, 새 INSERT만 검증한다.
create or replace function private.guard_cross_registry_assignment()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_ref uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.family_id::text, 17));
  if tg_table_name = 'activity_assignments' then
    select t.subject_ref_id into v_ref from public.activity_templates t
    where t.id = new.activity_template_id and t.family_id = new.family_id;
    if exists (
      select 1 from public.routine_assignments a
      join public.routine_rules r on r.id = a.rule_id and r.family_id = a.family_id
      where a.family_id = new.family_id and a.child_profile_id = new.child_profile_id
        and r.subject_ref_id = v_ref
        and private.routine_schedules_share_date(a.starts_on, a.ends_on, a.weekdays, new.starts_on, new.ends_on, new.weekdays)
    ) then raise exception 'ROUTINE_ASSIGNMENT_CONFLICT' using errcode = '23P01'; end if;
  elsif tg_table_name = 'routine_assignments' then
    select r.subject_ref_id into v_ref from public.routine_rules r
    where r.id = new.rule_id and r.family_id = new.family_id;
    if private.routine_assignment_conflicts_legacy(new.family_id, new.child_profile_id, v_ref, new.starts_on, new.ends_on, new.weekdays) then
      raise exception 'ROUTINE_ASSIGNMENT_CONFLICT' using errcode = '23P01';
    end if;
  else
    raise exception 'ROUTINE_INVALID_ASSIGNMENT_SURFACE' using errcode = '55000';
  end if;
  return new;
end $$;

revoke all on function private.guard_cross_registry_assignment() from public, anon, authenticated;
drop trigger if exists cross_registry_assignment_guard on public.activity_assignments;
create trigger cross_registry_assignment_guard before insert on public.activity_assignments
for each row execute function private.guard_cross_registry_assignment();
drop trigger if exists cross_registry_assignment_guard on public.routine_assignments;
create trigger cross_registry_assignment_guard before insert on public.routine_assignments
for each row execute function private.guard_cross_registry_assignment();

commit;
