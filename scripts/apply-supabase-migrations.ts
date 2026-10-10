import { Client } from "pg";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { getSupabaseConnectionString } from "../server/supabaseConnection";

const expectedProject = process.argv[2];
if (!expectedProject || !/^[a-z]{20}$/.test(expectedProject)) {
  throw new Error("Usage: pnpm exec tsx scripts/apply-supabase-migrations.ts <expected-project-ref>");
}
const connectionString = getSupabaseConnectionString();
const url = new URL(connectionString);
if (new URL(process.env.SUPABASE_URL!).hostname !== `${expectedProject}.supabase.co` ||
    (!decodeURIComponent(url.username).endsWith(`.${expectedProject}`) &&
     url.hostname !== `db.${expectedProject}.supabase.co`)) {
  throw new Error("Project mismatch: migration aborted");
}
const client = new Client({ connectionString, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
try {
  await client.connect();
  await client.query("select pg_advisory_lock(hashtext('play-routine-migrations'))");
  await client.query("create schema if not exists private; revoke all on schema private from public, anon, authenticated");
  await client.query(`create table if not exists private.schema_migrations (
    name text primary key, sha256 text not null, applied_at timestamptz not null default now()
  )`);
  const files = (await readdir("supabase/migrations")).filter(f => /^\d+.*\.sql$/.test(f)).sort();
  for (const file of files) {
    const sql = await readFile(`supabase/migrations/${file}`, "utf8");
    const hash = createHash("sha256").update(sql).digest("hex");
    const previous = await client.query("select sha256 from private.schema_migrations where name=$1", [file]);
    if (previous.rowCount) {
      if (previous.rows[0].sha256 !== hash) throw new Error(`Previously applied migration changed: ${file}`);
      console.log(`SKIP ${file}`);
      continue;
    }
    const body = sql.replace(/^\s*begin\s*;/i, "").replace(/commit\s*;\s*$/i, "");
    await client.query("begin");
    try {
      await client.query(body);
      await client.query("insert into private.schema_migrations(name,sha256) values($1,$2)", [file, hash]);
      await client.query("commit");
      console.log(`APPLIED ${file}`);
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
  const tables = await client.query("select tablename, rowsecurity from pg_tables where schemaname='public' order by tablename");
  console.log(JSON.stringify({project: expectedProject, tables: tables.rows}));
} catch (error) {
  const e = error as {code?: string};
  console.error("Migration failed; code:", e.code || "LOCAL_VALIDATION_ERROR");
  process.exitCode = 1;
} finally {
  await client.end();
}
