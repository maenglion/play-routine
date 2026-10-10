# Play Routine 인증 콜백 점검 — 2026-10-10 16:54 KST 갱신

**판정: localhost 콜백 설정 오류는 해결됐고, 실제 로그인·자녀 초대 수락·즉시 ACTIVE 연결까지 확인했다.** 부모의 재로그인 후 자녀 화면 확인은 마지막 사용자 확인으로 남는다.

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

격리된 **공개 배포 브라우저**에서 가짜 만료 콜백을 열어 한국어 만료 안내·로그인 화면·홈 URL 정리를 확인했다. 이 오류 화면 시험과 별개로, 16:52 실제 사용자 로그인·수락 보고 및 운영 DB 인증·비밀번호·연결 정합성을 확인했다. 상세 결과는 아래 실제 확인 절을 따른다.

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

16:48 당시 다음 단계였던 실제 로그인·자녀 수락은 16:52 성공을 확인했다. 이제 부모의 재로그인 후 자녀 표시를 확인한다. 메일 링크·토큰·비밀번호는 채팅에 보내지 않는다.

## References

[1]: https://supabase.com/docs/guides/auth/sessions/implicit-flow "Supabase implicit browser authentication flow"
[2]: https://supabase.com/docs/guides/auth/redirect-urls "Supabase Site URL and redirect allow list"
[3]: https://raw.githubusercontent.com/supabase/auth/master/internal/api/verify.go "Supabase Auth verification and error redirect implementation"

## 16:52 KST 실제 로그인·수락 확인

사용자가 실제 앱에서 로그인·초대 수락이 됐다고 보고했다. 이에 새 DB를 조회해 이메일 인증과 비밀번호 설정이 완료된 계정 2개, 가족 1개, ACCEPTED 초대 1개, ACTIVE 자녀 프로필 1개를 확인했다. 수락 시각은 **2026-10-10 16:51:20 KST**다.

초대의 accepted principal과 자녀 profile principal, 인증 이메일 fingerprint가 모두 일치한다. 활성 CHILD membership은 1개이고 링크 감사·부모 알림도 각 1개다. 실제 메일 발송 감사는 OTP_REQUESTED와 OTP_SENT 각 1개이며, 사용자의 로그인·수락 보고와 실제 인증·연결 상태를 함께 확인했다. 메일 발송 제공자의 SENT만으로 수신 성공을 추정한 것은 아니다.

실제 부모·자녀 Auth 사용자 역할을 읽기 전용 트랜잭션으로 적용해 자녀 프로필을 조회했다. 양쪽 모두 자기 가족의 ACTIVE 자녀 1개만 조회했고 데이터는 변경하지 않았다. 이 운영 DB에는 가족이 1개이므로 두 실제 가족 간 차단을 시험한 것은 아니며, 교차 가족 거절 증거는 앞서 별도 fixture로 수행한 21개 실DB 검증을 따른다.

**인증된 실제 자녀의 초대 수락·즉시 ACTIVE 연결은 성공으로 판정한다.** 다만 사용자의 ‘로그인’ 보고가 부모의 재로그인까지 의미하는지는 구분되지 않으므로 부모 로그아웃 → 비밀번호 재로그인 → 연결 자녀 표시 확인은 마지막 사용자 확인으로 남긴다. 실제 연결된 계정·가족·초대·감사 데이터는 보존했고 삭제·초기화하지 않았다. 별도 SMTP 설정 전체를 조회하거나 일반 사용자 대상 메일 전달 가능성을 검증한 것은 아니다.
