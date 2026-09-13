# Play Routine

ADHD 자녀의 일상 활동, 보상, 부모 확인을 지원하는 부모 웹·자녀 모바일 웹 애플리케이션입니다. 현재 공개 소스에는 Figma 기반 핵심 UI, Supabase 이메일 OTP 부모–자녀 연결, 가족별 RLS, 부모 CSV 내보내기, 자녀 프로필 사진 업로드, Supabase migration이 포함됩니다.

## 주요 화면

| 역할 | 화면 |
|---|---|
| 부모 | 이메일 OTP 로그인, 가족 생성, 자녀 이메일 초대, 연결 상태 확인, CSV 내보내기 |
| 자녀 | 이메일 OTP 로그인, 초대 수락, 오늘의 할 일, 현재 보유량·오늘 모으는 중, 작은 프로필 사진 |

## 기술 구성

| 영역 | 기술 |
|---|---|
| Frontend | React 19, Vite, Tailwind CSS 4, shadcn/ui |
| Server | Express, tRPC, TypeScript |
| Auth·DB | Supabase Auth, PostgreSQL, RLS |
| File storage | S3-compatible storage helper |
| Test | Vitest, PostgreSQL migration harness |

## 로컬 실행

```bash
pnpm install
pnpm dev
```

실행 전에 `docs/ENVIRONMENT.md`의 변수 목록을 로컬 또는 배포 환경의 비밀 저장소에 등록해야 합니다.

프로덕션 빌드는 다음 명령으로 확인합니다.

```bash
pnpm check
pnpm test
pnpm build
```

## 환경변수

실제 값은 저장소에 커밋하지 않습니다. `docs/ENVIRONMENT.md`의 변수명을 기준으로 로컬 또는 배포 환경의 비밀 저장소에 설정하세요.

| 변수 | 용도 | 노출 범위 |
|---|---|---|
| `VITE_SUPABASE_URL` | 브라우저 Supabase 프로젝트 URL | 클라이언트 허용 |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | 브라우저 publishable key | 클라이언트 허용 |
| `SUPABASE_URL` | 서버 Supabase 프로젝트 URL | 서버 |
| `SUPABASE_PUBLISHABLE_KEY` | 서버 Auth API 호출 | 서버 |
| `SUPABASE_DATABASE_URL` | PostgreSQL transaction pooler 연결 | 서버 비밀 |
| `BUILT_IN_FORGE_API_URL` | 프로필 이미지 저장 API | 서버 비밀 |
| `BUILT_IN_FORGE_API_KEY` | 프로필 이미지 저장 인증 | 서버 비밀 |

## Supabase migration

`supabase/migrations`의 SQL을 번호 순서대로 적용합니다.

```text
0001_identity_auth.sql
0002_auth_workflows.sql
0003_child_invitation_discovery.sql
0004_child_profile_avatar.sql
```

운영 DB에 적용하기 전에 `supabase/tests/identity_auth_harness.sql`로 PostgreSQL 제약과 워크플로를 검증하세요.

## 보안 원칙

자녀 초대 이메일 원문은 앱 테이블에 저장하지 않고 HMAC fingerprint와 마스킹된 값만 사용합니다. 자녀는 초대된 이메일로 OTP 인증한 뒤 초대를 수락하면 즉시 가족에 연결됩니다. 모든 가족 데이터 접근은 활성 membership과 RLS를 확인합니다. CSV와 프로필 이미지 API도 Supabase 세션과 가족 권한을 재검증합니다.

## 설계 문서

`docs/architecture`에는 전체 DB 구조, 확대 가능한 SVG ERD, 활동형 보상 `ACTIVITY_ENTITLEMENT` 설계, Auth·CSV 구현 요약이 포함됩니다.
