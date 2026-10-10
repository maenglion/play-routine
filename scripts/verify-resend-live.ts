import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { getSupabaseConnectionString } from "../server/supabaseConnection";
import { findActiveParentOwnedInvitation, reserveOtpRequest } from "../server/supabaseDb";

const client = new Client({ connectionString: getSupabaseConnectionString(), ssl: { rejectUnauthorized: false } });
const parent = randomUUID(), suffix = randomUUID();
const email = `resend-${suffix}@example.invalid`;
let family: string | undefined, invitation: string | undefined, profile: string | undefined, principal: string | undefined;
let passed = 0;
function assert(value: unknown, name: string) {
  if (!value) throw new Error(`FAILED: ${name}`);
  console.log(`PASS: ${name}`); passed++;
}
try {
  await client.connect();
  await client.query("begin");
  await client.query("insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values($1,'authenticated','authenticated',$2,now(),'{}','{}',now(),now())",[parent,`parent-${suffix}@example.invalid`]);
  principal = (await client.query("select id from public.principals where auth_user_id=$1",[parent])).rows[0].id;
  await client.query("select set_config('request.jwt.claim.sub',$1,true)",[parent]);
  await client.query("set local role authenticated");
  family = (await client.query("select * from public.bootstrap_parent_family('TEMP RESEND TEST')")).rows[0].family_id;
  const row = (await client.query("select * from public.create_child_invitation($1,'TEMP CHILD',$2)",[family,email])).rows[0];
  invitation = row.invitation_id; profile = row.child_profile_id;
  await client.query("commit");
  const input = { authUserId: parent, familyId: family!, invitationId: invitation!, email };
  assert(Boolean(await findActiveParentOwnedInvitation(input)),"Owner and matching email allowed");
  assert(await findActiveParentOwnedInvitation({...input,authUserId:randomUUID()}) === null,"Wrong parent rejected");
  assert(await findActiveParentOwnedInvitation({...input,familyId:randomUUID()}) === null,"Wrong family rejected");
  assert(await findActiveParentOwnedInvitation({...input,email:`wrong-${suffix}@example.invalid`}) === null,"Wrong email rejected");
  await client.query("update public.principals set status='SUSPENDED' where id=$1",[principal]);
  assert(await findActiveParentOwnedInvitation(input) === null,"Suspended parent rejected");
  await client.query("update public.principals set status='ACTIVE' where id=$1",[principal]);
  const attempts = await Promise.all([reserveOtpRequest(invitation!,randomUUID()),reserveOtpRequest(invitation!,randomUUID()),reserveOtpRequest(invitation!,randomUUID())]);
  assert(attempts.filter(r=>r.allowed).length === 1,"Three concurrent requests allow only one send");
  assert((await client.query("select count(*)::int as n from public.invitation_delivery_events where invitation_id=$1 and event_type='OTP_REQUESTED'",[invitation])).rows[0].n === 1,"Concurrent reservation creates one requested audit");
  await client.query("update public.invitation_delivery_events set created_at=now()-interval '2 minutes' where invitation_id=$1 and event_type='OTP_REQUESTED'",[invitation]);
  for(let i=0;i<4;i++) await client.query("insert into public.invitation_delivery_events(invitation_id,event_type,request_id,created_at) values($1,'OTP_REQUESTED',$2,now()-interval '2 minutes')",[invitation,randomUUID()]);
  const limited = await reserveOtpRequest(invitation!,randomUUID());
  assert(!limited.allowed && limited.dailyCount === 5 && limited.recentCount === 0,"Five requests per 24 hours enforced");
  console.log(`RESULT: ${passed} checks passed; no real email requested`);
} catch(e) {
  await client.query("rollback").catch(()=>{});
  console.error("Resend validation failed", (e as {code?:string}).code || (e as Error).message);
  process.exitCode = 1;
} finally {
  try {
    await client.query("begin");
    if (invitation) {
      await client.query("delete from public.invitation_delivery_events where invitation_id=$1",[invitation]);
      await client.query("delete from public.child_invitations where id=$1",[invitation]);
    }
    if (profile) await client.query("delete from public.child_profiles where id=$1",[profile]);
    if (family) {
      await client.query("delete from public.family_memberships where family_id=$1",[family]);
      await client.query("delete from public.families where id=$1",[family]);
    }
    if (principal) await client.query("delete from public.principals where id=$1",[principal]);
    await client.query("delete from auth.users where id=$1",[parent]);
    await client.query("commit");
    console.log("Temporary self-created UUID fixtures cleaned; other data untouched");
  } catch { await client.query("rollback").catch(()=>{}); console.error("Fixture cleanup failed"); process.exitCode=1; }
  await client.end();
}
