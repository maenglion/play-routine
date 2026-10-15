# Environment variables

실제 값은 GitHub에 커밋하지 않습니다. 아래 변수는 로컬 셸, CI secret, 또는 배포 환경의 비밀 저장소에서 설정합니다.

| 변수 | 예시 형식 | 용도 |
|---|---|---|
| `VITE_SUPABASE_URL` | `https://your-project-ref.supabase.co` | 브라우저 Supabase URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | `your_publishable_key` | 브라우저 publishable key |
| `SUPABASE_URL` | `https://your-project-ref.supabase.co` | 서버 Supabase URL |
| `SUPABASE_PUBLISHABLE_KEY` | `your_publishable_key` | 서버 Auth API 호출 |
| `SUPABASE_DATABASE_URL` | `postgresql://...` | PostgreSQL transaction pooler, 서버 비밀 |
| `BUILT_IN_FORGE_API_URL` | 배포 환경 제공값 | 프로필 이미지 저장 API |
| `BUILT_IN_FORGE_API_KEY` | 배포 환경 제공값 | 프로필 이미지 저장 인증 |
| `JWT_SECRET` | 긴 무작위 문자열 | 서버 세션 서명 |
| `VITE_APP_ID` | 배포 환경 제공값 | 애플리케이션 식별자 |
| `VITE_ANALYTICS_ENDPOINT` | URL | 분석 엔드포인트 |
| `VITE_ANALYTICS_WEBSITE_ID` | 식별자 | 분석 사이트 ID |

`VITE_` 접두사가 있는 변수는 브라우저 번들에 포함될 수 있으므로 비밀값을 넣지 않습니다. 데이터베이스 비밀번호, GitHub 토큰, 서버 저장소 키는 반드시 서버 전용 환경변수로 관리합니다.

## 검사와 실제 연결시험

`pnpm check`, `pnpm test`, `pnpm build`는 코드 검증입니다. 기본 테스트에서 외부 Auth·PostgreSQL 연결시험 2개는 제외합니다. 실제 연결은 다음 명령으로 별도 실행하며, 이 명령의 실패를 단위시험 통과로 덮지 않습니다.

```bash
RUN_LIVE_SUPABASE_TESTS=1 pnpm exec vitest run server/supabase.connection.test.ts server/supabase.database.connection.test.ts
```

실제 서비스 연결시험에는 현재 Auth URL·publishable key·DB 연결정보가 필요합니다. DB 검사는 Node `pg`를 사용하므로 별도 `psql` 설치를 요구하지 않습니다. DNS 실패나 pooler의 tenant/user 오류가 발생하면 대상 프로젝트 상태와 최신 연결정보를 확인합니다. 다른 프로젝트로 임의 전환하지 않습니다.

실제 메일 수신·부모/자녀 연결의 진행 상태는 저장소 루트 `WORKLOG.md`를 읽습니다. 단위시험과 빌드 성공은 실제 메일 수신·연결 완료를 의미하지 않습니다.

## DB 비밀번호 분리 입력과 복구 검증

`SUPABASE_DATABASE_PASSWORD`를 별도 서버 환경변수로 입력하면 `SUPABASE_DATABASE_URL` 안의 비밀번호를 대체합니다. 특수문자 인코딩은 `server/supabaseConnection.ts`가 처리하므로 비밀번호만 안전한 설정에 입력하면 됩니다. 이 값을 브라우저 환경이나 공개 저장소에 넣지 않습니다.

Migration은 `pnpm exec tsx scripts/apply-supabase-migrations.ts <현재-project-ref>`로 적용합니다. 앱 Auth URL과 DB 사용자 또는 직접 host의 프로젝트 식별자가 일치하지 않으면 중단하며, 파일 SHA-256과 성공 기록을 `private.schema_migrations`에 남깁니다. 적용 파일은 수정하지 않고 후속 migration을 추가합니다.

`pnpm exec tsx scripts/verify-family-link.ts`는 실제 PostgreSQL 역할·RPC·RLS·컬럼 권한을 검사한 후 전체 fixture를 롤백합니다. `pnpm exec tsx scripts/verify-resend-live.ts`는 자기가 생성한 UUID fixture만 사용해 소유권 SQL·3개 동시 요청·60초/24시간 제한을 시험하고 해당 fixture만 정리합니다. 두 시험 모두 실제 이메일을 보내지 않으며, 실제 메일 수신 시험을 대신하지 않습니다.

0005 migration은 새 프로젝트의 기본 전체 table grants를 제거하고 `anon`과 `authenticated`에 필요한 최소 권한만 부여합니다. RLS와 별개로 `TRUNCATE`·민감 컬럼 UPDATE·초대 fingerprint 읽기를 차단합니다. 테이블별 권한과 policy를 모두 확인해야 합니다.

## 활동 배정·체크·부모 확인 검증 (0009)

`RUN_LIVE_ACTIVITY_TESTS=1 pnpm exec vitest run server/activity-flow.live.test.ts`로 현재 DB의 활동 쓰기·읽기 권한, 중립 구간, 수행일/입력일 분리, 고정 규칙 버전·중복키·revision을 롤백 시험한다. 실DB fixture끼리는 공통 advisory lock으로 직렬화한다. 이 시험은 원장·잔액을 생성하지 않으며 새 배정 시작일은 가족 시간대 기준 다음날 이후다.

## 데일리·Quest 및 조건별 복수 보상 검증 (0017~0018)

`RUN_LIVE_ROUTINE_V2_TESTS=1 pnpm exec vitest run server/routine-v2.live.test.ts`는 단계별 임시저장·게시 불변·선택 보상 1~2개·스티커 기간 집계·보상권 중복 방지·부모/자녀/보호자 권한을 실제 PostgreSQL 역할로 검사한다. 모든 fixture는 공통 잠금 아래에서 생성하고 롤백한다. 실제 보상 송금이나 이메일 발송은 하지 않는다.

`pnpm exec tsx scripts/verify-existing-data-preservation.ts capture <보호된-snapshot-path>`로 기존 테이블의 행 수·내용 해시만 보관한 뒤, migration 및 롤백 시험 후 `verify <동일-path>`로 비교할 수 있다. 스냅샷에는 행 원문이 없으며 비공개 폴더에 보관한다. 실제 사용자가 동시에 기록을 바꾸면 변경 감지가 정상적으로 발생하므로 그 상황은 별도 대조한다.

신규 부모 CSV의 `routine-records`와 `routine-rewards`도 기존 서버의 부모 세션·가족 필터를 사용한다. Netlify에는 브라우저 공개 변수만 설정하고 서버 DB 비밀번호를 복사하지 않는다. 신규 보상권의 `AVAILABLE`·`FULFILLED` 및 재검토 표시는 일반 시간 원장·자동 송금과 다른 상태다.
