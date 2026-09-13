# Play Routine 전체 ERD 검토 v0.2

**작성자: Manus AI**  
**대상:** `Play-Routine-Full-ERD-v0.2`

![Play Routine 전체 DB ERD](/manus-storage/Play-Routine-Full-ERD-v0.2_571c0e34.png)

## 1. 검토 결과

| 항목 | 결과 |
|---|---:|
| 엔터티 | 65개 |
| 관계 | 83개 |
| 고아 테이블 | 0개 |
| 중복 테이블명 | 0개 |
| 존재하지 않는 노드 참조 | 0개 |
| 필수 핵심 관계 누락 | 0개 |
| 자동 위험 검증 | 전부 통과 |

전체 구조는 Auth·가족, 설정·활동·정책, 오늘 사건·평가·설명, 정산·불변 원장, 보상 권리·쿠폰·ACTIVITIES, 약 복용 지원, 승인 ref 지식, 잔차·AI 후보·사람 승인, 운영 감사의 9개 영역으로 나뉜다.

## 2. `ACTIVITIES` 보상 결정

화면의 제공 방식에는 **ACTIVITIES**를 추가한다. 물리 DB 코드는 일반 과제 `activity`와 혼동되지 않도록 `ACTIVITY_ENTITLEMENT`로 사용한다.

| 사용자 개념 | DB 표현 | 원장 처리 |
|---|---|---|
| 시간 보상 | `TIME_MINUTES` | 수량 원장 |
| 돈 보상 | `MONEY_KRW` | 수량 원장 |
| 물품 보상 | `ITEM_ENTITLEMENT` | 권리 발행 |
| 실물 쿠폰 | `COUPON_ENTITLEMENT` | 권리·쿠폰 상태 전이 |
| **ACTIVITIES** | `ACTIVITY_ENTITLEMENT` | 권리 발행·예약·완료 |

`ACTIVITY_ENTITLEMENT`는 영화, 놀이공원, 특별 외출, 보드게임 함께하기처럼 획득 후 이행해야 하는 권리다. 금액이나 분으로 환산해 원장 잔액에 더하지 않는다. `policy_effects.effect_kind='ISSUE_ENTITLEMENT'`가 정산될 때 `reward_entitlements`가 발행된다.

## 3. 활동 보상 수명주기

```text
ISSUED → RESERVED → COMPLETED
   │          ├────→ ISSUED      예약 취소
   │          ├────→ CANCELED
   ├───────────────→ CANCELED
   └───────────────→ EXPIRED
```

상태를 직접 덮어쓰지 않고 `reward_entitlement_events`를 append-only로 추가한다. 일반 패널티는 이미 얻은 활동 보상을 자동 몰수하지 않는다. 부모가 취소해야 할 경우 `ADMIN_CANCEL_ENTITLEMENT`라는 별도 결정 사건으로 남긴다.

## 4. 소유권·교차 가족 검토

| 위험 | ERD 처리 | 물리 migration 요구 |
|---|---|---|
| 다른 가족의 자녀에 활동 배정 | `family → child → assignment` | `(id, family_id)` 복합 FK |
| 다른 가족 정책을 평가에 사용 | config version과 policy set을 가족 소유 | 가족 ID 일치 trigger·함수 |
| 다른 가족 카탈로그 보상 발행 | family→catalog, child→entitlement | entitlement에 `family_id`, child·catalog 복합 FK |
| 타 가족 residual 편입 | residual decision과 ref scope 분리 | FAMILY ref는 같은 family만 target |
| 타 가족 CSV 내보내기 | family·parent actor 모두 연결 | 활성 부모 membership 재검증 |

## 5. 자동 위험 검증 결과

| 검증 | 결과 |
|---|---|
| 일반 과제와 활동 보상 테이블 분리 | 통과 |
| 약 복용 사건이 원장에 직접 연결되지 않음 | 통과 |
| 미분류 residual이 ref 정본을 직접 수정하지 않음 | 통과 |
| snapshot이 원장을 다시 쓰지 않음 | 통과 |
| 보상 권리가 append-only 사건 이력을 가짐 | 통과 |
| CSV가 부모 행위자와 가족 모두에 연결됨 | 통과 |

검증 결과는 `Play-Routine-Full-ERD-v0.2-validation.json`에 보존했다.

## 6. 적용 상태

Auth·가족·초대·알림·자녀 프로필 사진 영역은 새 Supabase에 적용됐다. 나머지 57개 설계 엔터티는 ERD 검토 상태이며, 문서에 정의한 migration 순서대로 단계 적용한다. 전체 구조를 한 번에 운영 DB에 생성하지 않는다.

## 7. 산출물

| 파일 | 용도 |
|---|---|
| `Play-Routine-Full-DB-Structure-v0.2.md` | 영역별 데이터 사전·무결성·적용 순서 |
| `Play-Routine-Full-ERD-v0.2.svg` | 확대 가능한 전체 ERD |
| `/manus-storage/Play-Routine-Full-ERD-v0.2_571c0e34.png` | 5716×5071 고해상도 전체 ERD 영구 자산 |
| `Play-Routine-Full-ERD-v0.2.dot` | Graphviz 편집 원본 |
| `Play-Routine-Full-ERD-v0.2-validation.json` | 고아·중복·필수 관계 자동 검증 결과 |
| `reward-activity-entitlement-v0.1.md` | ACTIVITIES 보상 상세 수명주기 |
