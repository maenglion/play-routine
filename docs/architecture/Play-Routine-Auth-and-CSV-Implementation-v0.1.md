# Play Routine 부모–자녀 Auth·CSV 구현 보고서 v0.1

**작성자: Manus AI**  
**Supabase 프로젝트 ref:** `dzbiwxqcmsgmtfyghmhx`  
**정책:** 기존 Google Sheet·Apps Script·원장 데이터 0건 이관, 신규 시작

## 1. 구현 결론

Play Routine의 로그인과 가족 연결을 **Supabase 이메일 OTP**로 교체했다. 부모는 이메일 OTP로 가입한 뒤 가족 공간을 만들고 자녀의 이름과 이메일을 초대한다. 자녀는 부모가 등록한 것과 동일한 이메일로 OTP 인증하고 초대를 수락하면, 사용자가 선택한 정책에 따라 부모의 추가 승인 없이 즉시 `ACTIVE`로 연결된다.

Google Sheets와 Apps Script는 운영 경로에서 제거했다. 부모 관리자 화면은 현재 자녀·초대·계정 연결 이력을 UTF-8 CSV로 내보낼 수 있다. 활동·원장·쿠폰·약 기록 CSV는 해당 신규 도메인 테이블을 구현할 때 같은 엔드포인트에 확장한다.

## 2. 실제 적용 상태

| 항목 | 적용 결과 |
|---|---|
| Supabase Auth API | publishable key로 health HTTP 200 확인 |
| Supabase PostgreSQL | transaction pooler 인증 테스트 통과 |
| Auth·가족 운영 테이블 | 8개 적용 |
| 보안 워크플로 함수 | 7개 적용 |
| RLS 활성 테이블 | 8개 적용 |
| RLS 정책 | 12개 적용 |
| 화면 | 부모·자녀 역할 선택, OTP 요청·검증, 가족 생성, 자녀 초대, 초대 수락 |
| CSV | 자녀·초대·연결 이력, 부모 bearer token·가족 membership 확인 |

Supabase는 이메일 OTP 요청에 `signInWithOtp`, 코드 검증에 `verifyOtp`를 제공한다. 신규 사용자 자동 생성 여부는 `shouldCreateUser`로 제어할 수 있다.[1] Play Routine은 부모 가입에는 자동 생성을 허용하고, 자녀는 서버가 유효한 초대를 확인한 뒤에만 OTP 요청을 실행한다.

## 3. 데이터 구조

| 테이블 | 책임 |
|---|---|
| `principals` | Auth 계정 변경·삭제와 분리된 안정적 행위자 ID |
| `families` | 부모가 소유하는 가족 공간 |
| `family_memberships` | 가족별 부모·보호자·자녀 역할과 유효기간 |
| `child_profiles` | 가족별 자녀 운영 프로필, 가입 전 생성 가능 |
| `child_invitations` | 부모가 등록한 자녀 이메일 초대의 상태·만료·수락 |
| `invitation_delivery_events` | OTP 요청·전송·실패·제한의 append-only 감사 로그 |
| `auth_link_events` | 연결·해제·재연결 감사 이력 |
| `notifications` | 자녀 연결·해제 등 계정 알림 |

Supabase의 `auth.users`는 앱 데이터 API에서 직접 사용하지 않고 `principals.auth_user_id`가 기본키를 참조한다. 이는 Supabase가 권고하는 앱용 public 프로필 테이블 패턴을 따른다.[2]

## 4. 부모 가입·초대 흐름

| 단계 | 처리 |
|---:|---|
| 1 | 부모 이메일에 OTP 전송 |
| 2 | 6자리 OTP 검증 후 Supabase session 발급 |
| 3 | `bootstrap_parent_family`로 principal·family·OWNER_PARENT membership 생성 |
| 4 | 부모가 자녀 이름·이메일 입력 |
| 5 | `create_child_invitation`이 자녀 profile과 7일 유효 초대 생성 |
| 6 | 이메일 원문은 Auth 외 앱 테이블에 저장하지 않고 HMAC fingerprint·마스킹값만 보존 |

같은 가족·같은 이메일에 활성 초대가 있으면 새 초대를 만들지 않는다. 만료 초대는 종결한 뒤 새 초대를 만들 수 있다.

## 5. 자녀 가입·즉시 연결 흐름

| 단계 | 처리 |
|---:|---|
| 1 | 자녀가 이메일 입력 |
| 2 | 서버가 비공개 HMAC fingerprint로 활성·미만료 초대를 확인 |
| 3 | 초대가 유효할 때만 Supabase OTP 요청 실행 |
| 4 | 자녀가 6자리 OTP 검증, Auth session 발급 |
| 5 | `list_my_active_child_invitations`가 인증 이메일과 일치하는 초대만 반환 |
| 6 | 자녀가 초대 수락 |
| 7 | `complete_child_invitation`이 행 잠금·재검사 후 profile·CHILD membership·초대 상태를 한 트랜잭션으로 변경 |
| 8 | 커밋 즉시 자녀는 `ACTIVE`, 부모에게 연결 알림 생성 |

같은 수락 요청이 재전송되면 기존 활성 membership을 반환한다. 다른 Auth 사용자가 수락하거나, 초대가 만료·취소·사용됐거나, 이메일 fingerprint가 다르면 거부한다.

## 6. 보안 경계

| 위험 | 방어 |
|---|---|
| 이메일 초대 존재 여부 탐색 | 자녀 OTP 요청은 초대 유무와 무관하게 같은 일반 응답 반환 |
| OTP 이메일 폭탄 | Supabase 제한 외에 초대별 60초·24시간 5회 제한 |
| 초대 탈취 | 인증 이메일 HMAC fingerprint 완전 일치 |
| 동시 수락 | 초대·자녀 profile `FOR UPDATE`와 유일 인덱스 |
| 재수락 중복 | 동일 principal은 기존 결과 반환, membership·알림 중복 생성 금지 |
| 교차 가족 접근 | `auth.uid → principal → active membership` RLS |
| 연결 해제 후 접근 | membership `ENDED`, profile `UNLINKED`, API마다 활성 membership 검사 |
| CSV 무단 다운로드 | Supabase access token 검증 후 부모 membership 재검사 |
| CSV 수식 주입 | `=`, `+`, `-`, `@` 시작 셀에 안전 접두사 적용 |

## 7. CSV 운영

부모 관리자 화면에는 현재 다음 세 CSV가 있다.

| CSV | 포함 데이터 |
|---|---|
| 자녀 | 자녀 profile, 상태, 계정 연결 여부, 연결·해제 시각 |
| 초대 | 마스킹 이메일, 초대 상태, 만료·수락·거절·취소 시각 |
| 연결 이력 | 연결·해제·재연결 사건과 사유 |

파일은 UTF-8 BOM을 포함해 한국어 Excel 환경에서도 열기 쉽게 했다. CSV는 운영 DB의 사본이며 DB를 대체하지 않는다. 수정한 CSV를 다시 올려 DB를 덮는 기능은 만들지 않았다.

## 8. 검증 결과

| 검증 | 결과 |
|---|---|
| TypeScript | 통과 |
| Vitest | 5개 파일, 7개 테스트 통과 |
| 프로덕션 빌드 | 통과 |
| 로컬 PostgreSQL migration 하네스 | 통과 |
| 가족 RLS 격리 | 무관 사용자 0건, 부모 자기 가족 조회 통과 |
| 이메일 불일치 초대 수락 | 거부 확인 |
| 초대 수락 멱등성 | CHILD membership·알림 각 1건 확인 |
| 연결 해제 | profile UNLINKED·membership ENDED·감사 이력 확인 |
| 무인증 CSV | HTTP 401 확인 |
| 데스크톱·모바일 화면 | 시각 검증 완료 |

실제 이메일 수신부터 OTP 입력까지의 최종 운영 확인은 대표가 사용할 부모 이메일과 자녀 이메일로 1회 수행해야 한다. 테스트 과정에서는 임의 고객 계정이나 가짜 가족 데이터를 운영 DB에 만들지 않았다.

## 9. 현재 범위와 다음 단계

이번 버전은 **인증·가족 관계·초대·초기 CSV 기반**을 실제 Supabase에 적용했다. 활동, `ref`, `policy`, today event, residual, settlement, ledger, coupon, medication 도메인은 승인된 규칙과 시뮬레이션을 기준으로 다음 migration에서 신규 생성한다. 기존 Google Sheet 원장과 사용자는 가져오지 않는다.

다음 운영 확인 순서는 다음과 같다.

1. 부모 탭에서 실제 부모 이메일로 OTP 가입한다.
2. 가족 공간을 생성한다.
3. 자녀가 실제 사용할 이메일을 등록한다.
4. 자녀 탭에서 같은 이메일로 OTP 인증한다.
5. 초대를 수락하고 즉시 연결되는지 확인한다.
6. 부모 화면에서 자녀·초대·연결 이력 CSV를 내려받는다.

## References

[1]: https://supabase.com/docs/guides/auth/auth-email-passwordless "Supabase Passwordless Email Sign-in"
[2]: https://supabase.com/docs/guides/auth/managing-user-data "Supabase User Management"
