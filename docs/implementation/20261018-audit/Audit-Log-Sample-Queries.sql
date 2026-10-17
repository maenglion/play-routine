-- 감사 시스템 설치 후 SQL Editor 관리자용 읽기 전용 예시.
-- 실제 가족·자녀 ID는 출력할 때 마스킹한다. 외부 공개 파일에 원시 감사행을 넣지 않는다.

-- 1. 트리거 설치 상태: 예상 16개, 모두 활성(O).
select n.nspname as table_schema, c.relname as table_name, t.tgenabled
from pg_catalog.pg_trigger t
join pg_catalog.pg_class c on c.oid=t.tgrelid
join pg_catalog.pg_namespace n on n.oid=c.relnamespace
where t.tgname='play_audit_row_change' and not t.tgisinternal
order by n.nspname, c.relname;

-- 2. 최근 변경: 업무 값과 개인정보 원문을 불필요하게 펼치지 않는다.
select audit_id, table_name, operation, occurred_at,
       actor_kind, changed_columns, transaction_id
from play_audit.events
order by audit_id desc limit 50;

-- 3. 특정 기간의 테이블별 변경 수(UTC 저장 시각을 한국 시각으로 표시).
select table_name, operation, count(*) as changes
from play_audit.events
where occurred_at >= statement_timestamp() - interval '7 days'
group by table_name, operation
order by table_name, operation;

-- 4. 감사 사본 지문 검사. 허용된 JSON 자체의 일관성만 검사한다.
-- 관리자 전체 변조나 원래 숨긴 payload 진위를 검증하는 쿼리가 아니다.
select count(*) as inconsistent_snapshot_fingerprints
from play_audit.events e
where (e.old_values is not null and e.old_fingerprint is distinct from
       encode(sha256(convert_to(e.old_values::text,'UTF8')),'hex'))
   or (e.new_values is not null and e.new_fingerprint is distinct from
       encode(sha256(convert_to(e.new_values::text,'UTF8')),'hex'));

-- 5. 주요 상태 변경만 확인.
select audit_id, table_name, operation,
       old_values->>'status' as prior_status,
       new_values->>'status' as next_status,
       occurred_at at time zone 'Asia/Seoul' as korean_time
from play_audit.events
where 'status'=any(changed_columns)
order by audit_id desc limit 50;

-- 부모 세션에서는 관리자 SELECT 대신 다음 RPC 사용.
-- SQL Editor의 postgres 역할은 로그인 부모 JWT가 아니므로 위조해서 호출하지 않는다.
-- 앱 예:
-- const {data,error}=await supabase.rpc('list_family_audit_events', {
--   p_family_id: activeFamilyId, p_before_audit_id: null, p_limit: 50
-- });
-- 다음 과거 페이지는 마지막 행의 audit_id를 p_before_audit_id로 전달.
-- 감사 완전성 점검에는 단방향 커서만 사용하지 말고 최근 기간을 재대조한다.
