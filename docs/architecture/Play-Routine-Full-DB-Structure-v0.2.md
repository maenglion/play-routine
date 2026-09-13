# Play Routine 전체 DB 구조 v0.2

**작성자: Manus AI**  
**DB:** Supabase PostgreSQL  
**상태:** Auth·가족 영역은 실제 적용, 나머지는 물리 migration 전 통합 설계

![Play Routine 전체 DB ERD](/manus-storage/Play-Routine-Full-ERD-v0.2_571c0e34.png)

## 1. 핵심 결정

Play Routine의 데이터는 **신원·가족, 설정·정책, 일상 사건, 평가·설명, 정산·원장, 보상 권리, 약 복용 지원, ref 지식, 잔차·AI 후보, 운영 감사**의 열 영역으로 나눈다. 모든 운영 데이터는 `family_id`와 안정적인 UUID를 사용하며, 가족 간 참조는 복합 외래키 또는 검증 함수로 차단한다.

`ACTIVITY_ENTITLEMENT`는 새 보상 제공 유형이다. 자녀가 해야 하는 일반 과제 `activity`와 이름이 충돌하지 않도록, 물리 DB에서는 `reward_catalog_items.reward_kind='ACTIVITY'`와 `reward_entitlements`로 표현한다. 정책 효과 코드는 `ISSUE_ENTITLEMENT`다.

## 2. 전체 영역

| 영역 | 정답 데이터 | 주요 테이블 |
|---|---|---|
| Auth·가족 | 누가 어느 가족에서 어떤 역할인지 | `principals`, `families`, `family_memberships`, `child_profiles`, `child_invitations` |
| 설정·정책 | 현재 게시된 활동·일정·판정·효과 | `family_config_versions`, `activity_templates`, `activity_versions`, `policy_sets`, `policy_rules`, `policy_bands`, `policy_effects` |
| 일상 사건 | 실제 수행·체크·관찰·확인·정정 | `assignments`, `activity_events`, `activity_event_status`, `measurements`, `evidence_records`, `verifications` |
| 평가·설명 | 어떤 기준으로 어떤 결과가 나왔는지 | `evaluations`, `evaluation_results`, `child_explanations`, `effect_candidates` |
| 정산·원장 | 확정 효과와 사용 가능 잔액 | `settlement_periods`, `settlement_runs`, `settlement_run_effects`, `asset_accounts`, `ledger_events`, `ledger_entries`, `daily_snapshots` |
| 보상 권리 | 물품·쿠폰·체험 활동의 발행·이행 | `reward_catalog_items`, `reward_activity_options`, `reward_entitlements`, `reward_entitlement_events`, `reward_activity_bookings`, `coupon_instances`, `coupon_state_events`, `coupon_redemptions` |
| 약 복용 지원 | 알림·자녀 주장·부모 관찰을 점수와 분리 | `medication_plans`, `medication_schedules`, `medication_events`, `medication_confirmations`, `reminder_deliveries` |
| ref 지식 | 승인된 개념과 허용 관계 | `ref_concept_types`, `ref_concepts`, `ref_relation_types`, `ref_relations`, `ref_aliases` |
| 잔차·AI | 아직 모르는 것과 사람 승인 과정 | `residual_cases`, `residual_evidence`, `residual_candidates`, `residual_decisions`, `residual_applications`, `ai_suggestion_runs`, `knowledge_candidates`, `knowledge_reviews` |
| 운영 감사 | 알림·비동기 전송·CSV 내보내기 감사 | `notifications`, `outbox_events`, `csv_export_events` |

## 3. 실제 적용된 Auth·가족 영역

현재 Supabase에는 아래 구조가 이미 적용되어 있다.

| 테이블 | 관계 |
|---|---|
| `principals` | `auth.users`와 0..1:1, 서비스 내부의 안정적 행위자 ID |
| `families` | 한 부모 principal이 생성, 여러 membership·자녀 profile 보유 |
| `family_memberships` | principal과 family의 다대다 역할·유효기간 연결 |
| `child_profiles` | 가족 소유, 가입 후 CHILD principal과 연결, `avatar_url`·`avatar_storage_key`로 작은 프로필 사진 참조 |
| `child_invitations` | 가족·자녀 profile·초대 부모·인증 이메일 fingerprint 연결 |
| `invitation_delivery_events` | OTP 요청·전송·실패·제한 append-only 로그 |
| `auth_link_events` | 연결·해제·재연결 감사 이력 |
| `notifications` | principal별 계정·운영 알림 |

## 4. 설정·활동·정책 영역

| 테이블 | 핵심 키·필드 | 관계·제약 |
|---|---|---|
| `family_config_versions` | `family_id`, `version`, `status`, `effective_from/to` | 한 가족에 같은 버전 1개; `DRAFT→PUBLISHED→RETIRED` |
| `activity_templates` | `family_id`, `stable_key`, `category_code` | `DAILY_STUDY`, `SPECIAL_SCHEDULE`, `LIFE_HABIT`, `OTHER` |
| `activity_versions` | `activity_template_id`, `config_version_id`, `version` | 게시 후 불변; 과거 assignment 재현 |
| `schedule_policies` | `activity_version_id`, 반복·마감·유예 정책 | 활동 버전 1:N |
| `assignments` | `family_id`, `child_profile_id`, `activity_version_id`, `business_date` | 자녀에게 실제 부여된 한 건 |
| `policy_sets` | `family_id`, `config_version_id`, `version`, `status` | 가족별 게시 규칙 묶음 |
| `policy_rules` | `policy_set_id`, `subject_ref_id`, `priority`, `verification_mode` | 활동·분류 ref를 판정 정책에 연결 |
| `activity_policy_bindings` | `activity_version_id`, `policy_rule_id` | 활동과 규칙의 명시적 M:N |
| `policy_dimensions` | `policy_rule_id`, `measurement_kind`, `unit`, `required` | 점수·수행량·시각 등 평가 축 |
| `policy_bands` | `policy_dimension_id`, `value_range`, `outcome_code` | range exclusion으로 구간 중복 금지 |
| `policy_effects` | `policy_band_id`, `effect_kind`, `asset_code`, `amount`, `reward_catalog_item_id`, `quantity` | `LEDGER_DELTA` 또는 `ISSUE_ENTITLEMENT` |
| `cap_policies` | 일·주·월 상한과 하한 | 효과에 선택 적용 |

`REWARD`, `NO_REWARD`, `PENALTY`, `NOOP`는 판정 결과다. `UNVERIFIED`, `UNKNOWN_OUTCOME`, `HELD_CONFLICT`는 처리 상태이므로 같은 enum에 넣지 않는다.

## 5. 사건·평가·설명 영역

| 테이블 | 핵심 책임 |
|---|---|
| `activity_events` | 수행·체크·부모 확인·반려·정정 사건을 발생 순서대로 저장 |
| `activity_event_status` | 분류·검증·평가·정산의 현재 projection |
| `activity_event_refs` | 사건과 승인 ref의 연결; 관계 잔차는 보상을 반드시 막지 않음 |
| `measurements` | 점수·분량·시각·선택값 같은 구조화된 측정 |
| `evidence_records` | 사진 메타·부모 메모·체크 근거; 파일은 S3에 저장 |
| `verifications` | 부모 확인·반려·보완 요청 |
| `evaluations` | assignment·사건을 게시 policy version으로 판정 |
| `evaluation_results` | 각 dimension에서 실제로 매칭된 band와 설명 |
| `child_explanations` | 아이에게 공개할 충족·미충족 이유, 관련 스킬, 다음 행동 |
| `effect_candidates` | 원장 또는 권리 발행 전의 확정 대기 효과 |

모든 사건은 `occurred_at`, `recorded_at`, `business_date`, `actor_principal_id`, `idempotency_key`를 가진다. 과거 체크는 기존 행을 고치지 않고 정정 사건이 `supersedes_event_id`를 참조한다.

## 6. 정산·원장 영역

| 테이블 | 핵심 책임 |
|---|---|
| `settlement_periods` | 일·주·월 회차의 `OPEN`, `PROVISIONAL`, `LOCKED`, `CORRECTED` 상태 |
| `settlement_runs` | 특정 회차를 처리한 멱등 배치 실행 |
| `settlement_run_effects` | 한 effect candidate가 어느 실행에서 처리됐는지 유일 기록 |
| `asset_accounts` | 자녀별 `TIME_MINUTES`, `MONEY_KRW` 계정 |
| `ledger_events` | 평가·사용·취소·소급·상쇄의 원인 사건 |
| `ledger_entries` | 계정별 debit·credit; 잔액의 유일한 정답 |
| `daily_snapshots` | 잔액·예정분·hold·미확인 수의 관측 revision |

`ACTIVITY_ENTITLEMENT`는 수량 원장에 넣지 않고 권리 테이블로 발행한다. 비용 예상값은 부모 시뮬레이션에만 사용한다.

## 7. 보상 권리와 체험·활동 보상

| 테이블 | 핵심 책임 |
|---|---|
| `reward_catalog_items` | `ITEM`, `COUPON`, `ACTIVITY` 보상 정의 |
| `reward_activity_options` | 예약·보호자 동행·장소·유효일 같은 체험 설정 |
| `reward_entitlements` | 자녀가 실제 획득한 보상 권리 |
| `reward_entitlement_events` | 발행·예약·사용·취소·만료 상태 이력 |
| `reward_activity_bookings` | 활동 보상의 예약 시각과 부모 확인 |
| `coupon_instances` | 실물 쿠폰 고유 코드·인쇄·할당 상태 |
| `coupon_state_events` | 쿠폰 상태 전이 감사 로그 |
| `coupon_redemptions` | 쿠폰 사용·취소와 원장 거래 연결 |

`reward_entitlements.status`는 `ISSUED`, `RESERVED`, `COMPLETED`, `CANCELED`, `EXPIRED`를 사용한다. 일반 패널티가 이미 획득한 권리를 자동 몰수하지 않는다.

## 8. 약 복용 지원 영역

약 복용 영역은 보상·패널티·원장에서 분리한다.

| 테이블 | 핵심 책임 |
|---|---|
| `medication_plans` | 부모가 관리하는 약 복용 지원 계획 |
| `medication_schedules` | 예정 시각·시간대·알림 정책 |
| `medication_events` | 자녀의 `TOOK`, `NOT_TAKEN`, `UNSURE`, 늦은 기록 주장 |
| `medication_confirmations` | 부모의 관찰·확인·불확실 판단; 자녀 주장을 덮지 않음 |
| `reminder_deliveries` | 자녀·부모 알림의 요청·전달·실패 감사 |

실제 복용 시각, 자녀가 기억해 체크한 시각, 부모 관찰 시각, 서버 기록 시각은 각각 저장한다.

## 9. ref·잔차·공용 노하우 영역

| 테이블 | 핵심 책임 |
|---|---|
| `ref_concept_types` | `ACTIVITY`, `CATEGORY`, `GOAL`, `CAPABILITY`, `CONTEXT`, `EVIDENCE_KIND` |
| `ref_concepts` | `SYSTEM`, `SHARED`, `FAMILY` 범위의 승인 개념 |
| `ref_relation_types` | 허용 from/to 타입과 카디널리티 |
| `ref_relations` | 승인 개념 사이의 유효기간 관계 |
| `ref_aliases` | 명칭 정규화 |
| `residual_cases` | 개념·관계·측정·결과가 아직 해결되지 않은 질문 |
| `residual_evidence` | 잔차 판단 근거 |
| `residual_candidates` | 기존 편입·가족 ref 생성·공용 후보 제안 |
| `residual_decisions` | 사람의 최종 결정 |
| `residual_applications` | 결정이 사건·통계·원장에 실제 반영된 기록 |
| `ai_suggestion_runs` | 모델·프롬프트 버전·입력 범위 감사 |
| `knowledge_candidates` | 비식별화된 공용 개념·관계·정책 템플릿 후보 |
| `knowledge_reviews` | 사람 검토·승인·반려 |

## 10. 교차 영역 무결성

| 위험 | 필수 제약 |
|---|---|
| 다른 가족 자녀를 참조 | 가족 소유 테이블에 `(id, family_id)` 유일키와 복합 FK |
| 게시 전 정책 사용 | assignment·evaluation은 `PUBLISHED` 버전만 참조 |
| 루브릭 중간 구간 누락·겹침 | range exclusion + 게시 전 완전성 검증 함수 |
| 같은 체크·정산 중복 | 사건·effect candidate·settlement posting 멱등키 unique |
| 잔차가 자동 패널티가 됨 | residual 상태와 outcome enum 분리 |
| 과거 원장 덮어쓰기 | append-only + reversal·retroactive adjustment |
| 보상 활동 중복 사용 | entitlement 상태 전이 함수 + 요청 idempotency key |
| 약 복용이 점수에 연결 | medication 영역에서 policy effect·ledger FK 금지 |
| ref 쓰레기통화 | `PUBLISHED`만 운영 참조, unknown은 `residual_cases` |
| AI 자동 일반화 | AI는 candidate만 작성, 사람 review 없이는 공유 게시 금지 |

## 11. 물리 적용 순서

전체 구조는 다음 migration 묶음으로 나누는 것이 안전하다.

| 순서 | migration |
|---:|---|
| 1 | 이미 적용된 Auth·가족·초대·알림 |
| 2 | ref 정본·가족 설정 버전·활동·정책 |
| 3 | assignment·사건·측정·검증·평가 |
| 4 | 잔차·AI 후보·사람 결정 |
| 5 | 정산·원장·스냅샷 |
| 6 | 보상 카탈로그·`ACTIVITY_ENTITLEMENT`·쿠폰 |
| 7 | 약 복용 지원·알림 |
| 8 | CSV 확장·감사·관리자 시뮬레이션 view |

Auth 외 영역은 이 ERD 검토 후 단계별 migration으로 적용한다. 한 번에 모든 테이블을 운영 DB에 생성하지 않는다.
