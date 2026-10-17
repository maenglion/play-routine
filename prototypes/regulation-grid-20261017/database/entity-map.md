# Play Routine 격리 PostgreSQL 엔티티 맵

> **범위:** `pr_design`은 운영 DB·기존 앱·Git·브라우저를 변경하지 않는 독립 PGlite/PostgreSQL 프로토타입이다. seed의 규정·자산·계획·규칙은 모두 **DRAFT / 운영 승인 미완료**이며, 운영 게시 또는 지급 승인을 뜻하지 않는다.

## 정본 관계와 보존 원칙

| 영역 | 테이블 | 정본 키·관계 | 강제/보존 원칙 |
|---|---|---|---|
| 가족 격리 | `families`, `family_memberships`, `children` | 거의 모든 자원에 `family_id`; 자녀·멤버 참조는 `(id, family_id)` 복합 FK | 가족 횡단 자녀/멤버 참조를 물리적으로 거절한다. |
| 상위·하위 규정 | `regulations`, `regulation_versions`, `regulation_version_relationships`, `version_compatibilities` | `PR-BASIC` → `PR-TASK` / `PR-QUEST` / `PR-LIFESTYLE`, lifecycle 의존 | 버전 전문은 append-only다. `monthly_plans`는 상위 규정 버전도 참조한다. |
| 개별 시행규칙의 규정 근거 | `rule_identities`, `rule_versions`, **`rule_governing_versions`** | `(family_id, rule_version_id, regulation_version_id)` 복합 FK bridge; trigger가 규칙 kind와 하위 규정 kind 일치를 검사 | 26 seed 규칙 각각이 정확히 TASK/QUEST/LIFESTYLE 하위 규정 DRAFT 버전에 연결된다. 운영 RPC는 게시된 규칙과 게시된 동일 kind 근거 규정이 모두 있어야 한다. |
| 조건·효과 정본 | **`rule_conditions`**, `rule_effects` | `(family_id, rule_version_id, condition_code)` 유일; `rule_effects`의 같은 3열 FK | `condition_spec` 원문 JSON은 유지하고, 조건별 `source_predicate` JSON leaf와 effect의 조건 코드를 분리·고정한다. 효과는 조건당 ordinal 1–2다. |
| 강화물 | `asset_identities`, `asset_versions` | ID와 불변 버전, 자산 단위·제공 방법 | `COUPAY_KRW`, `CASH_KRW`, `MINUTES`는 환산/합산하지 않는다. |
| 월 채택·일정 | `monthly_plans`, `plan_governing_versions`, `plan_rule_adoptions`, `recurrence_templates`, `scheduled_occurrences` | 계획은 규칙의 복사본이 아닌 정확한 버전 참조; 예정 회차는 채택/규칙 버전을 고정 | 불완전 템플릿은 지급 근거가 아니다. |
| 사실·판정 | `source_events`, `measurements`, `parent_confirmations` | 사실 → 측정 → 부모 확인 | 원천사건과 부모 판정은 append-only다. |
| 학교 스티커 | `sticker_types`, `school_day_assessments`, `sticker_awards` | 기본 0/1 평가와 학교 칭찬 +1을 분리 | final 정산은 해당 school scope·`SCHOOL` type·`SCHOOL_PRAISE` 원천만 센다. `UNCONFIRMED`은 0이 아니다. |
| 안정 기간·생활 한도 | `stable_rule_scopes`, `aggregation_periods`, `recognition_limit_buckets`, `recognition_limit_uses`, `lifestyle_recognition_results`, `effect_applications` | 기간 정본 키는 가족·자녀·stable scope·start/end·timezone; 계획/버전 미포함 | 모든 기간은 **`[starts_on, ends_on)`**: start 포함, end 제외이며 `ends_on > starts_on`이다. |
| 보상권·이행 | `reward_rights`, `reward_correction_events`, **`school_execution_batches`**, `actual_reward_executions` | 1개 요청 batch와 권리별 분할 실행 행 | batch 요청 키는 family 단위로 유일하며, replay의 period/external reference 불일치는 거절한다. 실행 행은 권리 잔여량을 넘지 못한다. |
| 모델 원장 | `immutable_ledger_entries` | `family_id`, `source_kind`, `source_id`의 append-only 모델 행 | **실제 정산 원장이 아니다.** 현재 child/asset/period/source FK가 없으며 잔액·송금·충전·자동회수는 구현하지 않았다. |
| 민감 기록 | `medication_records` | 자녀/기록자 가족 FK | 약물 기록은 L-013 패널티의 자동 입력·자동 판정·자동 차감 원천이 아니다. |

## 핵심 RPC 계약

| RPC | 강제하는 계약 | 명시적 비범위 |
|---|---|---|
| `recognize_lifestyle_event()` | 부모 역할, 가족 자녀, **전체 요청**(payload·rule version·occurred_at·event type) 동일 재전송만 idempotent, timezone business day 한도 원자 소비 | 임의의 모든 `condition_spec`을 평가하지 않는다. 자동 효과는 **양수·NULL 아님 reward가 있는 하나의 조건 Lifestyle**만 허용한다. 다중 조건/미구현 조건은 거절한다. |
| `approve_penalty_event()` | 부모·사유, 전체 요청 동일 replay, **음수값이 정의된 Lifestyle**만 허용 | 다른 규칙이나 양수 Lifestyle을 penalty로 쓰지 않으며 자동 차감/원장 반영을 하지 않는다. |
| `settle_school_period()` | `[start,end)` 회차/평가/칭찬 집계, final 시 feedback source와 `parent_confirmation_id` 및 `RECOGNIZED` 확인, `UNCONFIRMED`/문제+칭찬/unknown+praise 보류, 0–4→0·5–7→10,000·8+→15,000 배타 총액 | 일반 주간 경계·일반 중간지급·문제+칭찬 정책·칭찬 상한은 운영 승인 전 미정이다. 지급 effect 버전은 기간 내 예정 회차의 **정확히 하나인** rule version과 정확히 한 effect에서 resolve한다. |
| `execute_school_outstanding()` | `REVIEW_REQUIRED` 기간은 실행 거절. 총 잔여액을 하나의 batch로 반환하되, 오래된 권리부터 권리별 잔여 상한에 맞춰 여러 `actual_reward_executions`으로 분할 | 실제 Coupay API, 결제/충전, 원장 정산, 동시 부하 보장은 구현하지 않았다. |

## 권한·게시·테스트 경계

- raw table/sequence의 `PUBLIC` 권한은 회수한다. 배포 시 인증 앱 역할에는 명시 RPC `EXECUTE`만 부여하는 것이 전제다.
- `SECURITY DEFINER` 함수는 `assert_parent()`로 활성 부모를 확인한다. JWT 문자열 파서는 서명을 검증하지 않으므로 **API gateway/server가 signature·issuer·audience를 먼저 검증하고 요청별 claims를 설정해야 한다.**
- DRAFT seed로 RPC를 호출하거나 `p_test_only_interim=true`를 넘기는 것만으로 운영 권한이 생기지 않는다. `current_setting('pr_design.test_mode')='on'`인 **격리 fixture**에서만 DRAFT와 test-only interim을 허용한다. 운영은 `PUBLISHED` 규칙 및 그 게시 근거 규정 버전이 필요하다.
- `samples.sql`은 `BEGIN` 안에서 서명 검증 전제 claims와 fixture `test_mode`를 `set_config(..., true)`로 설정하고 마지막 `ROLLBACK`한다. placeholder 실행문은 주석으로만 남겼다.

## 검증 결과와 한계

이 `database` 폴더에서 `npm run verify`를 실행하면 PGlite에서 **39개 검사**를 재현한다. 설계 테이블은 38개다. 반례에는 기간 end 제외, Lifestyle/penalty의 date·rule replay 불일치, DRAFT 운영 호출 거절, client bool만의 interim 거절, 10,000+5,000 권리의 한 batch 2행 분할, 직접 overspend 거절, `REVIEW_REQUIRED` 실행 거절, parent confirmation 누락, unknown/problem+praise final 보류가 포함된다. fixture의 feedback confirmation은 `source_events → parent_confirmations → school_day_assessments` 실제 FK 사슬로 구성한다. `node verify-samples.mjs`는 schema·seed·samples 전체를 새로운 메모리 엔진에서 실행한다.

다음은 **검증하지 않았거나 구현하지 않았다**.

- PGlite는 단일 연결 직렬 시험이다. 실제 PostgreSQL의 다중 연결·동시 트랜잭션·부하 시험은 미검증이다.
- 실제 REST endpoint, JWT 서명 검증 통합, RLS 정책과 배포 role grant는 미검증이다.
- 모든 규칙의 임의 조건/수식 평가 엔진은 없다. `condition_spec`/`rule_conditions`는 정본 보존과 effect 연결이고, 자동 Lifestyle 적용 범위는 위의 단일 조건으로 의도적으로 좁다.
- 운영 승인, 게시 workflow, 사용자 확정 주간 경계, 실제 외부 지급/회수와 실제 원장 정산은 미구현이다.
