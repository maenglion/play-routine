-- School 위계 분리 예제: PostgreSQL 14+의 WITH RECURSIVE / CYCLE 사용.
-- 기존 운영 데이터와 pr_design 테이블을 전혀 수정하지 않는다.
-- 모든 자료는 예시다. 2026-11-01은 설명용 격상일이며 실제 승인일이 아니다.
-- 기존 규정 3개 테이블의 열 이름을 따라가되,
--   1) 임시 테이블 접두어 demo_를 사용하고
--   2) 관계에 effective_from/effective_to를 추가하고
--   3) 종류는 SCHOOL을 허용하는 text로 표현했다.
-- 현재 pr_design의 doc_kind ENUM에 SCHOOL이 이미 있다고 가정하지 않는다.
-- 임시 자료와 함수는 마지막 ROLLBACK으로 모두 제거된다.

BEGIN;

CREATE TEMP TABLE demo_regulations (
  regulation_id text PRIMARY KEY,
  family_id text NOT NULL,
  code text NOT NULL,
  kind text NOT NULL,
  UNIQUE (regulation_id, family_id),
  UNIQUE (family_id, code)
) ON COMMIT DROP;

CREATE TEMP TABLE demo_regulation_versions (
  regulation_version_id text PRIMARY KEY,
  family_id text NOT NULL,
  regulation_id text NOT NULL,
  version_no integer NOT NULL CHECK (version_no > 0),
  status text NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED')),
  source_text text NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  UNIQUE (regulation_version_id, family_id),
  UNIQUE (family_id, regulation_id, version_no),
  FOREIGN KEY (regulation_id, family_id)
    REFERENCES demo_regulations (regulation_id, family_id),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
) ON COMMIT DROP;

CREATE TEMP TABLE demo_regulation_version_relationships (
  relationship_id text PRIMARY KEY,
  family_id text NOT NULL,
  from_regulation_version_id text NOT NULL,
  to_regulation_version_id text NOT NULL,
  relationship text NOT NULL,
  approved boolean NOT NULL,
  review_note text NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  UNIQUE (family_id, from_regulation_version_id,
          to_regulation_version_id, relationship),
  FOREIGN KEY (from_regulation_version_id, family_id)
    REFERENCES demo_regulation_versions (regulation_version_id, family_id),
  FOREIGN KEY (to_regulation_version_id, family_id)
    REFERENCES demo_regulation_versions (regulation_version_id, family_id),
  CHECK (from_regulation_version_id <> to_regulation_version_id),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
) ON COMMIT DROP;

INSERT INTO demo_regulations VALUES
  ('reg-basic',  'demo-family', 'PR-BASIC',            'BASIC'),
  ('reg-task',   'demo-family', 'PR-TASK',             'TASK'),
  ('reg-quest',  'demo-family', 'PR-QUEST',            'QUEST'),
  ('reg-life',   'demo-family', 'PR-LIFESTYLE',        'LIFESTYLE'),
  ('reg-school', 'demo-family', 'PR-SCHOOL',           'SCHOOL'),
  ('reg-attend', 'demo-family', 'PR-SCHOOL-ATTENDANCE','SCHOOL');

-- School의 영구 regulation_id는 같고, v1/v2의 관할만 다르다.
-- 학교 출결 규정은 같은 버전이며 부모 School 버전과의 관계만 새로 연결한다.
INSERT INTO demo_regulation_versions VALUES
  ('basic-v1',  'demo-family', 'reg-basic',  1, 'PUBLISHED',
   '습관 형성 기본법', '2026-10-01 00:00+09', NULL),
  ('task-v1',   'demo-family', 'reg-task',   1, 'PUBLISHED',
   'Task 수행 규정', '2026-10-01 00:00+09', NULL),
  ('quest-v1',  'demo-family', 'reg-quest',  1, 'PUBLISHED',
   'Quest 달성 규정', '2026-10-01 00:00+09', NULL),
  ('life-v1',   'demo-family', 'reg-life',   1, 'PUBLISHED',
   'Lifestyle 인정 규정', '2026-10-01 00:00+09', NULL),
  ('school-v1', 'demo-family', 'reg-school', 1, 'PUBLISHED',
   'Task의 하위 학교 규정', '2026-10-01 00:00+09', '2026-11-01 00:00+09'),
  ('school-v2', 'demo-family', 'reg-school', 2, 'PUBLISHED',
   '기본법 직속 독립 학교 규정', '2026-11-01 00:00+09', NULL),
  ('attend-v1', 'demo-family', 'reg-attend', 1, 'PUBLISHED',
   '학교 출결 규정', '2026-10-01 00:00+09', NULL);

INSERT INTO demo_regulation_version_relationships VALUES
  ('edge-basic-task', 'demo-family', 'basic-v1', 'task-v1', 'GOVERNS', true,
   '기본법 아래 Task', '2026-10-01 00:00+09', NULL),
  ('edge-basic-quest','demo-family', 'basic-v1', 'quest-v1','GOVERNS', true,
   '기본법 아래 Quest', '2026-10-01 00:00+09', NULL),
  ('edge-basic-life', 'demo-family', 'basic-v1', 'life-v1', 'GOVERNS', true,
   '기본법 아래 Lifestyle', '2026-10-01 00:00+09', NULL),
  ('edge-old-school', 'demo-family', 'task-v1', 'school-v1','GOVERNS', true,
   '격상 전: Task 아래 School', '2026-10-01 00:00+09', '2026-11-01 00:00+09'),
  ('edge-new-school', 'demo-family', 'basic-v1','school-v2','GOVERNS', true,
   '격상 후: 기본법 아래 School', '2026-11-01 00:00+09', NULL),
  ('edge-old-attend', 'demo-family', 'school-v1','attend-v1','GOVERNS', true,
   'School v1 아래 출결', '2026-10-01 00:00+09', '2026-11-01 00:00+09'),
  ('edge-new-attend', 'demo-family', 'school-v2','attend-v1','GOVERNS', true,
   'School v2 아래 출결: 출결 원문 버전은 유지', '2026-11-01 00:00+09', NULL),
  ('edge-school-revision', 'demo-family', 'school-v1','school-v2','REVISES', true,
   'School의 관할 개정 이력: 위계 탐색에는 넣지 않는다', '2026-11-01 00:00+09', NULL);

-- 재귀 조회 본체.
-- 부모 -> 자식은 GOVERNS만 따른다. REVISES/호환/참조 관계는 제외한다.
-- 버전과 관계 양쪽의 [effective_from, effective_to) 및 승인 상태를 확인한다.
-- CYCLE은 규정의 영구 ID를 기준으로 한다. 순환 행을 숨기지 않고 표시한다.
CREATE FUNCTION pg_temp.regulation_tree(
  p_family_id text,
  p_root_code text,
  p_as_of timestamptz
)
RETURNS TABLE (
  depth integer,
  code text,
  version_no integer,
  parent_code text,
  path text,
  regulation_id text,
  regulation_version_id text,
  is_cycle boolean
)
LANGUAGE sql STABLE
AS $$
WITH RECURSIVE
active_nodes AS (
  SELECT r.regulation_id, r.code,
         v.regulation_version_id, v.version_no
  FROM pg_temp.demo_regulations r
  JOIN pg_temp.demo_regulation_versions v
    ON v.regulation_id = r.regulation_id
   AND v.family_id = r.family_id
  WHERE r.family_id = p_family_id
    AND v.status = 'PUBLISHED'
    AND v.effective_from <= p_as_of
    AND (v.effective_to IS NULL OR p_as_of < v.effective_to)
),
active_edges AS (
  SELECT e.from_regulation_version_id, e.to_regulation_version_id
  FROM pg_temp.demo_regulation_version_relationships e
  JOIN active_nodes parent
    ON parent.regulation_version_id = e.from_regulation_version_id
  JOIN active_nodes child
    ON child.regulation_version_id = e.to_regulation_version_id
  WHERE e.family_id = p_family_id
    AND e.relationship = 'GOVERNS'
    AND e.approved
    AND e.effective_from <= p_as_of
    AND (e.effective_to IS NULL OR p_as_of < e.effective_to)
),
walk (node_id, node_version_id, node_code, node_version_no,
      node_parent_code, node_depth, path_codes) AS (
  -- 시작점: 선택 가족의 기본법. 기본법을 0단계로 센다.
  SELECT n.regulation_id, n.regulation_version_id, n.code, n.version_no,
         NULL::text, 0, ARRAY[n.code]::text[]
  FROM active_nodes n
  WHERE n.code = p_root_code

  UNION ALL

  SELECT child.regulation_id, child.regulation_version_id,
         child.code, child.version_no, w.node_code,
         w.node_depth + 1, w.path_codes || child.code
  FROM walk w
  JOIN active_edges e
    ON e.from_regulation_version_id = w.node_version_id
  JOIN active_nodes child
    ON child.regulation_version_id = e.to_regulation_version_id
)
CYCLE node_id SET cycle_found USING cycle_path
SELECT node_depth, node_code, node_version_no, node_parent_code,
       array_to_string(path_codes, ' > '),
       node_id, node_version_id, cycle_found
FROM walk
ORDER BY path_codes
$$;

-- 쿼리 1. 격상 이전 전체 위계: School depth=2, parent=PR-TASK.
SELECT * FROM pg_temp.regulation_tree(
  'demo-family', 'PR-BASIC', '2026-10-31 12:00+09'
);

-- 쿼리 2. 격상 이후 전체 위계: School depth=1, parent=PR-BASIC.
SELECT * FROM pg_temp.regulation_tree(
  'demo-family', 'PR-BASIC', '2026-11-01 12:00+09'
);

-- 쿼리 3. 기본법 바로 아래 동등 위계 규정만 조회.
-- 결과: PR-LIFESTYLE / PR-QUEST / PR-SCHOOL / PR-TASK, 모두 depth=1.
SELECT code, version_no, parent_code, depth
FROM pg_temp.regulation_tree(
  'demo-family', 'PR-BASIC', '2026-11-01 12:00+09'
)
WHERE depth = 1 AND NOT is_cycle
ORDER BY code;

-- 쿼리 4. School 하위 경로만 조회.
-- root를 School로 바꾸면 School은 상대 depth=0, 출결은 depth=1.
SELECT code, version_no, depth, path
FROM pg_temp.regulation_tree(
  'demo-family', 'PR-SCHOOL', '2026-11-01 12:00+09'
)
WHERE NOT is_cycle;

-- 쿼리 5. School의 관할 변경을 같은 영구 ID의 이력으로 비교.
WITH dates(label, at_time) AS (
  VALUES ('격상 전', '2026-10-31 12:00+09'::timestamptz),
         ('격상 후', '2026-11-01 12:00+09'::timestamptz)
)
SELECT d.label, t.regulation_id, t.regulation_version_id,
       t.parent_code, t.depth, t.path
FROM dates d
CROSS JOIN LATERAL pg_temp.regulation_tree(
  'demo-family', 'PR-BASIC', d.at_time
) t
WHERE t.code = 'PR-SCHOOL'
ORDER BY d.at_time;

-- 쿼리 6. 순환 관할 진단. 정상 샘플은 0행이다.
SELECT code, path
FROM pg_temp.regulation_tree(
  'demo-family', 'PR-BASIC', '2026-11-01 12:00+09'
)
WHERE is_cycle;

-- 순환 검출 쿼리는 INSERT 차단 제약이나 부모 승인 검증의 대체물이 아니다.
-- 운영에서는 격상 변경 묶음의 승인·권한·관계 효력·순환·중복 관할을 별도 검사한다.
-- 이 SQL은 위계만 조회한다. 스티커·학교 주간 기간·보상권·원장은 변경하지 않는다.
ROLLBACK;
