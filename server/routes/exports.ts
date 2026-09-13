import { createClient } from "@supabase/supabase-js";
import type { Express, Request } from "express";
import { Pool } from "pg";

type Dataset = "children" | "invitations" | "auth-links";

let pool: Pool | null = null;

function getPool() {
  if (!pool) {
    const connectionString = process.env.SUPABASE_DATABASE_URL;
    if (!connectionString) throw new Error("SUPABASE_DATABASE_URL is missing");
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

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Supabase server configuration is missing");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function bearerToken(req: Request) {
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return null;
  return authorization.slice("Bearer ".length).trim();
}

export function csvCell(value: unknown) {
  let text = value == null ? "" : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function toCsv(rows: Record<string, unknown>[]) {
  if (rows.length === 0) return "status\r\nno_data\r\n";
  const headers = Object.keys(rows[0]);
  return [
    headers.map(csvCell).join(","),
    ...rows.map(row => headers.map(header => csvCell(row[header])).join(",")),
  ].join("\r\n");
}

async function parentFamilyForAuthUser(authUserId: string, requestedFamilyId?: string) {
  const result = await getPool().query<{ family_id: string }>(
    `select fm.family_id
       from public.principals p
       join public.family_memberships fm on fm.principal_id = p.id
      where p.auth_user_id = $1
        and p.status = 'ACTIVE'
        and fm.status = 'ACTIVE'
        and fm.role in ('OWNER_PARENT', 'PARENT')
        and ($2::uuid is null or fm.family_id = $2::uuid)
      order by case when fm.role = 'OWNER_PARENT' then 0 else 1 end
      limit 1`,
    [authUserId, requestedFamilyId ?? null],
  );
  return result.rows[0]?.family_id ?? null;
}

async function exportRows(dataset: Dataset, familyId: string) {
  if (dataset === "children") {
    return (
      await getPool().query(
        `select
           cp.id as child_profile_id,
           cp.display_name,
           cp.status,
           (cp.principal_id is not null) as account_linked,
           cp.linked_at,
           cp.unlinked_at,
           cp.created_at,
           cp.updated_at
         from public.child_profiles cp
         where cp.family_id = $1
         order by cp.created_at asc`,
        [familyId],
      )
    ).rows;
  }

  if (dataset === "invitations") {
    return (
      await getPool().query(
        `select
           ci.id as invitation_id,
           ci.child_profile_id,
           cp.display_name as child_display_name,
           ci.email_masked,
           ci.status,
           ci.expires_at,
           ci.accepted_at,
           ci.declined_at,
           ci.canceled_at,
           ci.created_at
         from public.child_invitations ci
         join public.child_profiles cp on cp.id = ci.child_profile_id
         where ci.family_id = $1
         order by ci.created_at asc`,
        [familyId],
      )
    ).rows;
  }

  return (
    await getPool().query(
      `select
         ale.id as auth_link_event_id,
         ale.child_profile_id,
         cp.display_name as child_display_name,
         ale.event_type,
         ale.reason,
         ale.created_at
       from public.auth_link_events ale
       join public.child_profiles cp on cp.id = ale.child_profile_id
       where ale.family_id = $1
       order by ale.created_at asc`,
      [familyId],
    )
  ).rows;
}

export function registerExportRoutes(app: Express) {
  app.get("/api/exports/family.csv", async (req, res) => {
    try {
      const token = bearerToken(req);
      if (!token) return res.status(401).json({ error: "AUTH_REQUIRED" });

      const { data, error } = await getSupabase().auth.getUser(token);
      if (error || !data.user) {
        return res.status(401).json({ error: "INVALID_SESSION" });
      }

      const dataset = String(req.query.dataset ?? "children") as Dataset;
      if (!["children", "invitations", "auth-links"].includes(dataset)) {
        return res.status(400).json({ error: "INVALID_DATASET" });
      }

      const familyId = await parentFamilyForAuthUser(
        data.user.id,
        typeof req.query.familyId === "string" ? req.query.familyId : undefined,
      );
      if (!familyId) return res.status(403).json({ error: "PARENT_ACCESS_REQUIRED" });

      const rows = await exportRows(dataset, familyId);
      const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="play-routine-${dataset}-${date}.csv"`,
      );
      return res.send(`\uFEFF${toCsv(rows)}`);
    } catch (error) {
      console.error("[CSV Export]", error);
      return res.status(500).json({ error: "EXPORT_FAILED" });
    }
  });
}
