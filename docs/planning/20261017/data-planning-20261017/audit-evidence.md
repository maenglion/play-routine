# 감사로그 구현 및 내부 감사 — 소스 근거 목록

아래 행 번호는 2026-10-17에 지정된 로컬 소스 파일을 읽어 확인한 것이다. 이는 **소스상 구현/계획의 근거**이며, 운영 DB 접속·실제 레코드 수·배포 여부를 검증한 결과는 아니다.

## A. 운영 migration에서 확인한 현황

- `/home/ubuntu/play-routine-rdb/supabase/migrations/0001_identity_auth.sql`
  - **103–125행:** `family_memberships`의 PK, `family_id`/`principal_id` FK, 역할·활성 상태·유효기간, 가족당 활성 OWNER_PARENT 하나를 제한하는 인덱스.
  - **151–186행:** 초대의 가족/자녀/초대자 연결, `email_fingerprint`와 활성 초대 중복 제한.
  - **188–198행:** `invitation_delivery_events`에 `request_id`, `ip_hash`, `device_hash`, 상세, 생성시각 및 `(invitation_id, request_id)` 유일성.
  - **200–212행:** `auth_link_events`에 가족·자녀·principal·초대·사건 유형·행위자·사유·생성시각과 자녀/가족 FK.
  - **290–350행:** 현재 principal, 활성 가족 구성원, 활성 부모(OWNER_PARENT/PARENT), 자녀 본인 여부 판정 함수.
  - **353–359행:** principals/families/family_memberships/child_profiles/invitations/invitation_delivery_events/auth_link_events에 RLS 적용.
  - **399–444행:** 가족 구성원/부모/자녀별 조회 정책과 `auth_link_events`의 부모 또는 본인 조회 정책.
  - **446–476행:** anon 권한 회수 및 authenticated의 제한된 SELECT/UPDATE 권한 부여.

- `/home/ubuntu/play-routine-rdb/supabase/migrations/0002_auth_workflows.sql`
  - **210–277행:** `complete_child_invitation`은 `SECURITY DEFINER` 함수이며 로그인·활성 principal·이메일 검증·초대 상태/기한/이메일 일치를 검사하고 행을 `FOR UPDATE`로 잠금.
  - **303–359행:** 자녀 membership 및 profile·invitation 상태 변경 뒤 `auth_link_events`에 LINKED/RELINKED, 행위자와 사유를 기록.
  - **362–383행:** 같은 완료 함수에서 활성 부모에게 `CHILD_LINKED` 수신자별 `notifications` 행을 생성.

- `/home/ubuntu/play-routine-rdb/supabase/migrations/0017_routine_v2.sql`
  - **182–235행:** occurrence는 현재 projection이고 완료 신고/부모 확인 원문은 append-only event에 남긴다는 주석; `routine_occurrence_events`의 가족·대상·행위자·사건 유형·idempotency key·revision·판정값·사유·기록시각, PK/FK/유일성.
  - **237–287행:** `routine_entitlements`의 권리 발생/이행 주체·시각 및 `routine_entitlement_events`의 권리 사건·행위자·요청 payload·기록시각.
  - **289–300행:** 모든 변경 RPC의 actor/key/payload와 response를 `routine_request_events`에 기록하고 actor+idempotency key 재사용을 차단.
  - **505–546행:** immutable guard와 `routine_occurrence_events`, `routine_entitlement_events`, `routine_request_events` 등의 UPDATE/DELETE를 거절하는 trigger.
  - **548–563행:** `routine_replay`가 actor+key advisory lock 및 `FOR UPDATE` 후 action/payload 동일 시 기존 응답을 반환하고, 다르면 키 재사용 오류; `routine_record_request`가 요청/응답을 기록.
  - **972–985행:** 자녀 완료 신고 RPC의 본인 권한 검사, 재실행 판정, `CHILD_REPORTED` 사건 삽입, occurrence 갱신, 요청기록.
  - **988–1023행:** 부모 확인 RPC의 부모 권한·날짜·공통 advisory lock·revision 검사, `PARENT_VERIFIED` 사건, projection 갱신, 권리 관련 처리, 요청기록.
  - **1025–1062행:** 기간 확정 RPC의 부모 권한·공통 잠금·재실행 판정·기간 마감 검사·권리 발급 및 `ISSUED` 사건·요청기록.
  - **1082–1094행:** 권리 이행 RPC의 부모 권한, 잠금, 재실행 판정, 검토/상태 검사, `FULFILLED` 사건과 요청기록.
  - **1096–1113행:** 원본 표 RLS 적용, public/anon/authenticated의 표 접근 회수, authenticated에는 명시 RPC 실행만 부여.

## B. 아직 미배포 `pr_design` 프로토타입 근거 — 운영 현황으로 사용하지 않음

- `/home/ubuntu/deliverables/play-routine-ordinance-prototype-20261017/database/schema.sql`
  - **263–306행:** append-only `source_events`, 분리된 `measurements`, `parent_confirmations`; 사건/확인의 PK, 가족·원천사건·부모 membership FK, client/idempotency key 유일성, 기록시각.
  - **429–489행:** reward right, correction event, execution batch, actual execution의 분리; 이행 요청키·외부 참조·실행자·실행시각과 FK/중복 차단.
  - **490–504행:** 보상권의 남은 유효량보다 큰 실제 이행을 잠금과 trigger로 차단.
  - **506–515행:** `immutable_ledger_entries`와 가족·원천 종류·원천 ID의 유일성.
  - **517–528행:** 민감한 medication record를 분리하며 trigger/RPC로 penalty/reward를 생성하지 않는다는 명시.
  - **530–542행:** 규정/원천사건/부모확인/보상권/정정/이행/원장에 UPDATE·DELETE를 거절하는 append-only trigger.
  - **688–717행:** 부모 확인 penalty RPC 예시의 부모 확인, 동일 원천사건·입력 불일치 시 idempotency 오류, 원천사건과 부모 확인 삽입.
  - **721–810행:** 학교 기간 정산 RPC 예시의 가족 내 자녀 검사, 행 잠금, 미확인 시 최종 확정 거부, 보상권 발급 및 상태 반환.
  - **825–861행:** 이행 RPC 예시의 부모 확인, idempotency key `FOR UPDATE`, 대상 범위/검토 상태 검사, 실행배치와 권리별 이행 기록, 배분 대조.
  - **863–869행:** `pr_design` 원본 표/시퀀스 public 권한 회수, authenticated에 명시 RPC 실행을 부여할 계획의 주석. 이 파일은 배포 migration이 아니다.

## C. 아직 미배포 신규 governance 계획 근거 — 운영 현황으로 사용하지 않음

- `/home/ubuntu/deliverables/hierarchy-notification-review-20261017/Play-Routine-Hierarchy-Reward-Notification-Design-v0.2.md`
  - **69–73행:** `governance_proposals`, append-only `governance_proposal_events`, `governance_change_sets`의 제안·승인·적용/실패 이력 및 snapshot hash/입력 hash/요청키 구상. 즉시 적용은 승인 RPC의 검증과 게시를 한 transaction으로 처리한다는 계획.
  - **75–77행:** 현 `public.notifications`와 신규 제안/적용/실패 알림의 구분; `routine_request_events`/`routine_entitlement_events`를 신규 제안 상태 정본으로 억지 통합하지 않음; 외부 전송은 outbox·전달시도 이력을 별도 계획.
  - **81–89행:** 제안·앱 알림의 짧은 transaction, 외부 검토/메일 호출의 transaction 밖 처리, 활성 부모 권한 확인, revision/input hash 잠금 대조, 재전송 idempotency 및 외부전송 exactly-once 미보장.
  - **93–99행:** 운영 연결 전 동시성/재전송/외부전송 실패 시험 필요, 신규 표를 현 운영 Supabase 배포로 혼동하지 말 것, 알림 채널·보존기간 미결정 및 민감정보 보존 구분.

## D. 본 감사 문안의 설계상 한계

- 위 어느 운영 migration이나 계획 문서에도 **외부 체크포인트를 보유한 hash chain의 실제 구현 근거는 없다.** 따라서 본문은 이를 향후 감사 필드/절차로 제안하되, DB owner/관리자가 표·trigger·해시를 함께 수정할 수 있으면 체인을 재생성할 수 있다는 한계를 명시했다.
- 위 소스에는 분리된 독립 감사인 지정 또는 정기 내부감사 실행기록의 근거가 없다. 따라서 현재 1인 점검은 자기점검이며 독립감사라고 표현하지 않았다.
