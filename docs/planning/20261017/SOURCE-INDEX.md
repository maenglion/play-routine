# Play Routine 기획·설계·검증 자료 색인 — 2026-10-17

**먼저 읽을 문서:** [데이터 기획안 v0.1](data-planning-20261017/Play-Routine-Data-Planning-Proposal-v0.1.md). 교수·일반 독자·데이터 지원사업 설명을 위해 데이터 구조, 용어, 감사 구현, 내부 감사, 개인정보와 검증 범위를 함께 설명한다.

이 폴더는 기획·검토·합성 실행 결과를 보존한다. 최신 운영 코드의 배포 폴더가 아니다. 실제 부모·자녀 원자료, 인증정보, 운영 DB 덤프·백업은 포함하지 않는다. `rule-simulation-20261017/output/DB-state.json`과 `DB-dump.sql`은 **완전 합성 예시 사건**의 실행 결과이며 운영 DB 사본이 아니다.

## 1. 규정 최신본과 개정 이력

- [법령형 구조·월별 승계 v0.2](../../governance/20261017/Play-Routine-Regulation-Lifecycle-v0.2.md)
- [기본규정·3대 하위규정 v0.6](../../governance/20261017/Play-Routine-Operating-Constitution-and-Three-Regulations-v0.6.md)
- [10월 시행령 v0.5](../../governance/20261017/Play-Routine-October-Enforcement-Rules-v0.5.md)
- [최초 법령형 구조에 대한 Grok 원문](../../governance/20261017/Grok-Regulation-Lifecycle-Review-20261017.md)

이전 문서 버전은 같은 `docs/governance/20261017`에 개정 근거로 보존했다. 최신본은 위 링크이며, 문서 버전과 실제 운영 승인 버전은 같다고 가정하지 않는다. 앞선 모델에 대한 Grok 의견을 후속 수정본의 재승인으로 쓰지 않는다.

## 2. 현행 분석과 초기 관계형 모델

- [현재 원장·규칙 대조표](reviews/Play-Routine-Current-Ledger-and-Rules-Review-20261016.md)
- [구조 검토 Word](rule-structure-20261016/Play-Routine-Rule-Structure-Review-v0.1-20261016.docx)
- [52개 Entity 초기 설계서](relational-model-20261016/Play-Routine-Relational-Model-v0.1.md)
- [초기 설계 Word](relational-model-20261016/Play-Routine-Relational-Model-v0.1.docx)
- [초기 모델 DDL](relational-model-20261016/Play-Routine-Relational-Reference-v0.1.sql) · [Entity 사전](relational-model-20261016/entity-dictionary.md)
- [검증 결과](relational-model-20261016/Validation-Result.json)

52개 Entity 모델은 10/16 당시 참고 설계다. 이후 법령형 계층·월별 채택·학교 계산으로 설계가 발전했으므로 그대로 운영 migration에 적용하지 않는다.

## 3. 과거·최근 조건 대입 시뮬레이션

- [46개 시나리오 결과 보고서](rule-simulation-20261017/Play-Routine-Rule-Simulation-20261017.md)
- [실행 범위·가정·재현 방법](rule-simulation-20261017/README.md)
- [조건 입력과 별도 기대값](rule-simulation-20261017/scenarios.json)
- [테스트 어댑터 코드](rule-simulation-20261017/engine.mjs)
- [246개 독립 비교 근거](rule-simulation-20261017/output/independent-checks.json)

OLD·NEW·PROPOSAL을 구분한 합성 시험이다. 시작 잔액·주간 경계 등 시험 가정은 사용자 운영 확정값이 아니다. 실제 자녀 행동·송금·자정 운영 배포 결과가 아니다.

## 4. 부모 표 화면과 다중 사용자 검토

- [부모 프로세스 과잉 단계 검토](reviews/Play-Routine-Parent-Management-Process-Review-20261017.md)
- [표 관리자·DB 확장성 통합 검토](reviews/Play-Routine-Grid-Admin-and-DB-Scalability-Review-20261017.md)
- [실제 Grok 확장성 검토 원문](reviews/grid-review/Grok-Grid-DB-Scalability-Review-20261017.md)
- [DB 점검 근거](reviews/grid-review/current-db-evidence.md) · [실제 호출 메타데이터](reviews/grid-review/grok-grid-review-metadata.json)
- [독립 상단 메뉴 프로토타입·38개 테이블·26개 DRAFT 규칙](../../../prototypes/regulation-grid-20261017/README.md)

운영표 / 규정 / 보상·원장 / 강화물 / 설정·기록의 모의 화면이다. 운영 앱을 이 화면으로 교체하지 않았다.

## 5. 신규 스키마·메뉴 ERD·격상 재귀 SQL

- [Grok 스키마·메뉴 통합 검토](grok-schema-menu-review-20261017/Play-Routine-Grok-Schema-and-Menu-ERD-Review-20261017.md)
- [실제 Grok 원문](grok-schema-menu-review-20261017/Grok-Schema-Multiuser-Review-20261017.md) · [메타데이터](grok-schema-menu-review-20261017/grok-review-metadata.json)
- [핵심 ERD](grok-schema-menu-review-20261017/Core-ERD.png) · [ERD 원본](grok-schema-menu-review-20261017/Core-ERD.mmd)
- [메뉴·데이터 연결도](grok-schema-menu-review-20261017/Menu-Data-Link.png) · [현재 모의 연결과 향후 연결 설명](grok-schema-menu-review-20261017/menu-erd-notes.md)
- [위계·격상 원칙](grok-schema-menu-review-20261017/Play-Routine-Regulation-Hierarchy-and-Promotion-v0.1.md)
- [School 재귀 조회 SQL](grok-schema-menu-review-20261017/School-Hierarchy-Recursive-Queries.sql) · [사용 안내](grok-schema-menu-review-20261017/School-Hierarchy-Recursive-Queries-Guide.md)
- [재귀 샘플 검증 결과](grok-schema-menu-review-20261017/school-verification/result.json)

테스트모드 NULL 조건과 정본 seed/시험 fixture 분리 문제는 검토에서 발견된 **미보강 사항**이다. 이 검토 폴더를 게시한 것으로 문제가 수정·배포됐다고 표시하지 않는다.

## 6. 격상·격하·보상 영향·부모 알림

- [Supabase 처리·보상·제안 알림·승인 이력 v0.2](hierarchy-notification-review-20261017/Play-Routine-Hierarchy-Reward-Notification-Design-v0.2.md)
- [실제 Grok 원문](hierarchy-notification-review-20261017/Grok-Hierarchy-Reward-Notification-Review-20261017.md)
- [호출·완결 메타데이터](hierarchy-notification-review-20261017/grok-review-metadata.json)

제안·읽음·승인·실제 적용을 구분한다. 신규 governance 테이블과 외부 알림은 계획이며 실제 운영 자동화가 아니다.

## 7. 최신 재사용 스킬

- [family-rule-governance SKILL.md](../../skills/family-rule-governance/SKILL.md)
- [격상·알림 검토 절차](../../skills/family-rule-governance/references/hierarchy-change-review.md)
- [실제 Grok 검토 템플릿](../../skills/family-rule-governance/templates/grok-hierarchy-review-prompt.md)
- [산술 검사 도구](../../skills/family-rule-governance/scripts/check_policy_math.py)

프로토타입 패키지 안의 `skill` 폴더는 최초 제작 당시의 사본이다. 최신 스킬은 위 `docs/skills/family-rule-governance`를 기준으로 사용한다.

## 8. 데이터 기획안과 감사 근거

- [데이터 기획안 v0.1](data-planning-20261017/Play-Routine-Data-Planning-Proposal-v0.1.md)
- [감사 소스 근거](data-planning-20261017/audit-evidence.md)
- [개인정보·접속기록 공식 근거](data-planning-20261017/privacy-sources.md)
- [데이터 처리 도식](data-planning-20261017/diagrams/Data-Lifecycle.png)
- [규정·보상 관계 도식](data-planning-20261017/diagrams/Regulation-and-Reward.png)
- [내부 감사 도식](data-planning-20261017/diagrams/Internal-Audit.png)

[PUBLICATION-MANIFEST.json](PUBLICATION-MANIFEST.json)은 복사한 문서·샘플·검토 파일의 최종 SHA-256과 크기를 기록한다. 현재 색인과 WORKLOG는 그 문서 목록을 설명하는 추가 파일이다.
