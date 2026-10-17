-- Play Routine 관계형 모델 v0.1 / 2026-10-16
-- 설계 검증용 DDL: 운영 migration 아님. pr_model 스키마에만 생성.
-- 4개 앵커는 기존 public 테이블의 축약 모형. 운영에서는 재생성하지 않고 기존 FK를 연결.
-- 게시/권한/한도 예약/판정/정산 RPC는 본 파일에 구현하지 않았으며 아래 문서 계약을 따라야 함.
BEGIN;
CREATE SCHEMA pr_model;
REVOKE ALL ON SCHEMA pr_model FROM PUBLIC;

-- 가족 앵커 / public.families의 기존 UUID를 유지하는 설계용 축약 앵커. 실제 인증 테이블을 새로 만들지 않음.
CREATE TABLE pr_model.families (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  timezone text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
 );

-- 사용자 앵커 / public.principals 재사용. 이메일·비밀번호·토큰은 모델에 복제하지 않음.
CREATE TABLE pr_model.principals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid UNIQUE,
  recorded_at timestamptz NOT NULL DEFAULT now()
 );

-- 자녀 앵커 / public.child_profiles의 UUID와 가족 소속을 재사용.
CREATE TABLE pr_model.child_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  principal_id uuid,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT
 );

-- 활동 정본 앵커 / public.ref_concepts 재사용. 고양이 화장실 등은 이름 붙인 인스턴스이며 고정 종류 테이블이 아님.
CREATE TABLE pr_model.ref_concepts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  name text NOT NULL,
  category_code text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT
 );

-- 자산·이행 단위 / 분/원/서비스별 포인트/소원 구분. 쿠페이 포인트와 다른 포인트는 다른 ID. 내부 원장과 외부 지급 중 하나의 경로만 선택.
CREATE TABLE pr_model.asset_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  code text NOT NULL,
  unit text NOT NULL,
  provider_code text NOT NULL,
  route text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,code),
  CHECK (unit IN ('MIN','WON','POINT','COUNT','WISH')),
  CHECK (route IN ('INTERNAL_LEDGER','EXTERNAL_FULFILLMENT')),
  CHECK (unit <> 'WISH' OR route='EXTERNAL_FULFILLMENT')
 );

-- 강화물·패널티 종류 / 같은 카탈로그 구조, 결과 방향 분리. 현재 허용 패널티는 MIN 차감. 돈 차감 등 미승인 확장은 게시 검증에서 거절.
CREATE TABLE pr_model.effect_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  direction text NOT NULL,
  asset_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,code),
  UNIQUE (family_id,id,direction,asset_id),
  CHECK (direction IN ('REWARD','PENALTY'))
 );

-- 스티커·표식 종류 / 종류 ID와 그림을 분리. STAR 그림이 같은 여러 종류라도 합산 대상을 명시해야 함. 패널티 표식 자체는 차감이 아님.
CREATE TABLE pr_model.sticker_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  direction text NOT NULL,
  icon_code text NOT NULL,
  image_url text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,code),
  CHECK (direction IN ('POSITIVE','INCIDENT_MARK'))
 );

-- 동일 활동 연결 / 밀크티/밀크티 학습지를 이름으로 자동 합치지 않고 부모 승인으로 연결. 별칭 순환 금지 RPC 검증.
CREATE TABLE pr_model.activity_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  alias_ref_id uuid NOT NULL,
  canonical_ref_id uuid NOT NULL,
  approved_by uuid NOT NULL,
  reason text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,alias_ref_id),
  CHECK (alias_ref_id <> canonical_ref_id)
 );

-- 규칙 안정 계보 / 게시 버전이 바뀌어도 계보 ID 유지. 회차의 PERFORMANCE/INCIDENT가 사실 방향이며 DAILY/QUEST와 별개.
CREATE TABLE pr_model.rule_series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  activity_id uuid NOT NULL,
  stable_key uuid NOT NULL,
  flow text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,stable_key),
  CHECK (flow IN ('DAILY','QUEST'))
 );

-- 기간 경계 정책 / 행은 불변. 기록 단위·집계 기간·한도 기간·정산 실행을 한 period 열로 섞지 않음.
CREATE TABLE pr_model.period_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  code text NOT NULL,
  kind text NOT NULL,
  timezone text NOT NULL,
  week_start smallint,
  anchor_on date,
  custom_days integer,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,code),
  CHECK (kind IN ('OCCURRENCE','DAY','WEEK','CALENDAR_MONTH','CUSTOM_DAYS','EVENT')),
  CHECK (week_start IS NULL OR week_start BETWEEN 1 AND 7),
  CHECK ((kind='WEEK')=(week_start IS NOT NULL)),
  CHECK ((kind='CUSTOM_DAYS')=(anchor_on IS NOT NULL AND custom_days IS NOT NULL)),
  CHECK (custom_days IS NULL OR custom_days>0)
 );

-- 특별 이벤트 범위 / 기간은 [start,end). 특별 이벤트는 문자열 메모가 아니라 범위 ID.
CREATE TABLE pr_model.special_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  name text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  timezone text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  CHECK (ends_at>starts_at)
 );

-- 불변 게시 버전 / 수정 대신 새 버전. 이전 버전은 같은 계보라는 강화 FK 적용. 미승인 숫자·기준 충돌은 게시 차단.
CREATE TABLE pr_model.rule_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  series_id uuid NOT NULL,
  version_no integer NOT NULL,
  effective_from date NOT NULL,
  previous_version_id uuid,
  published_by uuid NOT NULL,
  criteria text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  engine_version text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,series_id,version_no),
  UNIQUE (family_id,id,series_id),
  CHECK (version_no>0),
  CHECK (schema_version>0)
 );

-- 측정 정의 / 정답 수, 총문제 수, 소요 초, 점수, 백분율 등 복수 측정. PERCENT는 게시 시 0~100; 수량에는 그 범위를 강제하지 않음.
CREATE TABLE pr_model.metric_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  rule_version_id uuid NOT NULL,
  code text NOT NULL,
  value_kind text NOT NULL,
  unit_code text NOT NULL,
  min_value numeric,
  max_value numeric,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,rule_version_id,code),
  UNIQUE (family_id,id,rule_version_id),
  CHECK (value_kind IN ('NUMBER','BOOLEAN','LOCAL_TIME','INSTANT')),
  CHECK (min_value IS NULL OR max_value IS NULL OR min_value<=max_value)
 );

-- 집계·한도 대상 묶음 / 행과 구성원은 게시 후 불변. 활동/규칙/스티커를 합칠 범위를 명시하며 규칙 버전이 아니라 안정 계보로 연결.
CREATE TABLE pr_model.scope_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  name text NOT NULL,
  version_no integer NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  CHECK (version_no>0)
 );

-- 묶음 구성원 / 세 종류 중 정확히 하나를 참조. AND 합성 대상은 별도 묶음 정의/RPC 검증. 같은 사건이 두 구성원에 맞아도 DISTINCT 출처로 한 번 계산.
CREATE TABLE pr_model.scope_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  activity_id uuid,
  series_id uuid,
  sticker_type_id uuid,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  CHECK (num_nonnulls(activity_id,series_id,sticker_type_id)=1)
 );

-- 누적·비율 집계 정의 / 백분율의 분모·면제·미확인 건수를 함께 기록. 버전 연결은 부모 승인 시에만 명시적으로 허용.
CREATE TABLE pr_model.aggregation_specs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  period_policy_id uuid NOT NULL,
  special_event_id uuid,
  operation text NOT NULL,
  input_metric_code text,
  source_kind text NOT NULL,
  denominator_mode text,
  allow_version_bridge boolean NOT NULL DEFAULT false,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  CHECK (operation IN ('COUNT','SUM','PERCENT','STREAK')),
  CHECK (source_kind IN ('VERIFIED_VALUE','STICKER_EVENT','VERIFIED_OCCURRENCE')),
  CHECK ((operation='PERCENT')=(denominator_mode IS NOT NULL)),
  CHECK (denominator_mode IS NULL OR denominator_mode IN ('CONFIRMED_ELIGIBLE','SCHEDULED_ELIGIBLE'))
 );

-- 기본·추가·중립·차감 조건 / 5개와8개는 CUMULATIVE 기본+추가. +/0/- 같은 수치축은 EXCLUSIVE 그룹. 서로 다른 축의 합산 여부는 부모 승인 정책.
CREATE TABLE pr_model.conditions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  rule_version_id uuid NOT NULL,
  stable_key uuid NOT NULL,
  label text NOT NULL,
  direction text NOT NULL,
  mode text NOT NULL,
  aggregation_id uuid,
  conflict_group text,
  match_policy text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,rule_version_id,stable_key),
  UNIQUE (family_id,id,rule_version_id),
  UNIQUE (family_id,id,direction),
  CHECK (direction IN ('REWARD','NEUTRAL','PENALTY')),
  CHECK (mode IN ('PER_OCCURRENCE','PER_PERIOD')),
  CHECK ((mode='PER_PERIOD')=(aggregation_id IS NOT NULL)),
  CHECK (match_policy IN ('CUMULATIVE','EXCLUSIVE'))
 );

-- 조건 OR 그룹 / 그룹끼리 OR, 그룹 안 원자 조건은 AND. 조건 트리 무한 범용 JSON 대신 이 정규형 사용.
CREATE TABLE pr_model.predicate_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  condition_id uuid NOT NULL,
  rule_version_id uuid NOT NULL,
  group_no integer NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,condition_id,group_no),
  UNIQUE (family_id,id,rule_version_id),
  CHECK (group_no>0)
 );

-- 측정 비교 원자 / 예: correct_count≥15 AND elapsed_seconds≤180.그룹·측정은 같은 게시 버전 FK. 자료형·단위·참조 집계 일치는 게시 검증.
CREATE TABLE pr_model.predicates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  group_id uuid NOT NULL,
  rule_version_id uuid NOT NULL,
  metric_id uuid,
  aggregate_result boolean NOT NULL DEFAULT false,
  operator text NOT NULL,
  rhs_number numeric,
  rhs_boolean boolean,
  rhs_time time,
  rhs_instant timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  CHECK (operator IN ('EQ','NE','GT','GTE','LT','LTE')),
  CHECK (num_nonnulls(rhs_number,rhs_boolean,rhs_time,rhs_instant)=1),
  CHECK ((aggregate_result AND metric_id IS NULL) OR (NOT aggregate_result AND metric_id IS NOT NULL))
 );

-- 조건별 효과 항목 / REWARD는1~2개, 두 번째 선택. PENALTY는 당장1개만 허용하는 게시 검증. 값은 양수, 방향 별도. 소원은 text, 수치 자산은amount.
CREATE TABLE pr_model.condition_effects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  condition_id uuid NOT NULL,
  stable_key uuid NOT NULL,
  position smallint NOT NULL,
  effect_type_id uuid NOT NULL,
  direction text NOT NULL,
  asset_id uuid NOT NULL,
  amount numeric,
  text_value text,
  name_snapshot text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,condition_id,position),
  UNIQUE (family_id,condition_id,stable_key),
  UNIQUE (family_id,id,asset_id),
  CHECK (direction IN ('REWARD','PENALTY')),
  CHECK (position BETWEEN 1 AND 2),
  CHECK (num_nonnulls(amount,text_value)=1),
  CHECK (amount IS NULL OR amount>0),
  CHECK (text_value IS NULL OR length(btrim(text_value))>0),
  CHECK (amount IS NULL OR (amount=trunc(amount) AND abs(amount)<=1000000000000000000))
 );

-- 한도 안정 계보 / 규칙 버전이 바뀌었다고 하루 횟수·주 상한을 리셋하지 않는 안정 키.
CREATE TABLE pr_model.limit_policy_series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  stable_key uuid NOT NULL,
  name text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,stable_key)
 );

-- 인정 횟수·총량 정책 버전 / 한도 없으면 정책 없음; 초안 미설정은 따로 게시 완전성 검증. 한도판정 순서·부분허용은 필수. COUNT는 조건 달성1회, 효과2개여도1회.
CREATE TABLE pr_model.limit_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  policy_series_id uuid NOT NULL,
  version_no integer NOT NULL,
  scope_id uuid NOT NULL,
  period_policy_id uuid NOT NULL,
  direction text NOT NULL,
  limit_kind text NOT NULL,
  asset_id uuid,
  max_value numeric NOT NULL,
  allocation_mode text NOT NULL,
  effective_from date NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,policy_series_id,version_no),
  UNIQUE (family_id,id,policy_series_id),
  CHECK (direction IN ('REWARD','PENALTY')),
  CHECK (limit_kind IN ('COUNT','AMOUNT')),
  CHECK ((limit_kind='AMOUNT')=(asset_id IS NOT NULL)),
  CHECK (max_value>=0),
  CHECK (allocation_mode IN ('WHOLE_CONDITION','PARTIAL_ASSET')),
  CHECK (version_no>0),
  CHECK (max_value IS NULL OR (max_value=trunc(max_value) AND abs(max_value)<=1000000000000000000))
 );

-- 조건에 붙는 한도 관계 / 조건 N:M 한도. 일별·주간·월간·묶음 전체 한도를 동시에 연결할 수 있음. 방향·scope·효력 일치는 게시 검증.
CREATE TABLE pr_model.condition_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  condition_id uuid NOT NULL,
  limit_policy_id uuid NOT NULL,
  priority integer NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,condition_id,limit_policy_id),
  CHECK (priority>0)
 );

-- 자녀 배정·기록 일정 / 예정 횟수는 지급 인정 횟수가 아님. ON_DEMAND는 발생/반복 입력. 같은 자녀·canonical활동의 유효 버전 선택은 RPC/중복 배정 가드.
CREATE TABLE pr_model.assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  child_id uuid NOT NULL,
  series_id uuid NOT NULL,
  rule_version_id uuid NOT NULL,
  recording_kind text NOT NULL,
  starts_on date NOT NULL,
  ends_on date,
  special_event_id uuid,
  expected_per_day integer,
  created_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,id,child_id,series_id),
  UNIQUE (family_id,id,child_id,series_id,rule_version_id),
  CHECK (recording_kind IN ('SCHEDULED','ON_DEMAND','ONCE')),
  CHECK (ends_on IS NULL OR ends_on>=starts_on),
  CHECK (expected_per_day IS NULL OR expected_per_day>0)
 );

-- 배정 요일 / 요일 배열 대신 관계행. ONCE·ON_DEMAND에 불필요한 요일은 게시/배정 RPC가 금지.
CREATE TABLE pr_model.assignment_weekdays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  weekday smallint NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,assignment_id,weekday),
  CHECK (weekday BETWEEN 1 AND 7)
 );

-- 실제 수행·발생 회차 / 하루1행 제한 제거. 사실은4회, 인정2회가 가능. 같은 회차 재전송은origin_key로 중복 차단. 날짜 정정은 새 사건/무효화 이력.
CREATE TABLE pr_model.occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  child_id uuid NOT NULL,
  series_id uuid NOT NULL,
  business_date date NOT NULL,
  sequence_no integer NOT NULL,
  occurred_at timestamptz,
  kind text NOT NULL,
  origin_key uuid NOT NULL,
  rule_version_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,assignment_id,business_date,sequence_no),
  UNIQUE (family_id,origin_key),
  UNIQUE (family_id,id,child_id),
  UNIQUE (family_id,id,rule_version_id),
  CHECK (sequence_no>0),
  CHECK (kind IN ('PERFORMANCE','INCIDENT'))
 );

-- 자녀·부모 원래 보고 / 원문 보고 JSON은 감사 근거; 계산 정본은 verified_values. 토큰·비밀번호·메일 인증 URL 저장 금지.
CREATE TABLE pr_model.observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  occurrence_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  actor_role text NOT NULL,
  payload jsonb NOT NULL,
  request_key uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,actor_id,request_key),
  CHECK (actor_role IN ('CHILD','PARENT'))
 );

-- 부모 확인 revision / 미확인은행없음(null),0아님. 부모 확인이 우선. EXEMPT는분모제외,VOID는잘못기록한사건 무효. 같은 회차 supersedes FK 적용.
CREATE TABLE pr_model.verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  occurrence_id uuid NOT NULL,
  rule_version_id uuid NOT NULL,
  revision_no integer NOT NULL,
  actor_id uuid NOT NULL,
  supersedes_id uuid,
  decision text NOT NULL,
  reason text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,occurrence_id,revision_no),
  UNIQUE (family_id,id,occurrence_id),
  UNIQUE (family_id,id,rule_version_id),
  CHECK (revision_no>0),
  CHECK (decision IN ('CONFIRMED','EXEMPT','VOID')),
  CHECK (length(btrim(reason))>0)
 );

-- 확정 측정값 / 소요 초와 정답 수를 별도행으로 보관. 같은버전 FK. 숫자 finite·단위·범위는검증 RPC.
CREATE TABLE pr_model.verified_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  verification_id uuid NOT NULL,
  rule_version_id uuid NOT NULL,
  metric_id uuid NOT NULL,
  number_value numeric,
  boolean_value boolean,
  time_value time,
  instant_value timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,verification_id,metric_id),
  CHECK (num_nonnulls(number_value,boolean_value,time_value,instant_value)=1)
 );

-- 종류별 스티커 증감 / PASS+칭찬의1/2개는현재게시값 보존. 새규칙에서종류별증감. 수정시원행상쇄; 패널티표식은차감원장과분리.
CREATE TABLE pr_model.sticker_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  child_id uuid NOT NULL,
  occurrence_id uuid NOT NULL,
  verification_id uuid NOT NULL,
  sticker_type_id uuid NOT NULL,
  delta integer NOT NULL,
  reason text NOT NULL,
  reversal_of_id uuid,
  dedupe_key text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,dedupe_key),
  CHECK (delta<>0)
 );

-- 판정 대상의 안정 키 / 기간은 날짜 [start,end). 같은주간 조건·아이콘 버전변경 시 자동새지급 아님. 월·이벤트 경계는 정책으로 고정.
CREATE TABLE pr_model.evaluation_subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  child_id uuid NOT NULL,
  series_id uuid NOT NULL,
  kind text NOT NULL,
  occurrence_id uuid,
  aggregation_id uuid,
  period_start date,
  period_end date,
  timezone_snapshot text NOT NULL,
  special_event_id uuid,
  origin_key text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,child_id,series_id,origin_key),
  CHECK ((kind='OCCURRENCE' AND occurrence_id IS NOT NULL AND aggregation_id IS NULL AND period_start IS NULL AND period_end IS NULL) OR (kind='PERIOD' AND occurrence_id IS NULL AND aggregation_id IS NOT NULL AND period_start IS NOT NULL AND period_end>period_start))
 );

-- 판정 실행 revision / 분모·미확인 건수 고정. PARTIAL은완료로보이지않음. 안전한기본안은미확인으로최종미달차감불가, 추가인정은revision.
CREATE TABLE pr_model.evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  rule_version_id uuid NOT NULL,
  revision_no integer NOT NULL,
  completeness text NOT NULL,
  eligible_count integer NOT NULL,
  confirmed_count integer NOT NULL,
  hold_count integer NOT NULL,
  excluded_count integer NOT NULL,
  engine_version text NOT NULL,
  input_digest text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,subject_id,revision_no),
  UNIQUE (family_id,id,rule_version_id),
  CHECK (revision_no>0),
  CHECK (completeness IN ('PARTIAL','FINAL','HOLD')),
  CHECK (eligible_count>=0 AND confirmed_count>=0 AND hold_count>=0 AND excluded_count>=0)
 );

-- 판정 근거 연결 / 어떤확인revision을합산/제외했는지설명. 최신값조회변경으로과거결과가바뀌지않음.
CREATE TABLE pr_model.evaluation_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  evaluation_id uuid NOT NULL,
  verification_id uuid NOT NULL,
  included boolean NOT NULL,
  exclusion_reason text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,evaluation_id,verification_id),
  CHECK (included OR exclusion_reason IS NOT NULL)
 );

-- 조건 판정 결과 / MATCH와한도인정은별개. NO_MATCH는패널티발생이아님. 이행후정정시REVIEW_REQUIRED 경로.
CREATE TABLE pr_model.condition_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  evaluation_id uuid NOT NULL,
  rule_version_id uuid NOT NULL,
  condition_id uuid NOT NULL,
  result text NOT NULL,
  measured_value numeric,
  reason text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,evaluation_id,condition_id),
  CHECK (result IN ('MATCH','NO_MATCH','HOLD','EXEMPT'))
 );

-- 기간별 한도 잠금 단위 / 버전아닌policy_series로기간중중복상한을막음. 기간내한도정책변경은새기간효력/명시재검토만허용. 행잠금직렬화.
CREATE TABLE pr_model.limit_buckets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  child_id uuid NOT NULL,
  limit_policy_id uuid NOT NULL,
  policy_series_id uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  special_event_id uuid,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,child_id,policy_series_id,period_start,period_end,special_event_id),
  CHECK (period_end>period_start)
 );

-- 조건 인정 결정 / 상한초과도결정행보존. condition_result마다한번. 재평가는기존순권리와차이만생성하는RPC필수.
CREATE TABLE pr_model.admissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  condition_result_id uuid NOT NULL,
  status text NOT NULL,
  reason text NOT NULL,
  supersedes_id uuid,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,condition_result_id),
  CHECK (status IN ('ADMITTED','LIMITED','HELD','REJECTED','REVIEW_REQUIRED'))
 );

-- 인정된 효과 배분 / 돈+시간 두효과 개별추적. 전부인정 또는자산별부분정책에따름.0은차단효과이며grant를만들지않음.
CREATE TABLE pr_model.admission_effects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  admission_id uuid NOT NULL,
  effect_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  allowed_amount numeric,
  allowed_text text,
  status text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,admission_id,effect_id),
  UNIQUE (family_id,id,asset_id),
  CHECK (status IN ('ALLOWED','BLOCKED','HELD')),
  CHECK (num_nonnulls(allowed_amount,allowed_text)=1),
  CHECK (allowed_amount IS NULL OR allowed_amount>=0),
  CHECK (allowed_amount IS NULL OR (allowed_amount=trunc(allowed_amount) AND abs(allowed_amount)<=1000000000000000000))
 );

-- 한도 소모·해제 원장 / SUM(delta)로순소모. 지급대기권리도상한예약; 실제이행까지기다리면초과발행됨. COUNT는효과2개여도1. 패널티거절시승인예약해제.
CREATE TABLE pr_model.quota_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  bucket_id uuid NOT NULL,
  admission_id uuid NOT NULL,
  delta numeric NOT NULL,
  phase text NOT NULL,
  reversal_of_id uuid,
  dedupe_key text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,dedupe_key),
  CHECK (delta<>0),
  CHECK (phase IN ('RESERVE','RELEASE','ADJUST')),
  CHECK (delta IS NULL OR (delta=trunc(delta) AND abs(delta)<=1000000000000000000))
 );

-- 특별보너스 출처 / 별도자유칭찬,규칙조건없음. 현manual_bonus_coupons/manual_money_rewards는bridge로연결하며이미지급된내역재발행금지.
CREATE TABLE pr_model.manual_awards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  child_id uuid NOT NULL,
  effect_type_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  amount numeric,
  text_value text,
  reason text NOT NULL,
  actor_id uuid NOT NULL,
  request_key uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,request_key),
  UNIQUE (family_id,id,child_id,asset_id),
  CHECK (num_nonnulls(amount,text_value)=1),
  CHECK (amount IS NULL OR amount>0),
  CHECK (amount IS NULL OR (amount=trunc(amount) AND abs(amount)<=1000000000000000000))
 );

-- 보상권·승인 차감 요청 / 양수량+방향. PANELTY도여기서승인상태이력,실제차감아님. 과거AVAILABLE를사용가능잔액으로변환하지않음.
CREATE TABLE pr_model.grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  child_id uuid NOT NULL,
  admission_effect_id uuid,
  manual_award_id uuid,
  asset_id uuid NOT NULL,
  direction text NOT NULL,
  amount numeric,
  text_value text,
  business_date date NOT NULL,
  dedupe_key text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,dedupe_key),
  UNIQUE (family_id,admission_effect_id),
  UNIQUE (family_id,manual_award_id),
  UNIQUE (family_id,id,asset_id),
  CHECK (num_nonnulls(admission_effect_id,manual_award_id)=1),
  CHECK (num_nonnulls(amount,text_value)=1),
  CHECK (amount IS NULL OR amount>0),
  CHECK (direction IN ('REWARD','PENALTY')),
  CHECK (manual_award_id IS NULL OR direction='REWARD'),
  CHECK (amount IS NULL OR (amount=trunc(amount) AND abs(amount)<=1000000000000000000))
 );

-- 권리 승인·검토 이력 / 사실 확인과차감승인은별도액션. 변경상태는이력을읽는projection; 원본이벤트불변.
CREATE TABLE pr_model.grant_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  kind text NOT NULL,
  reason text NOT NULL,
  request_key uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,request_key),
  CHECK (kind IN ('PROPOSED','APPROVED','REJECTED','CANCELED','REVIEW_REQUIRED','REVIEW_RESOLVED','POSTED','FULFILLED'))
 );

-- 정산 실행·cutoff / 자정확정분정산. [이전cutoff,이번cutoff)구간. cutoff후확인분다음실행. 재시작해도ledger dedupe유지.
CREATE TABLE pr_model.settlement_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  run_key text NOT NULL,
  cutoff_at timestamptz NOT NULL,
  effective_at timestamptz NOT NULL,
  engine_version text NOT NULL,
  status text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,run_key),
  CHECK (status IN ('STARTED','COMMITTED','FAILED')),
  CHECK (effective_at>=cutoff_at)
 );

-- 외부 돈·소원 이행 / 외부포인트충전/현금전달/소원이행기록이지자동송금아님. v0.1전액이행한번,분할이행은후속확장.
CREATE TABLE pr_model.fulfillments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  amount numeric,
  note text NOT NULL,
  dedupe_key text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,grant_id),
  UNIQUE (family_id,dedupe_key),
  CHECK (amount IS NULL OR amount>0),
  CHECK (amount IS NULL OR (amount=trunc(amount) AND abs(amount)<=1000000000000000000))
 );

-- 시간·포인트 사용 요청 / 사용승인·잔액검사는거래RPC. 패널티와사용은다른거래종류. 사용자카드잔액믿지않음.
CREATE TABLE pr_model.usage_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  child_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  request_key uuid NOT NULL,
  requested_for timestamptz NOT NULL,
  reason text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,request_key)
 );

-- 사용 자산별 양 / 사용한단위가시간인지특정포인트인지명확하게FK로참조.
CREATE TABLE pr_model.usage_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  usage_request_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  amount numeric NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,usage_request_id,asset_id),
  UNIQUE (family_id,id,asset_id),
  CHECK (amount>0),
  CHECK (amount IS NULL OR (amount=trunc(amount) AND abs(amount)<=1000000000000000000))
 );

-- 사용 가능한 자산 원장 / 원장수정/삭제금지. 전액상쇄한번; 새정정효과는새grant. 잔액=sum(효력도래delta). 외부이행route 자산은여기중복적립금지.
CREATE TABLE pr_model.ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  child_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  grant_id uuid,
  usage_item_id uuid,
  reversal_of_id uuid,
  settlement_run_id uuid,
  kind text NOT NULL,
  delta numeric NOT NULL,
  business_date date NOT NULL,
  effective_at timestamptz NOT NULL,
  reason text NOT NULL,
  dedupe_key text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,dedupe_key),
  UNIQUE (family_id,grant_id),
  UNIQUE (family_id,usage_item_id),
  UNIQUE (family_id,reversal_of_id),
  UNIQUE (family_id,id,child_id,asset_id),
  CHECK (delta<>0),
  CHECK (num_nonnulls(grant_id,usage_item_id,reversal_of_id)=1),
  CHECK ((kind='REWARD' AND grant_id IS NOT NULL AND delta>0) OR (kind='PENALTY' AND grant_id IS NOT NULL AND delta<0) OR (kind='USAGE' AND usage_item_id IS NOT NULL AND delta<0) OR (kind='REVERSAL' AND reversal_of_id IS NOT NULL)),
  CHECK (delta IS NULL OR (delta=trunc(delta) AND abs(delta)<=1000000000000000000))
 );

-- 미분류·판정 불명 잔차 / unknown은ref에넣지않음. 자동보상/패널티추정금지,자정에도hold를보존.
CREATE TABLE pr_model.residuals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  child_id uuid NOT NULL,
  occurrence_id uuid,
  business_date date NOT NULL,
  raw_payload jsonb NOT NULL,
  reason_code text NOT NULL,
  origin_key uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,origin_key)
 );

-- 잔차 분류 승인 / 기존정본에연결/새종류승인/무효과/유지. 승인다음날이후효력,이미쓴today불변. 소급보상은별도판정·상쇄경로.
CREATE TABLE pr_model.residual_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  residual_id uuid NOT NULL,
  revision_no integer NOT NULL,
  decision text NOT NULL,
  target_ref_id uuid,
  target_rule_version_id uuid,
  actor_id uuid NOT NULL,
  effective_from date NOT NULL,
  reason text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,residual_id,revision_no),
  CHECK (revision_no>0),
  CHECK (decision IN ('ATTACH_EXISTING','CREATE_APPROVED_KIND','NO_EFFECT','KEEP_HOLD')),
  CHECK ((decision IN ('ATTACH_EXISTING','CREATE_APPROVED_KIND') AND target_ref_id IS NOT NULL) OR (decision IN ('NO_EFFECT','KEEP_HOLD') AND target_ref_id IS NULL AND target_rule_version_id IS NULL))
 );

-- 일별 사진 머리 / 잔액계산정본아닌관측. 정정후기존사진보존,revision추가.
CREATE TABLE pr_model.daily_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  child_id uuid NOT NULL,
  business_date date NOT NULL,
  revision_no integer NOT NULL,
  observed_at timestamptz NOT NULL,
  hold_count integer NOT NULL,
  residual_count integer NOT NULL,
  pending_penalty_count integer NOT NULL,
  settlement_run_id uuid,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,child_id,business_date,revision_no),
  CHECK (revision_no>0),
  CHECK (hold_count>=0 AND residual_count>=0 AND pending_penalty_count>=0)
 );

-- 사진의 자산별 잔액 / 분/원/서비스포인트따로. 외부돈/소원은이행대기상태로표시,내부사용가능잔액과혼동금지.
CREATE TABLE pr_model.snapshot_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  available_amount numeric NOT NULL,
  pending_amount numeric NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,snapshot_id,asset_id),
  CHECK (available_amount IS NULL OR (available_amount=trunc(available_amount) AND abs(available_amount)<=1000000000000000000)),
  CHECK (pending_amount IS NULL OR (pending_amount=trunc(pending_amount) AND abs(pending_amount)<=1000000000000000000))
 );

-- 기존 행 연결·이행 경계 / 마이그레이션내부감사. target_kind/id는예외적다형참조로전환검증필수; 업무계산에이열만믿지않고각FK로정본조회. 구Sheets데이터이관없음.
CREATE TABLE pr_model.source_bridges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  source_system text NOT NULL,
  source_table text NOT NULL,
  source_id uuid NOT NULL,
  target_kind text NOT NULL,
  target_id uuid NOT NULL,
  already_fulfilled boolean NOT NULL,
  cutover_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,source_system,source_table,source_id,target_kind)
 );

-- RPC 멱등 요청 기록 / 같은키·다른payload거절. 응답저장에는민감인증값제외. transaction성공과같이commit.
CREATE TABLE pr_model.request_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  request_key uuid NOT NULL,
  action text NOT NULL,
  payload_hash text NOT NULL,
  response_payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id,id),
  FOREIGN KEY (family_id) REFERENCES pr_model.families(id) ON DELETE RESTRICT,
  UNIQUE (family_id,actor_id,request_key)
 );
ALTER TABLE pr_model.child_profiles ADD CONSTRAINT fk_1 FOREIGN KEY (principal_id) REFERENCES pr_model.principals(id) ON DELETE RESTRICT;
ALTER TABLE pr_model.effect_types ADD CONSTRAINT fk_2 FOREIGN KEY (family_id,asset_id) REFERENCES pr_model.asset_types(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.activity_aliases ADD CONSTRAINT fk_3 FOREIGN KEY (family_id,alias_ref_id) REFERENCES pr_model.ref_concepts(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.activity_aliases ADD CONSTRAINT fk_4 FOREIGN KEY (family_id,canonical_ref_id) REFERENCES pr_model.ref_concepts(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.activity_aliases ADD CONSTRAINT fk_5 FOREIGN KEY (approved_by) REFERENCES pr_model.principals(id) ON DELETE RESTRICT;
ALTER TABLE pr_model.rule_series ADD CONSTRAINT fk_6 FOREIGN KEY (family_id,activity_id) REFERENCES pr_model.ref_concepts(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.rule_versions ADD CONSTRAINT fk_7 FOREIGN KEY (family_id,series_id) REFERENCES pr_model.rule_series(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.rule_versions ADD CONSTRAINT fk_8 FOREIGN KEY (family_id,previous_version_id) REFERENCES pr_model.rule_versions(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.rule_versions ADD CONSTRAINT fk_9 FOREIGN KEY (published_by) REFERENCES pr_model.principals(id) ON DELETE RESTRICT;
ALTER TABLE pr_model.rule_versions ADD CONSTRAINT fk_10 FOREIGN KEY (family_id,previous_version_id,series_id) REFERENCES pr_model.rule_versions(family_id,id,series_id) ON DELETE RESTRICT;
ALTER TABLE pr_model.metric_definitions ADD CONSTRAINT fk_11 FOREIGN KEY (family_id,rule_version_id) REFERENCES pr_model.rule_versions(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.scope_members ADD CONSTRAINT fk_12 FOREIGN KEY (family_id,scope_id) REFERENCES pr_model.scope_sets(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.scope_members ADD CONSTRAINT fk_13 FOREIGN KEY (family_id,activity_id) REFERENCES pr_model.ref_concepts(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.scope_members ADD CONSTRAINT fk_14 FOREIGN KEY (family_id,series_id) REFERENCES pr_model.rule_series(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.scope_members ADD CONSTRAINT fk_15 FOREIGN KEY (family_id,sticker_type_id) REFERENCES pr_model.sticker_types(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.aggregation_specs ADD CONSTRAINT fk_16 FOREIGN KEY (family_id,scope_id) REFERENCES pr_model.scope_sets(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.aggregation_specs ADD CONSTRAINT fk_17 FOREIGN KEY (family_id,period_policy_id) REFERENCES pr_model.period_policies(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.aggregation_specs ADD CONSTRAINT fk_18 FOREIGN KEY (family_id,special_event_id) REFERENCES pr_model.special_events(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.conditions ADD CONSTRAINT fk_19 FOREIGN KEY (family_id,rule_version_id) REFERENCES pr_model.rule_versions(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.conditions ADD CONSTRAINT fk_20 FOREIGN KEY (family_id,aggregation_id) REFERENCES pr_model.aggregation_specs(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.predicate_groups ADD CONSTRAINT fk_21 FOREIGN KEY (family_id,condition_id) REFERENCES pr_model.conditions(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.predicate_groups ADD CONSTRAINT fk_22 FOREIGN KEY (family_id,rule_version_id) REFERENCES pr_model.rule_versions(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.predicate_groups ADD CONSTRAINT fk_23 FOREIGN KEY (family_id,condition_id,rule_version_id) REFERENCES pr_model.conditions(family_id,id,rule_version_id) ON DELETE RESTRICT;
ALTER TABLE pr_model.predicates ADD CONSTRAINT fk_24 FOREIGN KEY (family_id,group_id) REFERENCES pr_model.predicate_groups(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.predicates ADD CONSTRAINT fk_25 FOREIGN KEY (family_id,metric_id) REFERENCES pr_model.metric_definitions(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.predicates ADD CONSTRAINT fk_26 FOREIGN KEY (family_id,rule_version_id) REFERENCES pr_model.rule_versions(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.predicates ADD CONSTRAINT fk_27 FOREIGN KEY (family_id,group_id,rule_version_id) REFERENCES pr_model.predicate_groups(family_id,id,rule_version_id) ON DELETE RESTRICT;
ALTER TABLE pr_model.predicates ADD CONSTRAINT fk_28 FOREIGN KEY (family_id,metric_id,rule_version_id) REFERENCES pr_model.metric_definitions(family_id,id,rule_version_id) ON DELETE RESTRICT;
ALTER TABLE pr_model.condition_effects ADD CONSTRAINT fk_29 FOREIGN KEY (family_id,condition_id) REFERENCES pr_model.conditions(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.condition_effects ADD CONSTRAINT fk_30 FOREIGN KEY (family_id,effect_type_id) REFERENCES pr_model.effect_types(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.condition_effects ADD CONSTRAINT fk_31 FOREIGN KEY (family_id,asset_id) REFERENCES pr_model.asset_types(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.condition_effects ADD CONSTRAINT fk_32 FOREIGN KEY (family_id,condition_id,direction) REFERENCES pr_model.conditions(family_id,id,direction) ON DELETE RESTRICT;
ALTER TABLE pr_model.condition_effects ADD CONSTRAINT fk_33 FOREIGN KEY (family_id,effect_type_id,direction,asset_id) REFERENCES pr_model.effect_types(family_id,id,direction,asset_id) ON DELETE RESTRICT;
ALTER TABLE pr_model.limit_policies ADD CONSTRAINT fk_34 FOREIGN KEY (family_id,policy_series_id) REFERENCES pr_model.limit_policy_series(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.limit_policies ADD CONSTRAINT fk_35 FOREIGN KEY (family_id,scope_id) REFERENCES pr_model.scope_sets(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.limit_policies ADD CONSTRAINT fk_36 FOREIGN KEY (family_id,period_policy_id) REFERENCES pr_model.period_policies(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.limit_policies ADD CONSTRAINT fk_37 FOREIGN KEY (family_id,asset_id) REFERENCES pr_model.asset_types(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.condition_limits ADD CONSTRAINT fk_38 FOREIGN KEY (family_id,condition_id) REFERENCES pr_model.conditions(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.condition_limits ADD CONSTRAINT fk_39 FOREIGN KEY (family_id,limit_policy_id) REFERENCES pr_model.limit_policies(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.assignments ADD CONSTRAINT fk_40 FOREIGN KEY (family_id,child_id) REFERENCES pr_model.child_profiles(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.assignments ADD CONSTRAINT fk_41 FOREIGN KEY (family_id,series_id) REFERENCES pr_model.rule_series(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.assignments ADD CONSTRAINT fk_42 FOREIGN KEY (family_id,rule_version_id) REFERENCES pr_model.rule_versions(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.assignments ADD CONSTRAINT fk_43 FOREIGN KEY (family_id,special_event_id) REFERENCES pr_model.special_events(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.assignments ADD CONSTRAINT fk_44 FOREIGN KEY (created_by) REFERENCES pr_model.principals(id) ON DELETE RESTRICT;
ALTER TABLE pr_model.assignments ADD CONSTRAINT fk_45 FOREIGN KEY (family_id,rule_version_id,series_id) REFERENCES pr_model.rule_versions(family_id,id,series_id) ON DELETE RESTRICT;
ALTER TABLE pr_model.assignment_weekdays ADD CONSTRAINT fk_46 FOREIGN KEY (family_id,assignment_id) REFERENCES pr_model.assignments(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.occurrences ADD CONSTRAINT fk_47 FOREIGN KEY (family_id,assignment_id) REFERENCES pr_model.assignments(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.occurrences ADD CONSTRAINT fk_48 FOREIGN KEY (family_id,child_id) REFERENCES pr_model.child_profiles(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.occurrences ADD CONSTRAINT fk_49 FOREIGN KEY (family_id,series_id) REFERENCES pr_model.rule_series(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.occurrences ADD CONSTRAINT fk_50 FOREIGN KEY (family_id,rule_version_id) REFERENCES pr_model.rule_versions(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.occurrences ADD CONSTRAINT fk_51 FOREIGN KEY (family_id,assignment_id,child_id,series_id) REFERENCES pr_model.assignments(family_id,id,child_id,series_id) ON DELETE RESTRICT;
ALTER TABLE pr_model.occurrences ADD CONSTRAINT fk_52 FOREIGN KEY (family_id,assignment_id,child_id,series_id,rule_version_id) REFERENCES pr_model.assignments(family_id,id,child_id,series_id,rule_version_id) ON DELETE RESTRICT;
ALTER TABLE pr_model.observations ADD CONSTRAINT fk_53 FOREIGN KEY (family_id,occurrence_id) REFERENCES pr_model.occurrences(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.observations ADD CONSTRAINT fk_54 FOREIGN KEY (actor_id) REFERENCES pr_model.principals(id) ON DELETE RESTRICT;
ALTER TABLE pr_model.verifications ADD CONSTRAINT fk_55 FOREIGN KEY (family_id,occurrence_id) REFERENCES pr_model.occurrences(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.verifications ADD CONSTRAINT fk_56 FOREIGN KEY (family_id,rule_version_id) REFERENCES pr_model.rule_versions(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.verifications ADD CONSTRAINT fk_57 FOREIGN KEY (actor_id) REFERENCES pr_model.principals(id) ON DELETE RESTRICT;
ALTER TABLE pr_model.verifications ADD CONSTRAINT fk_58 FOREIGN KEY (family_id,supersedes_id) REFERENCES pr_model.verifications(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.verifications ADD CONSTRAINT fk_59 FOREIGN KEY (family_id,supersedes_id,occurrence_id) REFERENCES pr_model.verifications(family_id,id,occurrence_id) ON DELETE RESTRICT;
ALTER TABLE pr_model.verifications ADD CONSTRAINT fk_60 FOREIGN KEY (family_id,occurrence_id,rule_version_id) REFERENCES pr_model.occurrences(family_id,id,rule_version_id) ON DELETE RESTRICT;
ALTER TABLE pr_model.verified_values ADD CONSTRAINT fk_61 FOREIGN KEY (family_id,verification_id) REFERENCES pr_model.verifications(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.verified_values ADD CONSTRAINT fk_62 FOREIGN KEY (family_id,metric_id) REFERENCES pr_model.metric_definitions(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.verified_values ADD CONSTRAINT fk_63 FOREIGN KEY (family_id,rule_version_id) REFERENCES pr_model.rule_versions(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.verified_values ADD CONSTRAINT fk_64 FOREIGN KEY (family_id,verification_id,rule_version_id) REFERENCES pr_model.verifications(family_id,id,rule_version_id) ON DELETE RESTRICT;
ALTER TABLE pr_model.verified_values ADD CONSTRAINT fk_65 FOREIGN KEY (family_id,metric_id,rule_version_id) REFERENCES pr_model.metric_definitions(family_id,id,rule_version_id) ON DELETE RESTRICT;
ALTER TABLE pr_model.sticker_events ADD CONSTRAINT fk_66 FOREIGN KEY (family_id,child_id) REFERENCES pr_model.child_profiles(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.sticker_events ADD CONSTRAINT fk_67 FOREIGN KEY (family_id,occurrence_id) REFERENCES pr_model.occurrences(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.sticker_events ADD CONSTRAINT fk_68 FOREIGN KEY (family_id,verification_id) REFERENCES pr_model.verifications(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.sticker_events ADD CONSTRAINT fk_69 FOREIGN KEY (family_id,sticker_type_id) REFERENCES pr_model.sticker_types(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.sticker_events ADD CONSTRAINT fk_70 FOREIGN KEY (family_id,reversal_of_id) REFERENCES pr_model.sticker_events(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.sticker_events ADD CONSTRAINT fk_71 FOREIGN KEY (family_id,occurrence_id,child_id) REFERENCES pr_model.occurrences(family_id,id,child_id) ON DELETE RESTRICT;
ALTER TABLE pr_model.sticker_events ADD CONSTRAINT fk_72 FOREIGN KEY (family_id,verification_id,occurrence_id) REFERENCES pr_model.verifications(family_id,id,occurrence_id) ON DELETE RESTRICT;
ALTER TABLE pr_model.evaluation_subjects ADD CONSTRAINT fk_73 FOREIGN KEY (family_id,child_id) REFERENCES pr_model.child_profiles(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.evaluation_subjects ADD CONSTRAINT fk_74 FOREIGN KEY (family_id,series_id) REFERENCES pr_model.rule_series(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.evaluation_subjects ADD CONSTRAINT fk_75 FOREIGN KEY (family_id,occurrence_id) REFERENCES pr_model.occurrences(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.evaluation_subjects ADD CONSTRAINT fk_76 FOREIGN KEY (family_id,aggregation_id) REFERENCES pr_model.aggregation_specs(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.evaluation_subjects ADD CONSTRAINT fk_77 FOREIGN KEY (family_id,special_event_id) REFERENCES pr_model.special_events(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.evaluation_subjects ADD CONSTRAINT fk_78 FOREIGN KEY (family_id,occurrence_id,child_id) REFERENCES pr_model.occurrences(family_id,id,child_id) ON DELETE RESTRICT;
ALTER TABLE pr_model.evaluations ADD CONSTRAINT fk_79 FOREIGN KEY (family_id,subject_id) REFERENCES pr_model.evaluation_subjects(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.evaluations ADD CONSTRAINT fk_80 FOREIGN KEY (family_id,rule_version_id) REFERENCES pr_model.rule_versions(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.evaluation_inputs ADD CONSTRAINT fk_81 FOREIGN KEY (family_id,evaluation_id) REFERENCES pr_model.evaluations(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.evaluation_inputs ADD CONSTRAINT fk_82 FOREIGN KEY (family_id,verification_id) REFERENCES pr_model.verifications(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.condition_results ADD CONSTRAINT fk_83 FOREIGN KEY (family_id,evaluation_id) REFERENCES pr_model.evaluations(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.condition_results ADD CONSTRAINT fk_84 FOREIGN KEY (family_id,condition_id) REFERENCES pr_model.conditions(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.condition_results ADD CONSTRAINT fk_85 FOREIGN KEY (family_id,rule_version_id) REFERENCES pr_model.rule_versions(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.condition_results ADD CONSTRAINT fk_86 FOREIGN KEY (family_id,evaluation_id,rule_version_id) REFERENCES pr_model.evaluations(family_id,id,rule_version_id) ON DELETE RESTRICT;
ALTER TABLE pr_model.condition_results ADD CONSTRAINT fk_87 FOREIGN KEY (family_id,condition_id,rule_version_id) REFERENCES pr_model.conditions(family_id,id,rule_version_id) ON DELETE RESTRICT;
ALTER TABLE pr_model.limit_buckets ADD CONSTRAINT fk_88 FOREIGN KEY (family_id,child_id) REFERENCES pr_model.child_profiles(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.limit_buckets ADD CONSTRAINT fk_89 FOREIGN KEY (family_id,limit_policy_id) REFERENCES pr_model.limit_policies(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.limit_buckets ADD CONSTRAINT fk_90 FOREIGN KEY (family_id,policy_series_id) REFERENCES pr_model.limit_policy_series(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.limit_buckets ADD CONSTRAINT fk_91 FOREIGN KEY (family_id,special_event_id) REFERENCES pr_model.special_events(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.limit_buckets ADD CONSTRAINT fk_92 FOREIGN KEY (family_id,limit_policy_id,policy_series_id) REFERENCES pr_model.limit_policies(family_id,id,policy_series_id) ON DELETE RESTRICT;
ALTER TABLE pr_model.admissions ADD CONSTRAINT fk_93 FOREIGN KEY (family_id,condition_result_id) REFERENCES pr_model.condition_results(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.admissions ADD CONSTRAINT fk_94 FOREIGN KEY (family_id,supersedes_id) REFERENCES pr_model.admissions(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.admission_effects ADD CONSTRAINT fk_95 FOREIGN KEY (family_id,admission_id) REFERENCES pr_model.admissions(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.admission_effects ADD CONSTRAINT fk_96 FOREIGN KEY (family_id,effect_id) REFERENCES pr_model.condition_effects(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.admission_effects ADD CONSTRAINT fk_97 FOREIGN KEY (family_id,asset_id) REFERENCES pr_model.asset_types(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.admission_effects ADD CONSTRAINT fk_98 FOREIGN KEY (family_id,effect_id,asset_id) REFERENCES pr_model.condition_effects(family_id,id,asset_id) ON DELETE RESTRICT;
ALTER TABLE pr_model.quota_entries ADD CONSTRAINT fk_99 FOREIGN KEY (family_id,bucket_id) REFERENCES pr_model.limit_buckets(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.quota_entries ADD CONSTRAINT fk_100 FOREIGN KEY (family_id,admission_id) REFERENCES pr_model.admissions(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.quota_entries ADD CONSTRAINT fk_101 FOREIGN KEY (family_id,reversal_of_id) REFERENCES pr_model.quota_entries(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.manual_awards ADD CONSTRAINT fk_102 FOREIGN KEY (family_id,child_id) REFERENCES pr_model.child_profiles(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.manual_awards ADD CONSTRAINT fk_103 FOREIGN KEY (family_id,effect_type_id) REFERENCES pr_model.effect_types(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.manual_awards ADD CONSTRAINT fk_104 FOREIGN KEY (family_id,asset_id) REFERENCES pr_model.asset_types(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.manual_awards ADD CONSTRAINT fk_105 FOREIGN KEY (actor_id) REFERENCES pr_model.principals(id) ON DELETE RESTRICT;
ALTER TABLE pr_model.grants ADD CONSTRAINT fk_106 FOREIGN KEY (family_id,child_id) REFERENCES pr_model.child_profiles(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.grants ADD CONSTRAINT fk_107 FOREIGN KEY (family_id,admission_effect_id) REFERENCES pr_model.admission_effects(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.grants ADD CONSTRAINT fk_108 FOREIGN KEY (family_id,manual_award_id) REFERENCES pr_model.manual_awards(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.grants ADD CONSTRAINT fk_109 FOREIGN KEY (family_id,asset_id) REFERENCES pr_model.asset_types(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.grants ADD CONSTRAINT fk_110 FOREIGN KEY (family_id,admission_effect_id,asset_id) REFERENCES pr_model.admission_effects(family_id,id,asset_id) ON DELETE RESTRICT;
ALTER TABLE pr_model.grants ADD CONSTRAINT fk_111 FOREIGN KEY (family_id,manual_award_id,child_id,asset_id) REFERENCES pr_model.manual_awards(family_id,id,child_id,asset_id) ON DELETE RESTRICT;
ALTER TABLE pr_model.grant_events ADD CONSTRAINT fk_112 FOREIGN KEY (family_id,grant_id) REFERENCES pr_model.grants(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.grant_events ADD CONSTRAINT fk_113 FOREIGN KEY (actor_id) REFERENCES pr_model.principals(id) ON DELETE RESTRICT;
ALTER TABLE pr_model.fulfillments ADD CONSTRAINT fk_114 FOREIGN KEY (family_id,grant_id) REFERENCES pr_model.grants(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.fulfillments ADD CONSTRAINT fk_115 FOREIGN KEY (actor_id) REFERENCES pr_model.principals(id) ON DELETE RESTRICT;
ALTER TABLE pr_model.usage_requests ADD CONSTRAINT fk_116 FOREIGN KEY (family_id,child_id) REFERENCES pr_model.child_profiles(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.usage_requests ADD CONSTRAINT fk_117 FOREIGN KEY (actor_id) REFERENCES pr_model.principals(id) ON DELETE RESTRICT;
ALTER TABLE pr_model.usage_items ADD CONSTRAINT fk_118 FOREIGN KEY (family_id,usage_request_id) REFERENCES pr_model.usage_requests(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.usage_items ADD CONSTRAINT fk_119 FOREIGN KEY (family_id,asset_id) REFERENCES pr_model.asset_types(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.ledger_entries ADD CONSTRAINT fk_120 FOREIGN KEY (family_id,child_id) REFERENCES pr_model.child_profiles(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.ledger_entries ADD CONSTRAINT fk_121 FOREIGN KEY (family_id,asset_id) REFERENCES pr_model.asset_types(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.ledger_entries ADD CONSTRAINT fk_122 FOREIGN KEY (family_id,grant_id) REFERENCES pr_model.grants(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.ledger_entries ADD CONSTRAINT fk_123 FOREIGN KEY (family_id,usage_item_id) REFERENCES pr_model.usage_items(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.ledger_entries ADD CONSTRAINT fk_124 FOREIGN KEY (family_id,reversal_of_id) REFERENCES pr_model.ledger_entries(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.ledger_entries ADD CONSTRAINT fk_125 FOREIGN KEY (family_id,settlement_run_id) REFERENCES pr_model.settlement_runs(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.ledger_entries ADD CONSTRAINT fk_126 FOREIGN KEY (family_id,grant_id,asset_id) REFERENCES pr_model.grants(family_id,id,asset_id) ON DELETE RESTRICT;
ALTER TABLE pr_model.ledger_entries ADD CONSTRAINT fk_127 FOREIGN KEY (family_id,usage_item_id,asset_id) REFERENCES pr_model.usage_items(family_id,id,asset_id) ON DELETE RESTRICT;
ALTER TABLE pr_model.ledger_entries ADD CONSTRAINT fk_128 FOREIGN KEY (family_id,reversal_of_id,child_id,asset_id) REFERENCES pr_model.ledger_entries(family_id,id,child_id,asset_id) ON DELETE RESTRICT;
ALTER TABLE pr_model.residuals ADD CONSTRAINT fk_129 FOREIGN KEY (family_id,child_id) REFERENCES pr_model.child_profiles(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.residuals ADD CONSTRAINT fk_130 FOREIGN KEY (family_id,occurrence_id) REFERENCES pr_model.occurrences(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.residual_decisions ADD CONSTRAINT fk_131 FOREIGN KEY (family_id,residual_id) REFERENCES pr_model.residuals(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.residual_decisions ADD CONSTRAINT fk_132 FOREIGN KEY (family_id,target_ref_id) REFERENCES pr_model.ref_concepts(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.residual_decisions ADD CONSTRAINT fk_133 FOREIGN KEY (family_id,target_rule_version_id) REFERENCES pr_model.rule_versions(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.residual_decisions ADD CONSTRAINT fk_134 FOREIGN KEY (actor_id) REFERENCES pr_model.principals(id) ON DELETE RESTRICT;
ALTER TABLE pr_model.daily_snapshots ADD CONSTRAINT fk_135 FOREIGN KEY (family_id,child_id) REFERENCES pr_model.child_profiles(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.daily_snapshots ADD CONSTRAINT fk_136 FOREIGN KEY (family_id,settlement_run_id) REFERENCES pr_model.settlement_runs(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.snapshot_assets ADD CONSTRAINT fk_137 FOREIGN KEY (family_id,snapshot_id) REFERENCES pr_model.daily_snapshots(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.snapshot_assets ADD CONSTRAINT fk_138 FOREIGN KEY (family_id,asset_id) REFERENCES pr_model.asset_types(family_id,id) ON DELETE RESTRICT;
ALTER TABLE pr_model.request_events ADD CONSTRAINT fk_139 FOREIGN KEY (actor_id) REFERENCES pr_model.principals(id) ON DELETE RESTRICT;
ALTER TABLE pr_model.metric_definitions ADD CHECK (min_value IS NULL OR min_value::text NOT IN ('NaN','Infinity','-Infinity'));
ALTER TABLE pr_model.metric_definitions ADD CHECK (max_value IS NULL OR max_value::text NOT IN ('NaN','Infinity','-Infinity'));
ALTER TABLE pr_model.predicates ADD CHECK (rhs_number IS NULL OR rhs_number::text NOT IN ('NaN','Infinity','-Infinity'));
ALTER TABLE pr_model.condition_effects ADD CHECK (amount IS NULL OR amount::text NOT IN ('NaN','Infinity','-Infinity'));
ALTER TABLE pr_model.limit_policies ADD CHECK (max_value IS NULL OR max_value::text NOT IN ('NaN','Infinity','-Infinity'));
ALTER TABLE pr_model.verified_values ADD CHECK (number_value IS NULL OR number_value::text NOT IN ('NaN','Infinity','-Infinity'));
ALTER TABLE pr_model.condition_results ADD CHECK (measured_value IS NULL OR measured_value::text NOT IN ('NaN','Infinity','-Infinity'));
ALTER TABLE pr_model.admission_effects ADD CHECK (allowed_amount IS NULL OR allowed_amount::text NOT IN ('NaN','Infinity','-Infinity'));
ALTER TABLE pr_model.quota_entries ADD CHECK (delta IS NULL OR delta::text NOT IN ('NaN','Infinity','-Infinity'));
ALTER TABLE pr_model.manual_awards ADD CHECK (amount IS NULL OR amount::text NOT IN ('NaN','Infinity','-Infinity'));
ALTER TABLE pr_model.grants ADD CHECK (amount IS NULL OR amount::text NOT IN ('NaN','Infinity','-Infinity'));
ALTER TABLE pr_model.fulfillments ADD CHECK (amount IS NULL OR amount::text NOT IN ('NaN','Infinity','-Infinity'));
ALTER TABLE pr_model.usage_items ADD CHECK (amount IS NULL OR amount::text NOT IN ('NaN','Infinity','-Infinity'));
ALTER TABLE pr_model.ledger_entries ADD CHECK (delta IS NULL OR delta::text NOT IN ('NaN','Infinity','-Infinity'));
ALTER TABLE pr_model.snapshot_assets ADD CHECK (available_amount IS NULL OR available_amount::text NOT IN ('NaN','Infinity','-Infinity'));
ALTER TABLE pr_model.snapshot_assets ADD CHECK (pending_amount IS NULL OR pending_amount::text NOT IN ('NaN','Infinity','-Infinity'));
CREATE UNIQUE INDEX scope_activity_id_uq ON pr_model.scope_members(family_id,scope_id,activity_id) WHERE activity_id IS NOT NULL;
CREATE UNIQUE INDEX scope_series_id_uq ON pr_model.scope_members(family_id,scope_id,series_id) WHERE series_id IS NOT NULL;
CREATE UNIQUE INDEX scope_sticker_type_id_uq ON pr_model.scope_members(family_id,scope_id,sticker_type_id) WHERE sticker_type_id IS NOT NULL;
CREATE UNIQUE INDEX limit_bucket_nullable_event_uq ON pr_model.limit_buckets(family_id,child_id,policy_series_id,period_start,period_end,special_event_id) NULLS NOT DISTINCT;
CREATE INDEX occurrences_child_day_idx ON pr_model.occurrences(family_id,child_id,business_date,sequence_no);
CREATE INDEX ledger_balance_idx ON pr_model.ledger_entries(family_id,child_id,asset_id,effective_at);
CREATE INDEX verification_revision_idx ON pr_model.verifications(family_id,occurrence_id,revision_no DESC);
CREATE INDEX quota_bucket_idx ON pr_model.quota_entries(family_id,bucket_id);
CREATE FUNCTION pr_model.guard_append_only() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$ BEGIN RAISE EXCEPTION 'DESIGN_APPEND_ONLY'; END $$;
CREATE FUNCTION pr_model.guard_ledger_insert() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE g pr_model.grants%ROWTYPE; a pr_model.asset_types%ROWTYPE; orig pr_model.ledger_entries%ROWTYPE; ui pr_model.usage_items%ROWTYPE;
BEGIN
 SELECT * INTO STRICT a FROM pr_model.asset_types WHERE id=NEW.asset_id AND family_id=NEW.family_id;
 IF a.route <> 'INTERNAL_LEDGER' THEN RAISE EXCEPTION 'DESIGN_EXTERNAL_ASSET_NOT_LEDGER'; END IF;
 IF NEW.reversal_of_id IS NOT NULL THEN
  SELECT * INTO STRICT orig FROM pr_model.ledger_entries WHERE id=NEW.reversal_of_id AND family_id=NEW.family_id;
  IF NEW.delta <> -orig.delta THEN RAISE EXCEPTION 'DESIGN_EXACT_REVERSAL_REQUIRED'; END IF;
 ELSIF NEW.grant_id IS NOT NULL THEN
  SELECT * INTO STRICT g FROM pr_model.grants WHERE id=NEW.grant_id AND family_id=NEW.family_id;
  IF g.child_id<>NEW.child_id OR g.asset_id<>NEW.asset_id OR g.amount IS NULL
     OR NEW.kind<>g.direction OR NEW.delta<>(CASE WHEN g.direction='REWARD' THEN g.amount ELSE -g.amount END)
  THEN RAISE EXCEPTION 'DESIGN_GRANT_LEDGER_MISMATCH'; END IF;
 ELSE
  SELECT * INTO STRICT ui FROM pr_model.usage_items WHERE id=NEW.usage_item_id AND family_id=NEW.family_id;
  IF NEW.delta<>-ui.amount OR NOT EXISTS (SELECT 1 FROM pr_model.usage_requests u WHERE u.id=ui.usage_request_id AND u.family_id=NEW.family_id AND u.child_id=NEW.child_id)
  THEN RAISE EXCEPTION 'DESIGN_USAGE_LEDGER_MISMATCH'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ledger_insert_guard BEFORE INSERT ON pr_model.ledger_entries FOR EACH ROW EXECUTE FUNCTION pr_model.guard_ledger_insert();
ALTER TABLE pr_model.families ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_model.principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_model.child_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_model.ref_concepts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_model.asset_types ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.asset_types FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.effect_types ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.effect_types FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.sticker_types ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.sticker_types FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.activity_aliases ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.activity_aliases FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.rule_series ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.rule_series FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.period_policies ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.period_policies FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.special_events ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.special_events FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.rule_versions ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.rule_versions FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.metric_definitions ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.metric_definitions FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.scope_sets ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.scope_sets FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.scope_members ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.scope_members FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.aggregation_specs ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.aggregation_specs FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.conditions ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.conditions FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.predicate_groups ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.predicate_groups FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.predicates ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.predicates FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.condition_effects ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.condition_effects FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.limit_policy_series ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.limit_policy_series FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.limit_policies ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.limit_policies FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.condition_limits ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.condition_limits FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.assignments ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.assignments FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.assignment_weekdays ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.assignment_weekdays FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.occurrences ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.occurrences FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.observations ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.observations FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.verifications ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.verifications FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.verified_values ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.verified_values FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.sticker_events ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.sticker_events FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.evaluation_subjects ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.evaluation_subjects FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.evaluations ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.evaluations FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.evaluation_inputs ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.evaluation_inputs FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.condition_results ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.condition_results FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.limit_buckets ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.limit_buckets FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.admissions ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.admissions FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.admission_effects ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.admission_effects FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.quota_entries ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.quota_entries FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.manual_awards ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.manual_awards FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.grants ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.grants FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.grant_events ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.grant_events FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.settlement_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_model.fulfillments ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.fulfillments FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.usage_requests ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.usage_requests FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.usage_items ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.usage_items FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.ledger_entries ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.ledger_entries FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.residuals ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.residuals FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.residual_decisions ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.residual_decisions FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.daily_snapshots ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.daily_snapshots FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.snapshot_assets ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.snapshot_assets FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.source_bridges ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.source_bridges FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
ALTER TABLE pr_model.request_events ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON pr_model.request_events FOR EACH ROW EXECUTE FUNCTION pr_model.guard_append_only();
REVOKE ALL ON ALL TABLES IN SCHEMA pr_model FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pr_model FROM PUBLIC;
COMMIT;
-- 미구현: 운영 RLS SELECT/RPC 권한, 역할 인가, 상태 전이, 행간 한도 집계, 실제 판정 및 정산 실행.
