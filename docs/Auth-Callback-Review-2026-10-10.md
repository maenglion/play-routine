# Play Routine 인증 콜백 점검 — 2026-10-10 16:48 KST 갱신

**판정: localhost 콜백 설정 오류는 해결됐고, 현재 SPA 콜백 코드와 실제 공개 복귀 정책은 검증을 통과했다.** 실제 이메일 수신·유효한 확인 링크의 세션 생성·부모–자녀 연결은 별도 종단시험 전이다.

## 실제 설정 변경 후 확인

새 프로젝트는 `dsnvohyinazotouqbzrv`다. 사용자에게 Site URL 수정을 안내했고 사용자가 완료한 뒤 실제 Auth 응답을 다시 검사했다. 공개 앱 번들과 서버·브라우저 환경 모두 새 프로젝트를 쓰며 이전 프로젝트 주소는 포함하지 않는다.

실제 사용자 토큰이나 이메일 발송 없이 `GET /auth/v1/verify`에 무효 토큰을 전달했다. HTTP 303의 Location에서 origin·path만 읽었으며 결과는 다음과 같다.

- redirect 생략: `https://playroutine-nkwde3yc.manus.space/`
- 공개 `/` 요청: 동일 공개 루트로 복귀
- 공개 `/auth/callback` 요청: 동일 전용 콜백 경로로 복귀
- 무관한 외부 주소 요청: 외부 주소가 아니라 공개 Site URL로 복귀

수정 전에는 위 요청이 모두 `http://localhost:3000/`으로 돌아갔다. **16:47 재검증에서는 localhost 목적지가 사라졌다.** Site URL의 실효 값과 두 공개 목적지의 수용 정책을 확인한 것이며, 관리 대시보드의 Redirect URLs 목록 전체를 직접 읽거나 모든 외부 origin을 전수 검사한 것은 아니다. Supabase는 Site URL과 요청 주소의 정책에 따라 복귀 주소를 결정하므로 실효 정책과 목록 등록 사실을 혼동하지 않는다.[2] [3]

## 현재 콜백 구현

앱은 Next.js가 아니라 React + Vite + Express SPA다. Supabase 클라이언트는 `flowType: "implicit"`, `detectSessionInUrl: true`로 브라우저 URL fragment의 세션을 수신한다. 이 방식에서는 `/`도 유효한 콜백 수신 지점이며 토큰 fragment는 서버에 전송되지 않는다.[1]

현재 이메일 요청은 부모 가입·자녀 첫 연결·부모 재전송 모두 현재 origin의 `/`를 사용한다. `/auth/callback`도 React 라우트로 등록해 같은 인증 흐름으로 받는다. 전용 경로가 꼭 서버 GET 라우트일 필요는 없다.

`/api/oauth/callback`은 이전 플랫폼 OAuth 코드이며 현재 Supabase 이메일 콜백이 아니다. 현재 앱은 Next.js `@supabase/ssr`·서버 쿠키·PKCE `exchangeCodeForSession` 구조가 아니다. `?code=...` 또는 `token_hash` 전용 템플릿을 추가하려면 별도 인증 설계가 필요하며 현재는 형식 불일치 안내를 표시한다.

이번 보강은 SDK 초기화 전에 콜백 여부·안전한 오류 안내만 보존하고 토큰 원문은 상태에 저장하지 않는다. `getSession()`의 세션 수신 완료를 기다린 후 계정을 갱신한다. 만료·이미 사용된 링크를 한국어로 안내하고 외부 `error_description`이나 SDK 오류 원문은 그대로 화면·로그에 출력하지 않는다. 처리 후 URL의 인증정보·fragment를 제거한다. 외부 `next` 주소를 따라가는 open redirect는 없다.

부모/자녀 metadata는 UI 모드 복원에만 사용하며 접근 권한은 DB membership·RLS로 판정한다. 기존 가족 연결이 있어도 비밀번호 설정이 필요하면 대시보드보다 설정 화면을 먼저 보여준다. 서버 이메일 redirect 검증은 운영에서 공개 origin만 허용하고 비웹 프로토콜·URL 사용자정보를 거절한다.

## 검증 결과와 남은 한계

코드 TypeScript·42개 단위시험·프로덕션 빌드를 통과했다. 별도 실제 콜백 설정시험에 전용 경로를 추가해 4개 정책을 검증한다. 기본 코드 시험에서 실제 서버 시험은 명시적 실행 전까지 skip된다.

격리된 **공개 배포 브라우저**에서 가짜 만료 콜백을 열어 한국어 만료 안내·로그인 화면·홈 URL 정리를 확인했다. 이는 실제 계정을 쓰지 않는 오류 화면 시험이다. 정상 유효 링크의 로그인 세션 생성·비밀번호 설정·실제 자녀 초대 수락까지 끝난 것으로 보고하지 않는다.

기존 메일은 만료·1회 사용·생성 당시 주소가 적용될 수 있으므로 종단시험에는 새 확인 메일을 사용한다. 실제 메일 수신은 SMTP 발송 설정과 별개로 확인해야 한다. 설정 수정과 함께 메일 전달이 자동 해결됐다고 판단하지 않는다.

## 현재 실효 설정과 재검증 명령

Site URL의 실효 값은 다음이다.

```text
https://playroutine-nkwde3yc.manus.space/
```

공개 루트와 다음 전용 수신 경로가 실제 Auth redirect에서 수용된다.

```text
https://playroutine-nkwde3yc.manus.space/auth/callback
```

운영 Site URL은 localhost로 되돌리지 않는다. 로컬 주소는 개발 시 필요할 때만 별도 허용하고, 운영에는 정확한 주소 설정을 권장한다.[2]

```bash
RUN_LIVE_AUTH_CALLBACK_TESTS=1 pnpm exec vitest run server/auth-callback.live.test.ts
```

다음 실제 단계는 공개 앱에서 부모 가입용 **새 확인 메일**을 요청하고 수신 여부를 확인하는 것이다. 메일 링크·토큰·비밀번호는 채팅에 보내지 않는다.

## References

[1]: https://supabase.com/docs/guides/auth/sessions/implicit-flow "Supabase implicit browser authentication flow"
[2]: https://supabase.com/docs/guides/auth/redirect-urls "Supabase Site URL and redirect allow list"
[3]: https://raw.githubusercontent.com/supabase/auth/master/internal/api/verify.go "Supabase Auth verification and error redirect implementation"
