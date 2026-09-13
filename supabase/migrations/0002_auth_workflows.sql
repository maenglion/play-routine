begin;

do $$ begin
  create type public.notification_type as enum (
    'CHILD_LINKED',
    'CHILD_UNLINKED',
    'INVITATION_DECLINED',
    'INVITATION_EXPIRED'
  );
exception when duplicate_object then null;
end $$;

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  recipient_principal_id uuid not null references public.principals(id) on delete restrict,
  notification_type public.notification_type not null,
  title text not null,
  body text not null,
  metadata jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists notifications_recipient_unread_idx
  on public.notifications(recipient_principal_id, created_at desc)
  where read_at is null;

alter table public.notifications enable row level security;

drop policy if exists notifications_select_self on public.notifications;
create policy notifications_select_self on public.notifications
for select to authenticated
using (recipient_principal_id = public.current_principal_id());

drop policy if exists notifications_update_self on public.notifications;
create policy notifications_update_self on public.notifications
for update to authenticated
using (recipient_principal_id = public.current_principal_id())
with check (recipient_principal_id = public.current_principal_id());

revoke all on public.notifications from anon;
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;

create or replace function private.mask_email(p_email text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_email text := lower(btrim(p_email));
  v_local text;
  v_domain text;
begin
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'INVALID_EMAIL' using errcode = '22023';
  end if;
  v_local := split_part(v_email, '@', 1);
  v_domain := split_part(v_email, '@', 2);
  return left(v_local, least(2, char_length(v_local))) || '***@' || v_domain;
end;
$$;

create or replace function public.bootstrap_parent_family(
  p_family_name text,
  p_timezone text default 'Asia/Seoul',
  p_parent_display_name text default null
)
returns table(family_id uuid, principal_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_principal_id uuid;
  v_family_id uuid;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  if char_length(btrim(p_family_name)) not between 1 and 100 then
    raise exception 'INVALID_FAMILY_NAME' using errcode = '22023';
  end if;

  select p.id into v_principal_id
  from public.principals p
  where p.auth_user_id = auth.uid()
    and p.status = 'ACTIVE'
  for update;

  if v_principal_id is null then
    insert into public.principals(auth_user_id, display_name)
    values (auth.uid(), nullif(btrim(p_parent_display_name), ''))
    returning id into v_principal_id;
  elsif p_parent_display_name is not null then
    update public.principals
    set display_name = nullif(btrim(p_parent_display_name), '')
    where id = v_principal_id;
  end if;

  insert into public.families(name, timezone, created_by_principal_id)
  values (btrim(p_family_name), p_timezone, v_principal_id)
  returning id into v_family_id;

  insert into public.family_memberships(
    family_id,
    principal_id,
    role,
    status,
    created_by_principal_id
  ) values (
    v_family_id,
    v_principal_id,
    'OWNER_PARENT',
    'ACTIVE',
    v_principal_id
  );

  return query select v_family_id, v_principal_id;
end;
$$;

create or replace function public.create_child_invitation(
  p_family_id uuid,
  p_child_display_name text,
  p_child_email text,
  p_expires_in interval default interval '7 days'
)
returns table(invitation_id uuid, child_profile_id uuid, email_masked text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.current_principal_id();
  v_profile_id uuid;
  v_invitation_id uuid;
  v_fingerprint bytea;
  v_masked text;
  v_expires_at timestamptz;
begin
  if v_actor is null or not public.is_active_parent(p_family_id) then
    raise exception 'PARENT_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  if char_length(btrim(p_child_display_name)) not between 1 and 100 then
    raise exception 'INVALID_CHILD_NAME' using errcode = '22023';
  end if;
  if p_expires_in < interval '1 hour' or p_expires_in > interval '30 days' then
    raise exception 'INVALID_EXPIRY' using errcode = '22023';
  end if;

  v_fingerprint := private.email_fingerprint(p_child_email);
  v_masked := private.mask_email(p_child_email);
  v_expires_at := now() + p_expires_in;

  if exists (
    select 1
    from public.child_invitations ci
    where ci.family_id = p_family_id
      and ci.email_fingerprint = v_fingerprint
      and ci.status = 'ACTIVE'
      and ci.expires_at > now()
  ) then
    raise exception 'ACTIVE_INVITATION_EXISTS' using errcode = '23505';
  end if;

  update public.child_invitations ci
  set status = 'EXPIRED'
  where ci.family_id = p_family_id
    and ci.email_fingerprint = v_fingerprint
    and ci.status = 'ACTIVE'
    and ci.expires_at <= now();

  insert into public.child_profiles(
    family_id,
    display_name,
    status,
    created_by_principal_id
  ) values (
    p_family_id,
    btrim(p_child_display_name),
    'PENDING_LINK',
    v_actor
  ) returning id into v_profile_id;

  insert into public.child_invitations(
    family_id,
    child_profile_id,
    invited_by_principal_id,
    email_fingerprint,
    email_masked,
    status,
    expires_at
  ) values (
    p_family_id,
    v_profile_id,
    v_actor,
    v_fingerprint,
    v_masked,
    'ACTIVE',
    v_expires_at
  ) returning id into v_invitation_id;

  return query select v_invitation_id, v_profile_id, v_masked, v_expires_at;
end;
$$;

create or replace function public.complete_child_invitation(
  p_invitation_id uuid
)
returns table(family_id uuid, child_profile_id uuid, principal_id uuid, membership_id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_principal public.principals%rowtype;
  v_invitation public.child_invitations%rowtype;
  v_profile public.child_profiles%rowtype;
  v_membership_id uuid;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;

  select p.* into v_principal
  from public.principals p
  where p.auth_user_id = auth.uid()
    and p.status = 'ACTIVE'
  for update;

  if v_principal.id is null or v_principal.auth_email_fingerprint is null then
    raise exception 'VERIFIED_EMAIL_REQUIRED' using errcode = '28000';
  end if;

  select ci.* into v_invitation
  from public.child_invitations ci
  where ci.id = p_invitation_id
  for update;

  if v_invitation.id is null then
    raise exception 'INVITATION_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_invitation.status = 'ACCEPTED'
     and v_invitation.accepted_principal_id = v_principal.id then
    select fm.id into v_membership_id
    from public.family_memberships fm
    where fm.family_id = v_invitation.family_id
      and fm.principal_id = v_principal.id
      and fm.role = 'CHILD'
      and fm.status = 'ACTIVE'
    limit 1;

    if v_membership_id is null then
      raise exception 'INVITATION_ALREADY_USED' using errcode = 'P0001';
    end if;

    return query select
      v_invitation.family_id,
      v_invitation.child_profile_id,
      v_principal.id,
      v_membership_id,
      'ACTIVE'::text;
    return;
  end if;

  if v_invitation.status <> 'ACTIVE' then
    raise exception 'INVITATION_NOT_ACTIVE' using errcode = 'P0001';
  end if;
  if v_invitation.expires_at <= now() then
    raise exception 'INVITATION_EXPIRED' using errcode = 'P0001';
  end if;
  if v_invitation.email_fingerprint <> v_principal.auth_email_fingerprint then
    raise exception 'INVITATION_EMAIL_MISMATCH' using errcode = '28000';
  end if;

  select cp.* into v_profile
  from public.child_profiles cp
  where cp.id = v_invitation.child_profile_id
    and cp.family_id = v_invitation.family_id
  for update;

  if v_profile.id is null then
    raise exception 'CHILD_PROFILE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_profile.status not in ('PENDING_LINK', 'UNLINKED') then
    raise exception 'CHILD_PROFILE_NOT_LINKABLE' using errcode = 'P0001';
  end if;
  if v_profile.principal_id is not null and v_profile.principal_id <> v_principal.id then
    raise exception 'CHILD_PROFILE_ALREADY_LINKED' using errcode = '23505';
  end if;

  select fm.id into v_membership_id
  from public.family_memberships fm
  where fm.family_id = v_invitation.family_id
    and fm.principal_id = v_principal.id
    and fm.status = 'ACTIVE'
  limit 1;

  if v_membership_id is null then
    insert into public.family_memberships(
      family_id,
      principal_id,
      role,
      status,
      created_by_principal_id
    ) values (
      v_invitation.family_id,
      v_principal.id,
      'CHILD',
      'ACTIVE',
      v_invitation.invited_by_principal_id
    ) returning id into v_membership_id;
  else
    if exists (
      select 1 from public.family_memberships fm
      where fm.id = v_membership_id and fm.role <> 'CHILD'
    ) then
      raise exception 'PRINCIPAL_ALREADY_HAS_ADULT_ROLE' using errcode = '23505';
    end if;
  end if;

  update public.child_profiles
  set principal_id = v_principal.id,
      status = 'ACTIVE',
      linked_at = coalesce(linked_at, now()),
      unlinked_at = null
  where id = v_profile.id;

  update public.child_invitations
  set status = 'ACCEPTED',
      accepted_at = now(),
      accepted_principal_id = v_principal.id
  where id = v_invitation.id;

  insert into public.auth_link_events(
    family_id,
    child_profile_id,
    principal_id,
    invitation_id,
    event_type,
    actor_principal_id,
    reason
  ) values (
    v_invitation.family_id,
    v_profile.id,
    v_principal.id,
    v_invitation.id,
    (
      case
        when v_profile.status = 'UNLINKED' then 'RELINKED'
        else 'LINKED'
      end
    )::public.auth_link_event_type,
    v_principal.id,
    'EMAIL_OTP_INVITATION_ACCEPTED'
  );

  insert into public.notifications(
    family_id,
    recipient_principal_id,
    notification_type,
    title,
    body,
    metadata
  )
  select
    fm.family_id,
    fm.principal_id,
    'CHILD_LINKED',
    '자녀 계정이 연결되었습니다',
    v_profile.display_name || ' 계정이 이메일 인증 후 연결되었습니다.',
    jsonb_build_object(
      'child_profile_id', v_profile.id,
      'invitation_id', v_invitation.id
    )
  from public.family_memberships fm
  where fm.family_id = v_invitation.family_id
    and fm.status = 'ACTIVE'
    and fm.role in ('OWNER_PARENT', 'PARENT');

  return query select
    v_invitation.family_id,
    v_profile.id,
    v_principal.id,
    v_membership_id,
    'ACTIVE'::text;
end;
$$;

create or replace function public.decline_child_invitation(
  p_invitation_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_principal public.principals%rowtype;
  v_invitation public.child_invitations%rowtype;
begin
  select p.* into v_principal
  from public.principals p
  where p.auth_user_id = auth.uid()
    and p.status = 'ACTIVE';

  if v_principal.id is null or v_principal.auth_email_fingerprint is null then
    raise exception 'VERIFIED_EMAIL_REQUIRED' using errcode = '28000';
  end if;

  select ci.* into v_invitation
  from public.child_invitations ci
  where ci.id = p_invitation_id
  for update;

  if v_invitation.id is null
     or v_invitation.status <> 'ACTIVE'
     or v_invitation.expires_at <= now()
     or v_invitation.email_fingerprint <> v_principal.auth_email_fingerprint then
    raise exception 'INVITATION_NOT_AVAILABLE' using errcode = 'P0001';
  end if;

  update public.child_invitations
  set status = 'DECLINED', declined_at = now()
  where id = v_invitation.id;

  insert into public.notifications(
    family_id,
    recipient_principal_id,
    notification_type,
    title,
    body,
    metadata
  )
  select
    fm.family_id,
    fm.principal_id,
    'INVITATION_DECLINED',
    '자녀 초대가 거절되었습니다',
    '초대받은 이메일 사용자가 연결을 거절했습니다.',
    jsonb_build_object('invitation_id', v_invitation.id)
  from public.family_memberships fm
  where fm.family_id = v_invitation.family_id
    and fm.status = 'ACTIVE'
    and fm.role in ('OWNER_PARENT', 'PARENT');
end;
$$;

create or replace function public.cancel_child_invitation(
  p_invitation_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invitation public.child_invitations%rowtype;
begin
  select ci.* into v_invitation
  from public.child_invitations ci
  where ci.id = p_invitation_id
  for update;

  if v_invitation.id is null or not public.is_active_parent(v_invitation.family_id) then
    raise exception 'PARENT_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  if v_invitation.status <> 'ACTIVE' then
    raise exception 'INVITATION_NOT_ACTIVE' using errcode = 'P0001';
  end if;

  update public.child_invitations
  set status = 'CANCELED', canceled_at = now()
  where id = v_invitation.id;
end;
$$;

create or replace function public.unlink_child_profile(
  p_child_profile_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.current_principal_id();
  v_profile public.child_profiles%rowtype;
begin
  select cp.* into v_profile
  from public.child_profiles cp
  where cp.id = p_child_profile_id
  for update;

  if v_profile.id is null or not public.is_active_parent(v_profile.family_id) then
    raise exception 'PARENT_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  if v_profile.status <> 'ACTIVE' or v_profile.principal_id is null then
    raise exception 'CHILD_PROFILE_NOT_ACTIVE' using errcode = 'P0001';
  end if;

  update public.family_memberships
  set status = 'ENDED',
      valid_to = now(),
      ended_by_principal_id = v_actor
  where family_id = v_profile.family_id
    and principal_id = v_profile.principal_id
    and role = 'CHILD'
    and status = 'ACTIVE';

  update public.child_profiles
  set status = 'UNLINKED',
      principal_id = null,
      unlinked_at = now()
  where id = v_profile.id;

  insert into public.auth_link_events(
    family_id,
    child_profile_id,
    principal_id,
    event_type,
    actor_principal_id,
    reason
  ) values (
    v_profile.family_id,
    v_profile.id,
    v_profile.principal_id,
    'UNLINKED',
    v_actor,
    nullif(btrim(p_reason), '')
  );

  insert into public.notifications(
    family_id,
    recipient_principal_id,
    notification_type,
    title,
    body,
    metadata
  ) values (
    v_profile.family_id,
    v_profile.principal_id,
    'CHILD_UNLINKED',
    '가족 연결이 해제되었습니다',
    '보호자가 이 가족과의 계정 연결을 해제했습니다.',
    jsonb_build_object('child_profile_id', v_profile.id)
  );
end;
$$;

revoke all on function private.mask_email(text) from public, anon, authenticated;
revoke all on function public.bootstrap_parent_family(text, text, text) from public, anon, authenticated;
revoke all on function public.create_child_invitation(uuid, text, text, interval) from public, anon, authenticated;
revoke all on function public.complete_child_invitation(uuid) from public, anon, authenticated;
revoke all on function public.decline_child_invitation(uuid) from public, anon, authenticated;
revoke all on function public.cancel_child_invitation(uuid) from public, anon, authenticated;
revoke all on function public.unlink_child_profile(uuid, text) from public, anon, authenticated;

grant execute on function public.bootstrap_parent_family(text, text, text) to authenticated;
grant execute on function public.create_child_invitation(uuid, text, text, interval) to authenticated;
grant execute on function public.complete_child_invitation(uuid) to authenticated;
grant execute on function public.decline_child_invitation(uuid) to authenticated;
grant execute on function public.cancel_child_invitation(uuid) to authenticated;
grant execute on function public.unlink_child_profile(uuid, text) to authenticated;

commit;
