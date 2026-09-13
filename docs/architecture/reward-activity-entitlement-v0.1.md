# Play Routine 체험·활동 보상 설계 v0.1

**작성자: Manus AI**  
**보상 자산 코드:** `ACTIVITY_ENTITLEMENT`

## 1. 정의

`ACTIVITY_ENTITLEMENT`는 자녀가 조건을 충족해 획득하는 **체험·함께하기·외출 권리**다. 예시는 영화 보기, 놀이공원 방문, 원하는 보드게임 함께하기, 특별 외출, 친구 초대하기 등이다.

> 일반 `activity`는 자녀가 수행하는 과제·행동이고, `ACTIVITY_ENTITLEMENT`는 수행 결과로 얻는 보상 권리다. 두 개념은 같은 테이블이나 같은 타입 코드로 합치지 않는다.

## 2. 다른 보상과의 차이

| 보상 자산 | 수량 단위 | 사용 방식 | 원장 방식 |
|---|---:|---|---|
| `TIME_MINUTES` | 분 | 디지털 시간 사용 | 수량 원장 |
| `MONEY_KRW` | 원 | 현금·예산 지급 | 수량 원장 |
| `ITEM_ENTITLEMENT` | 개 | 물품 수령 | 권리 발행·이행 |
| `COUPON_ENTITLEMENT` | 장 | 실물 쿠폰 전환·사용 | 권리 발행·상태 전이 |
| **`ACTIVITY_ENTITLEMENT`** | 회 | 체험 예약·완료 | 권리 발행·예약·이행 |

`ACTIVITY_ENTITLEMENT`는 금액이나 시간을 원장 잔액에 더하지 않는다. 대신 보상 템플릿에 따라 **권리 인스턴스 1개 이상을 발행**한다. 예상 비용·소요 시간은 부모 시뮬레이션용 메타데이터이며 자녀 자산 잔액과 분리한다.

## 3. 테이블 책임

| 테이블 | 핵심 필드 | 책임 |
|---|---|---|
| `reward_catalog_items` | `id`, `family_id`, `reward_kind`, `title`, `estimated_minutes`, `estimated_cost_krw`, `status` | 가족이 제공하는 보상 정의 |
| `reward_activity_options` | `reward_catalog_item_id`, `booking_required`, `guardian_required`, `location_note`, `valid_days` | 체험·활동 보상 전용 설정 |
| `reward_entitlements` | `id`, `child_profile_id`, `catalog_item_id`, `source_effect_candidate_id`, `status`, `issued_at`, `expires_at` | 자녀가 획득한 실제 권리 |
| `reward_entitlement_events` | `id`, `entitlement_id`, `event_type`, `actor_principal_id`, `occurred_at`, `note` | 모든 상태 전이 감사 기록 |
| `reward_activity_bookings` | `id`, `entitlement_id`, `scheduled_for`, `status`, `confirmed_by_principal_id` | 예약이 필요한 체험의 일정 |

## 4. 상태 수명주기

```text
ISSUED
  → RESERVED
  → COMPLETED

ISSUED → CANCELED
ISSUED → EXPIRED
RESERVED → ISSUED       예약 취소 후 권리 복원
RESERVED → CANCELED     부모가 권리 자체를 취소
RESERVED → EXPIRED      만료일 경과, 정책이 허용할 때만
COMPLETED               종결, 재사용 불가
```

상태를 직접 덮어쓰지 않고 `reward_entitlement_events`를 먼저 추가한 뒤 현재 상태를 갱신한다. 같은 요청의 중복 처리는 `idempotency_key` 유일 제약으로 막는다.

## 5. 정책 효과와 연결

`policy_effects.effect_kind='ISSUE_ENTITLEMENT'`이고 `reward_catalog_item_id`가 체험·활동 보상을 가리킬 때, 정산은 `reward_entitlements`를 생성한다. `quantity`는 발행 수량이며 `amount`를 사용하지 않는다.

| 규칙 결과 | 생성 결과 |
|---|---|
| `REWARD + TIME_MINUTES + 30` | 시간 원장 +30분 |
| `REWARD + ACTIVITY_ENTITLEMENT + 영화 보기 ×1` | 체험 권리 1개 발행 |
| `NO_REWARD` | 발행 없음 |
| `PENALTY` | 기존 체험 권리를 자동 몰수하지 않음 |
| `NOOP` | 발행 없음 |

패널티가 기존 체험 권리를 자동 회수하게 만들면 전액 몰수 문제와 같은 구조가 재발한다. 회수가 꼭 필요하면 일반 패널티가 아니라 별도 부모 결정 사건 `ADMIN_CANCEL_ENTITLEMENT`로 기록해야 한다.

## 6. 무결성 규칙

| 위험 | 제약·처리 |
|---|---|
| 일반 과제와 보상 활동 혼동 | `activity_templates`와 `reward_catalog_items` 분리 |
| 같은 보상 중복 발행 | `(source_effect_candidate_id, catalog_item_id, sequence_no)` 유일 |
| 완료된 권리 재사용 | `COMPLETED`에서 다른 사용 상태로 전이 금지 |
| 예약 없이 완료 | `booking_required=true`이면 활성 예약 필수 |
| 부모 동의 없는 외부 활동 | `guardian_required=true`이면 부모 principal 확인 필수 |
| 취소 후 원장 소급 변경 | 원장과 권리 이력을 덮지 않고 취소 사건 추가 |
| 비용을 자녀 자산으로 오인 | `estimated_cost_krw`는 시뮬레이션 메타데이터일 뿐 원장 미게시 |

## 7. 초기 권고

`ACTIVITY_ENTITLEMENT`를 보상 종류로 지원하되 초기 화면에는 부모가 직접 만든 카탈로그만 표시한다. 공용 카탈로그·AI 추천은 잔차·지식 승격 구조가 완성된 뒤 추가한다. 의료·상담·약 복용을 보상 활동으로 등록하지 않는다.
