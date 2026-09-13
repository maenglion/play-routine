begin;

create or replace function public.list_my_active_child_invitations()
returns table(
  invitation_id uuid,
  family_id uuid,
  family_name text,
  child_profile_id uuid,
  child_display_name text,
  email_masked text,
  expires_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    ci.id,
    ci.family_id,
    f.name,
    ci.child_profile_id,
    cp.display_name,
    ci.email_masked,
    ci.expires_at
  from public.principals p
  join public.child_invitations ci
    on ci.email_fingerprint = p.auth_email_fingerprint
  join public.families f on f.id = ci.family_id
  join public.child_profiles cp on cp.id = ci.child_profile_id
  where p.auth_user_id = auth.uid()
    and p.status = 'ACTIVE'
    and p.auth_email_fingerprint is not null
    and ci.status = 'ACTIVE'
    and ci.expires_at > now()
    and cp.status in ('PENDING_LINK', 'UNLINKED')
  order by ci.created_at asc
$$;

revoke all on function public.list_my_active_child_invitations()
  from public, anon, authenticated;
grant execute on function public.list_my_active_child_invitations()
  to authenticated;

commit;
