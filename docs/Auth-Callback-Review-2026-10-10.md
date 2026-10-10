# Play Routine 인증 콜백 점검 — 2026-10-10

**판정: 앱 코드는 보강했지만, 새 Supabase의 운영 콜백 설정은 아직 올바르지 않다.** 실제 Auth 서버가 공개 앱 대신 `http://localhost:3000/`로 리디렉션한다. 인증 health 성공·DB 접속 성공만으로 이 설정까지 정상이라고 볼 수 없다.

## 실제로 확인한 문제

대상은 새 프로젝트 `dsnvohyinazotouqbzrv`다. 공개 앱 JavaScript 번들이 이 프로젝트를 쓰며, 사라진 이전 프로젝트 주소는 포함하지 않는 것을 확인했다. 앱 서버·브라우저 환경의 프로젝트 URL도 일치한다.

실제 이메일이나 유효한 사용자 토큰을 사용하지 않고 `GET /auth/v1/verify`에 무효 토큰을 전달해 오류 콜백 정책을 확인했다. redirect를 자동으로 따라가지 않고 HTTP 303의 Location에서 목적지의 origin·path만 읽었다.

- redirect를 생략했을 때: `http://localhost:3000/`
- 공개 앱의 `/`를 요청했을 때: `http://localhost:3000/`
- 공개 앱의 `/auth/callback`을 요청했을 때: `http://localhost:3000/`
- 무관한 외부 주소를 요청했을 때: `http://localhost:3000/`

따라서 **실효 기본 Site URL은 localhost이며, 공개 목적지도 현재 허용된 주소로 처리되지 않는다.** 관리 화면 자체는 브라우저 로딩·시간 초과로 값을 읽지 못했지만, 실제 Auth 응답은 재현했다. 정확한 허용목록 전체와 이메일 템플릿은 아직 관리 화면에서 읽지 못했다.

별도로 추가한 실제 설정 Vitest 3개는 모두 실패했다. 이 결과는 코드 단위시험 통과와 구분해야 한다. 무효 토큰 오류 경로의 redirect 정책 검증이며, 실제 정상 메일의 수신·성공 콜백까지 시험한 것은 아니다.

## `/auth/callback`이 반드시 서버 라우트여야 하는 것은 아니다

현재 앱은 Next.js가 아니라 React + Vite + Express SPA다. 기존 Supabase 클라이언트는 `detectSessionInUrl: true`로 이메일 확인 후 URL fragment의 세션을 수신한다. 이 **implicit 브라우저 인증 방식에서는 `/` 자체가 유효한 콜백 수신 지점**이다. fragment는 서버에 전송되지 않으므로 Node 서버에서 `access_token`을 읽는 GET 라우트를 만들 필요가 없다.[1]

점검 전에는 앱의 React 라우트가 `/`만 등록했고 `/auth/callback`은 미등록이었다. HTTP 200이 나와도 SPA 정적 파일 fallback 응답일 뿐, React 화면은 Not Found로 갈 수 있었다. `/api/oauth/callback` 파일은 이전 플랫폼 OAuth 코드이며 현재 Supabase 이메일 인증의 콜백이 아니다. 이 주소를 Supabase Redirect URL로 지정해서는 안 된다.

또 현재 앱은 Next.js용 `@supabase/ssr` 서버 쿠키나 PKCE의 `exchangeCodeForSession` 방식이 아니다. 이를 혼합하거나 이메일 템플릿을 별도 `token_hash` 경로로 바꾸면 추가 구현이 필요하다.

## 이번에 수정한 코드

`client/src/App.tsx`에 `/auth/callback`을 등록해 기존 Home 인증 흐름으로 수신한다. 기존 `/` 이메일 복귀도 유지한다. 허용목록이 아직 잘못된 상황에서 발송 주소만 전용 경로로 바꾸지는 않았다. **현재 모든 이메일 요청은 공개 origin의 `/`를 사용한다.** `/auth/callback`은 추가 수신 가능한 별칭이다.

Supabase 클라이언트에 `flowType: "implicit"`을 명시했다. SDK 초기화 전에 콜백 여부·안전한 오류 안내만 읽고, 반환 상태에는 access/refresh token 값을 보존하지 않는다. `getSession()`이 SDK의 세션 수신을 완료할 때까지 기다린 후 화면을 갱신한다.

만료·이미 사용된 링크는 한국어 오류 안내를 표시한다. 외부 `error_description`이나 SDK 오류 원문은 그대로 화면·로그에 출력하지 않는다. 처리 후 주소에서 인증 파라미터·fragment를 제거하고 홈 경로로 정리한다. 외부 `next` 주소를 따라가는 open redirect는 구현하지 않는다.

확인 링크 복귀 후 계정 metadata의 parent/child 표시를 복원한다. 이는 UI 표시용이며, 실제 가족 접근 권한은 기존 DB membership·RLS로 판정한다. 기존 부모·자녀 membership이 있어도 비밀번호가 아직 설정되지 않았으면 대시보드보다 비밀번호 설정 화면을 먼저 보여준다.

서버 redirect origin 검증에는 http/https 프로토콜과 사용자정보 없는 URL 조건을 추가했다. 운영 환경의 localhost·무관한 외부 origin은 계속 거절한다.

## 검증 결과와 남은 한계

TypeScript 검사, 42개 단위시험, 프로덕션 빌드를 통과했다. 기본 실행에서 외부 연결시험 2개와 새 실제 callback 설정시험 3개는 명시적 실행 대상이라 skip된다. 별도 실행한 실제 callback 설정시험 3개는 localhost 응답 때문에 실패했다.

격리된 개발 브라우저에서 `/auth/callback#error=...&error_code=otp_expired`를 열어 한국어 만료 안내·로그인 화면·주소의 `/` 정리를 시각적으로 확인했다. 실제 사용자 세션이나 인증 링크는 사용하지 않았다.

현재 미완료 사항은 새 프로젝트 Site URL/허용 Redirect URL 수정, 이메일 템플릿 확인, 실제 부모·자녀 확인 메일 수신 및 정상 링크 복귀다. SMTP 발송 가능 여부는 콜백 문제와 별개다. 이번 코드 수정만으로 실제 이메일 인증이 끝까지 정상이라고 보고하지 않는다.

## 적용해야 할 Supabase 값

새 프로젝트의 Authentication → URL Configuration에서 **Site URL**은 다음으로 설정해야 한다.

```text
https://playroutine-nkwde3yc.manus.space/
```

현재 앱이 요청하는 주소에 맞춰 **Redirect URLs**에는 최소한 동일 공개 루트 주소가 필요하다. 추가 콜백 수신 경로를 쓰려면 다음도 등록한다.

```text
https://playroutine-nkwde3yc.manus.space/auth/callback
```

로컬 개발은 실제 필요할 때만 `http://localhost:3000/` 등을 허용목록에 추가하되 **공개 서비스의 Site URL을 localhost로 두지 않는다.** 운영에는 와일드카드 대신 정확한 주소를 권장한다.[2]

수정 후 `RUN_LIVE_AUTH_CALLBACK_TESTS=1 pnpm exec vitest run server/auth-callback.live.test.ts`를 실행해 기본 공개 복귀·공개 루트 수락·외부 주소의 공개 Site URL fallback 3개를 통과시킨다. 전용 경로의 실제 수신과 정상 메일 성공은 추가 실제 흐름으로 확인해야 한다. 실제 메일 링크·비밀번호·토큰은 채팅에 보내지 않는다.

## References

[1]: https://supabase.com/docs/guides/auth/sessions/implicit-flow "Supabase implicit browser authentication flow"
[2]: https://supabase.com/docs/guides/auth/redirect-urls "Supabase Site URL and redirect allow list"
[3]: https://raw.githubusercontent.com/supabase/auth/master/internal/api/verify.go "Supabase Auth verification and error redirect implementation"
