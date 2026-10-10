import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { getSupabaseConnectionString } from "../server/supabaseConnection";
import { avatarProfileForAuthUser } from "../server/routes/avatars";

const c = new Client({connectionString:getSupabaseConnectionString(),ssl:{rejectUnauthorized:false},connectionTimeoutMillis:10000});
let passed=0;
function ok(value:unknown,label:string) {if(!value)throw new Error(label);console.log(`PASS ${label}`);passed++;}
async function user(id:string){await c.query("reset role");await c.query("select set_config('request.jwt.claim.sub',$1,true)",[id]);await c.query("set local role authenticated");}
try {
  await c.connect();await c.query("begin");
  const [parent,child,guardian,other] = Array.from({length:4},()=>randomUUID());
  const suffix=randomUUID();
  for(const [id,name] of [[parent,"parent"],[child,"child"],[guardian,"guardian"],[other,"other"]])await c.query("insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values($1,'authenticated','authenticated',$2,now(),'{}','{}',now(),now())",[id,`${name}-${suffix}@example.invalid`]);
  await user(parent);const family=(await c.query("select * from public.bootstrap_parent_family('Avatar rollback family')")).rows[0].family_id;
  const invite=(await c.query("select * from public.create_child_invitation($1,'Avatar child',$2)",[family,`child-${suffix}@example.invalid`])).rows[0];
  await user(child);await c.query("select * from public.complete_child_invitation($1)",[invite.invitation_id]);
  await user(parent);const gi=(await c.query("select * from public.create_guardian_invitation($1,$2)",[family,`guardian-${suffix}@example.invalid`])).rows[0];
  await user(guardian);await c.query("select * from public.complete_guardian_invitation($1)",[gi.invitation_id]);
  await user(other);await c.query("select * from public.bootstrap_parent_family('Other avatar rollback family')");
  await c.query("reset role");
  ok((await avatarProfileForAuthUser(c,parent,invite.child_profile_id))?.child_profile_id===invite.child_profile_id,"Parent can edit own family child photo");
  ok(!await avatarProfileForAuthUser(c,parent),"Parent must identify target child");
  ok((await avatarProfileForAuthUser(c,child))?.child_profile_id===invite.child_profile_id,"Child can edit own photo");
  ok(!await avatarProfileForAuthUser(c,child,randomUUID()),"Child cannot select unrelated child");
  ok(!await avatarProfileForAuthUser(c,guardian,invite.child_profile_id),"View-only guardian cannot upload photo");
  ok(!await avatarProfileForAuthUser(c,other,invite.child_profile_id),"Other family parent cannot upload photo");
  await c.query("update public.principals set status='SUSPENDED' where auth_user_id=$1",[child]);
  ok(!await avatarProfileForAuthUser(c,child),"Suspended account cannot upload photo");
  console.log(`RESULT ${passed} checks; no files uploaded; all fixture data rolled back`);
} catch(e) {console.error("Avatar access validation failed:",(e as {code?:string}).code??(e as Error).message);process.exitCode=1;}
finally {await c.query("rollback").catch(()=>{});await c.end();}
