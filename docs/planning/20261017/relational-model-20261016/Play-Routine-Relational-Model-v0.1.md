# Play Routine — 엔티티·관계형 모델 설계 v0.1

**기존 가족·활동·강화물·게시 룰을 버리지 않고, ‘측정과 회차 → 부모 확인 → 기간별 인정 → 보상/차감 권리 → 정산·이행’을 분리해서 확장하는 PostgreSQL 모델입니다.** 보상과 패널티는 같은 관계 구조를 쓰되, 패널티의 사실 확인과 실제 차감 승인은 분리합니다. 특정 집안일을 고정 엔티티 유형으로 만들지 않습니다.

기준: 2026-10-16 작성한 9쪽 Word 「룰의 유형·구조·관계 정의」와 같은 날 08:19 전후의 읽기 전용 DB 분석, 실제 migration 0001·0017~0019. **이번 작업은 설계와 격리 검증이며 운영 DB·계정·입력 룰·배포를 변경하지 않았습니다.** 첨부 SQL은 `pr_model` 독립 스키마의 참조 DDL입니다. 운영 migration이나 완성된 판정·정산 엔진이 아닙니다.

## 1. 먼저 고정할 관계

| 질문 | 설계 결론 |
|---|---|
| 생활습관은 보상 유형인가? | 활동의 내용 분류입니다. 인정 횟수·총량 제한은 생활습관뿐 아니라 어떤 보상/패널티 조건에도 붙습니다. |
| 일·주·월은 테이블을 따로 만드는가? | 아닙니다. 기간 정책과 실제 기간 구간을 저장합니다. `daily_rewards`, `weekly_penalties` 같은 조합 테이블은 만들지 않습니다. |
| R1~R8, P1~P5를 각각 테이블로 만드는가? | 아닙니다. Word의 유형은 구성 패턴입니다. 회차/누적/측정/한도/효과를 조합합니다. |
| 스티커 그림이 같으면 같은 종류인가? | 아닙니다. `sticker_type_id`가 정본이고 `icon_code`는 표시입니다. 합산할 종류·활동을 별도 관계로 정의합니다. |
| 조건 하나에 돈+시간은 두 번 달성인가? | 아닙니다. 조건 인정은 한 번, 그 아래 효과 2개입니다. 효과 두 번째는 선택이며 둘 중 하나를 고르는 선택권이 아닙니다. |
| 패널티는 음수 강화물인가? | 카탈로그 구조는 공통이지만 `direction=PENALTY`를 별도 저장합니다. 양수 차감량과 승인 근거를 저장한 뒤 원장 단계에서 음의 효과로 반영합니다. |
| 지금 5개 룰은 다시 입력하는가? | 아니오. 기존 ID·버전·설명·값은 보존하고 연결표를 만듭니다. 설명과 수치가 충돌하는 항목만 확인이 필요합니다. |
| 아직 모르는 활동은 어디에 넣는가? | `residuals`에 hold로 보관합니다. `ref_nowhere`나 임의 보상·패널티는 만들지 않습니다. |

## 2. 계층과 엔티티 묶음

아래 이름은 **목표 논리 모델**입니다. 동일 역할의 기존 `public.routine_*`를 실제 구현에서 확장할지 새 테이블로 연결할지는 전환 단계에서 정합니다. 인증을 새로 만드는 설계가 아닙니다.

| 층 | 핵심 엔티티 | 한 행이 뜻하는 것 |
|---|---|---|
| 기존 정본·계정 | `families`, `principals`, `child_profiles`, `ref_concepts` | 기존 가족/사용자/자녀/승인된 활동의 안정 식별자. 참조 SQL에는 축약 앵커 4개만 있습니다. |
| 종류·표시 | `asset_types`, `effect_types`, `sticker_types`, `activity_aliases` | 자산 단위, 재사용 강화물·차감 종류, 스티커 종류, 부모가 승인한 동일 활동 연결 |
| 정책·버전 | `rule_series`, `rule_versions`, `metric_definitions`, `period_policies`, `special_events` | 하나의 약속 계보, 동결된 게시 버전, 측정 축, 기간 경계, 실제 이벤트 범위 |
| 합산 대상 | `scope_sets`, `scope_members`, `aggregation_specs` | 어떤 활동/규칙/종류를 어느 기간에 어떤 방식으로 집계하는가 |
| 조건·효과 | `conditions`, `predicate_groups`, `predicates`, `condition_effects` | 기본·추가·중립·패널티 조건과 수치 비교, 조건별 1~2개 효과 |
| 한도 정책 | `limit_policy_series`, `limit_policies`, `condition_limits` | 기간별 인정 횟수 또는 자산별 총량. 규칙 버전과 별개인 한도 계보 |
| 사실·확인 | `assignments`, `assignment_weekdays`, `occurrences`, `observations`, `verifications`, `verified_values`, `sticker_events` | 자녀 배정, 실제 회차, 자녀 보고, 부모 확인 revision, 확정 측정, 스티커 증감 |
| 판정·인정 | `evaluation_subjects`, `evaluations`, `evaluation_inputs`, `condition_results`, `admissions`, `admission_effects` | 안정 판정 대상, 실행 revision, 확인 근거, 조건 적합성, 한도 인정 및 효과 배분 |
| 한도 소비 | `limit_buckets`, `quota_entries` | 자녀·정책 계보·기간별 잠금 단위와 인정 예약·해제 내역 |
| 권리·승인 | `manual_awards`, `grants`, `grant_events` | 독립 보너스 출처, 보상권/차감 요청, 승인·검토 이력 |
| 반영·사용 | `settlement_runs`, `fulfillments`, `usage_requests`, `usage_items`, `ledger_entries` | 정산 실행, 실제 외부 이행, 사용 요청과 자산별 사용, 사용 가능 원장 |
| 잔차·관측 | `residuals`, `residual_decisions`, `daily_snapshots`, `snapshot_assets` | 미분류 사실, 분류 승인, 그날의 상태 사진과 자산별 잔액 |
| 전환·감사 | `source_bridges`, `request_events` | 기존 행과 목표 행의 연결·중복 지급 방지, RPC 재시도 식별 |

**전체 구조는 52개 엔티티(기존 축약 앵커 4개 포함)입니다.** 52개를 한 번에 운영에 추가하자는 뜻이 아닙니다. FK·N:M 관계·revision·감사·관측을 풀어 쓴 전체 모델이며, 구현은 6단계로 나눕니다. 현재 초안 JSON 저장인 `routine_drafts`와 기존 가족 멤버십·보호자 초대는 재사용하므로 참조 DDL에 중복 구현하지 않습니다.

## 3. 주요 관계와 카디널리티

`1:N`은 한 행이 여러 자식 행을 갖고, `N:M`은 연결 테이블을 거친다는 뜻입니다. `0..1`은 선택 관계입니다.

| 부모 → 자식 | 관계 | 왜 필요한가 |
|---|---|---|
| `ref_concepts` → `rule_series` | 1:N | 같은 활동에 독립 약속/규칙을 정의할 수 있으나 같은 사실의 중복 지급은 배정·조건 정책에서 막습니다. |
| `rule_series` → `rule_versions` | 1:N | 수정은 새 버전. 기간 실적과 한도 안정 키는 버전 ID만으로 바뀌지 않습니다. |
| `rule_versions` → `metric_definitions` | 1:N | 정답 수, 총문제 수, 소요 시간 등 여러 측정 축 |
| `rule_versions` → `conditions` | 1:N | 기본 보상, 선택 추가 구간, 중립, 차감 후보를 별도 조건으로 보존 |
| `conditions` → `predicate_groups` → `predicates` | 1:N → 1:N | 그룹 안은 AND, 그룹끼리는 OR. 복합 조건을 설명 문장에만 넣지 않습니다. |
| `conditions` → `condition_effects` | 보상 1:1..2 | 두 번째 보상은 선택. 중립 조건은 효과 0개. 패널티는 초기 정책에서 효과 1개만 허용합니다. |
| `effect_types` → `condition_effects` | 1:N | 강화물/차감 종류 한 번 등록 후 여러 활동에서 재사용 |
| `scope_sets` → `scope_members` | 1:N | 합산할 활동·규칙 계보·스티커 종류의 명시 목록 |
| `conditions` ↔ `limit_policies` | N:M, `condition_limits` | 같은 조건에 하루 횟수·주간 총량·전체 상한을 동시에 적용 가능 |
| `child_profiles` + `rule_versions` → `assignments` | 각각 1:N | 게시된 룰을 누가 언제 수행하는지 연결 |
| `assignments` → `occurrences` | 1:N | 같은 날 회차 1,2,3,4를 따로 기록. 하루 1행 제약 제거 |
| `occurrences` → `observations` / `verifications` | 각각 1:N | 자녀 보고와 부모 확인을 분리, 늦은 확인·정정 revision 보존 |
| `verifications` → `verified_values` | 1:N | 확인한 수치만 계산 정본으로 사용 |
| `verifications` → `sticker_events` | 1:N | 어떤 확인이 어떤 종류 스티커를 몇 개 만들었는지, 정정은 상쇄 |
| `evaluation_subjects` → `evaluations` | 1:N | 같은 주/수행건을 여러 번 재평가하되 새 대상인 것처럼 중복 지급하지 않음 |
| `evaluations` ↔ `verifications` | N:M, `evaluation_inputs` | 실제로 어떤 확인 revision을 포함·제외했는지 설명 가능 |
| `condition_results` → `admissions` → `admission_effects` | 1:0..1 → 1:N | 조건 충족과 한도 인정을 분리. 수행 성공이어도 상한 초과일 수 있음 |
| `limit_buckets` → `quota_entries` | 1:N | 이미 발행 대기인 권리도 한도 예약에 포함. 나중 지급만 세면 초과 발행됨 |
| `admission_effects` / `manual_awards` → `grants` | 각각 1:0..1, 둘 중 하나 | 정규 달성권과 자유 보너스를 명확한 FK로 추적 |
| `grants` → `ledger_entries` 또는 `fulfillments` | 정상 반영 1:0..1 | 자산의 반영 경로 하나만 선택. 외부 이행을 내부 잔액으로 다시 적립하지 않음 |
| `ledger_entries` → 상쇄 `ledger_entries` | 1:0..1 | 원거래 전액 상쇄 한 번. 부분 정정은 원거래 상쇄 + 새 올바른 거래 |
| `residuals` → `residual_decisions` | 1:N | 미분류 사실과 사람의 분류 결정을 보존 |
| `daily_snapshots` → `snapshot_assets` | 1:N | 분·원·서비스별 포인트를 분리한 관측 |

전체 FK는 `ERD-Full.mmd`, 읽기 쉬운 주요 관계는 `ERD-Core.mmd`에 담습니다. 일부 계보·검토 관계는 여러 행에 걸친 의미 검증이므로 아래 RPC 계약이 필요합니다.

## 4. 정본·정책·사실을 섞지 않는 규칙

| 층 | 저장할 것 | 저장하지 않을 것 |
|---|---|---|
| `ref_*` 정본 | 승인된 활동과 종류의 ID·이름·분류 | unknown, 오늘 점수, 돈 보상값 |
| 종류 카탈로그 | 미디어 쿠폰, 용돈, 쿠페이 포인트, 소원 / 차감 종류 / 스티커 종류 | 개인 활동의 임시 판정값 |
| 정책 | 어떤 조건에 어떤 단위·효과·횟수·기간을 적용하는가 | 부모가 아직 확인하지 않은 실제 수행 사실 |
| 수행 사실 | 회차·수행일·보고·부모 확인 수치 | 원장 잔액이나 승인 없는 차감 |
| 판정·권리 | 실제 근거로 어떤 조건이 충족·인정되었는가 | 사용 가능 잔액이라는 추정 |
| 원장 | 승인 후 효력이 생긴 보상·차감·사용·상쇄 | unknown·hold·미승인 패널티 |
| 스냅샷 | 그 시각에 보인 잔액·hold·대기 사진 | 잔액을 다시 계산하는 정본 |

범용 `nodes/edges` 테이블 하나에 모든 것을 넣지 않습니다. **필수 관계는 FK로 강제**하고, 합산 대상·조건-한도 관계는 전용 연결 테이블로 표현합니다. 온톨로지 내보내기는 이 관계를 읽어 만들 수 있습니다. 별도 그래프 DB가 지금의 거래 정합성에 필수는 아닙니다.

## 5. 측정·조건 모델

### 5.1 복합 Quest

| 엔티티 | ‘20문제 중 15개를 3분 내’의 행 |
|---|---|
| `metric_definitions` | `correct_count` NUMBER·COUNT, `total_count` NUMBER·COUNT, `elapsed_seconds` NUMBER·SECOND |
| `verified_values` | 부모 확인 revision에서 정답 15, 총문제 20, 소요 175초 |
| `conditions` | 조건 Q1, PER_OCCURRENCE, REWARD |
| `predicate_groups` | Q1의 그룹 1 |
| `predicates` | `correct_count GTE 15`, `elapsed_seconds LTE 180` — 두 행을 AND |
| `condition_effects` | 효과1 쿠페이 포인트 +30,000, 효과2 미디어 시간 +120분 — 같은 조건의 두 권리 |

수량 150은 유효할 수 있고 백분율 150은 유효하지 않습니다. `metric_definitions.value_kind/unit_code/min/max`와 게시 검증이 범위를 정합니다. 숫자를 전부 0~100으로 제한하지 않습니다. 정답률은 분모 `total_count>0`를 검사하고 `correct_count/total_count`를 계산하며, 원래 두 값도 보존합니다. 이번 참조 DDL은 파생식 실행 엔진까지 구현하지 않습니다.

현재 입력된 ‘15/20’과 ‘80%’는 각각 75%와 16/20이라는 서로 다른 조건입니다. 이번 설계 예는 문장 의도를 표현하는 방법이지 기존 룰을 75%로 바꾼 결과가 아닙니다.

### 5.2 중립·면제·유보

| 값 | 의미 | 효과 |
|---|---|---|
| `NEUTRAL` 조건 + MATCH | 확인 사실이 무효과 구간에 들어감 | 보상·차감 없음 |
| `NO_MATCH` | 특정 조건이 충족되지 않음 | 다른 조건을 검토. 이것만으로 패널티 아님 |
| `HOLD` | 측정·부모 확인·분류가 부족 | 계산 유보, 원장 없음 |
| `EXEMPT` | 부모가 면제·비해당을 명시 확인 | 예정 목표 분모에서 제외 가능 |
| 상한 초과 `LIMITED` | 수행/조건은 성공하나 인정 한도 밖 | 기록 보존, 추가 효과 없음 |

양수 보상 구간과 음수 차감 구간은 같은 측정 축의 `EXCLUSIVE/conflict_group`으로 겹치지 않게 게시 검증합니다. 5개와 8개처럼 여러 보상 조건을 함께 충족하는 경우는 `CUMULATIVE`입니다. 상위 구간은 **추가분**으로 저장해 10,000+5,000=15,000이며 10,000+15,000으로 지급하지 않습니다.

## 6. 스티커·집계 모델

| 관계 | 설계 |
|---|---|
| 종류 | `sticker_types.id`; 학교생활과 공부가 같은 STAR 그림이어도 별도 ID 가능 |
| 발생 근거 | `sticker_events`가 부모 확인 revision·수행건·종류·delta 참조 |
| 그림 | `icon_code`, 선택 이미지 URL. 그림으로 집계하지 않음 |
| 기간 합산 | `aggregation_specs` → `scope_sets`의 명시 구성원 + 기간 정책 |
| 같은 사실 이중 포함 | 활동과 종류 구성원 양쪽에 맞아도 같은 스티커 이벤트/수행 ID를 DISTINCT로 집계 |
| 버전 중간 변경 | `rule_series` 안정 키 유지. 합산 승계는 `allow_version_bridge`와 출처 목록을 명시 |
| 정정 | 원 스티커 행을 지우지 않고 반대 delta 이벤트, 새 올바른 발행 이벤트 추가 |
| 패널티 표식 | `INCIDENT_MARK` 종류. 표식 개수와 차감 분을 따로 기록 |

현재 PASS=1, PASS+칭찬=2인 동작은 기존 버전의 의미로 보존합니다. 새로운 자유 보너스 정책이 그 칭찬 스티커를 대체할지는 미확정이므로 자동 제거하지 않습니다. 시간/돈 보상을 스티커 계정 잔액으로 환산하지 않습니다.

## 7. 기간·횟수·총량을 분리하는 물리 구조

### 7.1 기간

| 축 | 엔티티·필드 | 예 |
|---|---|---|
| 기록 단위 | `assignments.recording_kind`, `occurrences.sequence_no/business_date` | 매일, 필요할 때 여러 회, 시험 한 번 |
| 판정 기간 | `aggregation_specs.period_policy_id` → `period_policies` | 매일 기록한 학교생활을 주간 집계 |
| 인정 제한 기간 | `limit_policies.period_policy_id` | 시험은 수행건 판정, 돈 보상은 월 1회까지만 |
| 실제 이벤트 | `special_events` ID·시작·종료 | 행사 종료까지 실적 누적 |
| 원장 반영 | `settlement_runs.cutoff_at/effective_at` | 자정 확정, 늦은 승인분 다음 실행 |

기간 경계는 `[start,end)` 반개구간으로 정합니다. 날짜는 가족의 사업일 `date`, 액션 시각은 `timestamptz`, 기간 정책에는 당시 시간대를 동결합니다. 주 시작 요일·달력 월/지정 주기·이벤트 범위를 등록하지 않은 정책은 게시하지 않습니다. TIME 입력은 가족의 현지 시각이며 `occurred_at`과 정책 timezone을 함께 확인합니다. 기간 정책을 나중에 수정해 이전 주의 경계를 바꾸지 않습니다.

### 7.2 한도

| 항목 | 저장 구조 | 카운트 기준 |
|---|---|---|
| 인정 횟수 | `limit_kind=COUNT, max_value=N` | 조건 인정 1회. 돈·시간 두 효과여도 1회 |
| 자산 총량 | `limit_kind=AMOUNT, asset_id, max_value` | 분·원·서비스별 포인트 따로 |
| 제한 범위 | `scope_sets` + `condition_limits` | 특정 활동, 명시 묶음, 등록한 자녀 전체 범위 |
| 실제 소모 | `limit_buckets` + `quota_entries` | 이미 예약된 승인·이행 대기분까지 포함 |
| 한도 없음 | 게시 정책에서 연결 한도 없음 | 초안의 ‘아직 미설정’과 구별해 부모가 확인 |
| 0 한도 | `max_value=0` | 인정 불가/예산 0. 제한 없음이 아님 |

**예: 실제 4회, 회당20분, 하루2회 인정.** `occurrences`는4행, `verifications`는각 회차 확인, 조건 결과4행입니다. 첫2회가인정되면권리+20,+20,한도예약1+1입니다. 나머지2회는`LIMITED`로보존하고추가권리는없습니다. 자정에 승인된2건만원장+40분이며 수행4회를실패로바꾸지않습니다. 숫자는예시이지기본정책이아닙니다.

### 7.3 동시 처리와 늦은 입력

1. RPC에서 활성 가족 부모/자녀 권한과 기대 revision을 확인합니다.
2. `request_events`에서 같은 actor+request_key의 payload 해시를 검사합니다. 같은 요청 재시도면 기존 응답, 다른 내용이면 거절합니다.
3. 적용할 일·주·월 한도 버킷을 `INSERT ... ON CONFLICT`로 준비하고 **정렬된 버킷 키 순서로 `FOR UPDATE` 잠금**을 잡습니다. 시간 사용에는 해당 자녀·자산 잠금도 같은 순서로 취합니다. [2]
4. 잠금 아래에서 `SUM(quota_entries.delta)`를 읽어 한도 잔여량을 검사합니다. 조건 인정·효과 배분·예약·권리 발행·감사를 한 트랜잭션으로 commit합니다.
5. 승인 대기 패널티는 예약을 잡되 승인 거절·취소 시 해제합니다. 표식만으로 차감하지 않습니다.

단순 `CHECK(SUM(...)<=N)`는 여러 행을 보장할 수 없습니다. PostgreSQL CHECK의 행간 검증 한계 때문에 기간 합계는 위 RPC 잠금으로 구현합니다. [1] 이번 SQL에는 **한도 집계/동시 RPC가 구현되어 있지 않습니다.**

인정 순서의 안전한 기본 제안은 **이미 확정한 예약을 우선하고, 늦은 기록 때문에 다른 수행의 보상을 자동 박탈하지 않는 것**입니다. 늦은 월요일 기록도 월요일 버킷을 쓰며 화요일 한도를 쓰지 않습니다. 실제 시각 순으로 모든 보상을 재배분하려면 기존 권리·지급분까지 검토하는 별도 정책으로 승인해야 합니다. 순서는 구현 전에 확정할 사용자 정책입니다.

## 8. 사실 확인·패널티 승인·권리의 상태 모델

| 단계 | 보상 | 패널티 | 권한 |
|---|---|---|---|
| 자녀 보고 | 사실 주장 | 문제 발생에 관한 기록만 | 자기 배정·수행건만 |
| 부모 확인 revision | 조건 근거 확정 | 실제 발생/수치 확정 | 활성 부모만 |
| 조건·한도 판정 | 권리 후보, 상한 초과면 효과0 | 차감 요청 후보, 한도 예약 | 판정 RPC |
| APPROVED | 기존 확정 규칙의 부모 확인과 같은 트랜잭션으로 승인 가능 | **별도 차감 승인 이벤트** 필수 | 부모 |
| REVIEW_REQUIRED | 이미 발행/이행된 후 정정 영향 검토 | 차감 정정 영향 검토 | 부모 |
| POSTED / FULFILLED | 내부 원장 또는 외부 실제 이행 | 승인 차감 원장 | 정산/이행 RPC |
| 취소·거절·상쇄 | 대기 권리 취소 또는 원거래 상쇄 | 미승인 거절 또는 오차감 상쇄 | 부모, 근거 필수 |

이벤트의 allowed transition을 RPC가 확인해야 합니다. 단순히 `grant_events.kind='APPROVED'` 행을 클라이언트가 넣는 권한은 주지 않습니다. 격리 참조 SQL에는 상태 코드와 기본 제약만 있고 운영 승인 RPC·RLS 역할은 미구현입니다.

`grants`에는 보상량의 절대값과 방향이 저장됩니다. 원장에만 `REWARD +amount`, `PENALTY -amount`로 들어갑니다. 기록 누락·0스티커·한도 초과는 PENALTY 생성 사유가 아닙니다. 현재 설계의 패널티 자산은 시간만 게시 가능하게 제한하고, 돈·소원 취소·전액 몰수·약 복용 차감은 넣지 않습니다. 후속 승인 없이 확장하지 않습니다.

**패널티 완화 관계:** `mitigation_confirmed` 같은 부모 확인 BOOLEAN 측정과 위반 측정을 별도로 둡니다. 같은 `conflict_group` 안에 ‘위반 AND 완화 없음’ 조건과 ‘위반 AND 완화 확인’ 조건을 배타적으로 구성하고, 각 조건에 부모가 승인한 서로 다른 차감량을 연결합니다. 기존 -80/-50을 기본값으로 넣지 않습니다. 이미 차감한 뒤 완화 사실을 확인했다면 과거 조건을 덮어쓰지 않고 재검토·상쇄·새 거래로 고칩니다.

## 9. 불변 원장·외부 이행·소급

### 9.1 원장과 자산

| 자산 | 권장 경로 | 원장/이행 의미 |
|---|---|---|
| 앱 미디어 시간 MIN | INTERNAL_LEDGER | 실제 사용 가능한 시간의 입출금·사용·상쇄 |
| 용돈 WON | EXTERNAL_FULFILLMENT 제안 | 부모의 실제 지급 확인. 앱 잔액 계좌/자동 송금이 아님 |
| 쿠페이 등 외부 POINT | EXTERNAL_FULFILLMENT 제안 | 해당 서비스로 실제 준 기록. 앱 포인트와 별개 |
| 앱 내부 포인트 | INTERNAL_LEDGER | 정의된 포인트 ID의 가상 잔액 |
| 소원 WISH | EXTERNAL_FULFILLMENT | 텍스트 약속의 이행, 숫자 잔액으로 합산하지 않음 |

외부 돈·포인트의 경로는 실제 운영 선택이며 기존 UNIT을 임의로 바꾸지 않습니다. 하나의 자산 ID를 내부 잔액과 외부 이행 양쪽으로 중복 지급하지 않습니다. 내부 원장이라는 용어는 **가상 보상 입출금**이며 금융 결제·은행 원장이 아닙니다.

### 9.2 원장 한 행의 필드

| 필드 | 관계·뜻 |
|---|---|
| `family_id`, `child_id`, `asset_id` | 가족·자녀·같은 단위의 계정 |
| `grant_id` / `usage_item_id` / `reversal_of_id` | 셋 중 정확히 하나의 출처. 없는 출처 메모로 지급하지 않음 |
| `kind`, `delta` | REWARD(+), PENALTY(-), USAGE(-), REVERSAL(원거래의 정확한 반대) |
| `business_date` | 실제 수행일/발생일 귀속 |
| `recorded_at` | 이 거래를 기록한 실제 액션 시각 |
| `effective_at` | 언제부터 사용 가능 잔액에 들어가는가 |
| `settlement_run_id` | 보상·차감의 정산 실행 근거. 사용 즉시 처리는 별도 승인 정책 |
| `dedupe_key` | 같은 지급·사용·상쇄를 재반영하지 않는 키 |
| `reason` | 부모/자녀에게 보여줄 설명 |

잔액 정본은 `SUM(delta) WHERE effective_at<=조회시각`입니다. 필요 시 별도 잠금용 계정 projection을 두되 다시 원장에서 만들 수 있어야 합니다. `balance_after`나 일별 사진을 거래 정본으로 쓰지 않습니다.

참조 SQL은 원장 UPDATE/DELETE를 차단하고, 같은권리/사용의중복반영과원거래전액상쇄중복을UNIQUE로차단합니다. INSERT trigger는 원장량이 권리/사용량과 일치하는지, 외부 자산이 아닌지, 상쇄량이 원거래의 반대인지 검사합니다. **부모 승인 상태, 잔액 부족, 차감 상한, 실제 정산 대상 선정은 RPC에 남는 필수 검증입니다.**

### 9.3 자정·늦은 확인

기존 결정대로 **보상과 승인 차감의 확정 원장 반영은 가족 시간대 자정 정산**을 기본으로 설계합니다. `settlement_runs`는 cutoff·효력 시각·엔진 버전을 고정합니다. 선택 대상은 ‘cutoff 이전에 승인되고 아직 원장에 한 번도 반영되지 않은 권리’ 전체입니다. 단순 `[이전 cutoff, 이번 cutoff)` 조회만 사용하면 commit이 늦어진 승인분을 빠뜨릴 수 있으므로 하한 시각만으로 대상을 버리지 않습니다.

| 상황 | 귀속·반영 |
|---|---|
| 월요일 수행, 화요일 부모 확인 | 월요일 사실·한도 버킷에 귀속. 승인 후 다음 정산의 effective_at으로 새 거래 추가 |
| 자정 이후 승인 | 지난 잔액 사진을 덮어쓰지 않고 다음 정산 대상으로 남음 |
| 부모 확인 정정 전 보상 미반영 | 과거 확인 유지, 새 revision으로 새 인정 결정·예약 정리 |
| 이미 원장 반영된 +40을 +20으로 정정 | 원래 +40 보존 → -40 상쇄 → 새 +20. 부모 검토/승인 필요 |
| 이미 외부 돈 지급 후 조건 수정 | REVIEW_REQUIRED. 실제 돈을 회수한 것으로 처리하거나 자동 음수 적립하지 않음 |
| 사용 가능 잔액을 이미 소비한 뒤 보상 취소 | 원거래 재계산만으로 사용 기록 삭제 금지. 잔액 하한/회수 처리 정책은 부모 결정 필요 |

**사용 차감 시점은 아직 확정하지 않은 운영 선택입니다.** 권장안은 보상·패널티 확정은 자정, 실제 사용은 승인 시점에 원장 차감하여 재사용을 막는 것입니다. 원장을 전부 자정에만 쓰겠다면 낮의 사용 요청에 별도 사용 예약을 두고 ‘사용가능 = 확정잔액 - 미반영 사용예약’으로 계산해야 합니다. 현재 참조 DDL의 `usage_requests/items`는 출처 모델이며 두 번째 방식의 예약 엔진은 추가 구현 대상입니다. 이 선택을 결정하지 않고 시간 사용 기능을 게시하지 않습니다.

## 10. 기간 목표의 미확인·완료·중간 판정

| 데이터 | 뜻 |
|---|---|
| `eligible_count` | 부모 면제 등을 제외한 판정 대상 수 |
| `confirmed_count` | 실제 확인된 대상 수 |
| `hold_count` | 미확인 건수. 실패로 환산하지 않음 |
| `excluded_count` | EXEMPT/VOID 등 명시 제외 건수 |
| `evaluation_inputs` | 실제 포함한 확인 revision의 목록 |
| `completeness` | PARTIAL / FINAL / HOLD |

안전한 기본 제안은 단조 누적 보상에는 확인된 실적으로 중간 달성권을 인정할 수 있으나, **미확인이 남아 있는 기간을 최종 미달 패널티로 닫지 않는 것**입니다. 백분율은 예정 분모·면제 분모·미확인 수를 모두 표시하고 FINAL일 때만 확정 비교하거나 부모가 불완전 판정을 명시 승인해야 합니다. FINAL 후 늦은 확인도 같은 `evaluation_subjects`의 새 revision이지 새 지급 기간이 아닙니다.

추가 구간 8개 달성으로 재평가할 때 기존5개기본권리를새로발행하면안됩니다. 판정RPC는안정subject+condition stable_key+effect stable_key의**이미발행된순권리**와새목표를비교해차이만반영합니다. UNIQUE(evaluation,result)만으로 이중지급이 막히는 것은 아닙니다. 게시 버전이 바뀔 때의 승계 목록·조건 계보는 부모 승인이 필요합니다.

## 11. 현재 입력한 5개 룰을 어떻게 연결하는가

다음은 08:19 전후 보존 조회값입니다. 11시 현재 DB를 다시 조회하거나 값을 바꾼 결과가 아닙니다.

| 기존 룰 | 목표 관계 | 보존할 값 | 별도 확인 |
|---|---|---|---|
| 학교생활 | DAILY 계보 → 학교 스티커 종류 → 주간 aggregation → 누적 조건2개 | 5개 +10,000POINT, 8개 추가 +5,000POINT | 주 경계, 칭찬2개 유지, 서비스POINT/원화 구별 |
| 밀크티 학습지 | DAILY 계보 → SMILE 표시 종류 → 일별 확인/조건 | ≥1스티커 +40MIN | 구버전 밀크티와 같은 활동이면 alias승인·배정경계 연결. 이름만으로 합치지 않음 |
| 기초연산 2000 | QUEST 계보 → 수치 조건 →11/1 ONCE 이벤트/배정 | 수량80이상 +120MIN, 60미만 후보80MIN | 점수/수량, 이하/미만,1시간/80분 충돌을 부모가 정함 |
| 기탄수학 G5 하루 3장, 나눗셈 | DAILY 계보 → STAR 표시 종류 → 일별 조건 | ≥1스티커 +40MIN | 실제 여러 회 수행과 추가 인정 여부를 한도 정책으로 선택 |
| 기탄수학 G5 나눗셈 20문제 3분 시험 | QUEST 계보 → 복수측정 정의 → AND 조건 →효과2개 | 현재80% +30,000POINT 및+120MIN, 하한후보120MIN | 15/20=75%와80% 충돌,3분측정 구조 필요. 새버전으로 명시 수정 |

현재 저장값을 무단으로 ‘정상화’해서 변경하지 않습니다. 특히 POINT를WON으로바꾸거나패널티후보를즉시차감하지않습니다. 게시된룰과자녀배정은별도관계이므로설계완료만으로자녀화면이모두작동한다고보고하지않습니다.

## 12. 잔차·today·스냅샷

| 대상 | 물리 모델 | 처리 |
|---|---|---|
| today 실시간 | 수행·확인·판정·미반영권리를 읽는 VIEW/RPC projection | 날짜별 새 테이블 안 만듦. 버전/수행일/hold/예정 분리 |
| 알 수 없는 사실 | `residuals` | 원문·원천 사건·일자 보존. ref·ledger에 추정값 넣지 않음 |
| 분류 승인 | `residual_decisions` | 기존 ref 연결/새 승인 종류/무효과/hold. 다음날이후효력,기존today줄변경안함 |
| 이미 지난 사실의 지급 요청 | 별도 verification/evaluation/grant 경로 | 분류 승인과 소급 보상을 같은 액션으로 묶지 않음 |
| 일별 사진 | `daily_snapshots`, `snapshot_assets` | 관측 시각·revision·자산별 잔액·hold·패널티 대기 |

생활습관으로 분류됐다는 이유만으로 보상을 주는 정책이 생기지 않습니다. 종류 연결과 효과 정책 연결은 별개입니다. 원래 source event·parent decision을 따라 관계를 추적할 수 있어 이후 노하우/온톨로지 내보내기가 가능합니다.

## 13. 키·제약·권한·인덱스

### 13.1 물리 원칙

| 규칙 | SQL에서 적용 | RPC/게시 검증에 남는 것 |
|---|---|---|
| 가족 격리 | UUID PK + `UNIQUE(family_id,id)` + 가족을 포함한 복합 FK | actor가 활성 가족의 부모/자녀인지 |
| 관계 경로 일치 | 같은조건/측정/확인버전, 같은배정/자녀/계보/버전, 같은지급자산복합FK | 판정 대상의계보·집계scope 전체,인정효과가정확한조건결과아래인지 |
| 숫자 정확성 | numeric 유한값, 정수단위량 검사. 소수값 반올림 거절 | 측정 단위,0~100백분율,카탈로그route,특정정책 범위 |
| 조건 효과 개수 | position1..2 + 조건별position유일 | REWARD최소1개·PENALTY초기1개·NEUTRAL0개,소원text/숫자amount 일치 |
| 관계 존재 | 명시 FK + ON DELETE RESTRICT | 별칭 순환,버전 승계 의미,조건 그룹 충돌/구간 공백 |
| 하루회차 | UNIQUE(assignment,date,sequence), origin_key | 예정없음/발생형허용,미래날짜 정책,수행일 정정 |
| 불변성 | 게시·확인·권리·원장·관측 UPDATE/DELETE trigger차단 | 잘못된행을상쇄/새revision으로처리하는 상태전이 |
| 기간상한 | 정책·버킷·소모행 구조 + 안정키 UNIQUE | 잠금후집계·예약,한도방향·적용기간·동시성 |
| 정산중복 | grant/usage/reversal 유일원장참조 | 승인완료검사·정산대상선정·잔액부족·사용예약 |
| 스냅샷 | UNIQUE(child,date,revision), 자산별행 | 생성cutoff와 실제원장 기준 일치 |

CHECK는 행 단위이며 자식행 개수·타 테이블 합계·actor역할을 일반 CHECK로 대체할 수 없습니다. 필요한 지점은 FK·UNIQUE·트리거·검증 RPC로 나눕니다. [1]

수행/확인/원장 시간이 `timestamptz`인 이유는 현재 PostgreSQL 실제 스키마와 UTC 액션 보존을 따르기 때문입니다. 클라이언트에서는 ISO/Unix로 전달·표시 변환할 수 있지만 사업일 `date`를 입력 시각의 UTC 날짜로 바꾸지 않습니다. 금액·포인트·분은 부동소수점이 아니라 정수 단위 `numeric`입니다.

### 13.2 RLS와 역할

| 주체 | 읽기 | 쓰기 |
|---|---|---|
| 부모 | 자기 가족의 룰·확인·권리·원장·감사·CSV | 검증 RPC로만 초안/게시/배정/확인/한도/차감승인/이행/정정 |
| 자녀 | 자기 배정·기록·확인 이유·권리·사용가능잔액·룰 | 자기 사실 보고·사용 요청만. 부모확인·차감승인·원장직접쓰기 불가 |
| 보호자 GUARDIAN | 기존 허용된 상태창 projection만 | 없음. 원시 감사·측정·부모 설정·CSV로 확대하지 않음 |
| 익명 | 가입·인증 UI 외 가족 데이터 없음 | 없음 |
| 서버 정산 역할 | 승인된 대상 조회·정산RPC | 원장 쓰기 RPC,사용자권한과분리한실행권한 |

운영은 기존 `current_principal_id/is_active_parent/is_child_profile_self`와 보호자 상태창RPC를 재사용합니다. 모든 domain row에서family FK가맞아도그계정이그가족에속했다는뜻은아닙니다. 클라이언트 직접INSERT/UPDATE/DELETE/TRUNCATE 권한을 주지 않습니다. `SECURITY DEFINER`는 `search_path=''`와 명시 schema·권한 검사·최소 EXECUTE grant가 필요합니다. DB owner/service role은 RLS를 우회할 수 있어 서버 경로에서 별도 인가가 필수입니다. [3]

참조 SQL은 RLS ENABLE+일반 PUBLIC권한회수+정책없음으로 작성되어 **일반 역할은 default deny**입니다. 완성된 부모/자녀/보호자 RLS 정책을 설치한 파일이 아닙니다. 격리 시험의 소유자 역할 통과를 실제 가족 접근 시험이라고 말하지 않습니다.

### 13.3 주요 인덱스

| 인덱스 | 대상 질의 |
|---|---|
| occurrence(family,child,business_date,sequence) | 오늘·과거회차 조회 |
| verification(family,occurrence,revision DESC) | 해당회차 최신부모확인 |
| ledger(family,child,asset,effective_at) | 사용가능잔액과자산별거래 |
| quota(family,bucket) | 한도순소모 |
| condition/rule/metric·관계 UQ | 게시내용복원·조건효과중복차단 |
| bucket stablekey+period+event NULLS NOT DISTINCT | 일반기간·특별이벤트 모두 버킷중복차단 |

모든 FK 열에 무조건 인덱스를 중복 생성하지 않고 실제 조회·삭제제한·트랜잭션 실행계획을 보고 후속 튜닝합니다. 참조 DDL의 NULLS NOT DISTINCT는 PostgreSQL15이상 문법입니다.

## 14. 현재 DB 보존형 구현 순서

| 단계 | 구현·검증 | 기존 입력 보존 |
|---|---|---|
| 1 종류·안정키 | 자산·패널티·스티커 종류,계보·alias,기존행bridge | 기존ref/강화물/rule_group_id ID 유지. Sheets 이관 없음 |
| 2 회차·측정·확인 | 하루N회,복수측정,확인revision·단위범위 | 기존하루행은sequence1로연결. 자녀계정/RLS 유지 |
| 3 조건·기간·한도 | AND/OR,기간집계,명시대상,횟수·총량예약 | 원래게시JSON불변. 미해결설명/수치충돌은새버전게시전확인 |
| 4 판정·권리·승인 | evaluation근거·중간판정·기본/추가차이·패널티승인 | 이미발행/이행된권리중복생성차단 |
| 5 원장·사용·정산 | 자산별원장·상쇄·cutoff·외부이행·사용정책 | 시작잔액은명시승인. AVAILABLE권리를전부잔액으로자동변환안함 |
| 6 잔차·사진·전환 | 잔차분류·상태사진·CSV·today읽기전환 | 해시/개수보존검증,구등록기쓰기종료·새등록기쓰기시작을명시 |

과도기에도 **한 원천 사실은 한 정본 쓰기 경로**로 처리합니다. 구·신규 테이블 양쪽에서 권리를 발행하는 dual-write는 하지 않습니다. `source_bridges`는 전환 감사이며 계산은 업무FK로 추적합니다. 이미 외부 지급된 권리는 `already_fulfilled`와 기존 이행 이력으로 연결하고 새로운 원장 적립을 만들지 않습니다.

같은 활동 이름인지는자동으로판단하지않습니다. 부모가밀크티/밀크티학습지의동일성을승인하면canonical연결,배정종료·시작경계,당일출처중복을검사합니다. 원래 확인·수행 날짜는변경하지않습니다.

## 15. Word의 유형이 모델에 들어가는 위치

| 유형 | 구성하는 관계 |
|---|---|
| R1 단위 수행 | occurrence→verification→PER_OCCURRENCE condition→effect |
| R2 인정 횟수 제한 | 위조건 + COUNT limit_policy + bucket/quota |
| R3 누적 구간 | sticker_events→aggregation→PER_PERIOD cumulative conditions→기본/추가효과 |
| R4 수치 구간 | numeric metric→predicate→exclusive/보상조건→effect |
| R5 복합 Quest | 여러metric→같은predicate_group 안 AND |
| R6 기간 목표 | 배정예정량+명시면제→aggregation분모→evaluation completeness→조건 |
| R7 이벤트 | special_event ID→배정/집계/한도범위 |
| R8 자유 보너스 | manual_award→grant→정산 또는이행. 정규조건 없음 |
| P1 발생 확인 | occurrence.kind=INCIDENT→verification→PENALTY condition→승인 |
| P2 반복 발생 | 회차별incident + COUNT/AMOUNT limits |
| P3 Quest 하한 | LT/LTE predicate + PENALTY direction + 승인 |
| P4 기간 미달 | 완전성검사된period subject + 낮은조건 + 승인. hold실패환산금지 |
| P5 실제 사용 초과 | usage측정·허용량검증→별도확인된incident + 정책조건. 과거×3배수 복원안함 |

기간 목표의연속수행(STREAK)·파생비율·사용초과·완화조건실행은향후엔진구현과검증이필요합니다. 테이블이있다는이유로이운영기능이완성됐다고말하지않습니다.

## 16. 남은 정책 결정 — 모델은 수용하되 자동 확정하지 않음

| 쟁점 | 모델이 지원하는 선택 | 설계 권장 기본안 / 경계 |
|---|---|---|
| 인정순서 | 확정순/실제수행순/부모선택 | 이미확정한권리자동박탈안함. 수행순재배분은별도검토 |
| 부분보상 | WHOLE_CONDITION/PARTIAL_ASSET | 두효과의의도를보존하려면whole먼저. 부분은부모명시 |
| 주·월 경계 | 주시작요일/달력월/지정일수/이벤트 | 빈칸을월요일/30일로자동추정해게시안함 |
| 미확인마감 | 중간보상/최종hold/부모명시확정 | 미확인때최종미달차감안함 |
| 규칙기간중변경 | 버전단절/승인된합산승계 | 새rule_id로기간권리한번더발행안함 |
| 하루칭찬2스티커 | 유지/새규칙변경 | 기존값보존. 자유보너스도별도 |
| 패널티다중효과 | 초기1개/후속2개 | 보상1~2개승인과패널티2개승인은별개 |
| 잔액하한·실사용취소 | 0하한/수동미반영/부채검토 | 승인없는음수잔액정책없음 |
| 사용차감시점 | 즉시원장/자정+사용예약 | 재사용방지방법을확정하기전배포금지 |
| 외부돈·포인트 | 외부이행/내부자산 | 서비스포인트·WON혼합환산금지 |
| 현Quest충돌 | 설명기준/저장값기준 | 부모확인후새버전. 현재값자동변경안함 |

## 17. 이번 검증과 구현 경계

첨부 DDL을 운영과 분리된 인메모리 PostgreSQL(PGlite)에 생성해 PK·FK·CHECK·UNIQUE·원장 trigger를 시험했습니다. **실제 제약 시험 20개 통과**했으며 **실제 제약 시험 20개 통과**했으며 **실제 제약 시험 20개 통과**했으며 결과는 `Validation-Result.json`에 있습니다. **실제 Supabase에 테이블을 추가하거나 실제 부모·자녀로 새로운 통합시험을 한 것은 아닙니다.**

| 검증 영역 | 이번 결과 | 후속 필요 |
|---|---|---|
| SQL 생성·관계 존재 | 52개 테이블 생성 | 실제Supabase버전·역할·schema권한을맞춘migration |
| 가족·게시버전·자산 FK | 잘못된가족참조거절,경로강화제약 생성 | 모든RPC actor권한·판정경로 통합시험 |
| 회차·정수·숫자 | 하루4회저장·회차중복·150수량·NaN/소수효과거절 | 현장입력UX·모든측정형 검증 |
| 선택보상·방향 | 세번째효과위치거절·보상/차감혼합거절 | 최소개수·패널티1개 정책게시검증 |
| 원장·상쇄 | 중복적립·과적립·UPDATE/DELETE·틀린상쇄·외부자산적립거절 | 실제승인·한도·잔액하한·정산실행 |
| 운영RLS·동시한도 | 이번엔실행안함 | 부모/자녀/보호자·타가족·동시승인/사용 롤백시험 |

반드시 후속 검증할 반례: 동시에남은1회한도를두부모가소비 / 월요일늦은입력 / 기본5개후8개추가달성 / 기간중버전변경 / 미확인미달 / 원장사용후정정 / 외부포인트실지급후정정 / 이벤트기간겹침 / 구·신밀크티중복배정 / 같은STAR종류혼합 / 잔차승인후소급의분리.

## 근거

[1]: https://www.postgresql.org/docs/current/ddl-constraints.html "PostgreSQL — 복합 외래키·UNIQUE·CHECK 제약과 행간 검증 한계"
[2]: https://www.postgresql.org/docs/current/explicit-locking.html "PostgreSQL — FOR UPDATE, 잠금 순서, advisory lock 및 교착 방지"
[3]: https://www.postgresql.org/docs/current/ddl-rowsecurity.html "PostgreSQL — RLS default deny와 owner/BYPASSRLS 예외"

프로젝트 근거: 원본 Word v0.1(2026-10-16), 「현재 원장·규칙과 운영방식 대조표」(08:19 전후조회), `0001_identity_auth.sql`, `0017_routine_v2.sql`, `0018_cross_registry_assignment_guard.sql`, `0019_unused_reinforcer_removal.sql`. 현행 모델의 개인식별자·이메일·비밀값·인증URL은 결과물에 포함하지 않았습니다.

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

