import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { getSupabaseConnectionString } from "../server/supabaseConnection";

const client = new Client({ connectionString: getSupabaseConnectionString(), ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
let passed = 0;
function assert(value: unknown, name: string) {
  if (!value) throw new Error(`FAILED: ${name}`);
  console.log(`PASS: ${name}`); passed++;
}
async function asUser(id: string) {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claim.role','authenticated',true)", [id]);
  await client.query("set local role authenticated");
}
async function rejected(sql: string, values: unknown[], code: string, label: string) {
  await client.query("savepoint expected_failure");
  let actual = "";
  try { await client.query(sql, values); } catch (e) { actual = (e as {code?: string}).code || "unknown"; }
  await client.query("rollback to savepoint expected_failure");
  assert(actual === code, label);
}
try {
  await client.connect();
  await client.query("begin");
  const parent = randomUUID(), otherParent = randomUUID(), child = randomUUID(), wrongChild = randomUUID();
  const suffix = randomUUID();
  const childEmail = `child-${suffix}@example.invalid`;
  for (const [id, email] of [[parent,`parent-${suffix}@example.invalid`],[otherParent,`other-${suffix}@example.invalid`],[child,childEmail],[wrongChild,`wrong-${suffix}@example.invalid`]]) {
    await client.query("insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values($1,'authenticated','authenticated',$2,now(),'{}','{}',now(),now())",[id,email]);
  }
  assert((await client.query("select count(*)::int as n from public.principals where auth_user_id=any($1::uuid[])",[[parent,otherParent,child,wrongChild]])).rows[0].n === 4,"Auth trigger creates principals");
  await asUser(parent);
  const f1 = (await client.query("select * from public.bootstrap_parent_family('ROLLBACK TEST FAMILY A','Asia/Seoul','Parent A')")).rows[0].family_id;
  assert(!(await client.query("select has_table_privilege('authenticated','public.families','TRUNCATE') as allowed")).rows[0].allowed,"Authenticated has no TRUNCATE grant");
  await rejected("update public.principals set status='SUSPENDED' where auth_user_id=$1",[parent],"42501","User cannot change principal security status");
  await rejected("update public.families set status='ARCHIVED',archived_at=now() where id=$1",[f1],"42501","Parent cannot bypass family lifecycle RPC");
  const inv = (await client.query("select * from public.create_child_invitation($1,'Test child',$2)",[f1,childEmail])).rows[0];
  assert(Boolean(inv.invitation_id),"Parent creates child invitation");
  await rejected("select * from public.create_child_invitation($1,'Test child',$2)",[f1,childEmail],"23505","Duplicate active invitation rejected");
  await asUser(otherParent);
  const f2 = (await client.query("select * from public.bootstrap_parent_family('ROLLBACK TEST FAMILY B')")).rows[0].family_id;
  assert((await client.query("select count(*)::int as n from public.families")).rows[0].n === 1,"Other parent sees own family only");
  await rejected("select * from public.create_child_invitation($1,'Unauthorized',$2)",[f1,childEmail],"42501","Other parent cannot invite to family A");
  await asUser(wrongChild);
  assert((await client.query("select * from public.list_my_active_child_invitations()")).rowCount === 0,"Wrong email sees no invitation");
  await rejected("select * from public.complete_child_invitation($1)",[inv.invitation_id],"28000","Wrong email cannot accept invitation");
  await asUser(child);
  assert((await client.query("select * from public.list_my_active_child_invitations()")).rowCount === 1,"Correct email sees invitation");
  const linked = (await client.query("select * from public.complete_child_invitation($1)",[inv.invitation_id])).rows[0];
  assert(linked.status === 'ACTIVE',"Child acceptance activates connection immediately");
  const again = (await client.query("select * from public.complete_child_invitation($1)",[inv.invitation_id])).rows[0];
  assert(again.membership_id === linked.membership_id,"Repeated acceptance is idempotent");
  assert((await client.query("select count(*)::int as n from public.families where id=$1",[f2])).rows[0].n === 0,"Child cannot read other family");
  await asUser(parent);
  assert((await client.query("select status from public.child_profiles where id=$1",[inv.child_profile_id])).rows[0]?.status === 'ACTIVE',"Parent sees active child profile");
  assert((await client.query("select count(*)::int as n from public.notifications where notification_type='CHILD_LINKED'")).rows[0].n === 1,"Parent receives link notification");
  await rejected("update public.child_profiles set status='SUSPENDED' where id=$1",[inv.child_profile_id],"42501","Parent cannot directly alter child security state");
  await rejected("select email_fingerprint from public.child_invitations",[],"42501","Parent cannot read private invitation fingerprint");
  await client.query("update public.child_profiles set display_name='Allowed display edit' where id=$1",[inv.child_profile_id]);
  assert((await client.query("select display_name from public.child_profiles where id=$1",[inv.child_profile_id])).rows[0].display_name === 'Allowed display edit',"Parent can edit allowed display field");
  await client.query("reset role");
  assert((await client.query("select count(*)::int as n from public.auth_link_events where invitation_id=$1",[inv.invitation_id])).rows[0].n === 1,"Acceptance creates one audit event");
  await client.query("set local role anon");
  await rejected("select id from public.families",[],"42501","Anonymous role cannot read families");
  console.log(`RESULT: ${passed} checks passed; all test data rolled back`);
} catch (e) {
  console.error("DB validation failed", (e as {code?: string}).code || (e as Error).message);
  process.exitCode = 1;
} finally {
  await client.query("rollback").catch(() => {});
  await client.end();
}
