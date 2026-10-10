begin;

-- Supabase의 기본 table grant가 RLS·column grant를 무력화하지 않도록 초기화한다.
-- 특히 TRUNCATE는 RLS의 보호를 받지 않으므로 클라이언트에 허용하지 않는다.
revoke all on table
  public.principals,
  public.families,
  public.family_memberships,
  public.child_profiles,
  public.child_invitations,
  public.invitation_delivery_events,
  public.auth_link_events,
  public.notifications
from anon, authenticated;

grant select on public.principals to authenticated;
grant update (display_name) on public.principals to authenticated;
grant select on public.families to authenticated;
grant update (name, timezone) on public.families to authenticated;
grant select on public.family_memberships to authenticated;
grant select on public.child_profiles to authenticated;
grant update (display_name) on public.child_profiles to authenticated;
grant select (
  id, family_id, child_profile_id, invited_by_principal_id,
  email_masked, status, expires_at, accepted_at, accepted_principal_id,
  declined_at, canceled_at, superseded_by_invitation_id, created_at, updated_at
) on public.child_invitations to authenticated;
grant select on public.invitation_delivery_events to authenticated;
grant select on public.auth_link_events to authenticated;
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;

-- 기본 public 권한 변경은 다른 서비스에 영향을 줄 수 있어 이 앱의 8개 테이블만 대상으로 한다.
commit;
