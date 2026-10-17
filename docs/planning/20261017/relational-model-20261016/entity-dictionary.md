## 부록 A. 엔티티별 물리 필드 사전

**공통:** UUID `id` PK, 가족 소속 행은 `family_id` FK와 `UNIQUE(family_id,id)`, `recorded_at timestamptz`. 가족·계정 앵커에 존재하지 않는 필드는 기존 public 스키마를 따른다. 아래는 설계용 `pr_model`이며 운영에 바로 적용한 모델이 아니다.

### 0 앵커

| 테이블 · 역할 | 주요 필드와 자료형 | FK · 유일성 |
|---|---|---|
| `families` — 가족 앵커 | `name` text!; `timezone` text! | 가족 FK; UUID PK |
| `principals` — 사용자 앵커 | `auth_user_id` uuid UNIQUE | 가족 FK; UUID PK |
| `child_profiles` — 자녀 앵커 | `principal_id` uuid | `principal_id` → `principals`; UUID PK |
| `ref_concepts` — 활동 정본 앵커 | `name` text!; `category_code` text! | 가족 FK; UUID PK |

- **`families`:** public.families의 기존 UUID를 유지하는 설계용 축약 앵커. 실제 인증 테이블을 새로 만들지 않음.
- **`principals`:** public.principals 재사용. 이메일·비밀번호·토큰은 모델에 복제하지 않음.
- **`child_profiles`:** public.child_profiles의 UUID와 가족 소속을 재사용.
- **`ref_concepts`:** public.ref_concepts 재사용. 고양이 화장실 등은 이름 붙인 인스턴스이며 고정 종류 테이블이 아님.

### 1 종류

| 테이블 · 역할 | 주요 필드와 자료형 | FK · 유일성 |
|---|---|---|
| `asset_types` — 자산·이행 단위 | `code` text!; `unit` text!; `provider_code` text!; `route` text! | 가족 FK; UQ(family_id,code) |
| `effect_types` — 강화물·패널티 종류 | `code` text!; `name` text!; `direction` text!; `asset_id` uuid! | `asset_id` → `asset_types`; UQ(family_id,code); UQ(family_id,id,direction,asset_id) |
| `sticker_types` — 스티커·표식 종류 | `code` text!; `name` text!; `direction` text!; `icon_code` text!; `image_url` text | 가족 FK; UQ(family_id,code) |
| `activity_aliases` — 동일 활동 연결 | `alias_ref_id` uuid!; `canonical_ref_id` uuid!; `approved_by` uuid!; `reason` text! | `alias_ref_id` → `ref_concepts`; `canonical_ref_id` → `ref_concepts`; `approved_by` → `principals`; UQ(family_id,alias_ref_id) |

- **`asset_types`:** 분/원/서비스별 포인트/소원 구분. 쿠페이 포인트와 다른 포인트는 다른 ID. 내부 원장과 외부 지급 중 하나의 경로만 선택.
- **`effect_types`:** 같은 카탈로그 구조, 결과 방향 분리. 현재 허용 패널티는 MIN 차감. 돈 차감 등 미승인 확장은 게시 검증에서 거절.
- **`sticker_types`:** 종류 ID와 그림을 분리. STAR 그림이 같은 여러 종류라도 합산 대상을 명시해야 함. 패널티 표식 자체는 차감이 아님.
- **`activity_aliases`:** 밀크티/밀크티 학습지를 이름으로 자동 합치지 않고 부모 승인으로 연결. 별칭 순환 금지 RPC 검증.

### 2 정책

| 테이블 · 역할 | 주요 필드와 자료형 | FK · 유일성 |
|---|---|---|
| `rule_series` — 규칙 안정 계보 | `activity_id` uuid!; `stable_key` uuid!; `flow` text! | `activity_id` → `ref_concepts`; UQ(family_id,stable_key) |
| `period_policies` — 기간 경계 정책 | `code` text!; `kind` text!; `timezone` text!; `week_start` smallint; `anchor_on` date; `custom_days` integer | 가족 FK; UQ(family_id,code) |
| `special_events` — 특별 이벤트 범위 | `name` text!; `starts_at` timestamptz!; `ends_at` timestamptz!; `timezone` text! | 가족 FK; UUID PK |
| `rule_versions` — 불변 게시 버전 | `series_id` uuid!; `version_no` integer!; `effective_from` date!; `previous_version_id` uuid; `published_by` uuid!; `criteria` text!; `schema_version` integer! DEFAULT 1; `engine_version` text! | `series_id` → `rule_series`; `previous_version_id` → `rule_versions`; `published_by` → `principals`; UQ(family_id,series_id,version_no); UQ(family_id,id,series_id) |
| `metric_definitions` — 측정 정의 | `rule_version_id` uuid!; `code` text!; `value_kind` text!; `unit_code` text!; `min_value` numeric; `max_value` numeric | `rule_version_id` → `rule_versions`; UQ(family_id,rule_version_id,code); UQ(family_id,id,rule_version_id) |
| `scope_sets` — 집계·한도 대상 묶음 | `name` text!; `version_no` integer! | 가족 FK; UUID PK |
| `scope_members` — 묶음 구성원 | `scope_id` uuid!; `activity_id` uuid; `series_id` uuid; `sticker_type_id` uuid | `scope_id` → `scope_sets`; `activity_id` → `ref_concepts`; `series_id` → `rule_series`; `sticker_type_id` → `sticker_types`; UUID PK |
| `aggregation_specs` — 누적·비율 집계 정의 | `scope_id` uuid!; `period_policy_id` uuid!; `special_event_id` uuid; `operation` text!; `input_metric_code` text; `source_kind` text!; `denominator_mode` text; `allow_version_bridge` boolean! DEFAULT false | `scope_id` → `scope_sets`; `period_policy_id` → `period_policies`; `special_event_id` → `special_events`; UUID PK |

- **`rule_series`:** 게시 버전이 바뀌어도 계보 ID 유지. 회차의 PERFORMANCE/INCIDENT가 사실 방향이며 DAILY/QUEST와 별개.
- **`period_policies`:** 행은 불변. 기록 단위·집계 기간·한도 기간·정산 실행을 한 period 열로 섞지 않음.
- **`special_events`:** 기간은 [start,end). 특별 이벤트는 문자열 메모가 아니라 범위 ID.
- **`rule_versions`:** 수정 대신 새 버전. 이전 버전은 같은 계보라는 강화 FK 적용. 미승인 숫자·기준 충돌은 게시 차단.
- **`metric_definitions`:** 정답 수, 총문제 수, 소요 초, 점수, 백분율 등 복수 측정. PERCENT는 게시 시 0~100; 수량에는 그 범위를 강제하지 않음.
- **`scope_sets`:** 행과 구성원은 게시 후 불변. 활동/규칙/스티커를 합칠 범위를 명시하며 규칙 버전이 아니라 안정 계보로 연결.
- **`scope_members`:** 세 종류 중 정확히 하나를 참조. AND 합성 대상은 별도 묶음 정의/RPC 검증. 같은 사건이 두 구성원에 맞아도 DISTINCT 출처로 한 번 계산.
- **`aggregation_specs`:** 백분율의 분모·면제·미확인 건수를 함께 기록. 버전 연결은 부모 승인 시에만 명시적으로 허용.

### 3 조건 효과

| 테이블 · 역할 | 주요 필드와 자료형 | FK · 유일성 |
|---|---|---|
| `conditions` — 기본·추가·중립·차감 조건 | `rule_version_id` uuid!; `stable_key` uuid!; `label` text!; `direction` text!; `mode` text!; `aggregation_id` uuid; `conflict_group` text; `match_policy` text! | `rule_version_id` → `rule_versions`; `aggregation_id` → `aggregation_specs`; UQ(family_id,rule_version_id,stable_key); UQ(family_id,id,rule_version_id); UQ(family_id,id,direction) |
| `predicate_groups` — 조건 OR 그룹 | `condition_id` uuid!; `rule_version_id` uuid!; `group_no` integer! | `condition_id` → `conditions`; `rule_version_id` → `rule_versions`; UQ(family_id,condition_id,group_no); UQ(family_id,id,rule_version_id) |
| `predicates` — 측정 비교 원자 | `group_id` uuid!; `rule_version_id` uuid!; `metric_id` uuid; `aggregate_result` boolean! DEFAULT false; `operator` text!; `rhs_number` numeric; `rhs_boolean` boolean; `rhs_time` time; `rhs_instant` timestamptz | `group_id` → `predicate_groups`; `metric_id` → `metric_definitions`; `rule_version_id` → `rule_versions`; UUID PK |
| `condition_effects` — 조건별 효과 항목 | `condition_id` uuid!; `stable_key` uuid!; `position` smallint!; `effect_type_id` uuid!; `direction` text!; `asset_id` uuid!; `amount` numeric; `text_value` text; `name_snapshot` text! | `condition_id` → `conditions`; `effect_type_id` → `effect_types`; `asset_id` → `asset_types`; UQ(family_id,condition_id,position); UQ(family_id,condition_id,stable_key); UQ(family_id,id,asset_id) |

- **`conditions`:** 5개와8개는 CUMULATIVE 기본+추가. +/0/- 같은 수치축은 EXCLUSIVE 그룹. 서로 다른 축의 합산 여부는 부모 승인 정책.
- **`predicate_groups`:** 그룹끼리 OR, 그룹 안 원자 조건은 AND. 조건 트리 무한 범용 JSON 대신 이 정규형 사용.
- **`predicates`:** 예: correct_count≥15 AND elapsed_seconds≤180.그룹·측정은 같은 게시 버전 FK. 자료형·단위·참조 집계 일치는 게시 검증.
- **`condition_effects`:** REWARD는1~2개, 두 번째 선택. PENALTY는 당장1개만 허용하는 게시 검증. 값은 양수, 방향 별도. 소원은 text, 수치 자산은amount.

### 4 인정 한도

| 테이블 · 역할 | 주요 필드와 자료형 | FK · 유일성 |
|---|---|---|
| `limit_policy_series` — 한도 안정 계보 | `stable_key` uuid!; `name` text! | 가족 FK; UQ(family_id,stable_key) |
| `limit_policies` — 인정 횟수·총량 정책 버전 | `policy_series_id` uuid!; `version_no` integer!; `scope_id` uuid!; `period_policy_id` uuid!; `direction` text!; `limit_kind` text!; `asset_id` uuid; `max_value` numeric!; `allocation_mode` text!; `effective_from` date! | `policy_series_id` → `limit_policy_series`; `scope_id` → `scope_sets`; `period_policy_id` → `period_policies`; `asset_id` → `asset_types`; UQ(family_id,policy_series_id,version_no); UQ(family_id,id,policy_series_id) |
| `condition_limits` — 조건에 붙는 한도 관계 | `condition_id` uuid!; `limit_policy_id` uuid!; `priority` integer! | `condition_id` → `conditions`; `limit_policy_id` → `limit_policies`; UQ(family_id,condition_id,limit_policy_id) |
| `limit_buckets` — 기간별 한도 잠금 단위 | `child_id` uuid!; `limit_policy_id` uuid!; `policy_series_id` uuid!; `period_start` date!; `period_end` date!; `special_event_id` uuid | `child_id` → `child_profiles`; `limit_policy_id` → `limit_policies`; `policy_series_id` → `limit_policy_series`; `special_event_id` → `special_events`; UQ(family_id,child_id,policy_series_id,period_start,period_end,special_event_id) |
| `quota_entries` — 한도 소모·해제 원장 | `bucket_id` uuid!; `admission_id` uuid!; `delta` numeric!; `phase` text!; `reversal_of_id` uuid; `dedupe_key` text! | `bucket_id` → `limit_buckets`; `admission_id` → `admissions`; `reversal_of_id` → `quota_entries`; UQ(family_id,dedupe_key) |

- **`limit_policy_series`:** 규칙 버전이 바뀌었다고 하루 횟수·주 상한을 리셋하지 않는 안정 키.
- **`limit_policies`:** 한도 없으면 정책 없음; 초안 미설정은 따로 게시 완전성 검증. 한도판정 순서·부분허용은 필수. COUNT는 조건 달성1회, 효과2개여도1회.
- **`condition_limits`:** 조건 N:M 한도. 일별·주간·월간·묶음 전체 한도를 동시에 연결할 수 있음. 방향·scope·효력 일치는 게시 검증.
- **`limit_buckets`:** 버전아닌policy_series로기간중중복상한을막음. 기간내한도정책변경은새기간효력/명시재검토만허용. 행잠금직렬화.
- **`quota_entries`:** SUM(delta)로순소모. 지급대기권리도상한예약; 실제이행까지기다리면초과발행됨. COUNT는효과2개여도1. 패널티거절시승인예약해제.

### 5 사실 확인

| 테이블 · 역할 | 주요 필드와 자료형 | FK · 유일성 |
|---|---|---|
| `assignments` — 자녀 배정·기록 일정 | `child_id` uuid!; `series_id` uuid!; `rule_version_id` uuid!; `recording_kind` text!; `starts_on` date!; `ends_on` date; `special_event_id` uuid; `expected_per_day` integer; `created_by` uuid! | `child_id` → `child_profiles`; `series_id` → `rule_series`; `rule_version_id` → `rule_versions`; `special_event_id` → `special_events`; `created_by` → `principals`; UQ(family_id,id,child_id,series_id); UQ(family_id,id,child_id,series_id,rule_version_id) |
| `assignment_weekdays` — 배정 요일 | `assignment_id` uuid!; `weekday` smallint! | `assignment_id` → `assignments`; UQ(family_id,assignment_id,weekday) |
| `occurrences` — 실제 수행·발생 회차 | `assignment_id` uuid!; `child_id` uuid!; `series_id` uuid!; `business_date` date!; `sequence_no` integer!; `occurred_at` timestamptz; `kind` text!; `origin_key` uuid!; `rule_version_id` uuid! | `assignment_id` → `assignments`; `child_id` → `child_profiles`; `series_id` → `rule_series`; `rule_version_id` → `rule_versions`; UQ(family_id,assignment_id,business_date,sequence_no); UQ(family_id,origin_key); UQ(family_id,id,child_id); UQ(family_id,id,rule_version_id) |
| `observations` — 자녀·부모 원래 보고 | `occurrence_id` uuid!; `actor_id` uuid!; `actor_role` text!; `payload` jsonb!; `request_key` uuid! | `occurrence_id` → `occurrences`; `actor_id` → `principals`; UQ(family_id,actor_id,request_key) |
| `verifications` — 부모 확인 revision | `occurrence_id` uuid!; `rule_version_id` uuid!; `revision_no` integer!; `actor_id` uuid!; `supersedes_id` uuid; `decision` text!; `reason` text! | `occurrence_id` → `occurrences`; `rule_version_id` → `rule_versions`; `actor_id` → `principals`; `supersedes_id` → `verifications`; UQ(family_id,occurrence_id,revision_no); UQ(family_id,id,occurrence_id); UQ(family_id,id,rule_version_id) |
| `verified_values` — 확정 측정값 | `verification_id` uuid!; `rule_version_id` uuid!; `metric_id` uuid!; `number_value` numeric; `boolean_value` boolean; `time_value` time; `instant_value` timestamptz | `verification_id` → `verifications`; `metric_id` → `metric_definitions`; `rule_version_id` → `rule_versions`; UQ(family_id,verification_id,metric_id) |
| `sticker_events` — 종류별 스티커 증감 | `child_id` uuid!; `occurrence_id` uuid!; `verification_id` uuid!; `sticker_type_id` uuid!; `delta` integer!; `reason` text!; `reversal_of_id` uuid; `dedupe_key` text! | `child_id` → `child_profiles`; `occurrence_id` → `occurrences`; `verification_id` → `verifications`; `sticker_type_id` → `sticker_types`; `reversal_of_id` → `sticker_events`; UQ(family_id,dedupe_key) |

- **`assignments`:** 예정 횟수는 지급 인정 횟수가 아님. ON_DEMAND는 발생/반복 입력. 같은 자녀·canonical활동의 유효 버전 선택은 RPC/중복 배정 가드.
- **`assignment_weekdays`:** 요일 배열 대신 관계행. ONCE·ON_DEMAND에 불필요한 요일은 게시/배정 RPC가 금지.
- **`occurrences`:** 하루1행 제한 제거. 사실은4회, 인정2회가 가능. 같은 회차 재전송은origin_key로 중복 차단. 날짜 정정은 새 사건/무효화 이력.
- **`observations`:** 원문 보고 JSON은 감사 근거; 계산 정본은 verified_values. 토큰·비밀번호·메일 인증 URL 저장 금지.
- **`verifications`:** 미확인은행없음(null),0아님. 부모 확인이 우선. EXEMPT는분모제외,VOID는잘못기록한사건 무효. 같은 회차 supersedes FK 적용.
- **`verified_values`:** 소요 초와 정답 수를 별도행으로 보관. 같은버전 FK. 숫자 finite·단위·범위는검증 RPC.
- **`sticker_events`:** PASS+칭찬의1/2개는현재게시값 보존. 새규칙에서종류별증감. 수정시원행상쇄; 패널티표식은차감원장과분리.

### 6 판정 권리

| 테이블 · 역할 | 주요 필드와 자료형 | FK · 유일성 |
|---|---|---|
| `evaluation_subjects` — 판정 대상의 안정 키 | `child_id` uuid!; `series_id` uuid!; `kind` text!; `occurrence_id` uuid; `aggregation_id` uuid; `period_start` date; `period_end` date; `timezone_snapshot` text!; `special_event_id` uuid; `origin_key` text! | `child_id` → `child_profiles`; `series_id` → `rule_series`; `occurrence_id` → `occurrences`; `aggregation_id` → `aggregation_specs`; `special_event_id` → `special_events`; UQ(family_id,child_id,series_id,origin_key) |
| `evaluations` — 판정 실행 revision | `subject_id` uuid!; `rule_version_id` uuid!; `revision_no` integer!; `completeness` text!; `eligible_count` integer!; `confirmed_count` integer!; `hold_count` integer!; `excluded_count` integer!; `engine_version` text!; `input_digest` text! | `subject_id` → `evaluation_subjects`; `rule_version_id` → `rule_versions`; UQ(family_id,subject_id,revision_no); UQ(family_id,id,rule_version_id) |
| `evaluation_inputs` — 판정 근거 연결 | `evaluation_id` uuid!; `verification_id` uuid!; `included` boolean!; `exclusion_reason` text | `evaluation_id` → `evaluations`; `verification_id` → `verifications`; UQ(family_id,evaluation_id,verification_id) |
| `condition_results` — 조건 판정 결과 | `evaluation_id` uuid!; `rule_version_id` uuid!; `condition_id` uuid!; `result` text!; `measured_value` numeric; `reason` text! | `evaluation_id` → `evaluations`; `condition_id` → `conditions`; `rule_version_id` → `rule_versions`; UQ(family_id,evaluation_id,condition_id) |
| `admissions` — 조건 인정 결정 | `condition_result_id` uuid!; `status` text!; `reason` text!; `supersedes_id` uuid | `condition_result_id` → `condition_results`; `supersedes_id` → `admissions`; UQ(family_id,condition_result_id) |
| `admission_effects` — 인정된 효과 배분 | `admission_id` uuid!; `effect_id` uuid!; `asset_id` uuid!; `allowed_amount` numeric; `allowed_text` text; `status` text! | `admission_id` → `admissions`; `effect_id` → `condition_effects`; `asset_id` → `asset_types`; UQ(family_id,admission_id,effect_id); UQ(family_id,id,asset_id) |
| `manual_awards` — 특별보너스 출처 | `child_id` uuid!; `effect_type_id` uuid!; `asset_id` uuid!; `amount` numeric; `text_value` text; `reason` text!; `actor_id` uuid!; `request_key` uuid! | `child_id` → `child_profiles`; `effect_type_id` → `effect_types`; `asset_id` → `asset_types`; `actor_id` → `principals`; UQ(family_id,request_key); UQ(family_id,id,child_id,asset_id) |
| `grants` — 보상권·승인 차감 요청 | `child_id` uuid!; `admission_effect_id` uuid; `manual_award_id` uuid; `asset_id` uuid!; `direction` text!; `amount` numeric; `text_value` text; `business_date` date!; `dedupe_key` text! | `child_id` → `child_profiles`; `admission_effect_id` → `admission_effects`; `manual_award_id` → `manual_awards`; `asset_id` → `asset_types`; UQ(family_id,dedupe_key); UQ(family_id,admission_effect_id); UQ(family_id,manual_award_id); UQ(family_id,id,asset_id) |
| `grant_events` — 권리 승인·검토 이력 | `grant_id` uuid!; `actor_id` uuid!; `kind` text!; `reason` text!; `request_key` uuid! | `grant_id` → `grants`; `actor_id` → `principals`; UQ(family_id,request_key) |

- **`evaluation_subjects`:** 기간은 날짜 [start,end). 같은주간 조건·아이콘 버전변경 시 자동새지급 아님. 월·이벤트 경계는 정책으로 고정.
- **`evaluations`:** 분모·미확인 건수 고정. PARTIAL은완료로보이지않음. 안전한기본안은미확인으로최종미달차감불가, 추가인정은revision.
- **`evaluation_inputs`:** 어떤확인revision을합산/제외했는지설명. 최신값조회변경으로과거결과가바뀌지않음.
- **`condition_results`:** MATCH와한도인정은별개. NO_MATCH는패널티발생이아님. 이행후정정시REVIEW_REQUIRED 경로.
- **`admissions`:** 상한초과도결정행보존. condition_result마다한번. 재평가는기존순권리와차이만생성하는RPC필수.
- **`admission_effects`:** 돈+시간 두효과 개별추적. 전부인정 또는자산별부분정책에따름.0은차단효과이며grant를만들지않음.
- **`manual_awards`:** 별도자유칭찬,규칙조건없음. 현manual_bonus_coupons/manual_money_rewards는bridge로연결하며이미지급된내역재발행금지.
- **`grants`:** 양수량+방향. PANELTY도여기서승인상태이력,실제차감아님. 과거AVAILABLE를사용가능잔액으로변환하지않음.
- **`grant_events`:** 사실 확인과차감승인은별도액션. 변경상태는이력을읽는projection; 원본이벤트불변.

### 7 원장 이행

| 테이블 · 역할 | 주요 필드와 자료형 | FK · 유일성 |
|---|---|---|
| `settlement_runs` — 정산 실행·cutoff | `run_key` text!; `cutoff_at` timestamptz!; `effective_at` timestamptz!; `engine_version` text!; `status` text! | 가족 FK; UQ(family_id,run_key) |
| `fulfillments` — 외부 돈·소원 이행 | `grant_id` uuid!; `actor_id` uuid!; `amount` numeric; `note` text!; `dedupe_key` text! | `grant_id` → `grants`; `actor_id` → `principals`; UQ(family_id,grant_id); UQ(family_id,dedupe_key) |
| `usage_requests` — 시간·포인트 사용 요청 | `child_id` uuid!; `actor_id` uuid!; `request_key` uuid!; `requested_for` timestamptz!; `reason` text! | `child_id` → `child_profiles`; `actor_id` → `principals`; UQ(family_id,request_key) |
| `usage_items` — 사용 자산별 양 | `usage_request_id` uuid!; `asset_id` uuid!; `amount` numeric! | `usage_request_id` → `usage_requests`; `asset_id` → `asset_types`; UQ(family_id,usage_request_id,asset_id); UQ(family_id,id,asset_id) |
| `ledger_entries` — 사용 가능한 자산 원장 | `child_id` uuid!; `asset_id` uuid!; `grant_id` uuid; `usage_item_id` uuid; `reversal_of_id` uuid; `settlement_run_id` uuid; `kind` text!; `delta` numeric!; `business_date` date!; `effective_at` timestamptz!; `reason` text!; `dedupe_key` text! | `child_id` → `child_profiles`; `asset_id` → `asset_types`; `grant_id` → `grants`; `usage_item_id` → `usage_items`; `reversal_of_id` → `ledger_entries`; `settlement_run_id` → `settlement_runs`; UQ(family_id,dedupe_key); UQ(family_id,grant_id); UQ(family_id,usage_item_id); UQ(family_id,reversal_of_id); UQ(family_id,id,child_id,asset_id) |

- **`settlement_runs`:** 자정확정분정산. [이전cutoff,이번cutoff)구간. cutoff후확인분다음실행. 재시작해도ledger dedupe유지.
- **`fulfillments`:** 외부포인트충전/현금전달/소원이행기록이지자동송금아님. v0.1전액이행한번,분할이행은후속확장.
- **`usage_requests`:** 사용승인·잔액검사는거래RPC. 패널티와사용은다른거래종류. 사용자카드잔액믿지않음.
- **`usage_items`:** 사용한단위가시간인지특정포인트인지명확하게FK로참조.
- **`ledger_entries`:** 원장수정/삭제금지. 전액상쇄한번; 새정정효과는새grant. 잔액=sum(효력도래delta). 외부이행route 자산은여기중복적립금지.

### 8 잔차 관측

| 테이블 · 역할 | 주요 필드와 자료형 | FK · 유일성 |
|---|---|---|
| `residuals` — 미분류·판정 불명 잔차 | `child_id` uuid!; `occurrence_id` uuid; `business_date` date!; `raw_payload` jsonb!; `reason_code` text!; `origin_key` uuid! | `child_id` → `child_profiles`; `occurrence_id` → `occurrences`; UQ(family_id,origin_key) |
| `residual_decisions` — 잔차 분류 승인 | `residual_id` uuid!; `revision_no` integer!; `decision` text!; `target_ref_id` uuid; `target_rule_version_id` uuid; `actor_id` uuid!; `effective_from` date!; `reason` text! | `residual_id` → `residuals`; `target_ref_id` → `ref_concepts`; `target_rule_version_id` → `rule_versions`; `actor_id` → `principals`; UQ(family_id,residual_id,revision_no) |
| `daily_snapshots` — 일별 사진 머리 | `child_id` uuid!; `business_date` date!; `revision_no` integer!; `observed_at` timestamptz!; `hold_count` integer!; `residual_count` integer!; `pending_penalty_count` integer!; `settlement_run_id` uuid | `child_id` → `child_profiles`; `settlement_run_id` → `settlement_runs`; UQ(family_id,child_id,business_date,revision_no) |
| `snapshot_assets` — 사진의 자산별 잔액 | `snapshot_id` uuid!; `asset_id` uuid!; `available_amount` numeric!; `pending_amount` numeric! | `snapshot_id` → `daily_snapshots`; `asset_id` → `asset_types`; UQ(family_id,snapshot_id,asset_id) |

- **`residuals`:** unknown은ref에넣지않음. 자동보상/패널티추정금지,자정에도hold를보존.
- **`residual_decisions`:** 기존정본에연결/새종류승인/무효과/유지. 승인다음날이후효력,이미쓴today불변. 소급보상은별도판정·상쇄경로.
- **`daily_snapshots`:** 잔액계산정본아닌관측. 정정후기존사진보존,revision추가.
- **`snapshot_assets`:** 분/원/서비스포인트따로. 외부돈/소원은이행대기상태로표시,내부사용가능잔액과혼동금지.

### 9 전환 감사

| 테이블 · 역할 | 주요 필드와 자료형 | FK · 유일성 |
|---|---|---|
| `source_bridges` — 기존 행 연결·이행 경계 | `source_system` text!; `source_table` text!; `source_id` uuid!; `target_kind` text!; `target_id` uuid!; `already_fulfilled` boolean!; `cutover_at` timestamptz! | 가족 FK; UQ(family_id,source_system,source_table,source_id,target_kind) |
| `request_events` — RPC 멱등 요청 기록 | `actor_id` uuid!; `request_key` uuid!; `action` text!; `payload_hash` text!; `response_payload` jsonb! | `actor_id` → `principals`; UQ(family_id,actor_id,request_key) |

- **`source_bridges`:** 마이그레이션내부감사. target_kind/id는예외적다형참조로전환검증필수; 업무계산에이열만믿지않고각FK로정본조회. 구Sheets데이터이관없음.
- **`request_events`:** 같은키·다른payload거절. 응답저장에는민감인증값제외. transaction성공과같이commit.

