begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;

revoke all on schema private from public, anon, authenticated;

create table if not exists private.app_secrets (
  key text primary key,
  secret bytea not null,
  created_at timestamptz not null default now()
);

insert into private.app_secrets(key, secret)
values ('email_fingerprint_hmac', extensions.gen_random_bytes(32))
on conflict (key) do nothing;

create or replace function private.email_fingerprint(p_email text)
returns bytea
language sql
stable
security definer
set search_path = ''
as $$
  select extensions.hmac(
    convert_to(lower(btrim(p_email)), 'utf8'),
    s.secret,
    'sha256'
  )
  from private.app_secrets s
  where s.key = 'email_fingerprint_hmac'
$$;

revoke all on function private.email_fingerprint(text) from public, anon, authenticated;

do $$ begin
  create type public.principal_status as enum ('ACTIVE', 'SUSPENDED', 'UNLINKED');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.family_status as enum ('ACTIVE', 'ARCHIVED');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.family_role as enum ('OWNER_PARENT', 'PARENT', 'GUARDIAN', 'CHILD');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.membership_status as enum ('ACTIVE', 'SUSPENDED', 'ENDED');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.child_profile_status as enum ('PENDING_LINK', 'ACTIVE', 'SUSPENDED', 'UNLINKED', 'ARCHIVED');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.child_invitation_status as enum ('ACTIVE', 'ACCEPTED', 'DECLINED', 'CANCELED', 'EXPIRED', 'SUPERSEDED');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.invitation_delivery_event_type as enum ('OTP_REQUESTED', 'OTP_RATE_LIMITED', 'OTP_SENT', 'OTP_FAILED');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.auth_link_event_type as enum ('LINKED', 'UNLINKED', 'RELINKED', 'AUTH_ACCOUNT_DETACHED', 'EMAIL_CHANGED');
exception when duplicate_object then null;
end $$;

create table if not exists public.principals (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete set null,
  auth_email_fingerprint bytea unique,
  display_name text,
  status public.principal_status not null default 'ACTIVE',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (display_name is null or char_length(btrim(display_name)) between 1 and 100),
  check (auth_email_fingerprint is null or octet_length(auth_email_fingerprint) = 32)
);

create table if not exists public.families (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default 'Asia/Seoul',
  status public.family_status not null default 'ACTIVE',
  created_by_principal_id uuid not null references public.principals(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  check (char_length(btrim(name)) between 1 and 100),
  check ((status = 'ARCHIVED') = (archived_at is not null))
);

create table if not exists public.family_memberships (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  principal_id uuid not null references public.principals(id) on delete restrict,
  role public.family_role not null,
  status public.membership_status not null default 'ACTIVE',
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  created_by_principal_id uuid references public.principals(id),
  ended_by_principal_id uuid references public.principals(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'ENDED') = (valid_to is not null)),
  check (valid_to is null or valid_to >= valid_from)
);

create unique index if not exists family_memberships_one_active_per_family
  on public.family_memberships(family_id, principal_id)
  where status = 'ACTIVE';

create unique index if not exists families_one_active_owner
  on public.family_memberships(family_id)
  where status = 'ACTIVE' and role = 'OWNER_PARENT';

create table if not exists public.child_profiles (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  principal_id uuid references public.principals(id) on delete restrict,
  display_name text not null,
  status public.child_profile_status not null default 'PENDING_LINK',
  created_by_principal_id uuid not null references public.principals(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  linked_at timestamptz,
  unlinked_at timestamptz,
  unique (id, family_id),
  check (char_length(btrim(display_name)) between 1 and 100),
  check (
    (status = 'PENDING_LINK' and principal_id is null and linked_at is null)
    or (status in ('ACTIVE', 'SUSPENDED') and principal_id is not null and linked_at is not null)
    or (status in ('UNLINKED', 'ARCHIVED'))
  )
);

create unique index if not exists child_profiles_one_active_principal_per_family
  on public.child_profiles(family_id, principal_id)
  where principal_id is not null and status in ('ACTIVE', 'SUSPENDED');

create table if not exists public.child_invitations (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  child_profile_id uuid not null,
  invited_by_principal_id uuid not null references public.principals(id) on delete restrict,
  email_fingerprint bytea not null,
  email_masked text not null,
  status public.child_invitation_status not null default 'ACTIVE',
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_principal_id uuid references public.principals(id) on delete restrict,
  declined_at timestamptz,
  canceled_at timestamptz,
  superseded_by_invitation_id uuid references public.child_invitations(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (child_profile_id, family_id)
    references public.child_profiles(id, family_id) on delete restrict,
  check (octet_length(email_fingerprint) = 32),
  check (expires_at > created_at),
  check (
    (status = 'ACTIVE' and accepted_at is null and accepted_principal_id is null and declined_at is null and canceled_at is null)
    or (status = 'ACCEPTED' and accepted_at is not null and accepted_principal_id is not null)
    or (status = 'DECLINED' and declined_at is not null)
    or (status = 'CANCELED' and canceled_at is not null)
    or (status in ('EXPIRED', 'SUPERSEDED'))
  )
);

create unique index if not exists child_invitations_one_active_per_profile
  on public.child_invitations(child_profile_id)
  where status = 'ACTIVE';

create unique index if not exists child_invitations_one_active_email_per_family
  on public.child_invitations(family_id, email_fingerprint)
  where status = 'ACTIVE';

create table if not exists public.invitation_delivery_events (
  id uuid primary key default gen_random_uuid(),
  invitation_id uuid not null references public.child_invitations(id) on delete restrict,
  event_type public.invitation_delivery_event_type not null,
  request_id uuid not null,
  ip_hash bytea,
  device_hash bytea,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (invitation_id, request_id)
);

create table if not exists public.auth_link_events (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  child_profile_id uuid not null,
  principal_id uuid not null references public.principals(id) on delete restrict,
  invitation_id uuid references public.child_invitations(id) on delete restrict,
  event_type public.auth_link_event_type not null,
  actor_principal_id uuid references public.principals(id) on delete restrict,
  reason text,
  created_at timestamptz not null default now(),
  foreign key (child_profile_id, family_id)
    references public.child_profiles(id, family_id) on delete restrict
);

create index if not exists family_memberships_principal_active_idx
  on public.family_memberships(principal_id, family_id)
  where status = 'ACTIVE';

create index if not exists child_profiles_family_status_idx
  on public.child_profiles(family_id, status);

create index if not exists child_invitations_fingerprint_status_idx
  on public.child_invitations(email_fingerprint, status, expires_at);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists principals_set_updated_at on public.principals;
create trigger principals_set_updated_at before update on public.principals
for each row execute function public.set_updated_at();

drop trigger if exists families_set_updated_at on public.families;
create trigger families_set_updated_at before update on public.families
for each row execute function public.set_updated_at();

drop trigger if exists family_memberships_set_updated_at on public.family_memberships;
create trigger family_memberships_set_updated_at before update on public.family_memberships
for each row execute function public.set_updated_at();

drop trigger if exists child_profiles_set_updated_at on public.child_profiles;
create trigger child_profiles_set_updated_at before update on public.child_profiles
for each row execute function public.set_updated_at();

drop trigger if exists child_invitations_set_updated_at on public.child_invitations;
create trigger child_invitations_set_updated_at before update on public.child_invitations
for each row execute function public.set_updated_at();

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.principals (
    auth_user_id,
    auth_email_fingerprint,
    display_name
  )
  values (
    new.id,
    case
      when new.email is null then null
      else private.email_fingerprint(new.email)
    end,
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), '')
  )
  on conflict (auth_user_id) do update
  set auth_email_fingerprint = excluded.auth_email_fingerprint,
      updated_at = now();
  return new;
exception when others then
  raise warning 'principal bootstrap failed for auth user %: %', new.id, sqlerrm;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert or update of email on auth.users
  for each row execute function public.handle_new_auth_user();

create or replace function public.current_principal_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
  from public.principals p
  where p.auth_user_id = auth.uid()
    and p.status = 'ACTIVE'
  limit 1
$$;

create or replace function public.is_active_family_member(p_family_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.family_memberships fm
    where fm.family_id = p_family_id
      and fm.principal_id = public.current_principal_id()
      and fm.status = 'ACTIVE'
  )
$$;

create or replace function public.is_active_parent(p_family_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.family_memberships fm
    where fm.family_id = p_family_id
      and fm.principal_id = public.current_principal_id()
      and fm.status = 'ACTIVE'
      and fm.role in ('OWNER_PARENT', 'PARENT')
  )
$$;

create or replace function public.is_child_profile_self(p_child_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.child_profiles cp
    where cp.id = p_child_profile_id
      and cp.principal_id = public.current_principal_id()
      and cp.status = 'ACTIVE'
  )
$$;

alter table public.principals enable row level security;
alter table public.families enable row level security;
alter table public.family_memberships enable row level security;
alter table public.child_profiles enable row level security;
alter table public.child_invitations enable row level security;
alter table public.invitation_delivery_events enable row level security;
alter table public.auth_link_events enable row level security;

drop policy if exists principals_select_self on public.principals;
create policy principals_select_self on public.principals
for select to authenticated
using (auth_user_id = auth.uid());

drop policy if exists principals_update_self on public.principals;
create policy principals_update_self on public.principals
for update to authenticated
using (auth_user_id = auth.uid())
with check (auth_user_id = auth.uid());

drop policy if exists families_select_member on public.families;
create policy families_select_member on public.families
for select to authenticated
using (public.is_active_family_member(id));

drop policy if exists families_update_owner on public.families;
create policy families_update_owner on public.families
for update to authenticated
using (
  exists (
    select 1 from public.family_memberships fm
    where fm.family_id = id
      and fm.principal_id = public.current_principal_id()
      and fm.status = 'ACTIVE'
      and fm.role = 'OWNER_PARENT'
  )
)
with check (
  exists (
    select 1 from public.family_memberships fm
    where fm.family_id = id
      and fm.principal_id = public.current_principal_id()
      and fm.status = 'ACTIVE'
      and fm.role = 'OWNER_PARENT'
  )
);

drop policy if exists memberships_select_parent_or_self on public.family_memberships;
create policy memberships_select_parent_or_self on public.family_memberships
for select to authenticated
using (
  principal_id = public.current_principal_id()
  or public.is_active_parent(family_id)
);

drop policy if exists child_profiles_select_parent_or_self on public.child_profiles;
create policy child_profiles_select_parent_or_self on public.child_profiles
for select to authenticated
using (
  public.is_active_parent(family_id)
  or principal_id = public.current_principal_id()
);

drop policy if exists child_profiles_update_parent on public.child_profiles;
create policy child_profiles_update_parent on public.child_profiles
for update to authenticated
using (public.is_active_parent(family_id))
with check (public.is_active_parent(family_id));

drop policy if exists child_invitations_select_parent on public.child_invitations;
create policy child_invitations_select_parent on public.child_invitations
for select to authenticated
using (public.is_active_parent(family_id));

drop policy if exists invitation_delivery_events_select_parent on public.invitation_delivery_events;
create policy invitation_delivery_events_select_parent on public.invitation_delivery_events
for select to authenticated
using (
  exists (
    select 1
    from public.child_invitations ci
    where ci.id = invitation_id
      and public.is_active_parent(ci.family_id)
  )
);

drop policy if exists auth_link_events_select_parent_or_self on public.auth_link_events;
create policy auth_link_events_select_parent_or_self on public.auth_link_events
for select to authenticated
using (
  public.is_active_parent(family_id)
  or principal_id = public.current_principal_id()
);

revoke all on public.principals from anon;
revoke all on public.families from anon;
revoke all on public.family_memberships from anon;
revoke all on public.child_profiles from anon;
revoke all on public.child_invitations from anon;
revoke all on public.invitation_delivery_events from anon;
revoke all on public.auth_link_events from anon;

grant select on public.principals to authenticated;
grant update (display_name) on public.principals to authenticated;
grant select, update (name, timezone) on public.families to authenticated;
grant select on public.family_memberships to authenticated;
grant select, update (display_name) on public.child_profiles to authenticated;
grant select (
  id,
  family_id,
  child_profile_id,
  invited_by_principal_id,
  email_masked,
  status,
  expires_at,
  accepted_at,
  accepted_principal_id,
  declined_at,
  canceled_at,
  superseded_by_invitation_id,
  created_at,
  updated_at
) on public.child_invitations to authenticated;
grant select on public.invitation_delivery_events to authenticated;
grant select on public.auth_link_events to authenticated;

revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.handle_new_auth_user() from public, anon, authenticated;
revoke all on function public.current_principal_id() from public, anon, authenticated;
revoke all on function public.is_active_family_member(uuid) from public, anon, authenticated;
revoke all on function public.is_active_parent(uuid) from public, anon, authenticated;
revoke all on function public.is_child_profile_self(uuid) from public, anon, authenticated;

grant execute on function public.current_principal_id() to authenticated;
grant execute on function public.is_active_family_member(uuid) to authenticated;
grant execute on function public.is_active_parent(uuid) to authenticated;
grant execute on function public.is_child_profile_self(uuid) to authenticated;

commit;
