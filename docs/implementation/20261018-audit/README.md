# Play Routine — Supabase 감사로그 시스템 v0.1

## 목적과 적용 범위

기존 부모·자녀 서비스의 **성공한 데이터 변경**을 DB 트리거가 자동 기록한다. 새 기록은 `play_audit.events`에 저장된다. 기존 규칙·보상·업무 사건·가족 데이터를 삭제하거나 초기화하지 않는다. 설치 이전 변경은 소급 생성하지 않는다.

현재 단계는 감사 DB·조회 RPC를 실제 서비스에 적용하는 범위다. 독립 모의 프로토타입을 운영 부모 화면으로 교체하거나 법령형 신규 모델 전체를 적용하는 작업이 아니다. 별도 감사 조회 화면은 이번 변경에 추가하지 않는다.

| 구성 | 객체 | 역할 |
|---|---|---|
| 감사 정본 | `play_audit.events` | 변경 전후의 허용 필드·주체·시각·대상 저장 |
| 자동 기록 | `play_audit.capture_row_change()` | 기존 업무 변경과 같은 transaction에서 감사 INSERT |
| 불변 가드 | `play_audit.prevent_event_mutation()` | 감사 UPDATE·DELETE·TRUNCATE 차단 |
| 부모 조회 | `public.list_family_audit_events()` | 인증되고 활성인 부모에게 자기 가족만 반환 |

## 자동 기록 대상 16개 테이블

| 영역 | 대상 |
|---|---|
| 가족 접근·자녀 상태 | `family_memberships`, `child_profiles` |
| 독립 수동보상 | `manual_money_rewards`, `manual_bonus_coupons`, `manual_reward_events` |
| 강화물·규칙 | `routine_reinforcers`, `routine_drafts`, `routine_rules`, `routine_conditions`, `routine_reward_items` |
| 배정·수행 | `routine_assignments`, `routine_assignment_end_events`, `routine_occurrences`, `routine_occurrence_events` |
| 보상권·이행 | `routine_entitlements`, `routine_entitlement_events` |

`INSERT`, `UPDATE`, `DELETE`를 기록한다. 같은 행에 같은 값을 쓰는 완전한 no-op은 추가 기록하지 않는다. 기존 불변 정책이 원본 삭제를 금지하는 경우, 이 감사 트리거가 그 삭제를 허용하지는 않는다.

전역 principal/Auth 원장·초대·로그인 세션·구형 v1 활동 테이블·앞으로 설계할 법령 위계·민감 관찰 테이블은 이 generic 트리거 대상이 아니다. 기존 업무 감사·Auth 플랫폼 로그를 유지하며, 신규 테이블은 별도 allowlist 검토 후 연결해야 한다.

## 무엇을 남기고 무엇을 빼는가

`family_id`, 대상 테이블·`row_id`, `operation`, 서버 `timestamptz`, `transaction_id`, JWT `auth.uid()`에서 확인한 행위자와 `db_session_user`, `changed_columns`, 허용된 `old_values`/`new_values`를 남긴다. 수행일은 `business_date` 같은 허용된 업무 필드로 저장 시각과 구분한다.

이메일·비밀번호·토큰·이름·초안/규칙 전체 `payload`·사유·의료기록·자유서술 원문·요청/응답 원문·idempotency key는 복사하지 않는다. 제외된 필드의 변경은 **열 이름만** 남는다. 원문 복원·기준 검토는 기존 불변 게시본·업무 사건과 권한 안에서 대조한다. 이 로그만으로 전체 초안 내용을 재구성할 수는 없다.

수치·자녀 수행 상태·주체 UUID도 개인정보가 될 수 있으므로 최소 권한으로 조회한다. `SHA-256 fingerprint`는 허용된 JSON 사본의 지문이며 익명화나 관리자 변조 방지를 보증하지 않는다.

## 권한과 한계

- 전용 schema를 Supabase **Exposed schemas**에 추가하지 않는다. `anon`, `authenticated`, `service_role`은 원시 테이블 권한이 없다.
- 부모 조회 RPC는 확인된 이메일, 활성 principal·가족·부모 멤버십, 멤버십 유효기간을 재검사한다. 자녀·조회 보호자·다른 가족·중지된 부모는 거절된다.
- `SECURITY DEFINER` 함수는 `search_path=''`와 명시적인 schema 참조를 사용한다. 불필요한 `EXECUTE` 권한을 회수한다.
- JWT 없는 관리자·배치 작업은 `DATABASE_SESSION`으로 기록한다. 임의 부모 ID를 대입하지 않는다. DB 관리자나 SQL 세션이 설정한 JWT 문맥까지 진짜 사용자 서명으로 보증하는 기능은 아니다.
- 감사 저장 실패 시 업무 변경도 실패하는 **fail-closed** 방식이다. 장애 시 무조건 트리거를 끄는 대신 원인과 승인된 복구를 기록해야 한다.
- rollback된 변경·권한 거절·실패한 로그인·SELECT·DDL은 행 트리거에 남지 않는다. 별도 서버 보안 이벤트, Auth 로그, 선택적 pgAudit·외부 로그 수집이 필요하다. 이 별도 시스템의 설정을 완료한 것으로 표시하지 않는다.
- 소유자/고권한 관리자는 트리거·권한·함수를 바꿀 수 있다. 외부 보관·서명 체크포인트·독립 감사는 아직 구현하지 않았다.
- 가족 FK는 감사 대상 가족의 물리 삭제를 제한한다. 보존·삭제 요청 정책과 기간을 별도로 승인해야 하며 자동 영구 보존을 개인정보 적법성으로 간주하지 않는다. 현재 자동 삭제 작업은 없다.
- `audit_id`는 sequence 발급 순서이지 완전한 commit 순서가 아니다. rollback 때 공백이 생긴다. 내부 감사의 누락 점검은 과거 방향 페이지 커서만 믿지 말고 최근 기간 재조회·업무 사건 대조를 병행한다.

## 파일과 실제 실행

`Play-Routine-Audit-Log-Install-v0.1.sql`은 해당 Supabase SQL Editor에서 관리자 권한으로 실행할 수 있는 설치 스크립트다. 한 transaction으로 설치하며 5초 잠금 대기·60초 문장 제한을 둔다. 같은 버전 재실행은 감사행을 삭제하지 않고 이 스크립트의 트리거만 재연결한다. 새 버전 변경은 별도 migration으로 관리한다.

서비스 저장소에서는 같은 내용이 `supabase/migrations/0020_audit_log.sql`에 있고 기존 대상·해시 검증 migration 적용기를 사용한다. 사용자 승인에 따른 실제 적용 상태는 최종 검증 결과/WORKLOG에 기록한다.

`Audit-Log-Sample-Queries.sql`에는 설치 상태·최근 변경·상태 전환·허용 사본 지문 검사와 부모 RPC 예시가 있다. 정상 Auth 부모 세션 없이 SQL Editor에서 부모 JWT를 임의로 대입해 운영 조회를 시험하지 않는다.

`verify-audit-log-live.ts`는 기존 서비스의 실제 부모 RPC·16개 트리거·조회 권한·불변성·fail-closed를 확인한다. 실제 이메일 발송·실제 자녀 데이터 변경 없이 합성 fixture를 transaction 안에서 생성하고 전부 rollback한다. `--preview`는 설치 자체도 rollback한다. 한 DB 연결의 시험이며 여러 연결 경쟁 부하를 검증한 것은 아니다.

## 공식 근거

- [Supabase — Database functions](https://supabase.com/docs/guides/database/functions): SECURITY DEFINER·최소 권한·부모 권한 재검사.
- [PostgreSQL wiki — Audit trigger](https://wiki.postgresql.org/wiki/Audit_trigger): AFTER 트리거·transaction·SELECT/관리자 감사의 한계. 오래된 예제의 예외 무시·전체 query 저장은 그대로 적용하지 않았다.
- [PostgreSQL — Row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html): owner/BYPASSRLS 경계.

## 2026-10-18 실제 서비스 적용 확인

사용자 승인에 따라 운영 Supabase `dsnvohyinazotouqbzrv`에 `0020_audit_log.sql`을 실제 적용했다. 설치 전 preview 검사 37개와 설치 후 검사 38개를 통과했다. 두 실행 모두 합성 시험 행은 전체 rollback했다. 설치 전후 기존 `public` 38개 테이블의 행 수·내용 해시가 동일했다.

Auth health는 HTTP 200, 공개 REST에서 익명 감사 조회는 HTTP 401 / `42501`로 차단됐다. TypeScript·기본 135개 시험·프로덕션 빌드도 통과했다. 테스트에서 만들어진 감사 행을 실제 사용자 변경 기록처럼 남기지 않았다. 이후 실제 성공 변경부터 로그가 쌓인다.
