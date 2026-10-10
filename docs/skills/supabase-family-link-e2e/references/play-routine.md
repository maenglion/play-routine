# Play Routine 적용 참고

## 대상 확인

현재 코드 저장소는 https://github.com/maenglion/play-routine 이다. 공개 앱 URL과 Supabase 프로젝트는 저장소 환경 문서·현재 설정에서 확인하며 이 참고에 키·연결 문자열을 고정하지 않는다.

이전 기준 공개 도메인은 playroutine-nkwde3yc.manus.space였다. 변경 시 서버의 허용 origin과 Auth Site URL/Redirect URL을 함께 바꾼다.

## 핵심 파일

| 책임 | 파일 |
|---|---|
| 현재 작업·차단 원인 | WORKLOG.md |
| 가입·로그인·부모 초대와 재전송 상태 | client/src/pages/Home.tsx |
| 부모 초대 카드 | client/src/components/play-routine/ParentDashboard.tsx |
| 확인 링크 발송·부모 세션 검사 | server/routers/supabaseAuth.ts |
| fingerprint·소유권·요청 제한·감사 SQL | server/supabaseDb.ts |
| 실제 테이블·RLS | supabase/migrations/ |

## 조회 패턴 — 먼저 schema 확인

child_invitations의 id로 범위를 한정하고 email_masked만 출력한다. 초대 생성과 메일 발송은 별개다. 부모 재전송 시 같은 이메일을 다시 입력하며 서버는 HMAC fingerprint를 비교한다. 실제 운영 한도는 60초 간격, 최근 24시간 5회이다.

```sql
-- 스키마가 이 구조인지 먼저 확인하고 parameter binding을 사용한다.
select id, status, expires_at, accepted_at, email_masked
from public.child_invitations
where id = $1;

select event_type, created_at,
       detail->>'code' as error_code,
       detail->>'status' as error_status
from public.invitation_delivery_events
where invitation_id = $1
order by created_at;
```

getUser로 검증한 부모 Auth id, ACTIVE 부모 membership, family id, invitation id, 같은 이메일 fingerprint가 모두 맞아야 재전송한다. 초대 ACCEPTED 후에는 연결 전 재전송 대상이 아니다.

## 검증 명령

```bash
pnpm check
pnpm test
pnpm build
RUN_LIVE_SUPABASE_TESTS=1 pnpm exec vitest run server/supabase.connection.test.ts server/supabase.database.connection.test.ts
```

2026-10-10 추출 시 코드 검증은 통과했으나 실제 연결시험은 Auth DNS ENOTFOUND와 DB tenant/user not found로 실패했다. 이 결과를 E2E 성공 사례로 사용하지 않는다. 최신 WORKLOG에서 차단 해소 여부를 다시 확인한다.

## 운영상 유의

단위시험의 lookup null mock은 라우터가 불일치 결과에서 발송하지 않는다는 증거일 뿐, SQL/RLS의 실DB 격리 검증이 아니다. 원자적 요청 예약의 transaction advisory lock도 실DB 동시 요청 시험을 별도로 수행한다.

기존 원장·사용자·잔액은 신규 서비스로 이관하지 않는다. 약 복용은 점수·원장과 분리한다. 전체 ERD를 실제 적용 테이블 목록으로 간주하지 않는다.
