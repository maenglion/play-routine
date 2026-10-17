# School 격상 전후를 조회하는 재귀 SQL

작성한 `School-Hierarchy-Recursive-Queries.sql` 전체를 격리 PostgreSQL 엔진(PGlite)에서 실행했고, 깊이·영구 ID·효력 경계·미승인 관계 제외·순환 종료·ROLLBACK 정리 등 12개 검증을 통과했다. 운영 Supabase에는 접속하거나 적용하지 않았다.

## 실제 조회 결과

설명용 격상일은 **2026-11-01 00:00 한국시간**이다. 실제 사용자 승인일을 정한 것이 아니다.

```text
2026-10-31 조회
PR-BASIC                                depth 0
  PR-TASK                               depth 1
    PR-SCHOOL@v1                        depth 2
      PR-SCHOOL-ATTENDANCE@v1            depth 3
  PR-QUEST                              depth 1
  PR-LIFESTYLE                          depth 1

2026-11-01 조회
PR-BASIC                                depth 0
  PR-TASK                               depth 1
  PR-QUEST                              depth 1
  PR-LIFESTYLE                          depth 1
  PR-SCHOOL@v2                          depth 1
    PR-SCHOOL-ATTENDANCE@v1              depth 2
```

School은 두 시점 모두 같은 영구 ID `reg-school`이다. 이전 Task 관할은 School v1과 당시 관계로 남고, 이후 기본법 직속 관계는 School v2에 연결된다. 하위 출결의 원문 버전은 바뀌지 않는다. 이 예제는 개별 Task 규칙을 School로 자동 이동하거나 스티커·기간·보상권을 재계산하지 않는다.

## 샘플의 쿼리 6개

SQL 파일에는 임시 테이블, 예시 자료, `WITH RECURSIVE`/`CYCLE` 본체를 가진 `pg_temp.regulation_tree()` 함수, 아래 호출과 마지막 `ROLLBACK`까지 모두 들어 있다. 별도 세션에서 전체 파일을 한 번 실행하면 임시 자료와 함수가 제거되며 SELECT 결과를 확인할 수 있다. 다른 작업이 진행 중인 트랜잭션에 붙여 실행하지 않는다.

```sql
-- 1. 격상 전 전체 위계
SELECT * FROM pg_temp.regulation_tree(
  'demo-family', 'PR-BASIC', '2026-10-31 12:00+09'
);

-- 2. 격상 후 전체 위계
SELECT * FROM pg_temp.regulation_tree(
  'demo-family', 'PR-BASIC', '2026-11-01 12:00+09'
);

-- 3. 기본법 바로 아래: Task와 School이 같은 depth=1
SELECT code, version_no, parent_code, depth
FROM pg_temp.regulation_tree(
  'demo-family', 'PR-BASIC', '2026-11-01 12:00+09'
)
WHERE depth = 1 AND NOT is_cycle
ORDER BY code;

-- 4. School을 시작점으로 하위 규정만 조회
SELECT code, version_no, depth, path
FROM pg_temp.regulation_tree(
  'demo-family', 'PR-SCHOOL', '2026-11-01 12:00+09'
)
WHERE NOT is_cycle;
```

5번은 같은 영구 ID의 이전·이후 부모와 버전을 비교하고, 6번은 순환 관계를 진단한다. `CYCLE`은 순환 경로에 표시를 남기며 무한 재귀를 끝낸다. 입력 단계의 순환 차단이나 사용자 승인 검증을 대신하지 않는다.

## 기존 모델과 정확히 다른 부분

기존 `regulations`, `regulation_versions`, `regulation_version_relationships`의 열 이름을 따라 임시 `demo_*` 표를 만들었다. 현재 `pr_design`에는 School 종류와 관계 효력 열이 완성돼 있지 않으므로, 기존 모델에서 이 예제가 그대로 실행된다고 가정하지 않았다.

이 예제는 규정 종류를 text로 두어 School을 표현한다. 실제 구현에서는 앞서 제안한 승인된 종류 카탈로그로 연결할 수 있다. 기존 규정 관계 표에는 없는 `effective_from`, `effective_to`를 샘플 관계 표에 추가했다. 버전과 관계의 효력을 모두 `[시작, 끝)`으로 검사한다.

이 예제의 이전 버전 종료 시각은 처음부터 확정된 예시 값이다. 실제 게시된 버전의 종료 시각을 나중에 덮어쓰도록 제안하는 것이 아니다. 운영 격상은 기존 불변 기록을 보존하면서 별도 변경 사건·관계 효력 이력과 승인 묶음을 통해 게시해야 한다.

재귀 조회는 승인된 `GOVERNS`만 따른다. `REVISES`나 호환·참조 관계는 위계에 합치지 않는다. 가족 필터는 자료 조회 범위를 좁히는 것이며 사용자 권한 검증이 아니다. 운영 API는 인증된 사용자의 가족 소속을 서버에서 먼저 확인해야 한다.
