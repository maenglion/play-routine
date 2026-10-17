import { Client } from "pg";
import { getSupabaseConnectionString } from "../server/supabaseConnection";
const mode = process.argv[2] ?? "dry-run";
if (!["dry-run", "apply"].includes(mode))
  throw new Error("사용법: dry-run|apply");
const project = "dsnvohyinazotouqbzrv",
  connection = getSupabaseConnectionString(),
  url = new URL(connection);
if (
  new URL(process.env.SUPABASE_URL!).hostname !== `${project}.supabase.co` ||
  (!decodeURIComponent(url.username).endsWith(`.${project}`) &&
    url.hostname !== `db.${project}.supabase.co`)
)
  throw new Error("대상 프로젝트 불일치");
const c = new Client({
  connectionString: connection,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
});
try {
  await c.connect();
  await c.query("begin");
  const t =
    await c.query(`select plan.id plan_id,p.id parent_id from public.october_plans plan
  join public.family_memberships fm on fm.family_id=plan.family_id and fm.role='OWNER_PARENT' and fm.status='ACTIVE'
  join public.principals p on p.id=fm.principal_id and p.status='ACTIVE'
  where plan.status='ACTIVE' and plan.month='2026-10-01'`);
  if (t.rowCount !== 1)
    throw new Error("활성 10월 계획·승인 대상 부모가 하나가 아니므로 중단");
  const result = (
    await c.query(
      "select private.apply_october_school_coupay_confirmation($1,$2) result",
      [t.rows[0].plan_id, t.rows[0].parent_id]
    )
  ).rows[0].result;
  await c.query(mode === "apply" ? "commit" : "rollback");
  console.log(
    JSON.stringify(
      {
        mode,
        ...result,
        committed: mode === "apply",
        recordsReset: false,
        fulfillmentsCreated: 0,
      },
      null,
      2
    )
  );
} catch (e) {
  await c.query("rollback").catch(() => {});
  console.error(
    "학교 자산 확정 실패:",
    (e as { code?: string }).code ?? (e as Error).message
  );
  process.exitCode = 1;
} finally {
  await c.end();
}
