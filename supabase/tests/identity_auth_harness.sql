\set ON_ERROR_STOP on

do $$ begin
  create role anon nologin;
exception when duplicate_object then null;
end $$;

do $$ begin
  create role authenticated nologin;
exception when duplicate_object then null;
end $$;

do $$ begin
  create role service_role nologin bypassrls;
exception when duplicate_object then null;
end $$;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

\ir ../migrations/0001_identity_auth.sql
\ir ../migrations/0002_auth_workflows.sql
\ir ../migrations/0003_child_invitation_discovery.sql

do $$
declare
  v_parent_auth uuid := '10000000-0000-0000-0000-000000000001';
  v_child_auth uuid := '10000000-0000-0000-0000-000000000002';
  v_attacker_auth uuid := '10000000-0000-0000-0000-000000000003';
  v_parent_principal uuid;
  v_child_principal uuid;
  v_family uuid;
  v_child_profile uuid;
  v_second_profile uuid;
  v_invitation uuid;
  v_second_invitation uuid;
  v_masked text;
  v_expires timestamptz;
  v_membership uuid;
  v_status text;
  v_count integer;
begin
  insert into auth.users(id, email, raw_user_meta_data)
  values
    (v_parent_auth, 'parent@example.com', '{"display_name":"부모"}'),
    (v_child_auth, 'child@example.com', '{"display_name":"자녀"}'),
    (v_attacker_auth, 'attacker@example.com', '{"display_name":"다른 사용자"}');

  perform set_config('request.jwt.claim.sub', v_parent_auth::text, false);

  select b.family_id, b.principal_id
  into strict v_family, v_parent_principal
  from public.bootstrap_parent_family(
    '테스트 가족',
    'Asia/Seoul',
    '부모'
  ) b;

  select i.invitation_id, i.child_profile_id, i.email_masked, i.expires_at
  into strict v_invitation, v_child_profile, v_masked, v_expires
  from public.create_child_invitation(
    v_family,
    '자녀',
    'child@example.com',
    interval '7 days'
  ) i;

  if v_masked <> 'ch***@example.com' or v_expires <= now() then
    raise exception 'invitation masking or expiry is invalid';
  end if;

  begin
    perform public.create_child_invitation(
      v_family,
      '중복 자녀',
      'child@example.com',
      interval '7 days'
    );
    raise exception 'expected duplicate active email invitation to fail';
  exception when unique_violation then
    null;
  end;

  select i.invitation_id, i.child_profile_id
  into strict v_second_invitation, v_second_profile
  from public.create_child_invitation(
    v_family,
    '두 번째 자녀',
    'child2@example.com',
    interval '7 days'
  ) i;

  perform set_config('request.jwt.claim.sub', v_attacker_auth::text, false);
  begin
    perform public.complete_child_invitation(v_second_invitation);
    raise exception 'expected mismatched verified email to fail';
  exception when invalid_authorization_specification then
    null;
  end;

  perform set_config('request.jwt.claim.sub', v_child_auth::text, false);

  select count(*) into v_count
  from public.list_my_active_child_invitations() i
  where i.invitation_id = v_invitation;

  if v_count <> 1 then
    raise exception 'verified child cannot discover matching invitation';
  end if;

  select c.principal_id, c.membership_id, c.status
  into strict v_child_principal, v_membership, v_status
  from public.complete_child_invitation(v_invitation) c;

  if v_status <> 'ACTIVE' then
    raise exception 'child must be active immediately after acceptance';
  end if;

  perform public.complete_child_invitation(v_invitation);

  select count(*) into v_count
  from public.family_memberships fm
  where fm.family_id = v_family
    and fm.principal_id = v_child_principal
    and fm.role = 'CHILD'
    and fm.status = 'ACTIVE';

  if v_count <> 1 then
    raise exception 'idempotent acceptance created duplicate membership';
  end if;

  select count(*) into v_count
  from public.notifications n
  where n.family_id = v_family
    and n.notification_type = 'CHILD_LINKED';

  if v_count <> 1 then
    raise exception 'idempotent acceptance created duplicate notifications';
  end if;

  perform set_config('request.jwt.claim.sub', v_parent_auth::text, false);
  perform public.unlink_child_profile(v_child_profile, '테스트 연결 해제');

  if not exists (
    select 1
    from public.child_profiles cp
    where cp.id = v_child_profile
      and cp.status = 'UNLINKED'
      and cp.principal_id is null
  ) then
    raise exception 'child profile was not unlinked';
  end if;

  if exists (
    select 1
    from public.family_memberships fm
    where fm.id = v_membership
      and fm.status = 'ACTIVE'
  ) then
    raise exception 'child membership remained active after unlink';
  end if;

  if not exists (
    select 1
    from public.notifications n
    where n.recipient_principal_id = v_child_principal
      and n.notification_type = 'CHILD_UNLINKED'
  ) then
    raise exception 'child unlink notification is missing';
  end if;
end;
$$;

select count(*) = 3 as principals_created from public.principals;
select count(*) = 1 as family_created from public.families;
select count(*) = 1 as accepted_invitation_created
from public.child_invitations
where status = 'ACCEPTED';
select count(*) = 1 as active_invitation_created
from public.child_invitations
where status = 'ACTIVE';
select count(*) = 1 as child_unlinked
from public.child_profiles
where status = 'UNLINKED';

set role authenticated;

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-0000-0000-000000000003',
  false
);
select count(*) = 0 as unrelated_user_cannot_see_family
from public.families;
select count(*) = 0 as unrelated_user_cannot_see_child_profiles
from public.child_profiles;

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-0000-0000-000000000001',
  false
);
select count(*) = 1 as parent_can_see_family
from public.families;
select count(*) = 2 as parent_can_see_own_child_profiles
from public.child_profiles;

reset role;
