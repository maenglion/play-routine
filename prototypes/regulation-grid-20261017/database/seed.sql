-- Prototype seed only. It represents no operational approval or live issuance.
SET search_path = pr_design, pg_catalog;

INSERT INTO families(family_id,display_name,timezone) VALUES ('fam-a','검증 가족 A','Asia/Seoul'),('fam-b','격리 검증 가족 B','Asia/Seoul');
INSERT INTO family_memberships(membership_id,family_id,auth_user_id,role) VALUES
 ('mem-a-parent','fam-a','11111111-1111-1111-1111-111111111111','OWNER_PARENT'),
 ('mem-a-child','fam-a','22222222-2222-2222-2222-222222222222','CHILD'),
 ('mem-a-guardian','fam-a','33333333-3333-3333-3333-333333333333','GUARDIAN'),
 ('mem-b-parent','fam-b','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','OWNER_PARENT');
INSERT INTO children(child_id,family_id,child_auth_user_id,display_name) VALUES
 ('child-a','fam-a','22222222-2222-2222-2222-222222222222','검증 자녀 A'),('child-b','fam-b',NULL,'검증 자녀 B');

INSERT INTO regulations(regulation_id,family_id,code,kind) VALUES
 ('reg-basic-a','fam-a','PR-BASIC','BASIC'),('reg-task-a','fam-a','PR-TASK','TASK'),('reg-quest-a','fam-a','PR-QUEST','QUEST'),('reg-life-a','fam-a','PR-LIFESTYLE','LIFESTYLE'),('reg-ops-a','fam-a','PR-OPS-LIFECYCLE','OPS_LIFECYCLE');
INSERT INTO regulation_versions(regulation_version_id,family_id,regulation_id,version_no,status,source_text,pending_fields) VALUES
 ('regv-basic-06','fam-a','reg-basic-a',6,'DRAFT','Play-Routine-Operating-Constitution-and-Three-Regulations-v0.6.md', '{"operational_approval":"pending"}'),
 ('regv-task-06','fam-a','reg-task-a',6,'DRAFT','Play-Routine-Operating-Constitution-and-Three-Regulations-v0.6.md', '{"operational_approval":"pending"}'),
 ('regv-quest-06','fam-a','reg-quest-a',6,'DRAFT','Play-Routine-Operating-Constitution-and-Three-Regulations-v0.6.md', '{"operational_approval":"pending"}'),
 ('regv-life-06','fam-a','reg-life-a',6,'DRAFT','Play-Routine-Operating-Constitution-and-Three-Regulations-v0.6.md', '{"operational_approval":"pending"}'),
 ('regv-ops-02','fam-a','reg-ops-a',2,'DRAFT','Play-Routine-Regulation-Lifecycle-v0.2.md', '{"week_boundary":"user_unconfirmed","interim_payment":"user_unconfirmed","transition_effect":"user_unconfirmed"}');
INSERT INTO regulation_version_relationships VALUES
 ('rel-basic-task','fam-a','regv-basic-06','regv-task-06','GOVERNS','prototype relation',false),
 ('rel-basic-quest','fam-a','regv-basic-06','regv-quest-06','GOVERNS','prototype relation',false),
 ('rel-basic-life','fam-a','regv-basic-06','regv-life-06','GOVERNS','prototype relation',false),
 ('rel-ops-task','fam-a','regv-ops-02','regv-task-06','DEPENDS_ON','period/settlement contract',false),
 ('rel-ops-quest','fam-a','regv-ops-02','regv-quest-06','DEPENDS_ON','period/settlement contract',false),
 ('rel-ops-life','fam-a','regv-ops-02','regv-life-06','DEPENDS_ON','period/settlement contract',false);
INSERT INTO version_compatibilities VALUES
 ('compat-basic-task','fam-a','regv-basic-06','regv-task-06',true,NULL,'draft compatibility only'),
 ('compat-basic-quest','fam-a','regv-basic-06','regv-quest-06',true,NULL,'draft compatibility only'),
 ('compat-basic-life','fam-a','regv-basic-06','regv-life-06',true,NULL,'draft compatibility only');

INSERT INTO asset_identities(asset_id,family_id,asset_code) VALUES
 ('asset-media','fam-a','MEDIA_COUPON'),('asset-coupay','fam-a','COUPAY_MONEY'),('asset-cash','fam-a','CASH_KRW');
INSERT INTO asset_versions(asset_version_id,family_id,asset_id,version_no,status,display_name,unit,delivery_method,input_contract) VALUES
 ('assetv-media-1','fam-a','asset-media',1,'DRAFT','미디어쿠폰','MINUTES','parent-managed coupon','{}'),
 ('assetv-coupay-1','fam-a','asset-coupay',1,'DRAFT','쿠페이머니','COUPAY_KRW','external Coupay fulfillment','{"no_conversion_to_points":true}'),
 ('assetv-cash-1','fam-a','asset-cash',1,'DRAFT','현금','CASH_KRW','external cash fulfillment','{}');

-- Exact source numbers: Quest 3, Task 7, Lifestyle 16 = 26. NULL effect quantity means the source did not state a value.
INSERT INTO rule_identities(rule_id,family_id,permanent_number,kind,stable_scope_code) VALUES
 ('r-q001','fam-a','Q-001','QUEST','q001-monthly-kitan'),('r-q002','fam-a','Q-002','QUEST','q002-monthly-origami'),('r-q003','fam-a','Q-003','QUEST','q003-midterm-event'),
 ('r-t001','fam-a','T-001','TASK','t001-daily-milkt'),('r-t002','fam-a','T-002','TASK','t002-daily-kitan'),('r-t003','fam-a','T-003','TASK','t003-violin'),('r-t004','fam-a','T-004','TASK','t004-writing'),('r-t005','fam-a','T-005','TASK','t005-gifted-problem'),('r-t006','fam-a','T-006','TASK','t006-gifted-class'),('r-t007','fam-a','T-007','TASK','school-weekly-stickers'),
 ('r-l001','fam-a','L-001','LIFESTYLE','l001-cat-litter'),('r-l002','fam-a','L-002','LIFESTYLE','l002-clothes'),('r-l003','fam-a','L-003','LIFESTYLE','l003-sweep-vacuum'),('r-l004','fam-a','L-004','LIFESTYLE','l004-nuri-medication'),('r-l005','fam-a','L-005','LIFESTYLE','l005-raon-waste'),('r-l006','fam-a','L-006','LIFESTYLE','l006-desk'),('r-l007','fam-a','L-007','LIFESTYLE','l007-recycling'),
 ('r-l008','fam-a','L-008','LIFESTYLE','l008-room-trash'),('r-l009','fam-a','L-009','LIFESTYLE','l009-wet-clothes'),('r-l010','fam-a','L-010','LIFESTYLE','l010-meal-cleanup'),('r-l011','fam-a','L-011','LIFESTYLE','l011-bedtime'),('r-l012','fam-a','L-012','LIFESTYLE','l012-secret-card'),('r-l013','fam-a','L-013','LIFESTYLE','l013-evening-med-check'),('r-l014','fam-a','L-014','LIFESTYLE','l014-rude-others'),('r-l015','fam-a','L-015','LIFESTYLE','l015-general-damage'),('r-l016','fam-a','L-016','LIFESTYLE','l016-device-damage');

INSERT INTO rule_versions(rule_version_id,family_id,rule_id,version_no,status,source_text,condition_spec,pending_fields,period,reward_mode,recognition_limit,positive_minutes,negative_minutes) VALUES
 ('rv-q001','fam-a','r-q001',1,'DRAFT','기탄수학 G5 하루3장, 10/1~31, 20문제 4분 이내 통과','{"dates":"2026-10-01..2026-10-31","pass":"20 problems within 4 minutes","middle":"none (pass/no-reward)"}','{"20_problem_pass_semantics":"pending","daily_task_link":"pending"}','MONTHLY',NULL,NULL,NULL,NULL),
 ('rv-q002','fam-a','r-q002',1,'DRAFT','종이접기 하나 골라서 완성','{"completion_count":1}','{"monthly_recognition_count":"pending","fulfillment":"pending"}','MONTHLY',NULL,NULL,NULL,NULL),
 ('rv-q003','fam-a','r-q003',1,'DRAFT','10/19~22 중간고사 최고 충족 배타 구간','{"exclusive_tiers":["90>=4:600","90=3:480","80>=3:360"]}','{"subject_scope":"pending","final_grade_time":"pending"}','EVENT',NULL,NULL,NULL,NULL),
 ('rv-t001','fam-a','r-t001',1,'DRAFT','밀크티 일별 40분 수행','{"duration_minutes":40}','{"daily_recognition_count":"pending"}','DAILY',NULL,NULL,NULL,NULL),
 ('rv-t002','fam-a','r-t002',1,'DRAFT','기탄 G5 일별 3장 15분 수행','{"pages":3,"duration_minutes":15}','{"15_minutes_meaning":"pending","q001_relation":"separate"}','DAILY',NULL,NULL,NULL,NULL),
 ('rv-t003','fam-a','r-t003',1,'DRAFT','바이올린 화/목 30분 수행','{"days":[2,4],"duration_minutes":30}','{"reward":"unspecified_not_zero"}','WEEKLY',NULL,NULL,NULL,NULL),
 ('rv-t004','fam-a','r-t004',1,'DRAFT','글씨쓰기 월/수 수업 후 완료','{"days":[1,3],"after_class":true}','{"class_or_extra_practice_scope":"pending"}','WEEKLY',NULL,NULL,NULL,NULL),
 ('rv-t005','fam-a','r-t005',1,'DRAFT','영재원 문제수업 화/금/영재원 없는 토요일','{"days":[2,5,6],"exclude_actual_t006_saturday":true}','{"separate_activity_evidence":"required"}','WEEKLY',NULL,NULL,NULL,NULL),
 ('rv-t006','fam-a','r-t006',1,'DRAFT','영재원 수업 2026-10-24 토요일','{"actual_date":"2026-10-24","recurrence":"biweekly Saturday"}','{"recurrence_anchor":"pending","exceptions":"pending"}','EVENT',NULL,NULL,NULL,NULL),
 ('rv-t007','fam-a','r-t007',1,'DRAFT','학교: 문제없음 기본1, 문제0, 칭찬 +1; 주 최종총액','{"daily_basic":"confirmed 0/1","praise":"additional 1","tiers":"0-4=0,5-7=10000,8+=15000","top":"exclusive target_total"}','{"week_boundary":"pending","problem_plus_praise":"pending","praise_cap":"pending","ordinary_interim_payment":"pending"}','WEEKLY','EXCLUSIVE_TARGET_TOTAL',NULL,NULL,NULL),
 ('rv-l001','fam-a','r-l001',1,'DRAFT','고양이 화장실 치우기','{"action":"cat litter"}','{}','DAILY',NULL,3,15,NULL),
 ('rv-l002','fam-a','r-l002',1,'DRAFT','옷 걸기·치우기','{"action":"put clothes away"}','{}','DAILY',NULL,1,15,NULL),
 ('rv-l003','fam-a','r-l003',1,'DRAFT','빗자루 쓸기/청소기','{"action":"sweep_or_vacuum"}','{"tool_combination":"pending"}','DAILY',NULL,1,15,NULL),
 ('rv-l004','fam-a','r-l004',1,'DRAFT','누리 약 먹이기','{"action":"give Nuri medication"}','{"pet_care_not_child_medication":true}','DAILY',NULL,2,15,NULL),
 ('rv-l005','fam-a','r-l005',1,'DRAFT','라온이 바닥 똥 치우기','{"action":"clean Raon waste"}','{}','DAILY',NULL,2,15,NULL),
 ('rv-l006','fam-a','r-l006',1,'DRAFT','책상 정리하기(책상 3종)','{"action":"organize desk types"}','{"all_three_or_choice":"pending"}','DAILY',NULL,1,30,NULL),
 ('rv-l007','fam-a','r-l007',1,'DRAFT','분리수거 양손 기준','{"action":"recycle both hands"}','{}','DAILY',NULL,1,30,NULL),
 ('rv-l008','fam-a','r-l008',1,'DRAFT','방 바닥 쓰레기 방치','{"violation":"room floor trash","check":"before sleep"}','{"check_count_equals_deduction_cap":"unapproved_incomplete"}','DAILY',NULL,NULL,NULL,-40),
 ('rv-l009','fam-a','r-l009',1,'DRAFT','목욕 후 화장실 바닥 젖은 옷','{"violation":"wet clothes after bath","check":"before sleep"}','{"check_count_equals_deduction_cap":"unapproved_incomplete"}','DAILY',NULL,NULL,NULL,-40),
 ('rv-l010','fam-a','r-l010',1,'DRAFT','식후 정리/트레이·그릇 싱크대 미이행','{"violation":"meal cleanup","check":"after meal"}','{"check_count":2,"check_count_equals_deduction_cap":"unapproved_incomplete"}','DAILY',NULL,NULL,NULL,-40),
 ('rv-l011','fam-a','r-l011',1,'DRAFT','10시까지 안 자기','{"violation":"not asleep by 22:00"}','{"sleep_definition":"pending","check_count_equals_deduction_cap":"unapproved_incomplete"}','DAILY',NULL,NULL,NULL,-40),
 ('rv-l012','fam-a','r-l012',1,'DRAFT','엄마/외부인 카드로 몰래 결제','{"violation":"secret card payment"}','{"dedup":"one event, not repeated confirmations"}','EVENT',NULL,NULL,NULL,-200),
 ('rv-l013','fam-a','r-l013',1,'DRAFT','19:30까지 저녁약 안 먹기: 부모 직접 질문 확인','{"violation":"not taken evening medicine by 19:30","confirmation":"parent direct inquiry"}','{"medication_record_not_automatic":true,"check_count_equals_deduction_cap":"unapproved_incomplete"}','DAILY',NULL,NULL,NULL,-40),
 ('rv-l014','fam-a','r-l014',1,'DRAFT','외부인에게 함부로 행동','{"violation":"rude behavior to others"}','{"behavior_scope":"pending","dedup":"not per complaint"}','EVENT',NULL,NULL,NULL,-60),
 ('rv-l015','fam-a','r-l015',1,'DRAFT','일반 기물파손','{"violation":"general property damage"}','{"frequency_is_not_monthly_limit":true,"l016_exclusivity":"proposed_not_approved"}','EVENT',NULL,NULL,NULL,-40),
 ('rv-l016','fam-a','r-l016',1,'DRAFT','휴대폰/태블릿/학습기기/모니터 파손','{"violation":"device damage"}','{"frequency_is_not_annual_limit":true,"l015_exclusivity":"proposed_not_approved"}','EVENT',NULL,NULL,NULL,-200);

-- 각 26개 규칙 버전은 해당 하위 규정의 같은 가족 버전에 정확히 연결한다.
INSERT INTO rule_governing_versions(rule_governing_version_id,family_id,rule_version_id,regulation_version_id)
SELECT 'gov-'||rv.rule_version_id,'fam-a',rv.rule_version_id,
       CASE ri.kind WHEN 'TASK' THEN 'regv-task-06' WHEN 'QUEST' THEN 'regv-quest-06' WHEN 'LIFESTYLE' THEN 'regv-life-06' END
FROM rule_versions rv JOIN rule_identities ri ON (ri.rule_id,ri.family_id)=(rv.rule_id,rv.family_id)
WHERE rv.family_id='fam-a';

-- condition_spec은 원문 JSON을 보존하고, effect가 참조할 condition_code는 별도 정규화한다.
INSERT INTO rule_conditions(rule_condition_id,family_id,rule_version_id,condition_code,source_predicate) VALUES
 ('cond-rv-q001-pass','fam-a','rv-q001','PASS',jsonb_build_object('condition_code','PASS','source_spec',(SELECT condition_spec FROM rule_versions WHERE family_id='fam-a' AND rule_version_id='rv-q001'))),
 ('cond-rv-q002-complete','fam-a','rv-q002','COMPLETE',jsonb_build_object('condition_code','COMPLETE','source_spec',(SELECT condition_spec FROM rule_versions WHERE family_id='fam-a' AND rule_version_id='rv-q002'))),
 ('cond-rv-q003-tier-1','fam-a','rv-q003','TIER_1',jsonb_build_object('condition_code','TIER_1','source_spec',(SELECT condition_spec FROM rule_versions WHERE family_id='fam-a' AND rule_version_id='rv-q003'))),
 ('cond-rv-q003-tier-2','fam-a','rv-q003','TIER_2',jsonb_build_object('condition_code','TIER_2','source_spec',(SELECT condition_spec FROM rule_versions WHERE family_id='fam-a' AND rule_version_id='rv-q003'))),
 ('cond-rv-q003-tier-3','fam-a','rv-q003','TIER_3',jsonb_build_object('condition_code','TIER_3','source_spec',(SELECT condition_spec FROM rule_versions WHERE family_id='fam-a' AND rule_version_id='rv-q003'))),
 ('cond-rv-t001-pass','fam-a','rv-t001','PASS',jsonb_build_object('condition_code','PASS','source_spec',(SELECT condition_spec FROM rule_versions WHERE family_id='fam-a' AND rule_version_id='rv-t001'))),
 ('cond-rv-t002-pass','fam-a','rv-t002','PASS',jsonb_build_object('condition_code','PASS','source_spec',(SELECT condition_spec FROM rule_versions WHERE family_id='fam-a' AND rule_version_id='rv-t002'))),
 ('cond-rv-t003-pass','fam-a','rv-t003','PASS',jsonb_build_object('condition_code','PASS','source_spec',(SELECT condition_spec FROM rule_versions WHERE family_id='fam-a' AND rule_version_id='rv-t003'))),
 ('cond-rv-t004-pass','fam-a','rv-t004','PASS',jsonb_build_object('condition_code','PASS','source_spec',(SELECT condition_spec FROM rule_versions WHERE family_id='fam-a' AND rule_version_id='rv-t004'))),
 ('cond-rv-t005-pass','fam-a','rv-t005','PASS',jsonb_build_object('condition_code','PASS','source_spec',(SELECT condition_spec FROM rule_versions WHERE family_id='fam-a' AND rule_version_id='rv-t005'))),
 ('cond-rv-t006-pass','fam-a','rv-t006','PASS',jsonb_build_object('condition_code','PASS','source_spec',(SELECT condition_spec FROM rule_versions WHERE family_id='fam-a' AND rule_version_id='rv-t006'))),
 ('cond-rv-t007-target-total-5-to-7','fam-a','rv-t007','TARGET_TOTAL_5_TO_7',jsonb_build_object('condition_code','TARGET_TOTAL_5_TO_7','source_spec',(SELECT condition_spec FROM rule_versions WHERE family_id='fam-a' AND rule_version_id='rv-t007'))),
 ('cond-rv-t007-target-total-8-plus','fam-a','rv-t007','TARGET_TOTAL_8_PLUS',jsonb_build_object('condition_code','TARGET_TOTAL_8_PLUS','source_spec',(SELECT condition_spec FROM rule_versions WHERE family_id='fam-a' AND rule_version_id='rv-t007'))),
 ('cond-rv-l001-pass','fam-a','rv-l001','PASS',jsonb_build_object('condition_code','PASS','source_spec',(SELECT condition_spec FROM rule_versions WHERE family_id='fam-a' AND rule_version_id='rv-l001'))),
 ('cond-rv-l001-optional-none-selected','fam-a','rv-l001','OPTIONAL_NONE_SELECTED',jsonb_build_object('condition_code','OPTIONAL_NONE_SELECTED','source_spec',(SELECT condition_spec FROM rule_versions WHERE family_id='fam-a' AND rule_version_id='rv-l001'))),
 ('cond-rv-l002-pass','fam-a','rv-l002','PASS',jsonb_build_object('condition_code','PASS','source_spec',(SELECT condition_spec FROM rule_versions WHERE family_id='fam-a' AND rule_version_id='rv-l002'))),
 ('cond-rv-l003-pass','fam-a','rv-l003','PASS',jsonb_build_object('condition_code','PASS','source_spec',(SELECT condition_spec FROM rule_versions WHERE family_id='fam-a' AND rule_version_id='rv-l003'))),
 ('cond-rv-l004-pass','fam-a','rv-l004','PASS',jsonb_build_object('condition_code','PASS','source_spec',(SELECT condition_spec FROM rule_versions WHERE family_id='fam-a' AND rule_version_id='rv-l004'))),
 ('cond-rv-l005-pass','fam-a','rv-l005','PASS',jsonb_build_object('condition_code','PASS','source_spec',(SELECT condition_spec FROM rule_versions WHERE family_id='fam-a' AND rule_version_id='rv-l005'))),
 ('cond-rv-l006-pass','fam-a','rv-l006','PASS',jsonb_build_object('condition_code','PASS','source_spec',(SELECT condition_spec FROM rule_versions WHERE family_id='fam-a' AND rule_version_id='rv-l006'))),
 ('cond-rv-l007-pass','fam-a','rv-l007','PASS',jsonb_build_object('condition_code','PASS','source_spec',(SELECT condition_spec FROM rule_versions WHERE family_id='fam-a' AND rule_version_id='rv-l007')));

INSERT INTO rule_effects(rule_effect_id,family_id,rule_version_id,ordinal,effect,asset_version_id,quantity,unit,condition_code) VALUES
 ('eff-q001-media','fam-a','rv-q001',1,'REWARD','assetv-media-1',300,'MINUTES','PASS'),('eff-q001-cash','fam-a','rv-q001',2,'REWARD','assetv-cash-1',50000,'CASH_KRW','PASS'),
 ('eff-q002-coupay','fam-a','rv-q002',1,'REWARD','assetv-coupay-1',20000,'COUPAY_KRW','COMPLETE'),
 ('eff-q003-600','fam-a','rv-q003',1,'REWARD','assetv-media-1',600,'MINUTES','TIER_1'),('eff-q003-480','fam-a','rv-q003',1,'REWARD','assetv-media-1',480,'MINUTES','TIER_2'),('eff-q003-360','fam-a','rv-q003',1,'REWARD','assetv-media-1',360,'MINUTES','TIER_3'),
 ('eff-t001','fam-a','rv-t001',1,'REWARD','assetv-media-1',40,'MINUTES','PASS'),('eff-t002','fam-a','rv-t002',1,'REWARD','assetv-media-1',40,'MINUTES','PASS'),
 ('eff-t003-unspecified','fam-a','rv-t003',1,'REWARD','assetv-media-1',NULL,'MINUTES','PASS'),('eff-t004','fam-a','rv-t004',1,'REWARD','assetv-media-1',60,'MINUTES','PASS'),('eff-t005','fam-a','rv-t005',1,'REWARD','assetv-media-1',60,'MINUTES','PASS'),('eff-t006','fam-a','rv-t006',1,'REWARD','assetv-media-1',240,'MINUTES','PASS'),
 ('eff-t007-base','fam-a','rv-t007',1,'REWARD','assetv-coupay-1',10000,'COUPAY_KRW','TARGET_TOTAL_5_TO_7'),('eff-t007-top','fam-a','rv-t007',1,'REWARD','assetv-coupay-1',15000,'COUPAY_KRW','TARGET_TOTAL_8_PLUS'),
 ('eff-l001','fam-a','rv-l001',1,'REWARD','assetv-media-1',15,'MINUTES','PASS'),('eff-l001-opt','fam-a','rv-l001',2,'STICKER',NULL,NULL,NULL,'OPTIONAL_NONE_SELECTED'),
 ('eff-l002','fam-a','rv-l002',1,'REWARD','assetv-media-1',15,'MINUTES','PASS'),('eff-l003','fam-a','rv-l003',1,'REWARD','assetv-media-1',15,'MINUTES','PASS'),('eff-l004','fam-a','rv-l004',1,'REWARD','assetv-media-1',15,'MINUTES','PASS'),('eff-l005','fam-a','rv-l005',1,'REWARD','assetv-media-1',15,'MINUTES','PASS'),('eff-l006','fam-a','rv-l006',1,'REWARD','assetv-media-1',30,'MINUTES','PASS'),('eff-l007','fam-a','rv-l007',1,'REWARD','assetv-media-1',30,'MINUTES','PASS');

INSERT INTO stable_rule_scopes(stable_scope_id,family_id,stable_scope_code,period,description) VALUES
 ('scope-l001','fam-a','l001-cat-litter','DAILY','family-child daily cap; does not reset by plan/rule version'),
 ('scope-school','fam-a','school-weekly-stickers','WEEKLY','school T-007 only; plan/version excluded from period identity');
INSERT INTO sticker_types(sticker_type_id,family_id,code,display_name) VALUES ('st-school','fam-a','SCHOOL','학교 스티커');
INSERT INTO monthly_plans(plan_id,family_id,operating_month,plan_version_no,timezone,status) VALUES ('plan-2026-10','fam-a','2026-10-01',1,'Asia/Seoul','DRAFT'),('plan-2026-11','fam-a','2026-11-01',1,'Asia/Seoul','DRAFT');
INSERT INTO plan_governing_versions(plan_id,family_id,regulation_version_id) SELECT p.plan_id,'fam-a',r.regulation_version_id FROM monthly_plans p CROSS JOIN regulation_versions r WHERE p.family_id='fam-a' AND r.family_id='fam-a';
INSERT INTO plan_rule_adoptions(adoption_id,family_id,plan_id,child_id,rule_version_id,applies_from,applies_to,adoption_status)
SELECT 'adopt-10-'||rv.rule_version_id,'fam-a','plan-2026-10','child-a',rv.rule_version_id,'2026-10-01'::date,'2026-10-31'::date,'DRAFT'::plan_status FROM rule_versions rv WHERE rv.family_id='fam-a'
UNION ALL SELECT 'adopt-11-l001','fam-a','plan-2026-11','child-a','rv-l001','2026-11-01'::date,'2026-11-30'::date,'DRAFT'::plan_status;
INSERT INTO recurrence_templates(recurrence_template_id,family_id,adoption_id,anchor_date,interval_days,weekday_iso,exceptions,status) VALUES
 ('tmpl-t006','fam-a','adopt-10-rv-t006',NULL,NULL,6,'[]','DRAFT');

-- Explicit eligible school occurrences for the test-only illustrative Monday boundary 2026-10-19..25.
-- This is NOT a user-approved weekly boundary. The fourth day is intentionally unconfirmed first.
INSERT INTO scheduled_occurrences(occurrence_id,family_id,child_id,adoption_id,rule_version_id,stable_scope_code,scheduled_for,state) VALUES
 ('occ-school-19','fam-a','child-a','adopt-10-rv-t007','rv-t007','school-weekly-stickers','2026-10-19 08:00+09','COMPLETED'),
 ('occ-school-20','fam-a','child-a','adopt-10-rv-t007','rv-t007','school-weekly-stickers','2026-10-20 08:00+09','COMPLETED'),
 ('occ-school-21','fam-a','child-a','adopt-10-rv-t007','rv-t007','school-weekly-stickers','2026-10-21 08:00+09','COMPLETED'),
 ('occ-school-22','fam-a','child-a','adopt-10-rv-t007','rv-t007','school-weekly-stickers','2026-10-22 08:00+09','COMPLETED');
