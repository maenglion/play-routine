import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { getSupabaseConnectionString } from "../server/supabaseConnection";
const client = new Client({connectionString:getSupabaseConnectionString(),ssl:{rejectUnauthorized:false},connectionTimeoutMillis:10000});
let passed=0;
function assert(value:unknown,label:string){if(!value)throw new Error(`FAILED: ${label}`);console.log(`PASS ${label}`);passed++;}
async function asUser(id:string){await client.query("reset role");await client.query("select set_config('request.jwt.claim.sub',$1,true)",[id]);await client.query("set local role authenticated");}
async function rejected(sql:string,values:unknown[],code:string,label:string){await client.query("savepoint expected_failure");let actual="";try{await client.query(sql,values);}catch(e){actual=(e as {code?:string}).code??"unknown";}await client.query("rollback to savepoint expected_failure");assert(actual===code,label);}
try {
 await client.connect();await client.query("begin");
 const suffix=randomUUID(),parent=randomUUID(),guardian=randomUUID(),other=randomUUID();
 for(const [id,name] of [[parent,"parent"],[guardian,"guardian"],[other,"other"]])await client.query("insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values($1,'authenticated','authenticated',$2,now(),'{}','{}',now(),now())",[id,`rule-${name}-${suffix}@example.invalid`]);
 await asUser(parent);const familyId=(await client.query("select * from public.bootstrap_parent_family('RULE ROLLBACK','Asia/Seoul')")).rows[0].family_id;
 assert(Boolean(familyId),"Parent creates rollback family");
 const gi=(await client.query("select * from public.create_guardian_invitation($1,$2)",[familyId,`rule-guardian-${suffix}@example.invalid`])).rows[0];
 await asUser(guardian);await client.query("select * from public.complete_guardian_invitation($1)",[gi.invitation_id]);
 await asUser(parent);
 const saveSql="select * from public.save_parent_rule_draft($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)";
 const saved=(await client.query(saveSql,[familyId,"Math score","DAILY_STUDY","parent scored","PERCENT","채점 정답률",50,80,30,0])).rows[0];
 assert(saved.status==='DRAFT',"Parent saves no-penalty draft");
 const row=(await client.query("select * from public.list_parent_rule_registry($1)",[familyId])).rows[0];
 assert(Number(row.penalty_limit)===50&&Number(row.reward_limit)===80&&row.penalty_minutes===0&&row.reward_minutes===30,"Disabled penalty remains listed with correct thresholds");
 await client.query("reset role");
 const bands=(await client.query("select lower(b.value_range)::text lo,upper(b.value_range)::text hi,upper_inc(b.value_range) inc,b.outcome_code::text outcome from public.policy_bands b join public.policy_dimensions d on d.id=b.policy_dimension_id where d.policy_rule_id=$1 order by lower(b.value_range)",[saved.policy_rule_id])).rows;
 assert(JSON.stringify(bands)===JSON.stringify([{lo:'0',hi:'50',inc:false,outcome:'NO_REWARD'},{lo:'50',hi:'80',inc:false,outcome:'NO_REWARD'},{lo:'80',hi:'100',inc:true,outcome:'REWARD'}]),"Three exhaustive bands include 100 with no overlap");
 await asUser(parent);const pub=(await client.query("select * from public.publish_parent_rule_draft($1)",[saved.config_version_id])).rows[0];
 const localTomorrow=(await client.query("select ((now() at time zone 'Asia/Seoul')::date+1)::text d")).rows[0].d;
 assert(pub.status==='PUBLISHED'&&new Date(pub.effective_from).getTime()===new Date(localTomorrow+'T00:00:00Z').getTime(),"Publication effective tomorrow in family timezone");
 assert((await client.query("select * from public.list_published_family_rules($1)",[familyId])).rowCount===0,"Tomorrow schedule excluded from today's active rules");
 await rejected("update public.family_config_versions set effective_from=current_date where id=$1",[saved.config_version_id],'42501',"Client cannot alter published config");
 const next=(await client.query(saveSql,[familyId,"Math score","DAILY_STUDY","future version","PERCENT","채점 정답률",40,75,0,20])).rows[0];
 assert(next.status==='DRAFT',"Same activity creates new draft version");
 await client.query("reset role");
 assert((await client.query("select count(*)::int n from public.ref_concepts where family_id=$1",[familyId])).rows[0].n===1,"New version reuses approved activity ref");
 await rejected("update public.family_config_versions set effective_from=current_date where id=$1",[saved.config_version_id],'55000',"Published config immutable even through DB trigger");
 await asUser(parent);await client.query("select * from public.publish_parent_rule_draft($1)",[next.config_version_id]);
 await rejected(saveSql,[familyId,"Math score","LIFE_HABIT",null,"PERCENT","기준",40,75,0,10],'22023',"Category cannot silently change");
 await rejected(saveSql,[familyId,"Invalid score","OTHER",null,"PERCENT","기준",80,40,0,0],'22023',"Inverted score thresholds rejected");
 await rejected(saveSql,[familyId,"Invalid amount","OTHER",null,"PERCENT","기준",40,80,-10,0],'22023',"Negative reward rejected");
 // 날짜가 지난 게시 버전 테스트 fixture만 조정한다. 전체 트랜잭션은 반드시 롤백한다.
 await client.query("reset role");await client.query("alter table public.family_config_versions disable trigger family_config_versions_immutable_after_publish");
 await client.query("update public.family_config_versions set effective_from=(now() at time zone 'Asia/Seoul')::date where id=any($1::uuid[])",[[saved.config_version_id,next.config_version_id]]);
 await client.query("alter table public.family_config_versions enable trigger family_config_versions_immutable_after_publish");
 await asUser(parent);const active=(await client.query("select * from public.list_published_family_rules($1)",[familyId])).rows;
 assert(active.length===1&&active[0].policy_rule_id===next.policy_rule_id,"Only latest effective rule per activity returned");
 await asUser(guardian);
 await rejected(saveSql,[familyId,"Guardian rule","OTHER",null,"PERCENT","기준",40,75,0,0],'42501',"Guardian cannot create rules");
 await rejected("select * from public.publish_parent_rule_draft($1)",[saved.config_version_id],'42501',"Guardian cannot publish rules");
 assert((await client.query("select * from public.list_parent_rule_registry($1)",[familyId])).rowCount===0,"Guardian cannot read parent registry");
 assert((await client.query("select * from public.list_published_family_rules($1)",[familyId])).rowCount===0,"Guardian cannot read published rules");
 await rejected("select id from public.policy_effects",[],'42501',"Direct policy table access denied");
 await asUser(other);assert((await client.query("select * from public.list_parent_rule_registry($1)",[familyId])).rowCount===0,"Other account cannot read family's rules");
 console.log(`RESULT ${passed} checks; all fixtures rolled back`);
}catch(e){console.error("Rule validation failed:",(e as {code?:string}).code??(e as Error).message,(e as {where?:string}).where??"");process.exitCode=1;}
finally{await client.query("rollback").catch(()=>{});await client.end();}
