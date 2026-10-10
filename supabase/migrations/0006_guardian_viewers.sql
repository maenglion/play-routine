begin;

-- Guardian invitations intentionally have their own lifecycle. They never create a child profile.
do $$ begin
  create type public.guardian_invitation_status as enum (
    'ACTIVE', 'ACCEPTED', 'CANCELED', 'EXPIRED'
  );
exception when duplicate_object then null;
end $$;

create table if not exists public.guardian_invitations (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  invited_by_principal_id uuid not null references public.principals(id) on delete restrict,
  email_fingerprint bytea not null,
  email_masked text not null,
  status public.guardian_invitation_status not null default 'ACTIVE',
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_principal_id uuid references public.principals(id) on delete restrict,
  canceled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (octet_length(email_fingerprint) = 32),
  check (expires_at > created_at),
  check (
    (status = 'ACTIVE' and accepted_at is null and accepted_principal_id is null and canceled_at is null)
    or (status = 'ACCEPTED' and accepted_at is not null and accepted_principal_id is not null)
    or (status = 'CANCELED' and canceled_at is not null)
    or status = 'EXPIRED'
  )
);

create unique index if not exists guardian_invitations_one_active_email_per_family
  on public.guardian_invitations(family_id, email_fingerprint)
  where status = 'ACTIVE';

create index if not exists guardian_invitations_fingerprint_status_idx
  on public.guardian_invitations(email_fingerprint, status, expires_at);

create index if not exists guardian_invitations_family_created_idx
  on public.guardian_invitations(family_id, created_at desc);

drop trigger if exists guardian_invitations_set_updated_at on public.guardian_invitations;
create trigger guardian_invitations_set_updated_at before update on public.guardian_invitations
for each row execute function public.set_updated_at();

alter table public.guardian_invitations enable row level security;

-- Guardians receive the family name through guardian_family_status only; they do not
-- inherit the general family row policy used by parents and children.
drop policy if exists families_select_member on public.families;
create policy families_select_parent_or_child on public.families
for select to authenticated
using (
  public.is_active_parent(id)
  or exists (
    select 1
    from public.family_memberships fm
    where fm.family_id = families.id
      and fm.principal_id = public.current_principal_id()
      and fm.role = 'CHILD'
      and fm.status = 'ACTIVE'
  )
);

-- A principal only receives child-profile or link-event data when it is an active CHILD,
-- never merely because it is a GUARDIAN with the same auth identity.
drop policy if exists child_profiles_select_parent_or_self on public.child_profiles;
create policy child_profiles_select_parent_or_active_child_self on public.child_profiles
for select to authenticated
using (
  public.is_active_parent(family_id)
  or exists (
    select 1
    from public.family_memberships fm
    where fm.family_id = child_profiles.family_id
      and fm.principal_id = public.current_principal_id()
      and fm.principal_id = child_profiles.principal_id
      and fm.role = 'CHILD'
      and fm.status = 'ACTIVE'
  )
);

drop policy if exists auth_link_events_select_parent_or_self on public.auth_link_events;
create policy auth_link_events_select_parent_or_active_child_self on public.auth_link_events
for select to authenticated
using (
  public.is_active_parent(family_id)
  or exists (
    select 1
    from public.family_memberships fm
    where fm.family_id = auth_link_events.family_id
      and fm.principal_id = public.current_principal_id()
      and fm.principal_id = auth_link_events.principal_id
      and fm.role = 'CHILD'
      and fm.status = 'ACTIVE'
  )
);

drop policy if exists guardian_invitations_select_parent on public.guardian_invitations;
create policy guardian_invitations_select_parent on public.guardian_invitations
for select to authenticated
using (public.is_active_parent(family_id));

-- No client table INSERT/UPDATE/DELETE policy is granted. Lifecycle changes are RPC-only.
revoke all on table public.guardian_invitations from anon, authenticated;
grant select (
  id,
  family_id,
  email_masked,
  status,
  expires_at,
  accepted_at,
  created_at
) on public.guardian_invitations to authenticated;

-- A guardian-only account must not bootstrap a separate editable parent workspace.
-- A person who is already an active parent in another family remains an adult account;
-- this guard only applies when their active memberships are GUARDIAN-only.
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

  if exists (
    select 1
    from public.family_memberships guardian_membership
    where guardian_membership.principal_id = v_principal_id
      and guardian_membership.role = 'GUARDIAN'
      and guardian_membership.status = 'ACTIVE'
  ) and not exists (
    select 1
    from public.family_memberships parent_membership
    where parent_membership.principal_id = v_principal_id
      and parent_membership.role in ('OWNER_PARENT', 'PARENT')
      and parent_membership.status = 'ACTIVE'
  ) then
    raise exception 'READ_ONLY_GUARDIAN' using errcode = '42501';
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

revoke all on function public.bootstrap_parent_family(text, text, text)
  from public, anon, authenticated;
grant execute on function public.bootstrap_parent_family(text, text, text)
  to authenticated;

create or replace function public.create_guardian_invitation(
  p_family_id uuid,
  p_guardian_email text,
  p_expires_in interval default interval '7 days'
)
returns table(invitation_id uuid, email_masked text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.current_principal_id();
  v_fingerprint bytea;
  v_masked text;
  v_expires_at timestamptz;
  v_invitation_id uuid;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  if v_actor is null or not public.is_active_parent(p_family_id) then
    raise exception 'PARENT_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.families f
    where f.id = p_family_id
      and f.status = 'ACTIVE'
  ) then
    raise exception 'FAMILY_NOT_ACTIVE' using errcode = '42501';
  end if;
  if p_expires_in < interval '1 hour' or p_expires_in > interval '30 days' then
    raise exception 'INVALID_EXPIRY' using errcode = '22023';
  end if;

  -- mask_email validates syntax; fingerprint is a keyed HMAC, never a plain email.
  v_masked := private.mask_email(p_guardian_email);
  v_fingerprint := private.email_fingerprint(p_guardian_email);
  v_expires_at := now() + p_expires_in;

  update public.guardian_invitations gi
  set status = 'EXPIRED'
  where gi.family_id = p_family_id
    and gi.email_fingerprint = v_fingerprint
    and gi.status = 'ACTIVE'
    and gi.expires_at <= now();

  if exists (
    select 1
    from public.family_memberships fm
    join public.principals p on p.id = fm.principal_id
    where fm.family_id = p_family_id
      and fm.status = 'ACTIVE'
      and p.auth_email_fingerprint = v_fingerprint
  ) then
    -- This includes OWNER_PARENT/PARENT and prevents an adult or child role change via invite.
    raise exception 'ACTIVE_FAMILY_MEMBERSHIP_EXISTS' using errcode = '23505';
  end if;

  if exists (
    select 1
    from public.guardian_invitations gi
    where gi.family_id = p_family_id
      and gi.email_fingerprint = v_fingerprint
      and gi.status = 'ACTIVE'
      and gi.expires_at > now()
  ) then
    raise exception 'ACTIVE_INVITATION_EXISTS' using errcode = '23505';
  end if;

  insert into public.guardian_invitations(
    family_id,
    invited_by_principal_id,
    email_fingerprint,
    email_masked,
    status,
    expires_at
  ) values (
    p_family_id,
    v_actor,
    v_fingerprint,
    v_masked,
    'ACTIVE',
    v_expires_at
  ) returning id into v_invitation_id;

  return query select v_invitation_id, v_masked, v_expires_at;
exception
  when unique_violation then
    -- A concurrent create cannot bypass the partial unique index.
    raise exception 'ACTIVE_INVITATION_EXISTS' using errcode = '23505';
end;
$$;

create or replace function public.list_my_active_guardian_invitations()
returns table(
  invitation_id uuid,
  family_id uuid,
  family_name text,
  email_masked text,
  expires_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;

  return query
  select
    gi.id,
    gi.family_id,
    f.name,
    gi.email_masked,
    gi.expires_at
  from public.principals p
  join auth.users u
    on u.id = p.auth_user_id
   and u.email_confirmed_at is not null
  join public.guardian_invitations gi
    on gi.email_fingerprint = p.auth_email_fingerprint
  join public.families f
    on f.id = gi.family_id
   and f.status = 'ACTIVE'
  join public.principals inviter
    on inviter.id = gi.invited_by_principal_id
   and inviter.status = 'ACTIVE'
  join public.family_memberships inviter_membership
    on inviter_membership.family_id = gi.family_id
   and inviter_membership.principal_id = gi.invited_by_principal_id
   and inviter_membership.role in ('OWNER_PARENT', 'PARENT')
   and inviter_membership.status = 'ACTIVE'
  where p.auth_user_id = auth.uid()
    and p.status = 'ACTIVE'
    and p.auth_email_fingerprint is not null
    and gi.status = 'ACTIVE'
    and gi.expires_at > now()
  order by gi.created_at asc;
end;
$$;

create or replace function public.complete_guardian_invitation(
  p_invitation_id uuid
)
returns table(family_id uuid, principal_id uuid, membership_id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_principal public.principals%rowtype;
  v_invitation public.guardian_invitations%rowtype;
  v_existing_membership public.family_memberships%rowtype;
  v_membership_id uuid;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;

  select p.* into v_principal
  from public.principals p
  join auth.users u
    on u.id = p.auth_user_id
   and u.email_confirmed_at is not null
  where p.auth_user_id = auth.uid()
    and p.status = 'ACTIVE'
  for update of p;

  if v_principal.id is null or v_principal.auth_email_fingerprint is null then
    raise exception 'VERIFIED_EMAIL_REQUIRED' using errcode = '28000';
  end if;

  select gi.* into v_invitation
  from public.guardian_invitations gi
  where gi.id = p_invitation_id
  for update;

  -- Deliberately one response for nonexistent, expired, used, canceled, and wrong-email IDs.
  if v_invitation.id is null
     or v_invitation.status is distinct from 'ACTIVE'
     or v_invitation.expires_at <= now()
     or v_invitation.email_fingerprint is distinct from v_principal.auth_email_fingerprint
     or not exists (
       select 1
       from public.families f
       join public.principals inviter
         on inviter.id = v_invitation.invited_by_principal_id
        and inviter.status = 'ACTIVE'
       join public.family_memberships inviter_membership
         on inviter_membership.family_id = f.id
        and inviter_membership.principal_id = v_invitation.invited_by_principal_id
        and inviter_membership.role in ('OWNER_PARENT', 'PARENT')
        and inviter_membership.status = 'ACTIVE'
       where f.id = v_invitation.family_id
         and f.status = 'ACTIVE'
     ) then
    raise exception 'INVITATION_NOT_AVAILABLE' using errcode = 'P0001';
  end if;

  select fm.* into v_existing_membership
  from public.family_memberships fm
  where fm.family_id = v_invitation.family_id
    and fm.principal_id = v_principal.id
    and fm.status = 'ACTIVE'
  for update;

  if v_existing_membership.id is not null then
    -- Never use an invitation to replace a CHILD, PARENT, or OWNER_PARENT role.
    raise exception 'INVITATION_NOT_AVAILABLE' using errcode = 'P0001';
  end if;

  insert into public.family_memberships(
    family_id,
    principal_id,
    role,
    status,
    created_by_principal_id
  ) values (
    v_invitation.family_id,
    v_principal.id,
    'GUARDIAN',
    'ACTIVE',
    v_invitation.invited_by_principal_id
  ) returning id into v_membership_id;

  update public.guardian_invitations
  set status = 'ACCEPTED',
      accepted_at = now(),
      accepted_principal_id = v_principal.id
  where id = v_invitation.id;

  return query select
    v_invitation.family_id,
    v_principal.id,
    v_membership_id,
    'ACTIVE'::text;
exception
  when unique_violation then
    -- The active-membership partial index also protects the acceptance race.
    raise exception 'INVITATION_NOT_AVAILABLE' using errcode = 'P0001';
end;
$$;

create or replace function public.guardian_family_status(
  p_family_id uuid
)
returns table(
  family_name text,
  child_display_name text,
  child_avatar_url text,
  child_status text,
  current_score bigint,
  score_availability text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_principal_id uuid;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;

  select p.id into v_principal_id
  from public.principals p
  join auth.users u
    on u.id = p.auth_user_id
   and u.email_confirmed_at is not null
  where p.auth_user_id = auth.uid()
    and p.status = 'ACTIVE';

  if v_principal_id is null or not exists (
    select 1
    from public.family_memberships fm
    where fm.family_id = p_family_id
      and fm.principal_id = v_principal_id
      and fm.role = 'GUARDIAN'
      and fm.status = 'ACTIVE'
  ) then
    raise exception 'GUARDIAN_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  -- Explicit projection only: active child name/avatar/status. Ledger does not exist yet.
  return query
  select
    f.name,
    cp.display_name,
    cp.avatar_url,
    cp.status::text,
    null::bigint,
    'UNAVAILABLE_LEDGER_ABSENT'::text
  from public.families f
  left join public.child_profiles cp
    on cp.family_id = f.id
   and cp.status = 'ACTIVE'
  where f.id = p_family_id
    and f.status = 'ACTIVE'
  order by cp.created_at asc nulls last;
end;
$$;

-- Deliberately backend-only for now: a destructive UI must add explicit confirmation first.
create or replace function public.revoke_guardian_membership(
  p_guardian_membership_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.current_principal_id();
  v_membership public.family_memberships%rowtype;
begin
  if auth.uid() is null or v_actor is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;

  select fm.* into v_membership
  from public.family_memberships fm
  where fm.id = p_guardian_membership_id
  for update;

  if v_membership.id is null
     or v_membership.role <> 'GUARDIAN'
     or v_membership.status <> 'ACTIVE'
     or not exists (
       select 1
       from public.family_memberships owner_membership
       where owner_membership.family_id = v_membership.family_id
         and owner_membership.principal_id = v_actor
         and owner_membership.role = 'OWNER_PARENT'
         and owner_membership.status = 'ACTIVE'
     ) then
    raise exception 'OWNER_PARENT_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  update public.family_memberships
  set status = 'ENDED',
      valid_to = now(),
      ended_by_principal_id = v_actor
  where id = v_membership.id;
end;
$$;

revoke all on function public.create_guardian_invitation(uuid, text, interval)
  from public, anon, authenticated;
revoke all on function public.list_my_active_guardian_invitations()
  from public, anon, authenticated;
revoke all on function public.complete_guardian_invitation(uuid)
  from public, anon, authenticated;
revoke all on function public.guardian_family_status(uuid)
  from public, anon, authenticated;
revoke all on function public.revoke_guardian_membership(uuid)
  from public, anon, authenticated;

grant execute on function public.create_guardian_invitation(uuid, text, interval)
  to authenticated;
grant execute on function public.list_my_active_guardian_invitations()
  to authenticated;
grant execute on function public.complete_guardian_invitation(uuid)
  to authenticated;
grant execute on function public.guardian_family_status(uuid)
  to authenticated;
grant execute on function public.revoke_guardian_membership(uuid)
  to authenticated;

commit;
