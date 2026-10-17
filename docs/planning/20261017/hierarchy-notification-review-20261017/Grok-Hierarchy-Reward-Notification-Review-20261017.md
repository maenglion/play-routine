# Grok 실제 검토 — 규정 격상·Supabase·보상·부모 알림

검토일: 2026-10-17. 실제 응답 모델: **grok-4.7**.

다음은 1차 설계와 격리 샘플에 대한 실제 응답 원문이다. 운영 적용·추가 설계 승인·성능 또는 동시성 검증 결과가 아니며, 이후 Manus 최종안의 재검증을 뜻하지 않는다. 실제 가족 개인정보나 인증값을 전송하지 않았다.

---

# 규정 위계 격상·격하 v0.1 독립 검토

## 직접 결론

위계를 고정 `doc_kind`가 아니라 승인된 `GOVERNS`와 효력 구간으로 두는 방향은 맞다. 격상·격하만으로 기존 규정 원문, `rule_id`, `stable_scope_code`, 열린 기간, 보상권, 이행, 원장을 바꾸거나 리셋하지 않는다. 보상·스티커·원장에는 같은 격상 트리를 적용하지 않고, 버전·승인·이력 패턴만 재사용 후보다.

증거: `pr_design.doc_kind`는 BASIC/TASK/QUEST/LIFESTYLE/OPS_LIFECYCLE뿐이고, `rule_identities.kind` CHECK도 TASK/QUEST/LIFESTYLE만 허용한다. `enforce_rule_governing_kind()`는 규칙 종류와 규정 종류가 같아야 INSERT된다. 따라서 현재 스키마가 School 격상을 이미 지원한다고 볼 수 없다. 격리 샘플의 시간 구간과 CYCLE 표시는 운영 제약이 아니다. SQL을 실행하거나 수정하지 않았고, 학교 금액 정책도 재결정하지 않는다.

## Supabase의 가능·별도 연동·현재 미설정

증거로 한정된 것은 PostgreSQL 17.11, 그리고 pg_cron·pg_net·pgmq가 available이지만 `installed_version`이 NULL이라는 읽기 전용 카탈로그다. age는 미조회다. 없다거나 있다는 결론으로 바꾸지 말고, 이 결과를 자동화·그래프·전체 플랫폼 지원 보장으로 확대하지 않는다.

Postgres 정본으로 가능한 범위는 규정 ID·버전·관계 저장, `WITH RECURSIVE` 탐색, 가족 복합 FK, 짧은 승인 RPC, 제안과 앱 알림 행의 한 트랜잭션 기록, 기존 `source_events.client_event_key`·`school_execution_batches.idempotency_key`형 업무 멱등이다. 샘플은 TEMP와 ROLLBACK이며, CYCLE이 순환 행을 보여주는 것과 INSERT를 거절하는 것은 다르다.

별도 연동: Grok 추론, 이메일·LINE·푸시, React/Netlify 화면. 이는 Postgres 기능이 아니다. Edge Functions의 wall 150초/400초와 idle 150초 한계 때문에 긴 모델 처리를 승인 트랜잭션이나 부모 요청 안에 넣지 않는다. 짧은 트랜잭션은 작업 행만 남긴다.

현재 미설정: 세 확장은 설치돼 있지 않고, 이 설계만으로 cron·queue·웹훅·상시 작업자가 생기지 않는다. 수동 점검으로 시작한다. 나중에 큐를 쓰더라도 재전달을 가정하고, 외부 정확히 한 번 전송은 보장하지 않는다.

## 보상 영향과 반례

관할만 옮긴다. `reward_rights`, `sticker_awards`, `school_day_assessments`, `actual_reward_executions`, `immutable_ledger_entries`를 재부모하지 않는다. 자산 분류는 `asset_identities`/`asset_versions`의 다른 관계다. 강화물 변경에 버전·승인·이력 패턴은 재사용할 수 있으나 검증은 별도다.

증거: `settle_school_period`의 목표는 스티커 수만 본다. 0~4는 0, 5~7은 10000, 8 이상은 15000이다. `v_issued`는 그 `aggregation_period_id`의 ISSUED `COUPAY_KRW` `reward_rights.quantity`에 `reward_correction_events.signed_quantity`를 더한 값이다. 이행액은 빼지 않는다. 유효 10000이 있고 목표가 15000이면 `v_new`는 5000이고, `source_key`는 `school-period:{period}:target:{target}`로 갈린다.

반례 1. 기간 유니크는 `(family_id, child_id, stable_scope_id, starts_on, ends_on, timezone)`이다. 격상으로 새 `stable_scope_code`를 만들면 새 기간의 `v_issued`는 0이다. 8개면 15000이 추가되고 옛 10000도 남는다. `school_day_assessments`도 `stable_scope_code`+`business_date`라 스티커가 갈라질 수 있다. `rule_id`와 scope는 유지한다.

반례 2. 함수는 상위 상한을 읽지 않는다. Task 쪽 상한·배타 조건이 `version_compatibilities`나 상위 원문에만 있으면, School이 기본법 직속이 된 뒤 CASE는 그대로 15000이어도 상속이 빠진다. 금액이 같다고 영향 없음이면 안 된다. 확인 전에는 미검토다. 계약을 유지할 수 없으면 별도 보상 개정 전에 새 조합을 게시하지 않는다.

반례 3. 10000 권리를 이미 이행해도 발행식은 5000을 더 만든다. 이행을 다시 빼 15000을 발행하거나, 격상 RPC가 정산·원장을 호출하면 계약 위반이다. `immutable_ledger_entries`는 append-only이고 유니크가 `(family_id, source_kind, source_id)`다. 열린 `aggregation_periods.governing_plan_id`도 격상 UPDATE로 덮지 않는다. 열린 기간은 당시 묶음을 고정하고, 새 관계는 부모가 정한 시행일 이후의 새 기간에만 읽는다.

## 부모 알림 한 카드

한 명 운영이면 규정 메뉴의 수동 구조 점검과, 할 일 입력을 막지 않는 카드면 된다. 읽음은 승인이 아니다. 외부 채널·주기는 정하지 않는다. 카드와 모델 입력에 자녀 이름, 행동 상세, `medication_records.payload`를 넣지 않는다.

카드 예: 제목 `구조 점검 1`. 본문 `School을 Task 아래에서 기본법 직속으로 두는 제안. 출결 rule_id와 이번 주 스티커·보상권·원장은 유지. 상위 상한 상속은 미검토.` 행동 `나중에`, `자세히`. 승인 화면에서만 기준 버전과 시행일을 다시 보여 준다. 기각된 동일 대상·동일 입력 해시는 재알림하지 않는다. 보류 조건은 부모가 고른 값만 저장한다.

이 프로토타입 `schema.sql`에는 `notifications`가 없다. 자료의 Manus 문장은 운영 소스의 `public.notifications`와 연결용 enum, 알림함 UI 부재를 소스 확인으로 적은 것이지, 이 검토가 조회하거나 발송한 결과가 아니다. 재사용 전에 계약만 확인하고, 없으면 수신자 행을 최소 추가한다. UI 차단만으로는 부족하고 DB·RLS·수신자 조건이 필요하다. `routine_request_events`나 `routine_entitlement_events`에 제안 정본을 넣지 않는다. GUARDIAN에게 승인 원문을 열지 않는다.

## 기록·동시성 필수 보완

1. 관계 효력. 운영 `regulation_version_relationships`에는 `effective_from`/`effective_to`가 없고, `forbid_update_delete` 대상도 아니다. 유니크가 가족·양끝 버전·관계뿐이라 `task-v1→school-v1`과 `basic-v1→school-v1`이 동시에 남을 수 있다. 샘플은 `school-v2`를 새로 만들어 쌍을 피했을 뿐 운영 제약이 아니다. 게시 원문을 UPDATE하지 말고 종료·신규를 추가 행으로 남기되, 같은 쌍의 둘째 행이 유니크에 막히는 점도 같이 설계한다. 승인 RPC가 순환과 시점 겹침을 거절해야 한다.

2. 종류와 ID. SCHOOL을 enum, CHECK, `enforce_rule_governing_kind()`, UI 필터에 함께 넣기 전에는 게시하지 않는다. 종류를 맞추려고 새 `rule_id`나 `stable_scope_code`를 발급하지 않는다. 규칙 수로 자동 격상하지 않는다. `rule_governing_versions`도 기간이 없어 한 `rule_version_id`가 두 규정 버전에 동시에 연결될 수 있다.

3. 정산 고정. 반례 1처럼 scope가 갈라지면 이행 완료 뒤에도 새 기간에서 15000이 생길 수 있다. 격상 트랜잭션은 `settle_school_period`와 원장을 호출하지 않는다. 상위 상한이 끊기면 금액이 같아도 미검토 또는 계산 변경이다.

4. 승인과 효력. `approved_at`과 관계 시행 시각을 구분한다. 샘플의 2026-11-01은 설명용이다. 미래 행을 승인 시각의 현재 트리로 읽히게 하지 않는다. 변경 묶음은 SCHEDULED/APPLIED/FAILED로 제안 상태와 분리한다.

5. 승인 동시성. 부모가 본 입력 해시와 기준 `regulation_version_id`/`version_no`가 바뀌면 잠금 후 거절하고 자동 재승인하지 않는다. 같은 `request_id`는 같은 묶음을 반환한다. 가족 복합 FK, 활성 OWNER_PARENT/PARENT 재확인, RPC 최소 권한, `test_mode` 제거가 필요하다. 샘플의 REVOKE와 주석 GRANT는 production RLS가 아니다.

6. 최소 기록. 새 정본은 제안, 불변 사건, 승인 변경 묶음이면 된다. 검토·보류·기각·승인 시각과 이유, 모델 ID·입력 해시·반론은 남기되 승인자·`read_at`·토큰과 섞지 않는다. 앱 알림은 같은 짧은 트랜잭션에 한 건만 넣는다. 외부 전송은 채널이 정해진 뒤에 outbox와 시도 사건으로 중복·실패를 기록하며, 정확히 한 번은 보장하지 않는다.

## 지금 보류할 복잡성

주간 경계, 상시 감시 주기, 보존 기간, 외부 알림 채널은 정하지 않는다. pg_cron·pgmq 설치, AGE, 그래프 DB, 새 마이크로서비스, 다단계 엔진을 선행 조건으로 두지 않는다. 측정된 한계 전에는 PostgreSQL 정본과 재귀 조회로 충분하다.

이 글은 v0.1과 격리 샘플의 독립 검토다. 이후 수정본을 재검증한 결과가 아니다.
