import { PGlite } from '@electric-sql/pglite';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dbDir = join(here, '.pglite-verify');
await rm(dbDir, { recursive: true, force: true });
const db = await PGlite.create(dbDir);
const schema = await readFile(join(here, 'schema.sql'), 'utf8');
const seed = await readFile(join(here, 'seed.sql'), 'utf8');
const results = {};
let checks = 0;
function ok(condition, name, detail) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${name}${detail ? ` — ${detail}` : ''}`);
  checks += 1; results[name] = detail ?? true;
}
async function q(sql, params = []) { return db.query(sql, params); }
async function scalar(sql, params = []) { const r = await q(sql, params); return Object.values(r.rows[0] ?? {})[0]; }
async function asUser(uuid) { await q(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uuid })]); }
async function testMode(on) { await q(`SELECT set_config('pr_design.test_mode', $1, false)`, [on ? 'on' : 'off']); }
async function rejected(name, fn) {
  try { await fn(); } catch (e) { ok(true, name, e.message); return; }
  throw new Error(`ASSERTION FAILED: ${name} was accepted`);
}

await db.exec(schema);
await db.exec(seed);
await asUser('11111111-1111-1111-1111-111111111111');
await testMode(true); // 격리 PGlite fixture만 DRAFT 및 test-only path를 허용한다.

// 원문 26개와 새 정본 bridge/condition 관계.
ok(Number(await scalar(`SELECT count(*) FROM pr_design.rule_identities WHERE family_id='fam-a'`)) === 26, 'rule_identity_count_26');
ok(Number(await scalar(`SELECT count(*) FROM pr_design.rule_governing_versions WHERE family_id='fam-a'`)) === 26, 'all_26_rules_have_subordinate_regulation_bridge');
ok(Number(await scalar(`SELECT count(*) FROM pr_design.rule_effects e LEFT JOIN pr_design.rule_conditions c ON (c.family_id,c.rule_version_id,c.condition_code)=(e.family_id,e.rule_version_id,e.condition_code) WHERE c.rule_condition_id IS NULL`)) === 0, 'every_effect_has_normalized_condition');
ok(Number(await scalar(`SELECT count(*) FROM pr_design.plan_governing_versions pgv JOIN pr_design.regulation_versions rv ON (rv.regulation_version_id,rv.family_id)=(pgv.regulation_version_id,pgv.family_id) JOIN pr_design.regulations r ON (r.regulation_id,r.family_id)=(rv.regulation_id,rv.family_id) WHERE pgv.plan_id='plan-2026-10' AND r.kind='BASIC'`)) === 1, 'plan_has_basic_governing_version');
ok((await scalar(`SELECT quantity FROM pr_design.rule_effects WHERE rule_effect_id='eff-t003-unspecified'`)) === null, 'violin_unspecified_is_null');
await rejected('wrong_kind_rule_governing_bridge_rejected', () => q(`INSERT INTO pr_design.rule_governing_versions VALUES ('bad-gov','fam-a','rv-l001','regv-task-06')`));

// 단일 PRIMARY 조건에서만 자동 Lifestyle 효과를 적용한다. 두 자산도 count 하나만 소비한다.
await db.exec(`SET search_path=pr_design,pg_catalog;
 INSERT INTO rule_versions(rule_version_id,family_id,rule_id,version_no,status,source_text,condition_spec,pending_fields,period,reward_mode,recognition_limit,positive_minutes)
 VALUES ('rv-l001-test2','fam-a','r-l001',2,'DRAFT','TEST ONLY: one recognized fact with two assets','{}','{"test_only":true}','DAILY',NULL,3,15);
 INSERT INTO rule_governing_versions VALUES ('gov-rv-l001-test2','fam-a','rv-l001-test2','regv-life-06');
 INSERT INTO rule_conditions VALUES ('cond-rv-l001-test2-primary','fam-a','rv-l001-test2','PRIMARY','{}');
 INSERT INTO rule_effects(rule_effect_id,family_id,rule_version_id,ordinal,effect,asset_version_id,quantity,unit,condition_code) VALUES
 ('eff-l001-test2-media','fam-a','rv-l001-test2',1,'REWARD','assetv-media-1',15,'MINUTES','PRIMARY'),
 ('eff-l001-test2-cash','fam-a','rv-l001-test2',2,'REWARD','assetv-cash-1',1,'CASH_KRW','PRIMARY');`);
const lifeCall = (key, payload, at = '2026-10-17 10:00+09', rule = 'rv-l001-test2') => q(
 `SELECT pr_design.recognize_lifestyle_event('fam-a','child-a',$1,$2::timestamptz,$3,$4::jsonb) AS x`, [rule, at, key, JSON.stringify(payload)]);
const l1 = (await lifeCall('l-1', { action: 'cat-litter', proof: 1 })).rows[0].x;
await lifeCall('l-2', { action: 'cat-litter', proof: 2 });
await lifeCall('l-3', { action: 'cat-litter', proof: 3 });
const l4 = (await lifeCall('l-4', { action: 'cat-litter', proof: 4 })).rows[0].x;
const replay = (await lifeCall('l-1', { action: 'cat-litter', proof: 1 })).rows[0].x;
ok(l1.outcome === 'REWARDED' && l4.outcome === 'LIMIT_EXCEEDED', 'lifestyle_cap_preserves_over_limit_fact');
ok(replay.replayed === true && replay.event_id === l1.event_id, 'lifestyle_exact_retransmit_idempotent');
ok(Number(await scalar(`SELECT used_count FROM pr_design.recognition_limit_buckets WHERE business_date='2026-10-17'`)) === 3, 'daily_cap_3_of_4');
ok(Number(await scalar(`SELECT count(*) FROM pr_design.effect_applications WHERE source_event_id=$1`, [l1.event_id])) === 2, 'two_assets_one_count');
await rejected('same_key_different_payload_rejected', () => lifeCall('l-1', { action: 'cat-litter', proof: 99 }));
await rejected('same_key_same_payload_different_date_rejected', () => lifeCall('l-1', { action: 'cat-litter', proof: 1 }, '2026-10-18 10:00+09'));
await rejected('same_key_same_payload_different_rule_rejected', () => lifeCall('l-1', { action: 'cat-litter', proof: 1 }, '2026-10-17 10:00+09', 'rv-l001'));
await rejected('multi_condition_lifestyle_auto_apply_rejected', () => lifeCall('l-main-multi-condition', { action: 'cat-litter' }, '2026-10-18 10:00+09', 'rv-l001'));
await testMode(false);
await rejected('draft_lifestyle_denied_outside_isolated_test_mode', () => lifeCall('draft-no-test', { action: 'cat-litter' }));
await testMode(true);

// 패널티는 정의된 음수 Lifestyle만, replay도 rule/date/reason까지 동일해야 한다.
const penalty = await q(`SELECT pr_design.approve_penalty_event('fam-a','child-a','rv-l013','2026-10-17 19:31+09','l013-1','{"direct_question":true,"not_taken_by":"19:30"}','부모 직접 질문으로 확인') AS event_id`);
const penaltyReplay = await q(`SELECT pr_design.approve_penalty_event('fam-a','child-a','rv-l013','2026-10-17 19:31+09','l013-1','{"direct_question":true,"not_taken_by":"19:30"}','부모 직접 질문으로 확인') AS event_id`);
ok(penalty.rows[0].event_id === penaltyReplay.rows[0].event_id, 'penalty_exact_retransmit_idempotent');
await rejected('penalty_same_key_different_date_rejected', () => q(`SELECT pr_design.approve_penalty_event('fam-a','child-a','rv-l013','2026-10-18 19:31+09','l013-1','{"direct_question":true,"not_taken_by":"19:30"}','부모 직접 질문으로 확인')`));
await rejected('penalty_same_key_different_rule_rejected', () => q(`SELECT pr_design.approve_penalty_event('fam-a','child-a','rv-l008','2026-10-17 19:31+09','l013-1','{"direct_question":true,"not_taken_by":"19:30"}','부모 직접 질문으로 확인')`));
await rejected('positive_lifestyle_cannot_be_penalty', () => q(`SELECT pr_design.approve_penalty_event('fam-a','child-a','rv-l001-test2','2026-10-17 19:31+09','bad-positive','{}','reason')`));

// 이 fixture의 feedback 및 parent confirmation은 실제 source_event -> confirmation FK 사슬을 가진다.
async function schoolAssessment(occId, date, basic, suffix) {
  const ev = `school-evt-${suffix}`, pc = `school-pc-${suffix}`;
  await q(`INSERT INTO pr_design.source_events(source_event_id,family_id,child_id,occurrence_id,rule_version_id,event_type,occurred_at,payload,client_event_key)
    VALUES ($1,'fam-a','child-a',$2,'rv-t007','SCHOOL_FEEDBACK',$3::timestamptz,$4::jsonb,$5)`,
    [ev, occId, `${date} 15:00+09`, JSON.stringify({ feedback: basic ? 'NO_PROBLEM' : 'PROBLEM' }), `school-feedback-${suffix}`]);
  await q(`INSERT INTO pr_design.parent_confirmations(confirmation_id,family_id,source_event_id,parent_membership_id,decision,idempotency_key)
    VALUES ($1,'fam-a',$2,'mem-a-parent','RECOGNIZED',$3)`, [pc, ev, `school-confirm-${suffix}`]);
  await q(`INSERT INTO pr_design.school_day_assessments(assessment_id,family_id,child_id,occurrence_id,stable_scope_code,business_date,feedback,basic_sticker_count,parent_confirmation_id)
    VALUES ($1,'fam-a','child-a',$2,'school-weekly-stickers',$3::date,$4,$5,$6)`,
    [`school-assess-${suffix}`, occId, date, basic ? 'NO_PROBLEM' : 'PROBLEM', basic, pc]);
}
async function addSchoolOccurrence(occId, date, suffix) {
  await q(`INSERT INTO pr_design.scheduled_occurrences(occurrence_id,family_id,child_id,adoption_id,rule_version_id,stable_scope_code,scheduled_for,state)
   VALUES ($1,'fam-a','child-a','adopt-10-rv-t007','rv-t007','school-weekly-stickers',$2::timestamptz,'COMPLETED')`, [occId, `${date} 08:00+09`]);
  await schoolAssessment(occId, date, 1, suffix);
}
const settle = (start, end, final = true, testOnly = false, reference = null) => q(
 `SELECT pr_design.settle_school_period('fam-a','child-a','school-weekly-stickers',$1::date,$2::date,'Asia/Seoul',$3,$4,$5) AS x`, [start, end, final, testOnly, reference]);

// [19,23)에는 19~22만 포함한다. 23일 확정 자료가 있어도 목표는 4다.
await rejected('school_unconfirmed_final_close_rejected', () => settle('2026-10-19', '2026-10-23', true));
for (const [occ, date, n] of [['occ-school-19','2026-10-19','a'],['occ-school-20','2026-10-20','b'],['occ-school-21','2026-10-21','c'],['occ-school-22','2026-10-22','d']]) await schoolAssessment(occ, date, 1, `four-${n}`);
await addSchoolOccurrence('occ-school-23','2026-10-23','endpoint');
// 학교 scope도 아니거나 SCHOOL sticker type도 아닌 praise는 총액에 섞이지 않는다.
await q(`INSERT INTO pr_design.sticker_types VALUES ('st-other','fam-a','OTHER','기타 스티커')`);
await q(`INSERT INTO pr_design.source_events VALUES ('praise-wrong-scope','fam-a','child-a','occ-school-19','rv-l001','SCHOOL_PRAISE','2026-10-19 16:00+09','{}','praise-wrong-scope',clock_timestamp()), ('praise-wrong-type','fam-a','child-a','occ-school-20','rv-t007','SCHOOL_PRAISE','2026-10-20 16:00+09','{}','praise-wrong-type',clock_timestamp())`);
await q(`INSERT INTO pr_design.parent_confirmations VALUES ('pc-praise-wrong-scope','fam-a','praise-wrong-scope','mem-a-parent','RECOGNIZED',NULL,'pc-praise-wrong-scope',clock_timestamp()), ('pc-praise-wrong-type','fam-a','praise-wrong-type','mem-a-parent','RECOGNIZED',NULL,'pc-praise-wrong-type',clock_timestamp())`);
await q(`INSERT INTO pr_design.sticker_awards VALUES ('award-wrong-scope','fam-a','child-a','st-school','praise-wrong-scope','pc-praise-wrong-scope','SCHOOL_PRAISE',1), ('award-wrong-type','fam-a','child-a','st-other','praise-wrong-type','pc-praise-wrong-type','SCHOOL_PRAISE',1)`);
const four = (await settle('2026-10-19', '2026-10-23', true)).rows[0].x;
ok(four.stickers === 4 && Number(four.target_total) === 0, 'period_end_exclusive_19_to_23_excludes_23');
ok(four.stickers === 4, 'praise_requires_school_scope_and_school_sticker_type');

// 클라이언트 bool만으로는 중간발행이 안 된다: isolated GUC를 끄면 거절된다.
await testMode(false);
await rejected('ordinary_interim_and_client_bool_denied', () => settle('2026-10-26', '2026-11-03', false, true, 'CLIENT-CANNOT-AUTHORIZE'));
await testMode(true);

// 5→8 경로: 10,000 발행과 5,000 추가 발행 후 한 번의 이행은 권리별 두 행(10k+5k)이다.
for (let i = 0; i < 8; i++) { const date = new Date(Date.UTC(2026, 10, 9 + i)).toISOString().slice(0,10); await addSchoolOccurrence(`occ-school-c-${i}`, date, `c-${i}`); }
await q(`DELETE FROM pr_design.school_day_assessments WHERE assessment_id IN ('school-assess-c-5','school-assess-c-6','school-assess-c-7')`);
const c5 = (await settle('2026-11-09','2026-11-17',false,true,'TEST-ONLY-INTERIM-20261017')).rows[0].x;
for (const [i,date] of [[5,'2026-11-14'],[6,'2026-11-15'],[7,'2026-11-16']]) await schoolAssessment(`occ-school-c-${i}`,date,1,`c-${i}-re`);
const c8 = (await settle('2026-11-09','2026-11-17',true)).rows[0].x;
ok(Number(c5.new_right) === 10000 && Number(c8.new_right) === 5000, 'school_5_then_8_issues_10000_plus_5000');
const paid = await scalar(`SELECT pr_design.execute_school_outstanding('fam-a',$1,'pay-c-all','receipt-c-all')`, [c5.period_id]);
ok(Number(paid) === 15000, 'one_batch_returns_total_15000');
ok(Number(await scalar(`SELECT count(*) FROM pr_design.actual_reward_executions x JOIN pr_design.school_execution_batches b ON b.execution_batch_id=x.execution_batch_id WHERE b.idempotency_key='pay-c-all'`)) === 2, 'one_batch_is_split_across_two_rights');
ok(Number(await scalar(`SELECT min(x.quantity) FROM pr_design.actual_reward_executions x JOIN pr_design.school_execution_batches b ON b.execution_batch_id=x.execution_batch_id WHERE b.idempotency_key='pay-c-all'`)) === 5000 && Number(await scalar(`SELECT max(x.quantity) FROM pr_design.actual_reward_executions x JOIN pr_design.school_execution_batches b ON b.execution_batch_id=x.execution_batch_id WHERE b.idempotency_key='pay-c-all'`)) === 10000, 'right_allocations_5000_and_10000');
ok(Number(await scalar(`SELECT count(*) FROM (SELECT r.reward_right_id FROM pr_design.actual_reward_executions x JOIN pr_design.reward_rights r ON (r.reward_right_id,r.family_id)=(x.reward_right_id,x.family_id) GROUP BY r.reward_right_id,r.quantity HAVING sum(x.quantity) > r.quantity) overspent`)) === 0, 'per_right_overspend_impossible_in_fixture');
await rejected('direct_per_right_overspend_rejected', () => q(`INSERT INTO pr_design.actual_reward_executions(execution_id,family_id,execution_batch_id,reward_right_id,idempotency_key,quantity,executed_by_membership_id) SELECT 'bad-overspend','fam-a',x.execution_batch_id,x.reward_right_id,'bad-overspend',1,'mem-a-parent' FROM pr_design.actual_reward_executions x JOIN pr_design.school_execution_batches b ON b.execution_batch_id=x.execution_batch_id WHERE b.idempotency_key='pay-c-all' LIMIT 1`));
ok(Number(await scalar(`SELECT pr_design.execute_school_outstanding('fam-a',$1,'pay-c-all','receipt-c-all')`, [c5.period_id])) === 15000, 'execution_exact_retransmit_returns_batch_total');
await rejected('execution_replay_period_mismatch_rejected', () => q(`SELECT pr_design.execute_school_outstanding('fam-a','not-the-period','pay-c-all','receipt-c-all')`));
await rejected('execution_replay_external_reference_mismatch_rejected', () => q(`SELECT pr_design.execute_school_outstanding('fam-a',$1,'pay-c-all','other-receipt')`, [c5.period_id]));

// 하향 정정은 자동 회수가 아니라 REVIEW_REQUIRED이며, 이후 지급은 금지한다.
await q(`UPDATE pr_design.school_day_assessments SET feedback='PROBLEM', basic_sticker_count=0 WHERE assessment_id IN ('school-assess-c-4','school-assess-c-5-re','school-assess-c-6-re','school-assess-c-7-re')`);
const correction = (await settle('2026-11-09','2026-11-17',true)).rows[0].x;
ok(correction.status === 'REVIEW_REQUIRED', 'downward_correction_requires_review');
await rejected('review_required_period_cannot_execute', () => q(`SELECT pr_design.execute_school_outstanding('fam-a',$1,'review-pay','receipt-review')`, [c5.period_id]));

// parent confirmation 누락, UNCONFIRMED+praise, PROBLEM+praise는 final에서 확정 불가다.
await q(`INSERT INTO pr_design.scheduled_occurrences VALUES ('occ-no-parent','fam-a','child-a','adopt-10-rv-t007','rv-t007','school-weekly-stickers','2026-12-01 08:00+09','COMPLETED')`);
await q(`INSERT INTO pr_design.school_day_assessments(assessment_id,family_id,child_id,occurrence_id,stable_scope_code,business_date,feedback,basic_sticker_count) VALUES ('assess-no-parent','fam-a','child-a','occ-no-parent','school-weekly-stickers','2026-12-01','NO_PROBLEM',1)`);
await rejected('missing_parent_confirmation_final_denied', () => settle('2026-12-01','2026-12-02',true));
async function praise(occId, date, suffix) {
 const ev=`praise-evt-${suffix}`, pc=`praise-pc-${suffix}`;
 await q(`INSERT INTO pr_design.source_events VALUES ($1,'fam-a','child-a',$2,'rv-t007','SCHOOL_PRAISE',$3::timestamptz,'{}',$4,clock_timestamp())`,[ev,occId,`${date} 16:00+09`,`praise-key-${suffix}`]);
 await q(`INSERT INTO pr_design.parent_confirmations VALUES ($1,'fam-a',$2,'mem-a-parent','RECOGNIZED',NULL,$3,clock_timestamp())`,[pc,ev,`praise-confirm-${suffix}`]);
 await q(`INSERT INTO pr_design.sticker_awards VALUES ($1,'fam-a','child-a','st-school',$2,$3,'SCHOOL_PRAISE',1)`,[`praise-award-${suffix}`,ev,pc]);
}
await q(`INSERT INTO pr_design.scheduled_occurrences VALUES ('occ-unknown-praise','fam-a','child-a','adopt-10-rv-t007','rv-t007','school-weekly-stickers','2026-12-03 08:00+09','COMPLETED')`);
await q(`INSERT INTO pr_design.school_day_assessments(assessment_id,family_id,child_id,occurrence_id,stable_scope_code,business_date,feedback) VALUES ('assess-unknown-praise','fam-a','child-a','occ-unknown-praise','school-weekly-stickers','2026-12-03','UNCONFIRMED')`);
await praise('occ-unknown-praise','2026-12-03','unknown');
await rejected('unknown_feedback_praise_final_denied', () => settle('2026-12-03','2026-12-04',true));
await addSchoolOccurrence('occ-problem-praise','2026-12-05','problem');
await q(`UPDATE pr_design.school_day_assessments SET feedback='PROBLEM',basic_sticker_count=0 WHERE assessment_id='school-assess-problem'`);
await praise('occ-problem-praise','2026-12-05','problem');
await rejected('problem_plus_praise_final_denied', () => settle('2026-12-05','2026-12-06',true));

// 가족 격리와 불변 원장 모델 경계.
await rejected('composite_family_fk_rejects_cross_tenant_child', () => q(`INSERT INTO pr_design.source_events(source_event_id,family_id,child_id,event_type,occurred_at,payload,client_event_key) VALUES ('bad-fk','fam-b','child-a','SELF_REPORT',clock_timestamp(),'{}','bad-fk')`));
await q(`INSERT INTO pr_design.immutable_ledger_entries VALUES ('ledger-test','fam-a','TEST','source-1','MINUTES',15,clock_timestamp())`);
await rejected('immutable_ledger_update_rejected', () => q(`UPDATE pr_design.immutable_ledger_entries SET signed_quantity=20 WHERE ledger_entry_id='ledger-test'`));

const counts = {};
for (const [name, sql] of Object.entries({ rules:`SELECT count(*) FROM pr_design.rule_identities`, rule_conditions:`SELECT count(*) FROM pr_design.rule_conditions`, source_events:`SELECT count(*) FROM pr_design.source_events`, school_periods:`SELECT count(*) FROM pr_design.aggregation_periods`, reward_rights:`SELECT count(*) FROM pr_design.reward_rights`, reward_execution_batches:`SELECT count(*) FROM pr_design.school_execution_batches`, reward_execution_rows:`SELECT count(*) FROM pr_design.actual_reward_executions` })) counts[name] = Number(await scalar(sql));
const output = { status:'PASS', checks, counts, results, caveats:[
 'PGlite is single-connection/serial only; real PostgreSQL parallel transactions and load behavior are unverified.',
 'This is not a real REST/JWT-signature/RLS integration test; server-side signature validation and production role grants remain deployment work.',
 'immutable_ledger_entries is only an append-only ledger model: it has no child/asset/period/source FK and is not a real settlement ledger.',
 'condition_spec JSON and normalized rule_conditions preserve predicates/codes, but arbitrary all-rule condition evaluation is not implemented; automatic Lifestyle application is deliberately limited to one positive condition.'
] };
await writeFile(join(here, 'verify-result.json'), JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify(output, null, 2));
await db.close();
