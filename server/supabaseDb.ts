import { Pool } from "pg";
import { getSupabaseConnectionString } from "./supabaseConnection";

export type ChildInvitationLookup = {
  id: string;
  familyId: string;
  childProfileId: string;
};

let pool: Pool | null = null;

function getPool() {
  if (!pool) {
    const connectionString = getSupabaseConnectionString();
    pool = new Pool({
      connectionString,
      max: 4,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export async function findActiveChildInvitation(
  email: string,
): Promise<ChildInvitationLookup | null> {
  const result = await getPool().query<{
    id: string;
    family_id: string;
    child_profile_id: string;
  }>(
    `select ci.id, ci.family_id, ci.child_profile_id
       from public.child_invitations ci
      where ci.email_fingerprint = private.email_fingerprint($1)
        and ci.status = 'ACTIVE'
        and ci.expires_at > now()
      order by ci.created_at asc
      limit 1`,
    [normalizeEmail(email)],
  );

  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        familyId: row.family_id,
        childProfileId: row.child_profile_id,
      }
    : null;
}

export async function getOtpRequestAllowance(invitationId: string) {
  const result = await getPool().query<{
    recent_count: string;
    daily_count: string;
  }>(
    `select
       count(*) filter (
         where created_at >= now() - interval '60 seconds'
           and event_type = 'OTP_REQUESTED'
       )::text as recent_count,
       count(*) filter (
         where created_at >= now() - interval '24 hours'
           and event_type = 'OTP_REQUESTED'
       )::text as daily_count
     from public.invitation_delivery_events
     where invitation_id = $1`,
    [invitationId],
  );

  const row = result.rows[0];
  const recentCount = Number(row?.recent_count ?? 0);
  const dailyCount = Number(row?.daily_count ?? 0);
  return {
    allowed: recentCount === 0 && dailyCount < 5,
    recentCount,
    dailyCount,
  };
}

export async function findActiveParentOwnedInvitation(input: {
  authUserId: string;
  familyId: string;
  invitationId: string;
  email: string;
}): Promise<ChildInvitationLookup | null> {
  const result = await getPool().query<{
    id: string; family_id: string; child_profile_id: string;
  }>(
    `select ci.id, ci.family_id, ci.child_profile_id
       from public.child_invitations ci
       join public.principals p on p.auth_user_id = $1
       join public.family_memberships fm
         on fm.principal_id = p.id and fm.family_id = ci.family_id
      where ci.id = $2 and ci.family_id = $3
        and ci.email_fingerprint = private.email_fingerprint($4)
        and ci.status = 'ACTIVE' and ci.expires_at > now()
        and p.status = 'ACTIVE'
        and fm.status = 'ACTIVE' and fm.role in ('OWNER_PARENT', 'PARENT')
      limit 1`,
    [input.authUserId, input.invitationId, input.familyId, normalizeEmail(input.email)],
  );
  const row = result.rows[0];
  return row ? { id: row.id, familyId: row.family_id, childProfileId: row.child_profile_id } : null;
}

// 부모 재전송과 자녀 요청이 동시에 들어와도 한 초대의 제한을 공유한다.
export async function reserveOtpRequest(invitationId: string, requestId: string) {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [invitationId]);
    const result = await client.query<{ recent_count: string; daily_count: string }>(
      `select
         count(*) filter (where created_at >= now() - interval '60 seconds')::text as recent_count,
         count(*) filter (where created_at >= now() - interval '24 hours')::text as daily_count
       from public.invitation_delivery_events
       where invitation_id = $1 and event_type = 'OTP_REQUESTED'`,
      [invitationId],
    );
    const recentCount = Number(result.rows[0]?.recent_count ?? 0);
    const dailyCount = Number(result.rows[0]?.daily_count ?? 0);
    const allowed = recentCount === 0 && dailyCount < 5;
    await client.query(
      `insert into public.invitation_delivery_events(invitation_id, event_type, request_id, detail)
       values ($1, $2, $3, $4::jsonb)`,
      [invitationId, allowed ? "OTP_REQUESTED" : "OTP_RATE_LIMITED", requestId,
        JSON.stringify({ recentCount, dailyCount })],
    );
    await client.query("commit");
    return { allowed, recentCount, dailyCount };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function recordInvitationDeliveryEvent(input: {
  invitationId: string;
  eventType: "OTP_REQUESTED" | "OTP_RATE_LIMITED" | "OTP_SENT" | "OTP_FAILED";
  requestId: string;
  detail?: Record<string, unknown>;
}) {
  await getPool().query(
    `insert into public.invitation_delivery_events(
       invitation_id, event_type, request_id, detail
     ) values ($1, $2, $3, $4::jsonb)
     on conflict (invitation_id, request_id) do nothing`,
    [
      input.invitationId,
      input.eventType,
      input.requestId,
      JSON.stringify(input.detail ?? {}),
    ],
  );
}
