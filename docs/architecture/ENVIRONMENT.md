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
