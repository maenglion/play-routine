import { Client } from "pg";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { getSupabaseConnectionString } from "../server/supabaseConnection";

async function main() {
  const connectionString = getSupabaseConnectionString();
  const expected = "dsnvohyinazotouqbzrv";
  const url = new URL(connectionString);
  if (
    new URL(process.env.SUPABASE_URL!).hostname !== `${expected}.supabase.co` ||
    (!decodeURIComponent(url.username).endsWith(`.${expected}`) &&
      url.hostname !== `db.${expected}.supabase.co`)
  )
    throw new Error("TARGET_MISMATCH");
  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });
  await client.connect();
  try {
    await client.query("begin read only");
    const triggers = (
      await client.query(
        "select count(*)::int as n,bool_and(tgenabled='O') as enabled from pg_trigger where tgname='play_audit_row_change' and not tgisinternal"
      )
    ).rows[0];
    const events = (
      await client.query("select count(*)::int as n from play_audit.events")
    ).rows[0].n;
    const migration = (
      await client.query(
        "select sha256 from private.schema_migrations where name='0020_audit_log.sql'"
      )
    ).rows[0];
    const sha = createHash("sha256")
      .update(readFileSync("supabase/migrations/0020_audit_log.sql"))
      .digest("hex");
    const invalid = (
      await client.query(`select count(*)::int as n from play_audit.events e
      where (old_values is not null and old_fingerprint is distinct from encode(sha256(convert_to(old_values::text,'UTF8')),'hex'))
      or (new_values is not null and new_fingerprint is distinct from encode(sha256(convert_to(new_values::text,'UTF8')),'hex'))`)
    ).rows[0].n;
    await client.query("commit");
    const result = {
      installed: true,
      triggerCount: triggers.n,
      allEnabled: triggers.enabled,
      installedSqlMatches: sha === migration?.sha256,
      auditRows: events,
      inconsistentSnapshotFingerprints: invalid,
    };
    if (
      result.triggerCount !== 16 ||
      !result.allEnabled ||
      !result.installedSqlMatches ||
      invalid !== 0
    )
      throw new Error("AUDIT_OBJECTS_MISMATCH");
    if (process.argv[2])
      writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result));
  } finally {
    await client.end();
  }
}
main().catch(error => {
  console.error(
    "감사 설치 상태 확인 실패:",
    (error as { code?: string }).code || "LOCAL_VALIDATION_ERROR"
  );
  process.exitCode = 1;
});
