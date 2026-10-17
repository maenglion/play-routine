# Play Routine 메뉴·ERD 연동 메모

> **판독 기준:** `schema.sql`은 격리 설계(38 tables)이고, 현 UI는 Supabase/API 호출이 없습니다. `rules.ts`의 정적 26건과 `localStorage`의 모의 `State`만 읽고 변경합니다. 따라서 **Menu-Data-Link의 실선은 현재 브라우저 모의 연결**, **점선은 아직 없는 API/RPC 연결 계획**입니다. 점선은 ERD의 FK가 아닙니다.

## 두 그림의 역할

| 파일 | 읽는 방법 | 범위 |
|---|---|---|
| [Core-ERD.mmd](Core-ERD.mmd) / [PNG](Core-ERD.png) | 까마귀발 선은 `schema.sql`의 실제 FK 및 nullable 여부에 따른 cardinality만 표시 | 밀도를 제한한 핵심 23 tables. `immutable_ledger_entries`는 **FK가 없어 고립**되어 있다. |
| [Menu-Data-Link.mmd](Menu-Data-Link.mmd) / [PNG](Menu-Data-Link.png) | 실선=현 App.tsx 읽기/변경, 점선=향후 DB API/RPC 대응 | 메뉴 5개, 정적 규칙·6개 모의 state dataset·설계 DB 대응 및 미연결 영역 |

## 식별자: 화면의 26 rules code와 DB 정본

`rules.ts`는 **TASK 7 + QUEST 3 + LIFESTYLE 16 = 26**을 `code` (`T-001`, `Q-001`, `L-001`)로만 보관합니다. DB에서는 다음을 분리합니다.

```text
rules.ts code (화면 표시·현재 모의 조회 키)
  └─[향후 resolve]─> rule_identities.permanent_number (가족 내 영구 번호)
                       └─ rule_identities.rule_id (내부 정체성 ru_id 역할)
                          └─ rule_versions.rule_version_id (불변 정확 버전)
                               └─ rule_governing_versions (동일 kind 규정 버전 근거 bridge)
```

- 실제 SQL 열 이름은 `rule_id`이며, 여기서 말하는 **ru_id는 그 내부 정체성 키의 의미**다. `permanent_number`가 사용자/규정에 보이는 T/Q/L 번호다.
- `monthly_plans`는 규칙을 복사하지 않는다. `plan_rule_adoptions`가 **자녀 + 정확한 `rule_version_id`**를 월 계획에 채택하고, `scheduled_occurrences`가 그 채택과 규칙 버전을 고정한다.
- 현 `Occurrence.code`만으로는 DB의 가족·채택·버전을 결정할 수 없다. API는 `code → rule_id → published rule_version → adoption/occurrence`를 서버에서 resolve해야 한다.

## 현재 메뉴별 데이터와 DB 갭

| 메뉴 | 현재 읽기/변경(실선) | 점선으로 대응할 설계 DB | 중요한 갭 |
|---|---|---|---|
| 운영표 | `rules`, `occurrences`, `school`, `rights`, `paid`; 발생 추가·부모 확인·학교 토글 | 계획/채택/회차, `source_events`, `parent_confirmations`, 학교 평가·스티커·기간/한도 | 모의 `Occurrence`는 `code`뿐이며 원사건/판정/한도/정확 버전의 FK가 없다. |
| 규정 | `rules.ts` 26건 읽기·필터만 | 규정/규정버전, rule identity/version, governing bridge, conditions/effects | 현 화면은 규정을 게시·개정·승인하지 않으며 DRAFT 값의 표시다. |
| 보상·원장 | `rights[]`, `paid` 및 학교 요약; 모의 발행/이행 | `reward_rights`, corrections, batch, actual executions | `paid`는 숫자 하나다. DB는 1 batch와 권리별 실행행을 분리하며, 실 송금/충전도 없다. |
| 강화물 | `reinforcers[]` 읽기·추가 | asset identity + immutable asset version | 화면의 `MEDIA_MIN` 등은 모의 식별자이며 규칙 effect의 `asset_version_id`가 아니다. |
| 설정·기록 | `audit[]` 열람, `occurrences[]` CSV, 전체 localStorage reset | 직접 대응 테이블 없음 | audit은 브라우저 UX 로그다. `immutable_ledger_entries`는 audit/잔액/송금 테이블이 아니며 FK도 없다. |

## 학교: T-007만 집계

- 현 `schoolSummary()`는 **T-007 학교 주간**의 `school[]`만 `base(0/1/null) + praise(0/1)`로 계산한다. `base=null`, feedback 미수신, 또는 문제(0)+칭찬(1)은 보류다. 다른 규칙/스티커와 합산하지 않는다.
- 설계 DB도 학교 기본 0/1은 `school_day_assessments`, 독립 칭찬은 `sticker_awards`로 분리한다. `UNCONFIRMED`은 0이 아니다.
- `stable_rule_scopes`, `aggregation_periods`의 기간 키는 계획/규칙 버전이 아니라 family·child·stable scope·`[starts_on, ends_on)`·timezone에 고정된다. 생활 한도는 `recognition_limit_buckets`에 별도로 저장된다. 원사건/부모 판정과 한도 버킷 사이에 **직접 FK는 없다**; `recognition_limit_uses`와 `lifestyle_recognition_results`가 그 연결을 보관하며 Core 축약본에서는 도면 밖으로 뒀다.

## Core 축약본에서 도면 밖으로 둔 실제 테이블/관계

23-table 한도를 지키기 위해 다음은 Markdown으로만 명시한다. 생략은 미구현이나 관계 부정을 뜻하지 않는다.

- `family_memberships`: `parent_confirmations.parent_membership_id`와 각 승인/실행자의 실제 복합 FK 대상. Core에는 `parent_confirmations` 속성으로만 표기했다.
- `asset_identities`: `asset_versions.asset_id`의 실제 FK 대상. Core에는 `asset_versions`부터 표시했다.
- `plan_governing_versions`, `recurrence_templates`, regulation/rule lineage·compatibility: 규정·계획의 버전 관계/반복 일정을 보강한다.
- `measurements`, `sticker_types`, `sticker_awards`, `recognition_limit_uses`, `lifestyle_recognition_results`, `effect_applications`, `reward_correction_events`: 사실·스티커·한도 소비·효과 적용·정정의 상세 정본이다.
- `medication_records`: 민감 기록으로 별도다. 특히 L-013은 부모 직접 확인 생활 사건이며, 복약 기록 공란이 자동 패널티/보상/원장 변경을 만들지 않는다.

## 구현 시 지켜야 할 경계

1. `immutable_ledger_entries`에는 child/asset/period/source FK가 없다. **원장으로 보이는 UI 화살표나 직접 FK 선을 추가해 실제 정산처럼 해석하면 안 된다.**
2. seed의 26 규칙·규정·자산·계획은 DRAFT prototype 데이터다. 운영 호출은 게시(`PUBLISHED`)된 규칙과 같은 kind의 게시 근거 규정 버전을 요구한다.
3. 현 CSV는 `occurrences[]`만 브라우저에서 다운로드하는 모의 문서다. DB export·감사 원장·실계정 데이터가 아니다.
4. 실제 통합은 raw table write가 아니라 권한 확인·idempotency·기간 정산을 강제하는 서버 API/RPC에서 수행해야 한다.

## 근거 소스(읽기 전용)

- `database/schema.sql`: FK/cardinality, 원장 FK 부재, 약물 분리
- `database/seed.sql`: 26개 식별자와 Task 7 / Quest 3 / Lifestyle 16 fixture
- `database/entity-map.md`: 설계 경계 및 RPC 비범위
- `prototype/src/App.tsx`, `rules.ts`, `logic.ts`: 메뉴, `localStorage`, 26개 정적 규칙, 학교 집계·모의 발행/이행
