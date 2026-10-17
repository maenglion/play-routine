# Play Routine 규정형 DB·부모 운영표 패키지

먼저 `Implementation-Guide.md`를 읽으면 규정·월별 계획·실제 회차·인정 한도·보상권·이행의 관계가 보인다. 기존 운영 DB나 공개 앱을 바꾸는 설치 패키지가 아니다.

| 위치 | 내용 |
|---|---|
| `Implementation-Guide.md` | 전체 관계, 생활 4회/3회 한도, 학교 최고총액과 권리·이행, UI 경로 |
| `database/schema.sql` | `pr_design` 격리 PostgreSQL 모델과 부모 권한 함수 |
| `database/seed.sql` | 10월 Task 7·Quest 3·Lifestyle 16의 원문 번호·명시 값·미정 값 |
| `database/samples.sql` | 부모 범위 조회·생활 인정·학교 마감·보상권/이행 샘플 |
| `database/entity-map.md` | 테이블·키·FK·RPC 검증 책임과 미구현 경계 |
| `database/verify-design.mjs` | 격리 PGlite 실제 실행 시험 |
| `database/verify-result.json` | 실행한 검증 결과와 실제 행 수 |
| `prototype/src/` | React·TypeScript 상단 메뉴·운영표·모의 계산 소스 |
| `prototype/dist/` | 검증된 정적 빌드 결과 |
| `prototype/README.md` | 프런트 실행법과 실제 운영 미연결 경계 |
| `skill/family-rule-governance/` | 재사용 스킬·정책 사례·검증 반례·순수 산술 도구 |
| `source-documents/` | 설계의 기준인 기본법·하위규정·10월 시행령·승계 원문 |

## 실행은 한 단계씩

화면을 보려면 먼저 `prototype` 폴더에서 `npm ci`를 실행한다. 완료되면 `npm run dev`로 미리보기를 시작한다. 자세한 안내는 해당 폴더 README에 있다.

DB 시험은 **별도 폴더**인 `database`에서 `npm install`로 의존성을 준비한 후 `node verify-design.mjs`를 실행한다. `schema.sql`을 운영 Supabase의 SQL Editor에 붙여 넣지 않는다. 시험은 메모리 안의 격리 엔진을 사용한다.

스킬 산술 도구는 Python 표준 라이브러리만 사용한다. `check_policy_math.py --self-test`는 DB나 실제 지급을 검사하지 않는다.

## 유의할 범위

생활 상한·학교 최종총액의 핵심 계산은 검증하지만, 기존 계정 연결·규칙 초기화·실제 송금/쿠페이 충전·전체 자정 원장·법령 게시 처리기의 운영 통합을 포함하지 않는다. 기간 경계·일반 중간 지급·미확정 규칙은 예시 가정과 분리되어 있다. 실제 PostgreSQL 병렬 트랜잭션과 운영 RLS 시험은 배포 전 추가 검증 사항이다.

SQL에서 시험용 JWT claims를 직접 설정하는 부분은 격리 fixture·신뢰 서버의 전제다. 실제 브라우저에 부모 ID를 지정하게 하거나 DB 비밀번호·service-role 키를 넣는 방식이 아니다. 이 패키지에는 운영 인증값을 포함하지 않는다.
