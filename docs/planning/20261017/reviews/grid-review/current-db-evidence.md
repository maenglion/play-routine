# Play Routine 현행 DB·서버 다중 가족 격리 검토 근거

- **검토일:** 2026-10-17
- **범위:** 현행 저장소의 `supabase/migrations/0001`~`0019`, `server/supabaseDb.ts`, `server/routes/avatars.ts`, `server/routes/exports.ts` 및 부모/자녀 루틴 호출부. 코드·운영 행·권한·원격 저장소는 변경하지 않았다.
- **실DB 확인 방법:** `server/supabaseConnection.ts:2-10`과 같은 환경변수 조합으로 접속하여 `BEGIN READ ONLY` 안에서 `pg_class`, `pg_policies`, `pg_constraint`, `pg_indexes`, `pg_proc`, 권한 함수를 조회했다. **응용 테이블 행, 가족 ID, 이메일, 자녀 사실은 조회·기록하지 않았다.** 접속 역할은 `postgres`이고 `rolbypassrls=true`였다.
- **중요한 구분:** `docs/Play-Routine-Full-DB-Structure-v0.2.md:1-6`은 Auth·가족 외 영역을 “물리 migration 전 통합 설계”라고 명시한다. 따라서 이 메모는 이를 현행 DDL/배포 스키마로 주장하지 않으며, 아래의 “실DB 카탈로그”는 실제 존재 객체에만 적용한다.

## 결론

현재 구조는 **가족을 최상위 테넌트 키로 두고, 부모/자녀/보호자 역할과 `family_id` 복합 FK, raw-table 차단 + 인증 RPC 경계**를 이미 갖췄다. 한 명의 부모 관리자가 표 중심 UI를 사용하더라도, 데이터 모델 자체는 다중 가족 확장을 전제로 한 편이다. 특히 루틴 v2의 규칙·배정·수행 사건·권리(보상 약속)는 가족 단위로 묶여 있고, 자녀 프런트는 부모 프런트와 별도 RPC 경로를 유지할 수 있다.

다만 부모 표 UI로 조회를 집중할 때는 **무제한 JSON 집계 목록과 RLS를 우회하는 서버 DB 연결에 대한 경계 강화**가 먼저 필요하다. 이것은 현재 취약점이 확인되었다는 뜻이 아니라, 여러 가족/긴 이력을 지원하는 UI로 넓히기 전에 회귀를 막기 위한 우선 과제다.

## 확인된 잘된 점

### 1) 가족 테넌트·역할 모델과 기본 RLS

- `principals`–`families`–`family_memberships`–`child_profiles`가 분리되어 있다. 가족 멤버십은 `(family_id, principal_id)` 활성 유니크, 가족당 활성 `OWNER_PARENT` 유니크를 둔다. 자녀 프로필도 `(id, family_id)` 유니크를 제공한다. **근거:** `0001_identity_auth.sql:78-149`.
- 현재 주체/활성 멤버/부모 여부는 `auth.uid()`에서 내부 principal로 변환한 뒤 가족 ID로 재확인한다. **근거:** `0001_identity_auth.sql:290-335`.
- 기본 프로필·가족·멤버십·초대에는 RLS 정책이 있으며, 부모는 자기 가족의 자녀를, 활성 자녀는 자기 프로필만 읽도록 한다. **근거:** `0001_identity_auth.sql:353-476`, 보호자 범위를 더 좁힌 `0006_guardian_viewers.sql:50-116`.
- 실DB 카탈로그에서도 기본 identity/가족 테이블의 RLS 활성 및 authenticated 전용 정책을 확인했다. `families`, `family_memberships`, `child_profiles`, 초대/링크/보호자 초대 정책은 `USING` 조건을 가진다. 보호자는 일반 가족 행·자녀 프로필을 부모처럼 상속하지 않는다.
- 기본 grant는 별도 강화되어 있다. `0005_client_privilege_hardening.sql:3-30`은 익명/인증 클라이언트의 광범위 권한을 먼저 회수하고, 필요한 읽기와 제한된 열 업데이트만 재부여한다. `TRUNCATE`는 RLS 적용 대상이 아니라는 주석도 명시되어 있다.

### 2) 루틴 v2의 물리적 가족 격리와 무결성

- 루틴 강화물, 초안, 게시 규칙, 조건, 보상 항목, 배정, 발생 건, 원천 사건, 권리 및 권리 사건에 모두 `family_id`가 있다. `routine_assignments`, `routine_occurrences`, `routine_occurrence_events`, `routine_entitlements` 등은 `(참조 ID, family_id)` 복합 FK로 부모 객체와 **같은 가족**임을 강제한다. **DDL 근거:** `0017_routine_v2.sql:19-32, 55-92, 141-180, 183-235, 238-287`.
- 실DB `pg_constraint`에도 예를 들어 `routine_occurrences (assignment_id, family_id) → routine_assignments (id, family_id)`, `routine_occurrence_events (occurrence_id, family_id) → routine_occurrences (id, family_id)`, `routine_entitlements`의 child/rule/condition/reward/origin occurrence 복합 FK, `routine_entitlement_events (entitlement_id, family_id) → routine_entitlements (id, family_id)`가 실제 존재했다.
- 중복 지급 방지는 Quest의 occurrence 원점 유니크와 Daily의 자녀·규칙·기간·조건·보상 항목 유니크로 분리한다. **근거:** `0017_routine_v2.sql:267-274`.
- 실DB 인덱스에는 가족·자녀·기간 조회용 `routine_assignments_family_child_dates_idx`, GiST `routine_assignments_child_rule_range_idx`, 발생 건의 `routine_occurrences_child_date_idx`/검증 완료 partial index, 권리의 `routine_entitlements_child_created_idx`, 위 두 지급 유니크 인덱스, 규칙 버전의 `routine_rules_family_group_effective_idx`가 존재했다. 이는 인덱스 **존재** 확인이지, 속도 수치나 부하 한계를 뜻하지 않는다.
- 구 활동 레지스트리와 v2 루틴 레지스트리 사이의 중복 배정은 가족별 advisory transaction lock과 실제 날짜/요일 겹침 검사로 양방향 차단한다. **근거:** `0018_cross_registry_assignment_guard.sql:3-39`; v2 생성 경로의 가족 lock과 충돌 검사도 `0017_routine_v2.sql:764-791`.

### 3) raw table을 닫고 인증·역할 검증 RPC로 표면을 제한

- 루틴 raw table은 RLS를 켜고, `public`/`anon`/`authenticated`의 모든 table 권한을 회수한 뒤 필요한 RPC 실행만 authenticated에 부여한다. **근거:** `0017_routine_v2.sql:1096-1112`.
- 실DB 카탈로그에서 루틴·활동·수동 보상 raw table 19개는 모두 `relrowsecurity=true`, 해당 raw table의 정책 수 0, `anon` 및 `authenticated`의 SELECT/INSERT/UPDATE/DELETE/TRUNCATE 권한 모두 false였다. 이는 “RLS 정책으로 테이블 API를 허용”하는 방식이 아니라, **테이블 API 자체를 닫고 SECURITY DEFINER RPC만 공개**하는 방식과 일치한다.
- 실DB 카탈로그에서 `list_routine_registry`, `list_routine_assignments`, `list_routine_day`, `list_routine_entitlements`, `list_routine_reinforcers`는 모두 `SECURITY DEFINER`, `anon EXECUTE=false`, `authenticated EXECUTE=true`였다. 각 RPC 내부의 권한 검사는 다음과 같다.
  - 부모 전용 레지스트리/강화물/배정: `0017_routine_v2.sql:605-614, 645-654, 794-799`.
  - 일별 목록과 권리 목록: 대상 child profile에서 family를 얻은 뒤 verified parent 또는 그 자녀 자신인지를 검사한다. **근거:** `0017_routine_v2.sql:841-862, 1073-1080`.
  - 발생 건을 물리화하는 일별 조회는 단일 `child_profile_id`와 단일 `business_date`를 받는다. 미래 날짜도 거부한다. **근거:** `0017_routine_v2.sql:819-829, 841-848`.
- 활동 v1와 수동 보상도 같은 원칙이다. raw table을 닫고 RPC만 부여한다. **근거:** `0009_activity_assignments_and_review.sql:1002-1038`, `0012_manual_rewards.sql:985-1019`.

### 4) 원천 사건·부모 확인·보상/패널티·원장 경계가 유지됨

- 활동 발생 건은 현재 projection이고, `activity_occurrence_events`가 자녀 보고/부모 확인의 append-only 원천 사건이다. 부모 확인은 expected revision과 actor 단위 idempotency key를 검사한다. **근거:** `0009_activity_assignments_and_review.sql:122-214, 887-998`.
- 루틴도 occurrence projection과 `routine_occurrence_events`를 분리한다. 검증 후에도 낮은 정정은 권리를 자동 회수하지 않고 `requires_review` 및 append-only 권리 사건으로 남긴다. **근거:** `0017_routine_v2.sql:182-235, 890-970, 988-1023`.
- Quest/Daily 권리는 별도 `routine_entitlements`이며, 이행은 부모만 가능하고 검토 대기 권리는 이행할 수 없다. **근거:** `0017_routine_v2.sql:1025-1062, 1073-1094`.
- 수동 금전 보상도 외부 지급 확인 기록일 뿐 자동 송금이나 잔액 원장이 아니다. **근거:** `0012_manual_rewards.sql:3-5, 576-649, 1021-1030`. 실DB에 원장 잔액을 대신하는 테이블/쓰기 경로가 있다고 확인하지 않았다.
- 불변성은 트리거로도 보강되어 있다. 실DB 카탈로그에서 루틴 규칙·조건·보상 항목·원천 사건·권리 사건·요청 사건의 update/delete 불변 트리거, 배정 종료만 허용하는 guard, 활동 원천 사건 append-only 트리거를 확인했다. 미사용 강화물 삭제만은 활성 인증 부모·미참조·감사 조건의 좁은 예외다. **근거:** `0017_routine_v2.sql:504-546`, `0019_unused_reinforcer_removal.sql:3-28`.

> **표 UI 불변 원칙:** 표의 행 편집은 원천 사건, 부모 확인, 보상 권리, 패널티 평가 및 미래 원장을 한 행으로 합치거나 직접 UPDATE하는 기능이 되어서는 안 된다. 사실 정정은 기존의 revision/idempotency/append-only RPC 경로를 계속 사용해야 하며, 임의 원장 수정이나 이미 발행된 권리의 자동 몰수 권한을 추가하지 않는다.

## 서버 경계와 테넌트 필터 확인

| 경로 | 확인된 격리 방식 | 판정 |
|---|---|---|
| `server/supabaseDb.ts` | DB pool은 환경변수 연결 문자열을 사용한다(`:10-24`). 초대 이메일 lookup은 fingerprint로만 찾고(`:30-56`), 부모 재전송은 `auth_user_id`, 전달받은 `family_id`, 초대 ID 및 활성 부모 멤버십을 한 SQL에서 모두 확인한다(`:87-111`). OTP 예약은 초대 ID advisory lock을 사용한다(`:114-143`). | 초대 재전송의 가족 스코프 검증은 양호. 단, 이 pool은 실DB에서 RLS 우회 역할이므로 새 직접 SQL은 별도 검토가 필요. |
| `server/routes/avatars.ts` | bearer token을 Supabase Auth로 검증하고(`:107-119`), child 또는 같은 가족의 OWNER_PARENT/PARENT만 profile lookup을 통과한다(`:78-105`). 저장 키도 family/profile 경로를 포함한다(`:123-127`). | 현재 lookup은 가족을 검증한다. 아래 위험 2의 쓰기 조건 보강이 필요. |
| `server/routes/exports.ts` | 내보내기 전 authenticated + 이메일 확인을 요구하고(`:190-209`), `parentFamilyForAuthUser`가 활성 부모 멤버십으로 `familyId`를 결정한다(`:54-69`). 각 dataset SQL은 `where … family_id=$1`로 고정한다. 예: routine records/rewards `:73-102`, child/invitation/link `:128-186`. | 가족 필터가 일관되게 존재하며, 복합 FK도 조인 무결성을 보조. |

## 위험 및 우선순위 (4개, 성능 수치 미측정)

| 우선순위 | 위험·근거 | 지금 필요한 조치 | 사용자가 늘어난 뒤 필요한 조치 |
|---|---|---|---|
| 1 | **무제한 목록 집계.** 실DB 함수 정의 카탈로그에서 `list_routine_registry`, `list_routine_assignments`, `list_routine_entitlements`, `list_routine_reinforcers`는 `jsonb_agg`를 사용하고 `LIMIT`/`OFFSET`가 없었다. 소스도 registry는 가족의 모든 drafts/rules(`0017:645-654`), assignment는 가족 전체(`0017:794-799`), entitlement는 자녀 전체 이력(`0017:1073-1080`)을 반환한다. 부모 UI는 refresh마다 registry, assignments, 선택 자녀의 일별 목록과 전체 entitlement를 병렬 호출한다(`RoutineParentPanel.tsx:313-374`). 자녀 UI도 전체 entitlement를 호출한다(`RoutineChildPanel.tsx:106-144`). | **표 UI 도입과 함께** 목록 RPC에 기간/상태/자녀 필터와 cursor 또는 제한된 페이지 계약을 설계한다. 현재 일별 목록은 단일 날짜이므로 유지 가능하다. 표에는 기본 기간(예: 현재 운영 범위)과 “더 보기”를 명시한다. | 실제 사용 패턴을 익명 집계한 뒤 `EXPLAIN (ANALYZE)`/부하 시험으로 추가 복합·partial index, export 전용 비동기화 여부를 결정한다. 이번 검토에서는 속도·가족 수·동시성 수치를 측정하지 않았다. |
| 2 | **RLS 우회 서버 SQL의 방어 심도 부족.** 실DB 연결 역할은 `rolbypassrls=true`이며 `supabaseDb.ts:13-21`, `avatars.ts:17-28`, `exports.ts:10-21`은 그 pool을 쓴다. `avatarProfileForAuthUser`는 먼저 가족/역할을 검증하지만(`avatars.ts:78-105`), 뒤의 UPDATE는 `where id=$1`만 사용한다(`:137-145`). 현 구현에서 임의 profile ID가 통과한다는 증거는 없지만, 인증 확인과 쓰기 사이의 별도 쿼리·향후 재사용은 회귀 지점이다. | **지금** privileged server DB 접근의 코드 규칙을 정한다: 모든 읽기/쓰기에 family scope를 명시하고, 특히 쓰기는 `id AND family_id` 및 가능하면 동일 트랜잭션의 역할 재확인을 사용한다. 새 부모 표 API는 publishable key가 아닌 이 서버 pool을 쓸 경우 이 규칙을 테스트한다. | 서버 역할을 더 축소하거나 tenant-scoped DB/RPC façade로 통일하고, 다중 가족 회귀 테스트(부모/자녀/보호자/해지 직후)를 지속 실행한다. |
| 3 | **복수 가족 부모의 암묵적 기본 선택.** 루틴 RPC들은 명시적 `p_family_id`를 요구하지만, CSV `parentFamilyForAuthUser`는 familyId가 없으면 OWNER_PARENT 우선 정렬 후 한 가족을 `limit 1` 선택한다(`exports.ts:54-69`). 한 부모가 여러 가족에 속할 미래에는 표/내보내기가 사용자의 의도와 다른 가족을 기본으로 선택할 수 있다. | 현재 단일 가족 운영에서는 UI가 명시 family context를 계속 전달하고, 부모 표 state/API에서 `familyId`를 필수값으로 취급한다. | 실제로 한 계정의 복수 가족 기능을 노출할 때, 상단 가족 전환기·최근 선택 저장·CSV 파일명/헤더의 가족 context·전환 시 state 초기화를 구현한다. 서버 fallback은 명시 선택 없이는 거절하거나 UX 정책을 문서화한다. |
| 4 | **감사 요청 이벤트의 가족별 운영 조회 준비도.** `routine_request_events`는 actor+idempotency 유니크와 action/payload/response를 기록하지만 테이블 열에 `family_id`가 없다(`0017:289-300`). 현행에는 이를 가족별로 노출하는 목록 RPC가 없으므로 즉시 격리 누출은 확인되지 않았다. 하지만 다가족 관리자 감사 표·보존 정책을 만들면 payload JSON을 기준으로 필터하는 설계가 된다. | 지금은 이 내부 감사 테이블을 부모 표의 범용 원장/감사 화면에 노출하지 않는다. | 가족별 감사 조회가 제품 범위에 들어올 때만, 별도 가족 스코프 감사 projection 또는 명시 family key를 추가하되 기존 immutable request event를 수정하지 않는 이행 방식을 설계한다. |

## 부모 표 UI에 대한 적용 메모

1. **현재 바로 가능한 표의 데이터 원천:** 명시 family context로 `list_routine_registry`, `list_routine_assignments`, 선택 자녀·선택일의 `list_routine_day`, 필터된 entitlement 목록을 사용한다. 자녀 프런트는 `list_routine_day(child, day)`와 `list_routine_entitlements(child)`의 별도 권한 경계를 그대로 유지한다.
2. **표에서 허용할 동작:** 기존 인증 RPC를 호출하는 초안 저장·게시·배정 종료·자녀 보고·부모 검증·기간 확정·권리 이행의 상태 표시 및 명시적 액션. 직접 테이블 편집/일괄 UPDATE는 허용하지 않는다.
3. **표에서 분리해 표시할 열:** (a) 자녀의 원천 보고, (b) 부모 검증/사유, (c) 발행된 권리와 `requires_review`, (d) 수동 지급의 외부 지급 확인은 별도 상태/행으로 둔다. `confirmed_minutes`, 보상 예정, 권리 이행을 잔액·원장으로 합산해 보여주지 않는다.
4. **검증 한계:** 이번에는 실제 가족 수 증가, 대량 이력, 실제 응답 시간, 경합 부하, 실제 역할 간 데이터 행 비교를 시험하지 않았다. 따라서 임의 성능 수치나 “몇 가족까지 가능”이라는 결론은 내리지 않는다.

## 인수 기준 요약

- 새 부모 표 API/SQL은 **명시 `family_id`**, 서버 측 활성 역할 확인, 관련 객체의 `(id, family_id)` 일치를 갖춘다.
- 한 페이지의 데이터 범위는 날짜·자녀·상태·cursor 중 하나 이상으로 제한한다. CSV 전체 내보내기는 별도 장기 작업으로 취급할 수 있으나, 가족 필터는 계속 강제한다.
- 자녀 UI의 본인 child-profile 권한, 보호자의 read-only/status-only 경계, 부모의 가족별 권한을 변경하지 않는다.
- 원천 사건, 부모 확인, 보상/패널티 평가, 보상 권리, 미래 원장은 분리 유지한다. **임의 원장 수정·자동 현금/시간 잔액 변경·이미 획득한 권리의 자동 몰수는 허용하지 않는다.**
