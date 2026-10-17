# Grok 실제 검토 — 신규 규정 DB와 다중 가족 확장

검토일: 2026-10-17. 실제 응답 모델: **grok-4.7**. 대상: GitHub `7f008e7`의 독립 설계·프로토타입.

아래는 Grok의 실제 응답 원문이다. 정책 확정·운영 적용·성능 및 동시성 시험 결과를 뜻하지 않는다. 실제 가족 개인정보나 인증값을 전송하지 않았다.

---

# pr_design 가족 확장 검토

## 직접 결론

검토 대상은 운영 DB가 아니라 `pr_design` 38테이블 격리 SQL과, `rules.ts` 26건·`localStorage`만 읽는 프로토타입이다. 성능·동시성 시험은 실행하지 않았다. `verify-result.json`은 제공된 PGlite 단일 연결 기록으로만 인용한다.

가족별 독립 방향은 맞다. 부모가 현재 1명이라는 이유로 `family_id`, 서버 권한 검증, 동시성 키를 제거하면 안 된다. 테이블 `PUBLIC` 회수는 스크립트에 있으나 함수 `EXECUTE` 회수, RLS, role grant, JWT 서명 검증은 없다. 이것은 현재 운영 취약점 단정이 아니라 운영 전 필수 보강이다. 원장 모형과 메뉴 URL을 실정산·실DB 조회로 보면 안 된다.

## 유지할 구조

증거: 자녀·멤버·사건·채택은 `(id, family_id)` 복합 FK다. 제공 기록의 `composite_family_fk_rejects_cross_tenant_child`는 가족 횡단 자녀 참조 거절로 적혀 있다. `rule_governing_versions`와 `enforce_rule_governing_kind()`는 규칙 kind와 하위 규정 kind를 맞추고, seed 26규칙은 TASK/QUEST/LIFESTYLE 브리지가 있다. `rule_conditions`와 `rule_effects`의 `(family_id, rule_version_id, condition_code)`는 조건 코드 정본을 JSON과 분리한다.

월 채택은 규칙 복사가 아니다. `plan_rule_adoptions.rule_version_id`가 버전을 가리킨다. `aggregation_periods`와 `recognition_limit_buckets` 유일 키에 plan/rule version이 없다. `stable_scope_code`는 `rule_identities`에서 가족 단위로 유일하다. 이 축은 확장에 맞으므로 유지한다.

학교 금액은 이미 0–4=0, 5–7=10,000, 8+=15,000이고, 기존 발행을 뺀 `v_new`만 새 권리다. 제공 기록은 10,000+5,000과 한 배치의 권리별 5,000/10,000 분할을 적는다. 이행액은 `actual_reward_executions` 합으로 권리 잔량에서 빠진다. 현금·쿠페이·분은 `asset_unit`이 다르고 정산은 `COUPAY_KRW`만 본다.

한도 초과는 삭제가 아니다. `recognize_lifestyle_event()`는 사건을 남기고 `LIMIT_EXCEEDED`를 기록한다. `UNCONFIRMED`는 0이 아니다. 평가 제약이 개수를 NULL로 두고, final 정산은 미해결 회차가 있으면 예외다. `medication_records`에는 보상 트리거가 없고 L-013은 `approve_penalty_event()`의 별도 부모 사건이다. 주 경계, 일반 중간지급, 문제+칭찬, 칭찬 상한은 미확정으로 둔다. 값을 새로 정하지 않는다.

## 우선 수정

### 1. 함수 실행권과 claims·test_mode

근거: `REVOKE ALL`은 테이블·시퀀스뿐이다. 함수 `EXECUTE` 회수와 `GRANT EXECUTE`는 주석이다. `current_auth_user_id()`, `assert_parent()`, `test_mode_enabled()`, `assert_rule_operable()`와 생활·패널티·학교·이행 함수는 `SECURITY DEFINER`이고 `search_path = pr_design, pg_temp`다. claims는 `current_setting('request.jwt.claims')`의 `sub`만, test_mode는 `pr_design.test_mode='on'`만 본다. 서명 검증과 RLS는 없다.

반례: 운영 전 `GRANT USAGE`만 하고 `PUBLIC EXECUTE`를 남기면, 스키마를 쓸 수 있는 역할이 소유자 권한 RPC를 호출할 수 있다. 그 역할이 두 GUC를 `SET`할 수 있으면 다른 `sub`로 가장하거나 DRAFT·interim 조건을 켤 수 있다. 지금 그렇게 배포됐다는 뜻은 아니다.

권고·시점: 앱 역할을 만들기 전. 스키마 함수 `EXECUTE`를 `PUBLIC`에서 회수하고 의도한 5개 RPC만 부여한다. JWT 서명·issuer·audience는 DB 밖에서 검증하고, 앱 역할은 두 설정을 바꾸지 못하게 한다. `search_path` 고정은 유지한다. `pg_temp`를 뒤에 둔 것은 임시 객체가 기본으로 앞서는 검색을 피한 독해다. 카탈로그는 실행하지 않았다.

### 2. 없는 행의 동시 재전송

근거: 생활 함수는 `ON CONFLICT DO NOTHING` 후 다시 잠근다. `approve_penalty_event()`는 없는 행 `FOR UPDATE` 뒤 `ON CONFLICT` 없이 `INSERT`한다. `execute_school_outstanding()`도 배치가 없으면 잠글 행이 없고, 기간 잠금 뒤에 `INSERT`한다. 배치 유일 키는 `(family_id, idempotency_key)`다.

반례: 두 기기가 같은 키를 동시에 보내면 둘 다 없음으로 통과하고, 하나는 정상 replay 대신 유일 제약 오류가 될 수 있다. 다른 키 두 건의 이행은 기간 잠금 뒤에서 잔액을 다시 계산하므로 이중 지급 가능성이 낮다. 코드 독해이며 다중 연결 시험이 아니다.

권고·시점: 부모 기기가 둘 이상이 되기 전. 패널티와 배치도 충돌 후 재조회, 또는 `INSERT` 전 키 잠금으로 맞춘다. 실 PostgreSQL 다중 연결로만 확인한다.

### 3. 정정·평가와 기간 잠금

근거: `prevent_reward_right_overspend()`는 이행 `INSERT` 전에만 권리 행을 잠근다. `reward_correction_events`에는 잔량 검사와 멱등 키가 없다. 정산·이행은 `aggregation_periods`를 잠그지만, 평가를 쓰는 RPC는 이 파일에 없다.

반례: 10,000을 이행한 뒤 정정 −1,000은 트리거가 없다. 다른 세션이 기간을 잠그지 않고 평가를 바꾸면, READ COMMITTED에서 정산이 본 스티커와 커밋된 평가가 어긋날 수 있다. 부모 둘의 동시 정정은 미검증이다.

권고·시점: 다부모 정정 전. 정정 RPC가 권리와 기간을 잠그고, 이행을 넘는 감소는 자동 회수가 아니라 기존 `review_required`로 보낸다. 평가 변경도 같은 기간 잠금을 먼저 잡는다. 새 금액 정책은 넣지 않는다. 실 PG 다중 연결 시험이 필요하다.

### 4. 가족 안 자녀·회차·scope

근거: `source_events`와 `school_day_assessments`의 회차 FK는 `(occurrence_id, family_id)`뿐이다. 회차의 `child_id`와 같아야 한다는 제약이 없다. `stable_scope_code`에도 `stable_rule_scopes` FK가 없다. seed scope는 L-001과 학교뿐이다. 생활 RPC는 scope가 없으면 예외다.

반례: 같은 가족의 자녀 A 사건이 자녀 B 회차를 가리켜도 가족 FK는 통과한다. 제공 반례는 가족 횡단만 다룬다. L-002를 이 RPC로 호출하면 seed 상태에서는 scope 부재다. L-001은 조건이 둘이라 함수의 조건 1개 검사와 어긋날 수 있다. 마지막은 미실행 독해다.

권고·시점: 둘째 자녀 또는 운영표 RPC 연결 전. 회차 참조에 `child_id`를 넣거나 같은 자녀·scope를 트리거로 고정한다. RPC가 쓸 scope 행만 추가한다. 한도 숫자와 주 경계는 정하지 않는다.

### 5. 역할별 읽기와 권리 상태

근거: 쓰기는 `assert_parent()`의 `OWNER_PARENT`/`PARENT`만 통과한다. `CHILD`/`GUARDIAN` 조회 RPC·RLS·뷰가 없다. `reward_rights`는 append-only라 `VOIDED`로 고칠 수 없다. 검토 플래그는 `aggregation_periods.review_required`에 있다.

반례: 테이블 `SELECT`를 주면 가족 필터 없이 읽힌다. 발급 권리를 상태 UPDATE로 무효화할 수 없고, 수량 변경은 정정 행뿐이다.

권고·시점: UI를 DB에 붙이기 전. 테이블 권한은 주지 않고 가족·역할·자녀가 서버에서 걸러진 RPC 또는 RLS를 둔다. 권리 상태를 사건으로 둘지 정정만 쓸지는 선택이며 여기서 정하지 않는다. 보호자 읽기 전용은 설정 문구일 뿐 구현이 아니다.

### 6. 원장 연결 전 관계

근거: `immutable_ledger_entries`는 `(family_id, source_kind, source_id)`만 유일하고 자녀·자산·기간·원천 FK가 없다. RPC도 여기에 쓰지 않는다.

반례: 그 두 컬럼만으로 다른 자녀나 분·원·쿠페이를 한 잔액처럼 읽을 수 있다.

권고·시점: 외부 지급 연결 전. 그때 실 자녀·자산·기간·원천 관계를 정한다. 그 전엔 모형이다. 파티션, 샤딩, 그래프 DB, 마이크로서비스, 가족별 스키마는 측정 전이므로 하지 않는다.

## 지금 하지 않아도 되는 것

PK·UNIQUE가 이미 인덱스다. 다시 만들 경로는 `source_events (family_id, child_id, client_event_key)`, `scheduled_occurrences (family_id, child_id, stable_scope_code, scheduled_for)`, `school_day_assessments (family_id, child_id, stable_scope_code, business_date)`, 버킷·기간·멤버십·이행 행의 기존 유일 키다. FK가 참조 측 인덱스를 만든다고 보지 않는다.

없는 경로는 `reward_rights (family_id, aggregation_period_id)`와 `reward_correction_events (family_id, reward_right_id)`다. 정산·잔량 합이 이 조건으로 찾고, 기존 키는 `source_key` 또는 `correction_id`라 대신하지 못한다. 날짜 범위용 `source_events (family_id, child_id, occurred_at)`, `parent_confirmations (family_id, source_event_id)`, `medication_records (family_id, child_id, recorded_at)`도 없다. 기록이 26규칙·소수 행이므로 성능 수치나 수만 가족 지원은 말할 수 없다. 읽기가 DB에 붙거나 잠금 안 합계가 커질 때 이 경로만 추가하면 된다.

페이지네이션의 실측도 지금은 불필요하다. 다만 이후 캐시·저장 키는 URL이 아니라 가족, 역할, 자녀, 기간이어야 한다.

## 메뉴와 26규칙

증거: `rules.ts`와 seed 신원은 Task 7, Quest 3, Lifestyle 16이다. 화면은 정적 배열과 `logic.ts`만 본다. `/operations`의 날짜·주간 URL은 DB 조회도 RLS 증명도 아니다. 로컬 한도 초과는 행을 남기므로 삭제 아님과 방향만 같다. 학교 계산은 확정 구간과 추가분·미이행을 로컬 권리로만 본다. 미확인·문제+칭찬은 발행을 막지만 SQL final과 같은 트랜잭션이 아니다.

`/regulations`의 7/3/16은 정적 건수다. `pending`은 미확정 표시이며 DB `pending_fields`와 동기화되지 않았다. `/rewards` 이행은 권리별 행이 아니라 `paid` 하나라 배치 분할을 보여 주지 않는다. 원장은 화면에도 미연결이다. `/reinforcers`는 `localStorage`만 바꾸고 seed `asset_versions`·`rule_effects`와 연결되지 않는다. 코드도 `MEDIA_MIN`과 `MEDIA_COUPON`으로 다르다. `/settings`에는 로그인·복약 행이 없다. L-013과 복약을 별개라고 쓴 문구는 스키마와 맞지만 연동은 아니다.

메뉴를 가족별 프런트로 붙여도 라우트가 규칙 버전 게시, 자산 버전, RLS를 대신하게 하면 안 된다.

## 틀릴 수 있는 점

함수 `PUBLIC EXECUTE`와 스키마 `USAGE` 기본값은 카탈로그를 조회하지 않았다. 이 스크립트에 회수·부여가 없다는 점만 확실하다. 동시성 판단은 잠금 순서의 독해다. 생활 버킷은 없는 행 삽입 후 `FOR UPDATE`라 실 PG에서 직렬화될 가능성이 높지만 확인하지 않았다. 첫 삽입이 `limit_count`를 고정하는데, 같은 날 한도 변경을 따를지는 정책이 없어 정하지 않았다. `assert_parent()`의 `LIMIT 1`은 한 로그인의 부모 역할이 둘이면 비결정적일 수 있어, 다중 부모 전에 정렬을 정하면 된다. `child_auth_user_id` 전역 유일은 한 로그인 한 자녀행이며, 가족 간 계정은 선택이다. seed 조건 행은 21로 세었고 검증 JSON은 22다. samples가 없어 확정하지 않는다.
