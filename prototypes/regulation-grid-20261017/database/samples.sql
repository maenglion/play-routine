-- Play Routine 격리 prototype의 실제 실행 가능 샘플이다. 운영 DB migration이 아니다.
-- 전제: 신뢰된 API gateway/server가 JWT의 signature, issuer, audience를 먼저 검증한다.
BEGIN;
SET LOCAL search_path = pr_design, pg_catalog;
-- true는 BEGIN/COMMIT 범위의 transaction-local 설정이다. 독립 SET LOCAL은 다음 statement에 남지 않는다.
SELECT set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', true);
-- DRAFT seed와 테스트 중간발행을 허용하는 것은 이 격리 fixture의 명시 GUC일 뿐, 클라이언트 bool은 권한이 아니다.
SELECT set_config('pr_design.test_mode', 'on', true);

-- 1) 부모 scoped 26규칙/버전 및 각각의 하위 규정 정본 bridge. 운영에서는 PUBLISHED만 RPC가 허용한다.
SELECT ri.permanent_number, ri.kind, rv.version_no, rv.status, gv.regulation_version_id AS governed_by,
       rg.code AS governing_document, rv.period, rv.pending_fields
FROM rule_identities ri
JOIN rule_versions rv ON (rv.rule_id,rv.family_id)=(ri.rule_id,ri.family_id)
JOIN rule_governing_versions rgv ON (rgv.rule_version_id,rgv.family_id)=(rv.rule_version_id,rv.family_id)
JOIN regulation_versions gv ON (gv.regulation_version_id,gv.family_id)=(rgv.regulation_version_id,rgv.family_id)
JOIN regulations rg ON (rg.regulation_id,rg.family_id)=(gv.regulation_id,gv.family_id)
WHERE ri.family_id='fam-a'
ORDER BY ri.permanent_number;

-- 2) JSON 원문 predicate와 effect가 참조하는 정규화 condition_code는 분리 보존된다.
SELECT rc.rule_version_id, rc.condition_code, rc.source_predicate, re.effect, re.ordinal, re.quantity, re.unit
FROM rule_conditions rc
LEFT JOIN rule_effects re ON (re.family_id,re.rule_version_id,re.condition_code)=(rc.family_id,rc.rule_version_id,rc.condition_code)
WHERE rc.family_id='fam-a'
ORDER BY rc.rule_version_id,rc.condition_code,re.ordinal;

-- 3) 원 seed의 모든 Lifestyle 자동조건을 평가한다고 주장하지 않는다.
-- 이 transaction 안에서만 단일 PRIMARY fixture 규칙/조건/효과/scope를 만들고 rollback한다.
INSERT INTO rule_versions(rule_version_id,family_id,rule_id,version_no,status,source_text,condition_spec,pending_fields,period,recognition_limit,positive_minutes)
VALUES ('rv-l002-sample','fam-a','r-l002',2,'DRAFT','samples.sql only: one PRIMARY condition','{"action":"put clothes away"}','{"test_only":true}','DAILY',1,15);
INSERT INTO rule_governing_versions(rule_governing_version_id,family_id,rule_version_id,regulation_version_id)
VALUES ('gov-rv-l002-sample','fam-a','rv-l002-sample','regv-life-06');
INSERT INTO rule_conditions(rule_condition_id,family_id,rule_version_id,condition_code,source_predicate)
VALUES ('cond-rv-l002-sample-primary','fam-a','rv-l002-sample','PRIMARY','{"action":"put clothes away"}');
INSERT INTO rule_effects(rule_effect_id,family_id,rule_version_id,ordinal,effect,asset_version_id,quantity,unit,condition_code)
VALUES ('eff-rv-l002-sample-primary','fam-a','rv-l002-sample',1,'REWARD','assetv-media-1',15,'MINUTES','PRIMARY');
INSERT INTO stable_rule_scopes(stable_scope_id,family_id,stable_scope_code,period,description)
VALUES ('scope-l002-sample','fam-a','l002-clothes','DAILY','samples.sql transaction-only single-condition scope');
SELECT recognize_lifestyle_event(
 'fam-a','child-a','rv-l002-sample','2026-10-17 10:00+09','sample-l002-001',
 '{"action":"put-clothes-away","evidence":"parent-observed"}'::jsonb
) AS lifestyle_result;
SELECT b.business_date,b.limit_count,b.used_count,r.outcome,r.applied_minutes
FROM recognition_limit_buckets b
JOIN lifestyle_recognition_results r ON (r.bucket_id,r.family_id)=(b.bucket_id,b.family_id)
WHERE b.family_id='fam-a' AND b.child_id='child-a' AND b.stable_scope_id='scope-l002-sample';

-- 4) 정의된 음수 Lifestyle인 L-013만 부모 사유와 함께 penalty fact로 남긴다. 자동 차감/원장정산은 하지 않는다.
SELECT approve_penalty_event(
 'fam-a','child-a','rv-l013','2026-10-17 19:31+09','sample-l013-001',
 '{"direct_question":true,"not_taken_by":"19:30"}'::jsonb,
 '부모가 아이에게 직접 물어 19:30 미복용을 확인'
) AS penalty_event_id;

-- 5) 학교 범위는 [starts_on, ends_on): 2026-10-19부터 25일까지를 SQL end=26으로 전달한다.
SELECT o.occurrence_id,(o.scheduled_for AT TIME ZONE 'Asia/Seoul')::date AS business_date,o.state,a.feedback,a.basic_sticker_count
FROM scheduled_occurrences o
LEFT JOIN school_day_assessments a ON (a.occurrence_id,a.family_id)=(o.occurrence_id,o.family_id)
WHERE o.family_id='fam-a' AND o.child_id='child-a' AND o.stable_scope_code='school-weekly-stickers'
  AND (o.scheduled_for AT TIME ZONE 'Asia/Seoul')::date >= DATE '2026-10-19'
  AND (o.scheduled_for AT TIME ZONE 'Asia/Seoul')::date < DATE '2026-10-26'
ORDER BY business_date;

-- 현재 seed에는 19~22가 미확정이라 final 호출은 반드시 거절된다. 예외를 잡아 samples.sql 전체 실행을 보장한다.
DO $$ BEGIN
  PERFORM settle_school_period('fam-a','child-a','school-weekly-stickers',DATE '2026-10-19',DATE '2026-10-26','Asia/Seoul',true,false,NULL);
  RAISE EXCEPTION 'expected final school settlement rejection did not occur';
EXCEPTION WHEN others THEN
  IF SQLERRM NOT LIKE 'cannot final-close:%unresolved' THEN RAISE; END IF;
END $$;

-- placeholder는 실행 SQL이 아니라 주석 선택문으로만 제공한다. 실제 운영 이행은 canonical aggregation_period_id를 조회해 인자로 전달한다.
-- SELECT execute_school_outstanding('fam-a', '<canonical-aggregation-period-id>', 'fulfillment-request-001', 'external receipt/reference');
SELECT ap.aggregation_period_id,ap.starts_on,ap.ends_on,ap.final_closed,ap.review_required,
       school_execution_outstanding('fam-a',ap.aggregation_period_id) AS fulfillment_outstanding
FROM aggregation_periods ap
WHERE ap.family_id='fam-a' AND ap.child_id='child-a' AND ap.stable_scope_id='scope-school'
ORDER BY ap.starts_on;

-- 샘플은 fixture에 영구 사실/권리/이행을 남기지 않는다.
ROLLBACK;
