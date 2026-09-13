import { Pool } from "pg";

export type ChildInvitationLookup = {
  id: string;
  familyId: string;
  childProfileId: string;
};

let pool: Pool | null = null;

function getPool() {
  if (!pool) {
    const connectionString = process.env.SUPABASE_DATABASE_URL;
    if (!connectionString) {
      throw new Error("SUPABASE_DATABASE_URL is not configured");
    }
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
