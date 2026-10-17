import { Client } from "pg";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { getSupabaseConnectionString } from "../server/supabaseConnection";

const action = process.argv[2];
const destination = process.argv[3];
if (!destination || !["capture", "verify"].includes(action)) throw new Error("사용법: capture|verify <snapshot-path>");
if (new URL(process.env.SUPABASE_URL!).hostname !== "dsnvohyinazotouqbzrv.supabase.co") throw new Error("프로젝트 불일치");
const client = new Client({ connectionString: getSupabaseConnectionString(), ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
type Snapshot = { table: string; count: number; hash: string }[];
try {
  await client.connect();
  const previous: Snapshot | null = action === "verify" ? JSON.parse(await readFile(destination, "utf8")) : null;
  const tables = previous ? previous.map(row => row.table) : (await client.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows.map(row => row.tablename as string);
  const snapshot: Snapshot = [];
  for (const table of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error("테이블 이름 검증 실패");
    const { rows } = await client.query(`select count(*)::integer as count, coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) as records from public."${table}" t`);
    snapshot.push({ table, count: rows[0].count, hash: createHash("sha256").update(JSON.stringify(rows[0].records)).digest("hex") });
  }
  if (previous) {
    const changed = snapshot.filter((row, index) => row.count !== previous[index].count || row.hash !== previous[index].hash).map(row => row.table);
    if (changed.length) { console.error("기존 데이터 변경 감지(원문은 출력하지 않음):", changed.join(", ")); process.exitCode = 1; }
    else console.log(`기존 ${snapshot.length}개 테이블의 행 수·내용 동일: 검증 통과`);
  } else {
    await writeFile(destination, JSON.stringify(snapshot, null, 2) + "\n", { mode: 0o600 });
    console.log(`기존 ${snapshot.length}개 테이블의 원문 없는 해시 스냅샷 저장`);
  }
} catch (e) {
  console.error("보존 검증 실패; 코드:", (e as { code?: string }).code ?? "VALIDATION_ERROR"); process.exitCode = 1;
} finally { await client.end(); }
