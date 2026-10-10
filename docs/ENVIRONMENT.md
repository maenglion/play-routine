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
