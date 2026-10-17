-- Play Routine isolated design prototype. Not a live migration; never apply to production.
-- PostgreSQL 16 / PGlite compatible. All identifiers are prototype-local.

CREATE SCHEMA IF NOT EXISTS pr_design;
SET search_path = pr_design, pg_catalog;

CREATE TYPE membership_role AS ENUM ('OWNER_PARENT','PARENT','CHILD','GUARDIAN');
CREATE TYPE doc_kind AS ENUM ('BASIC','TASK','QUEST','LIFESTYLE','OPS_LIFECYCLE');
CREATE TYPE version_status AS ENUM ('DRAFT','APPROVED','PUBLISHED','RETIRED');
CREATE TYPE relationship_kind AS ENUM ('GOVERNS','DEPENDS_ON','REVISES','REPLACES','RETIRES','SUCCEEDS');
CREATE TYPE period_kind AS ENUM ('DAILY','WEEKLY','MONTHLY','EVENT');
CREATE TYPE event_kind AS ENUM ('SELF_REPORT','PARENT_RECOGNITION','PENALTY_REPORT','SCHOOL_FEEDBACK','SCHOOL_PRAISE','CORRECTION');
CREATE TYPE confirmation_decision AS ENUM ('RECOGNIZED','NOT_RECOGNIZED','PENALTY_APPROVED','PENALTY_REJECTED');
CREATE TYPE recognition_outcome AS ENUM ('REWARDED','LIMIT_EXCEEDED','NOT_RECOGNIZED','PENDING');
CREATE TYPE asset_unit AS ENUM ('MINUTES','COUPAY_KRW','CASH_KRW','POINTS','CONTENT');
CREATE TYPE effect_kind AS ENUM ('REWARD','PENALTY','STICKER');
CREATE TYPE plan_status AS ENUM ('DRAFT','APPROVED','PUBLISHED','CLOSED');
CREATE TYPE occurrence_state AS ENUM ('SCHEDULED','CANCELLED','COMPLETED','UNCONFIRMED');
CREATE TYPE feedback_state AS ENUM ('UNCONFIRMED','NO_PROBLEM','PROBLEM');
CREATE TYPE right_status AS ENUM ('ISSUED','REVIEW_REQUIRED','VOIDED');
CREATE TYPE reward_mode AS ENUM ('EXCLUSIVE_TARGET_TOTAL','CUMULATIVE_INCREMENT');

-- 1. Tenant identity. A client never receives table grants in an implementation.
CREATE TABLE families (
  family_id text PRIMARY KEY,
  display_name text NOT NULL,
  timezone text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE family_memberships (
  membership_id text PRIMARY KEY,
  family_id text NOT NULL REFERENCES families(family_id),
  auth_user_id uuid NOT NULL,
  role membership_role NOT NULL,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (family_id, membership_id),
  UNIQUE (family_id, auth_user_id, role)
);
CREATE TABLE children (
  child_id text PRIMARY KEY,
  family_id text NOT NULL REFERENCES families(family_id),
  child_auth_user_id uuid UNIQUE,
  display_name text NOT NULL,
  UNIQUE (child_id, family_id)
);

-- 2. Immutable governing documents and their compatibility / lineage.
CREATE TABLE regulations (
  regulation_id text PRIMARY KEY,
  family_id text NOT NULL REFERENCES families(family_id),
  code text NOT NULL,
  kind doc_kind NOT NULL,
  UNIQUE (family_id, code), UNIQUE (regulation_id, family_id)
);
CREATE TABLE regulation_versions (
  regulation_version_id text PRIMARY KEY,
  family_id text NOT NULL,
  regulation_id text NOT NULL,
  version_no integer NOT NULL CHECK (version_no > 0),
  status version_status NOT NULL,
  source_text text NOT NULL,
  effective_from timestamptz,
  effective_to timestamptz,
  approved_by_membership_id text,
  approved_at timestamptz,
  pending_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (regulation_version_id, family_id),
  UNIQUE (family_id, regulation_id, version_no),
  FOREIGN KEY (regulation_id, family_id) REFERENCES regulations(regulation_id, family_id),
  FOREIGN KEY (approved_by_membership_id, family_id) REFERENCES family_memberships(membership_id, family_id)
);
CREATE TABLE regulation_version_relationships (
  relationship_id text PRIMARY KEY,
  family_id text NOT NULL,
  from_regulation_version_id text NOT NULL,
  to_regulation_version_id text NOT NULL,
  relationship relationship_kind NOT NULL,
  review_note text,
  approved boolean NOT NULL DEFAULT false,
  UNIQUE (family_id, from_regulation_version_id, to_regulation_version_id, relationship),
  FOREIGN KEY (from_regulation_version_id, family_id) REFERENCES regulation_versions(regulation_version_id, family_id),
  FOREIGN KEY (to_regulation_version_id, family_id) REFERENCES regulation_versions(regulation_version_id, family_id)
);
CREATE TABLE version_compatibilities (
  compatibility_id text PRIMARY KEY,
  family_id text NOT NULL,
  governing_regulation_version_id text NOT NULL,
  governed_regulation_version_id text NOT NULL,
  compatible boolean NOT NULL,
  reviewed_by_membership_id text,
  review_note text NOT NULL,
  UNIQUE (family_id, governing_regulation_version_id, governed_regulation_version_id),
  FOREIGN KEY (governing_regulation_version_id, family_id) REFERENCES regulation_versions(regulation_version_id, family_id),
  FOREIGN KEY (governed_regulation_version_id, family_id) REFERENCES regulation_versions(regulation_version_id, family_id),
  FOREIGN KEY (reviewed_by_membership_id, family_id) REFERENCES family_memberships(membership_id, family_id)
);

-- 3. Individual enforcement-rule identity/version and versioned asset definitions.
CREATE TABLE rule_identities (
  rule_id text PRIMARY KEY,
  family_id text NOT NULL REFERENCES families(family_id),
  permanent_number text NOT NULL,
  kind doc_kind NOT NULL CHECK (kind IN ('TASK','QUEST','LIFESTYLE')),
  stable_scope_code text NOT NULL, -- never changes merely because plan/version changes
  UNIQUE (family_id, permanent_number), UNIQUE (rule_id, family_id),
  UNIQUE (family_id, stable_scope_code)
);
CREATE TABLE rule_versions (
  rule_version_id text PRIMARY KEY,
  family_id text NOT NULL,
  rule_id text NOT NULL,
  version_no integer NOT NULL CHECK (version_no > 0),
  status version_status NOT NULL,
  source_text text NOT NULL,
  condition_spec jsonb NOT NULL,
  pending_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  period period_kind NOT NULL,
  reward_mode reward_mode,
  recognition_limit integer, -- NULL means unspecified, never zero-by-default
  positive_minutes numeric(12,2),
  negative_minutes numeric(12,2),
  effective_from timestamptz,
  effective_to timestamptz,
  UNIQUE (rule_version_id, family_id), UNIQUE (family_id, rule_id, version_no),
  FOREIGN KEY (rule_id, family_id) REFERENCES rule_identities(rule_id, family_id),
  CHECK (recognition_limit IS NULL OR recognition_limit > 0)
);
-- 개별 시행규칙 버전은 반드시 같은 가족의 해당 하위 규정 버전에 연결된다.
CREATE TABLE rule_governing_versions (
  rule_governing_version_id text PRIMARY KEY,
  family_id text NOT NULL,
  rule_version_id text NOT NULL,
  regulation_version_id text NOT NULL,
  UNIQUE (family_id, rule_version_id, regulation_version_id),
  FOREIGN KEY (rule_version_id, family_id) REFERENCES rule_versions(rule_version_id, family_id),
  FOREIGN KEY (regulation_version_id, family_id) REFERENCES regulation_versions(regulation_version_id, family_id)
);
CREATE TABLE rule_version_lineage (
  lineage_id text PRIMARY KEY,
  family_id text NOT NULL,
  from_rule_version_id text NOT NULL,
  to_rule_version_id text NOT NULL,
  relationship relationship_kind NOT NULL CHECK (relationship IN ('REVISES','REPLACES','RETIRES','SUCCEEDS')),
  rationale text NOT NULL,
  UNIQUE (family_id, from_rule_version_id, to_rule_version_id, relationship),
  FOREIGN KEY (from_rule_version_id, family_id) REFERENCES rule_versions(rule_version_id, family_id),
  FOREIGN KEY (to_rule_version_id, family_id) REFERENCES rule_versions(rule_version_id, family_id)
);
CREATE TABLE asset_identities (
  asset_id text PRIMARY KEY,
  family_id text NOT NULL REFERENCES families(family_id),
  asset_code text NOT NULL,
  UNIQUE (family_id, asset_code), UNIQUE (asset_id, family_id)
);
CREATE TABLE asset_versions (
  asset_version_id text PRIMARY KEY,
  family_id text NOT NULL,
  asset_id text NOT NULL,
  version_no integer NOT NULL CHECK (version_no > 0),
  status version_status NOT NULL,
  display_name text NOT NULL,
  unit asset_unit NOT NULL,
  delivery_method text NOT NULL,
  input_contract jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (asset_version_id, family_id), UNIQUE (family_id, asset_id, version_no),
  FOREIGN KEY (asset_id, family_id) REFERENCES asset_identities(asset_id, family_id)
);
CREATE TABLE rule_effects (
  rule_effect_id text PRIMARY KEY,
  family_id text NOT NULL,
  rule_version_id text NOT NULL,
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 1 AND 2), -- policy permits one or two
  effect effect_kind NOT NULL,
  asset_version_id text,
  quantity numeric(12,2), -- NULL intentionally represents unspecified value
  unit asset_unit,
  condition_code text NOT NULL DEFAULT 'PRIMARY',
  UNIQUE (rule_effect_id, family_id),
  UNIQUE (family_id, rule_version_id, condition_code, ordinal), -- 1–2 effects for each condition
  FOREIGN KEY (rule_version_id, family_id) REFERENCES rule_versions(rule_version_id, family_id),
  FOREIGN KEY (asset_version_id, family_id) REFERENCES asset_versions(asset_version_id, family_id),
  CHECK ((effect = 'STICKER' AND asset_version_id IS NULL) OR (effect <> 'STICKER' AND asset_version_id IS NOT NULL)),
  CHECK (quantity IS NULL OR quantity >= 0)
);
-- 조건 원문/JSON은 유지하되, 효과가 참조하는 조건 코드는 별도 정본 행으로 고정한다.
CREATE TABLE rule_conditions (
  rule_condition_id text PRIMARY KEY,
  family_id text NOT NULL,
  rule_version_id text NOT NULL,
  condition_code text NOT NULL,
  source_predicate jsonb NOT NULL,
  UNIQUE (family_id, rule_version_id, condition_code),
  FOREIGN KEY (rule_version_id, family_id) REFERENCES rule_versions(rule_version_id, family_id)
);
ALTER TABLE rule_effects ADD CONSTRAINT rule_effect_condition_fk
  FOREIGN KEY (family_id, rule_version_id, condition_code)
  REFERENCES rule_conditions(family_id, rule_version_id, condition_code);

-- 4. Approved reference plan (not a copied rule) and scheduling.
CREATE TABLE monthly_plans (
  plan_id text PRIMARY KEY,
  family_id text NOT NULL REFERENCES families(family_id),
  operating_month date NOT NULL CHECK (date_trunc('month', operating_month)::date = operating_month),
  plan_version_no integer NOT NULL CHECK (plan_version_no > 0),
  timezone text NOT NULL,
  status plan_status NOT NULL,
  approved_by_membership_id text,
  approved_at timestamptz,
  UNIQUE (family_id, operating_month, plan_version_no), UNIQUE (plan_id, family_id),
  FOREIGN KEY (approved_by_membership_id, family_id) REFERENCES family_memberships(membership_id, family_id)
);
CREATE TABLE plan_governing_versions (
  plan_id text NOT NULL,
  family_id text NOT NULL,
  regulation_version_id text NOT NULL,
  PRIMARY KEY (plan_id, regulation_version_id),
  FOREIGN KEY (plan_id, family_id) REFERENCES monthly_plans(plan_id, family_id),
  FOREIGN KEY (regulation_version_id, family_id) REFERENCES regulation_versions(regulation_version_id, family_id)
);
CREATE TABLE plan_rule_adoptions (
  adoption_id text PRIMARY KEY,
  family_id text NOT NULL,
  plan_id text NOT NULL,
  child_id text NOT NULL,
  rule_version_id text NOT NULL,
  applies_from date NOT NULL,
  applies_to date NOT NULL,
  adoption_status plan_status NOT NULL,
  UNIQUE (family_id, plan_id, child_id, rule_version_id), UNIQUE (adoption_id, family_id),
  FOREIGN KEY (plan_id, family_id) REFERENCES monthly_plans(plan_id, family_id),
  FOREIGN KEY (child_id, family_id) REFERENCES children(child_id, family_id),
  FOREIGN KEY (rule_version_id, family_id) REFERENCES rule_versions(rule_version_id, family_id),
  CHECK (applies_to >= applies_from)
);
CREATE TABLE recurrence_templates (
  recurrence_template_id text PRIMARY KEY,
  family_id text NOT NULL,
  adoption_id text NOT NULL,
  anchor_date date, -- NULL is an incomplete candidate; it cannot create a payable occurrence
  interval_days integer,
  weekday_iso smallint CHECK (weekday_iso BETWEEN 1 AND 7),
  exceptions jsonb NOT NULL DEFAULT '[]'::jsonb,
  status version_status NOT NULL,
  FOREIGN KEY (adoption_id, family_id) REFERENCES plan_rule_adoptions(adoption_id, family_id),
  CHECK ((anchor_date IS NULL AND interval_days IS NULL) OR (anchor_date IS NOT NULL AND interval_days > 0))
);
CREATE TABLE scheduled_occurrences (
  occurrence_id text PRIMARY KEY,
  family_id text NOT NULL,
  child_id text NOT NULL,
  adoption_id text NOT NULL,
  rule_version_id text NOT NULL,
  stable_scope_code text NOT NULL,
  scheduled_for timestamptz NOT NULL,
  state occurrence_state NOT NULL DEFAULT 'SCHEDULED',
  UNIQUE (family_id, child_id, stable_scope_code, scheduled_for),
  UNIQUE (occurrence_id, family_id),
  FOREIGN KEY (child_id, family_id) REFERENCES children(child_id, family_id),
  FOREIGN KEY (adoption_id, family_id) REFERENCES plan_rule_adoptions(adoption_id, family_id),
  FOREIGN KEY (rule_version_id, family_id) REFERENCES rule_versions(rule_version_id, family_id)
);

-- 5. Facts are append-only. Confirmation/measurement is separate from a raw fact.
CREATE TABLE source_events (
  source_event_id text PRIMARY KEY,
  family_id text NOT NULL,
  child_id text NOT NULL,
  occurrence_id text,
  rule_version_id text,
  event_type event_kind NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  client_event_key text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (family_id, child_id, client_event_key), UNIQUE (source_event_id, family_id),
  FOREIGN KEY (child_id, family_id) REFERENCES children(child_id, family_id),
  FOREIGN KEY (occurrence_id, family_id) REFERENCES scheduled_occurrences(occurrence_id, family_id),
  FOREIGN KEY (rule_version_id, family_id) REFERENCES rule_versions(rule_version_id, family_id)
);
CREATE TABLE measurements (
  measurement_id text PRIMARY KEY,
  family_id text NOT NULL,
  source_event_id text NOT NULL,
  metric_code text NOT NULL,
  value_numeric numeric(14,3),
  unit text NOT NULL,
  known boolean NOT NULL DEFAULT true,
  UNIQUE (family_id, source_event_id, metric_code),
  FOREIGN KEY (source_event_id, family_id) REFERENCES source_events(source_event_id, family_id),
  CHECK ((known AND value_numeric IS NOT NULL) OR (NOT known AND value_numeric IS NULL))
);
CREATE TABLE parent_confirmations (
  confirmation_id text PRIMARY KEY,
  family_id text NOT NULL,
  source_event_id text NOT NULL,
  parent_membership_id text NOT NULL,
  decision confirmation_decision NOT NULL,
  reason text,
  idempotency_key text NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (family_id, parent_membership_id, idempotency_key),
  UNIQUE (confirmation_id, family_id),
  FOREIGN KEY (source_event_id, family_id) REFERENCES source_events(source_event_id, family_id),
  FOREIGN KEY (parent_membership_id, family_id) REFERENCES family_memberships(membership_id, family_id),
  CHECK ((decision NOT IN ('PENALTY_APPROVED','PENALTY_REJECTED')) OR reason IS NOT NULL)
);

-- 6. School's 0/1 basic sticker is distinct from an independently confirmed praise sticker.
CREATE TABLE sticker_types (
  sticker_type_id text PRIMARY KEY,
  family_id text NOT NULL REFERENCES families(family_id),
  code text NOT NULL,
  display_name text NOT NULL,
  UNIQUE (family_id, code), UNIQUE (sticker_type_id, family_id)
);
CREATE TABLE school_day_assessments (
  assessment_id text PRIMARY KEY,
  family_id text NOT NULL,
  child_id text NOT NULL,
  occurrence_id text NOT NULL,
  stable_scope_code text NOT NULL,
  business_date date NOT NULL,
  feedback feedback_state NOT NULL DEFAULT 'UNCONFIRMED',
  basic_sticker_count smallint,
  parent_confirmation_id text,
  UNIQUE (family_id, child_id, stable_scope_code, business_date),
  FOREIGN KEY (child_id, family_id) REFERENCES children(child_id, family_id),
  FOREIGN KEY (occurrence_id, family_id) REFERENCES scheduled_occurrences(occurrence_id, family_id),
  FOREIGN KEY (parent_confirmation_id, family_id) REFERENCES parent_confirmations(confirmation_id, family_id),
  CHECK ((feedback = 'UNCONFIRMED' AND basic_sticker_count IS NULL) OR
         (feedback = 'NO_PROBLEM' AND basic_sticker_count = 1) OR
         (feedback = 'PROBLEM' AND basic_sticker_count = 0))
);
CREATE TABLE sticker_awards (
  sticker_award_id text PRIMARY KEY,
  family_id text NOT NULL,
  child_id text NOT NULL,
  sticker_type_id text NOT NULL,
  source_event_id text NOT NULL,
  parent_confirmation_id text NOT NULL,
  award_kind text NOT NULL CHECK (award_kind IN ('SCHOOL_BASIC','SCHOOL_PRAISE','OTHER')),
  quantity smallint NOT NULL CHECK (quantity = 1),
  UNIQUE (family_id, source_event_id, sticker_type_id, award_kind),
  FOREIGN KEY (child_id, family_id) REFERENCES children(child_id, family_id),
  FOREIGN KEY (sticker_type_id, family_id) REFERENCES sticker_types(sticker_type_id, family_id),
  FOREIGN KEY (source_event_id, family_id) REFERENCES source_events(source_event_id, family_id),
  FOREIGN KEY (parent_confirmation_id, family_id) REFERENCES parent_confirmations(confirmation_id, family_id)
);

-- 7. Stable scope period/bucket. Neither plan nor rule-version is in the uniqueness key.
CREATE TABLE stable_rule_scopes (
  stable_scope_id text PRIMARY KEY,
  family_id text NOT NULL REFERENCES families(family_id),
  stable_scope_code text NOT NULL,
  period period_kind NOT NULL,
  description text NOT NULL,
  UNIQUE (family_id, stable_scope_code), UNIQUE (stable_scope_id, family_id)
);
CREATE TABLE aggregation_periods (
  aggregation_period_id text PRIMARY KEY,
  family_id text NOT NULL,
  child_id text NOT NULL,
  stable_scope_id text NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  timezone text NOT NULL,
  governing_plan_id text,
  final_closed boolean NOT NULL DEFAULT false,
  review_required boolean NOT NULL DEFAULT false,
  UNIQUE (family_id, child_id, stable_scope_id, starts_on, ends_on, timezone),
  UNIQUE (aggregation_period_id, family_id),
  FOREIGN KEY (child_id, family_id) REFERENCES children(child_id, family_id),
  FOREIGN KEY (stable_scope_id, family_id) REFERENCES stable_rule_scopes(stable_scope_id, family_id),
  FOREIGN KEY (governing_plan_id, family_id) REFERENCES monthly_plans(plan_id, family_id),
  -- starts_on은 포함, ends_on은 제외하는 반개구간 [starts_on, ends_on)이다.
  CHECK (ends_on > starts_on)
);
CREATE TABLE recognition_limit_buckets (
  bucket_id text PRIMARY KEY,
  family_id text NOT NULL,
  child_id text NOT NULL,
  stable_scope_id text NOT NULL,
  business_date date NOT NULL,
  timezone text NOT NULL,
  limit_count integer NOT NULL CHECK (limit_count > 0),
  used_count integer NOT NULL DEFAULT 0 CHECK (used_count >= 0 AND used_count <= limit_count),
  UNIQUE (family_id, child_id, stable_scope_id, business_date),
  UNIQUE (bucket_id, family_id),
  FOREIGN KEY (child_id, family_id) REFERENCES children(child_id, family_id),
  FOREIGN KEY (stable_scope_id, family_id) REFERENCES stable_rule_scopes(stable_scope_id, family_id)
);
CREATE TABLE recognition_limit_uses (
  use_id text PRIMARY KEY,
  family_id text NOT NULL,
  bucket_id text NOT NULL,
  source_event_id text NOT NULL,
  used_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (family_id, source_event_id),
  FOREIGN KEY (bucket_id, family_id) REFERENCES recognition_limit_buckets(bucket_id, family_id),
  FOREIGN KEY (source_event_id, family_id) REFERENCES source_events(source_event_id, family_id)
);
CREATE TABLE lifestyle_recognition_results (
  result_id text PRIMARY KEY,
  family_id text NOT NULL,
  source_event_id text NOT NULL,
  rule_version_id text NOT NULL,
  bucket_id text NOT NULL,
  outcome recognition_outcome NOT NULL,
  count_consumed boolean NOT NULL,
  applied_minutes numeric(12,2) NOT NULL DEFAULT 0,
  UNIQUE (family_id, source_event_id),
  FOREIGN KEY (source_event_id, family_id) REFERENCES source_events(source_event_id, family_id),
  FOREIGN KEY (rule_version_id, family_id) REFERENCES rule_versions(rule_version_id, family_id),
  FOREIGN KEY (bucket_id, family_id) REFERENCES recognition_limit_buckets(bucket_id, family_id)
);
CREATE TABLE effect_applications (
  effect_application_id text PRIMARY KEY,
  family_id text NOT NULL,
  source_event_id text NOT NULL,
  rule_effect_id text NOT NULL,
  applied_quantity numeric(12,2),
  unit asset_unit,
  UNIQUE (family_id, source_event_id, rule_effect_id),
  FOREIGN KEY (source_event_id, family_id) REFERENCES source_events(source_event_id, family_id),
  FOREIGN KEY (rule_effect_id, family_id) REFERENCES rule_effects(rule_effect_id, family_id)
);

-- 8. Reward entitlement, correction and external fulfillment are separate from the immutable model ledger.
CREATE TABLE reward_rights (
  reward_right_id text PRIMARY KEY,
  family_id text NOT NULL,
  child_id text NOT NULL,
  aggregation_period_id text,
  rule_version_id text,
  asset_version_id text NOT NULL,
  source_key text NOT NULL,
  quantity numeric(12,2) NOT NULL CHECK (quantity > 0),
  unit asset_unit NOT NULL,
  display_name_snapshot text NOT NULL,
  delivery_method_snapshot text NOT NULL,
  status right_status NOT NULL DEFAULT 'ISSUED',
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (family_id, source_key), UNIQUE (reward_right_id, family_id),
  FOREIGN KEY (child_id, family_id) REFERENCES children(child_id, family_id),
  FOREIGN KEY (aggregation_period_id, family_id) REFERENCES aggregation_periods(aggregation_period_id, family_id),
  FOREIGN KEY (rule_version_id, family_id) REFERENCES rule_versions(rule_version_id, family_id),
  FOREIGN KEY (asset_version_id, family_id) REFERENCES asset_versions(asset_version_id, family_id)
);
CREATE TABLE reward_correction_events (
  correction_id text PRIMARY KEY,
  family_id text NOT NULL,
  reward_right_id text NOT NULL,
  signed_quantity numeric(12,2) NOT NULL CHECK (signed_quantity <> 0),
  reason text NOT NULL,
  approved_by_membership_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (reward_right_id, family_id) REFERENCES reward_rights(reward_right_id, family_id),
  FOREIGN KEY (approved_by_membership_id, family_id) REFERENCES family_memberships(membership_id, family_id)
);
-- 하나의 이행 요청은 배치 한 건이며, 권리별 이행 행으로만 분할 기록된다.
CREATE TABLE school_execution_batches (
  execution_batch_id text PRIMARY KEY,
  family_id text NOT NULL,
  aggregation_period_id text NOT NULL,
  idempotency_key text NOT NULL,
  external_reference text,
  quantity numeric(12,2) NOT NULL CHECK (quantity >= 0),
  executed_by_membership_id text NOT NULL,
  executed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (family_id, idempotency_key),
  UNIQUE (execution_batch_id, family_id),
  FOREIGN KEY (aggregation_period_id, family_id) REFERENCES aggregation_periods(aggregation_period_id, family_id),
  FOREIGN KEY (executed_by_membership_id, family_id) REFERENCES family_memberships(membership_id, family_id)
);
CREATE TABLE actual_reward_executions (
  execution_id text PRIMARY KEY,
  family_id text NOT NULL,
  execution_batch_id text NOT NULL,
  reward_right_id text NOT NULL,
  idempotency_key text NOT NULL,
  quantity numeric(12,2) NOT NULL CHECK (quantity > 0),
  executed_by_membership_id text NOT NULL,
  executed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  external_reference text,
  UNIQUE (family_id, reward_right_id, idempotency_key),
  FOREIGN KEY (execution_batch_id, family_id) REFERENCES school_execution_batches(execution_batch_id, family_id),
  FOREIGN KEY (reward_right_id, family_id) REFERENCES reward_rights(reward_right_id, family_id),
  FOREIGN KEY (executed_by_membership_id, family_id) REFERENCES family_memberships(membership_id, family_id)
);
-- raw-table 오용까지 포함해 한 보상권의 유효 권리량보다 큰 이행을 차단한다.
CREATE OR REPLACE FUNCTION prevent_reward_right_overspend() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_available numeric;
BEGIN
  SELECT r.quantity + COALESCE((SELECT sum(c.signed_quantity) FROM reward_correction_events c WHERE c.family_id=r.family_id AND c.reward_right_id=r.reward_right_id),0)
       - COALESCE((SELECT sum(x.quantity) FROM actual_reward_executions x WHERE x.family_id=r.family_id AND x.reward_right_id=r.reward_right_id),0)
    INTO v_available
    FROM reward_rights r WHERE r.family_id=NEW.family_id AND r.reward_right_id=NEW.reward_right_id FOR UPDATE;
  IF v_available IS NULL OR NEW.quantity > v_available THEN
    RAISE EXCEPTION 'execution exceeds remaining reward right quantity';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER actual_reward_executions_no_overspend BEFORE INSERT ON actual_reward_executions
FOR EACH ROW EXECUTE FUNCTION prevent_reward_right_overspend();

CREATE TABLE immutable_ledger_entries (
  ledger_entry_id text PRIMARY KEY,
  family_id text NOT NULL,
  source_kind text NOT NULL,
  source_id text NOT NULL,
  unit asset_unit NOT NULL,
  signed_quantity numeric(12,2) NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (family_id, source_kind, source_id)
);

-- Medication is sensitive, separate, and cannot generate penalty/reward by trigger or RPC.
CREATE TABLE medication_records (
  medication_record_id text PRIMARY KEY,
  family_id text NOT NULL,
  child_id text NOT NULL,
  recorded_by_membership_id text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  dose_period text NOT NULL CHECK (dose_period IN ('MORNING','EVENING')),
  payload jsonb NOT NULL,
  FOREIGN KEY (child_id, family_id) REFERENCES children(child_id, family_id),
  FOREIGN KEY (recorded_by_membership_id, family_id) REFERENCES family_memberships(membership_id, family_id)
);

-- Append-only protections. Projection tables (school_day_assessments / periods) are deliberately mutable only by RPC.
CREATE OR REPLACE FUNCTION forbid_update_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'pr_design.% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER immutable_regulation_versions BEFORE UPDATE OR DELETE ON regulation_versions FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER immutable_rule_versions BEFORE UPDATE OR DELETE ON rule_versions FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER immutable_asset_versions BEFORE UPDATE OR DELETE ON asset_versions FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER immutable_source_events BEFORE UPDATE OR DELETE ON source_events FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER immutable_parent_confirmations BEFORE UPDATE OR DELETE ON parent_confirmations FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER immutable_reward_rights BEFORE UPDATE OR DELETE ON reward_rights FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER immutable_corrections BEFORE UPDATE OR DELETE ON reward_correction_events FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER immutable_executions BEFORE UPDATE OR DELETE ON actual_reward_executions FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER immutable_execution_batches BEFORE UPDATE OR DELETE ON school_execution_batches FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER immutable_ledger BEFORE UPDATE OR DELETE ON immutable_ledger_entries FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

-- 브리지 FK만으로는 문서 kind 일치까지 표현할 수 없어, 같은 가족의 정확한 하위 규정만 허용한다.
CREATE OR REPLACE FUNCTION enforce_rule_governing_kind() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_rule_kind doc_kind; v_reg_kind doc_kind;
BEGIN
  SELECT ri.kind, r.kind INTO v_rule_kind, v_reg_kind
    FROM rule_versions rv
    JOIN rule_identities ri ON (ri.rule_id,ri.family_id)=(rv.rule_id,rv.family_id)
    JOIN regulation_versions gv ON (gv.regulation_version_id,gv.family_id)=(NEW.regulation_version_id,NEW.family_id)
    JOIN regulations r ON (r.regulation_id,r.family_id)=(gv.regulation_id,gv.family_id)
   WHERE rv.family_id=NEW.family_id AND rv.rule_version_id=NEW.rule_version_id;
  IF v_rule_kind IS NULL OR v_reg_kind IS DISTINCT FROM v_rule_kind THEN
    RAISE EXCEPTION 'rule governing regulation kind must match rule kind';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rule_governing_versions_kind BEFORE INSERT OR UPDATE ON rule_governing_versions
FOR EACH ROW EXECUTE FUNCTION enforce_rule_governing_kind();

-- Auth boundary: server must validate JWT before placing claims; this parser does not validate a signature.
CREATE OR REPLACE FUNCTION current_auth_user_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pr_design, pg_temp AS $$
  SELECT (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;
CREATE OR REPLACE FUNCTION assert_parent(p_family_id text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pr_design, pg_temp AS $$
DECLARE v_member text;
BEGIN
  SELECT membership_id INTO v_member FROM family_memberships
   WHERE family_id=p_family_id AND auth_user_id=current_auth_user_id()
     AND active AND role IN ('OWNER_PARENT','PARENT') LIMIT 1;
  IF v_member IS NULL THEN RAISE EXCEPTION 'parent membership required for family %', p_family_id USING ERRCODE='42501'; END IF;
  RETURN v_member;
END $$;

-- 테스트 fixture에서만 DRAFT를 허용한다. 운영 호출은 게시(PUBLISHED) 버전만 허용한다.
CREATE OR REPLACE FUNCTION test_mode_enabled() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pr_design, pg_temp AS $$
  SELECT current_setting('pr_design.test_mode', true) = 'on'
$$;
CREATE OR REPLACE FUNCTION assert_rule_operable(p_family_id text,p_rule_version_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pr_design, pg_temp AS $$
DECLARE v_status version_status; v_kind doc_kind;
BEGIN
  SELECT rv.status,ri.kind INTO v_status,v_kind
    FROM rule_versions rv JOIN rule_identities ri ON (ri.rule_id,ri.family_id)=(rv.rule_id,rv.family_id)
   WHERE rv.family_id=p_family_id AND rv.rule_version_id=p_rule_version_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'rule version is outside family'; END IF;
  IF NOT (v_status='PUBLISHED' OR (test_mode_enabled() AND v_status='DRAFT')) THEN
    RAISE EXCEPTION 'published rule version required';
  END IF;
  PERFORM 1 FROM rule_governing_versions g
    JOIN regulation_versions gv ON (gv.regulation_version_id,gv.family_id)=(g.regulation_version_id,g.family_id)
    JOIN regulations rg ON (rg.regulation_id,rg.family_id)=(gv.regulation_id,gv.family_id)
   WHERE g.family_id=p_family_id AND g.rule_version_id=p_rule_version_id AND rg.kind=v_kind
     AND (gv.status='PUBLISHED' OR (test_mode_enabled() AND gv.status='DRAFT'));
  IF NOT FOUND THEN RAISE EXCEPTION 'published governing regulation version required'; END IF;
END $$;

-- Parent-recognized Lifestyle fact. 구현 범위는 부모가 직접 판정한 단일 조건뿐이다.
CREATE OR REPLACE FUNCTION recognize_lifestyle_event(
  p_family_id text, p_child_id text, p_rule_version_id text, p_occurred_at timestamptz,
  p_idempotency_key text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pr_design, pg_temp AS $$
DECLARE v_parent text; v_event text; v_payload jsonb; v_existing_rule text; v_existing_at timestamptz; v_existing_type event_kind;
        v_scope text; v_scope_id text; v_tz text; v_day date; v_limit integer; v_minutes numeric; v_bucket text;
        v_used boolean; v_result lifestyle_recognition_results%ROWTYPE; v_effect record;
        v_kind doc_kind; v_condition text; v_condition_count integer; v_reward_count integer; v_rewards_valid boolean;
BEGIN
  v_parent := assert_parent(p_family_id);
  SELECT e.source_event_id,e.payload,e.rule_version_id,e.occurred_at,e.event_type
    INTO v_event,v_payload,v_existing_rule,v_existing_at,v_existing_type
    FROM source_events e WHERE e.family_id=p_family_id AND e.child_id=p_child_id AND e.client_event_key=p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_payload IS DISTINCT FROM p_payload OR v_existing_rule IS DISTINCT FROM p_rule_version_id
       OR v_existing_at IS DISTINCT FROM p_occurred_at OR v_existing_type IS DISTINCT FROM 'PARENT_RECOGNITION'::event_kind THEN
      RAISE EXCEPTION 'idempotency request mismatch' USING ERRCODE='22000';
    END IF;
    SELECT * INTO v_result FROM lifestyle_recognition_results WHERE family_id=p_family_id AND source_event_id=v_event;
    IF v_result.result_id IS NULL THEN RAISE EXCEPTION 'idempotency key belongs to a non-lifestyle recognition event'; END IF;
    RETURN jsonb_build_object('event_id',v_event,'outcome',v_result.outcome,'count_consumed',v_result.count_consumed,'replayed',true);
  END IF;
  PERFORM assert_rule_operable(p_family_id,p_rule_version_id);
  SELECT r.stable_scope_code,rv.recognition_limit,rv.positive_minutes,f.timezone,r.kind
    INTO v_scope,v_limit,v_minutes,v_tz,v_kind
    FROM rule_versions rv JOIN rule_identities r ON (r.rule_id,r.family_id)=(rv.rule_id,rv.family_id)
    JOIN families f ON f.family_id=rv.family_id
   WHERE rv.family_id=p_family_id AND rv.rule_version_id=p_rule_version_id;
  IF v_kind IS DISTINCT FROM 'LIFESTYLE'::doc_kind OR v_limit IS NULL OR v_minutes IS NULL OR v_minutes <= 0 THEN
    RAISE EXCEPTION 'complete positive Lifestyle limit and minutes required';
  END IF;
  SELECT count(*),min(condition_code) INTO v_condition_count,v_condition
    FROM rule_conditions WHERE family_id=p_family_id AND rule_version_id=p_rule_version_id;
  SELECT count(*),bool_and(quantity IS NOT NULL AND quantity > 0) INTO v_reward_count,v_rewards_valid
    FROM rule_effects WHERE family_id=p_family_id AND rule_version_id=p_rule_version_id AND effect='REWARD';
  IF v_condition_count <> 1 OR v_reward_count=0 OR NOT COALESCE(v_rewards_valid,false)
     OR EXISTS (SELECT 1 FROM rule_effects WHERE family_id=p_family_id AND rule_version_id=p_rule_version_id AND effect='REWARD' AND condition_code<>v_condition) THEN
    RAISE EXCEPTION 'Lifestyle automatic application supports only one condition with positive, specified rewards';
  END IF;
  PERFORM 1 FROM children WHERE child_id=p_child_id AND family_id=p_family_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'child is outside family' USING ERRCODE='42501'; END IF;
  v_day := (p_occurred_at AT TIME ZONE v_tz)::date;
  INSERT INTO source_events(source_event_id,family_id,child_id,rule_version_id,event_type,occurred_at,payload,client_event_key)
  VALUES ('evt-'||md5(p_family_id||p_child_id||p_idempotency_key),p_family_id,p_child_id,p_rule_version_id,'PARENT_RECOGNITION',p_occurred_at,p_payload,p_idempotency_key)
  ON CONFLICT (family_id,child_id,client_event_key) DO NOTHING RETURNING source_event_id INTO v_event;
  IF v_event IS NULL THEN
    SELECT e.source_event_id,e.payload,e.rule_version_id,e.occurred_at,e.event_type
      INTO v_event,v_payload,v_existing_rule,v_existing_at,v_existing_type
      FROM source_events e WHERE e.family_id=p_family_id AND e.child_id=p_child_id AND e.client_event_key=p_idempotency_key FOR UPDATE;
    IF v_payload IS DISTINCT FROM p_payload OR v_existing_rule IS DISTINCT FROM p_rule_version_id
       OR v_existing_at IS DISTINCT FROM p_occurred_at OR v_existing_type IS DISTINCT FROM 'PARENT_RECOGNITION'::event_kind THEN
      RAISE EXCEPTION 'idempotency request mismatch' USING ERRCODE='22000';
    END IF;
    SELECT * INTO v_result FROM lifestyle_recognition_results WHERE family_id=p_family_id AND source_event_id=v_event;
    IF v_result.result_id IS NULL THEN RAISE EXCEPTION 'idempotency key belongs to a non-lifestyle recognition event'; END IF;
    RETURN jsonb_build_object('event_id',v_event,'outcome',v_result.outcome,'count_consumed',v_result.count_consumed,'replayed',true);
  END IF;
  INSERT INTO parent_confirmations(confirmation_id,family_id,source_event_id,parent_membership_id,decision,reason,idempotency_key)
  VALUES ('pc-'||md5(v_event),p_family_id,v_event,v_parent,'RECOGNIZED',NULL,'confirm:'||p_idempotency_key);
  SELECT stable_scope_id INTO v_scope_id FROM stable_rule_scopes WHERE family_id=p_family_id AND stable_scope_code=v_scope;
  IF v_scope_id IS NULL THEN RAISE EXCEPTION 'stable scope missing'; END IF;
  INSERT INTO recognition_limit_buckets(bucket_id,family_id,child_id,stable_scope_id,business_date,timezone,limit_count)
  VALUES ('bucket-'||md5(p_family_id||p_child_id||v_scope||v_day::text),p_family_id,p_child_id,v_scope_id,v_day,v_tz,v_limit)
  ON CONFLICT (family_id,child_id,stable_scope_id,business_date) DO NOTHING;
  SELECT bucket_id INTO v_bucket FROM recognition_limit_buckets
   WHERE family_id=p_family_id AND child_id=p_child_id AND stable_scope_id=v_scope_id AND business_date=v_day FOR UPDATE;
  UPDATE recognition_limit_buckets SET used_count=used_count+1
   WHERE bucket_id=v_bucket AND used_count < limit_count RETURNING true INTO v_used;
  IF COALESCE(v_used,false) THEN
    INSERT INTO recognition_limit_uses(use_id,family_id,bucket_id,source_event_id)
    VALUES ('use-'||md5(v_event),p_family_id,v_bucket,v_event);
    INSERT INTO lifestyle_recognition_results(result_id,family_id,source_event_id,rule_version_id,bucket_id,outcome,count_consumed,applied_minutes)
    VALUES ('lr-'||md5(v_event),p_family_id,v_event,p_rule_version_id,v_bucket,'REWARDED',true,v_minutes);
    FOR v_effect IN SELECT * FROM rule_effects WHERE family_id=p_family_id AND rule_version_id=p_rule_version_id AND effect='REWARD' AND condition_code=v_condition LOOP
      INSERT INTO effect_applications(effect_application_id,family_id,source_event_id,rule_effect_id,applied_quantity,unit)
      VALUES ('ea-'||md5(v_event||v_effect.rule_effect_id),p_family_id,v_event,v_effect.rule_effect_id,v_effect.quantity,v_effect.unit);
    END LOOP;
    RETURN jsonb_build_object('event_id',v_event,'outcome','REWARDED','count_consumed',true,'replayed',false);
  END IF;
  INSERT INTO lifestyle_recognition_results(result_id,family_id,source_event_id,rule_version_id,bucket_id,outcome,count_consumed,applied_minutes)
  VALUES ('lr-'||md5(v_event),p_family_id,v_event,p_rule_version_id,v_bucket,'LIMIT_EXCEEDED',false,0);
  RETURN jsonb_build_object('event_id',v_event,'outcome','LIMIT_EXCEEDED','count_consumed',false,'replayed',false);
END $$;

-- 패널티도 명시된 음수 Lifestyle 규칙과 원 요청 전체가 일치할 때만 재전송으로 인정한다.
CREATE OR REPLACE FUNCTION approve_penalty_event(
  p_family_id text,p_child_id text,p_rule_version_id text,p_occurred_at timestamptz,p_idempotency_key text,p_payload jsonb,p_reason text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pr_design, pg_temp AS $$
DECLARE v_parent text; v_event text; v_existing jsonb; v_existing_rule text; v_existing_at timestamptz; v_existing_type event_kind;
        v_existing_reason text; v_kind doc_kind; v_negative numeric;
BEGIN
  v_parent:=assert_parent(p_family_id);
  IF p_reason IS NULL OR btrim(p_reason)='' THEN RAISE EXCEPTION 'penalty reason required'; END IF;
  SELECT e.source_event_id,e.payload,e.rule_version_id,e.occurred_at,e.event_type
    INTO v_event,v_existing,v_existing_rule,v_existing_at,v_existing_type
    FROM source_events e WHERE e.family_id=p_family_id AND e.child_id=p_child_id AND e.client_event_key=p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    SELECT reason INTO v_existing_reason FROM parent_confirmations WHERE family_id=p_family_id AND source_event_id=v_event AND decision='PENALTY_APPROVED';
    IF v_existing IS DISTINCT FROM p_payload OR v_existing_rule IS DISTINCT FROM p_rule_version_id OR v_existing_at IS DISTINCT FROM p_occurred_at
       OR v_existing_type IS DISTINCT FROM 'PENALTY_REPORT'::event_kind OR v_existing_reason IS DISTINCT FROM p_reason THEN
      RAISE EXCEPTION 'idempotency request mismatch' USING ERRCODE='22000';
    END IF;
    RETURN v_event;
  END IF;
  PERFORM assert_rule_operable(p_family_id,p_rule_version_id);
  SELECT ri.kind,rv.negative_minutes INTO v_kind,v_negative FROM rule_versions rv JOIN rule_identities ri ON (ri.rule_id,ri.family_id)=(rv.rule_id,rv.family_id)
   WHERE rv.family_id=p_family_id AND rv.rule_version_id=p_rule_version_id;
  IF v_kind IS DISTINCT FROM 'LIFESTYLE'::doc_kind OR v_negative IS NULL OR v_negative >= 0 THEN
    RAISE EXCEPTION 'defined negative Lifestyle rule required for penalty';
  END IF;
  INSERT INTO source_events VALUES ('evt-'||md5(p_family_id||p_child_id||p_idempotency_key),p_family_id,p_child_id,NULL,p_rule_version_id,'PENALTY_REPORT',p_occurred_at,p_payload,p_idempotency_key,clock_timestamp()) RETURNING source_event_id INTO v_event;
  INSERT INTO parent_confirmations(confirmation_id,family_id,source_event_id,parent_membership_id,decision,reason,idempotency_key)
  VALUES ('pc-'||md5(v_event),p_family_id,v_event,v_parent,'PENALTY_APPROVED',p_reason,'penalty:'||p_idempotency_key);
  RETURN v_event;
END $$;

-- 학교 정산은 [starts_on, ends_on)만 집계한다. p_test_only_interim 자체는 권한이 아니다.
CREATE OR REPLACE FUNCTION settle_school_period(
 p_family_id text,p_child_id text,p_scope_code text,p_starts_on date,p_ends_on date,p_timezone text,
 p_final boolean DEFAULT true,p_test_only_interim boolean DEFAULT false,p_decision_reference text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pr_design, pg_temp AS $$
DECLARE v_parent text; v_scope text; v_period text; v_total int; v_target numeric; v_issued numeric; v_new numeric;
        v_unconfirmed int; v_bad_praise int; v_asset text; v_name text; v_delivery text; v_rule text;
        v_rule_count int; v_effect_count int;
BEGIN
 v_parent:=assert_parent(p_family_id);
 IF p_ends_on <= p_starts_on THEN RAISE EXCEPTION 'ends_on must be after starts_on'; END IF;
 SELECT stable_scope_id INTO v_scope FROM stable_rule_scopes WHERE family_id=p_family_id AND stable_scope_code=p_scope_code AND period='WEEKLY';
 IF v_scope IS NULL THEN RAISE EXCEPTION 'weekly stable scope missing'; END IF;
 PERFORM 1 FROM children WHERE family_id=p_family_id AND child_id=p_child_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'child is outside family' USING ERRCODE='42501'; END IF;
 INSERT INTO aggregation_periods(aggregation_period_id,family_id,child_id,stable_scope_id,starts_on,ends_on,timezone)
 VALUES ('period-'||md5(p_family_id||p_child_id||p_scope_code||p_starts_on||p_ends_on||p_timezone),p_family_id,p_child_id,v_scope,p_starts_on,p_ends_on,p_timezone)
 ON CONFLICT (family_id,child_id,stable_scope_id,starts_on,ends_on,timezone) DO NOTHING;
 SELECT aggregation_period_id INTO v_period FROM aggregation_periods WHERE family_id=p_family_id AND child_id=p_child_id AND stable_scope_id=v_scope AND starts_on=p_starts_on AND ends_on=p_ends_on AND timezone=p_timezone FOR UPDATE;
 IF NOT p_final AND NOT (test_mode_enabled() AND p_test_only_interim AND p_decision_reference IS NOT NULL) THEN
   RAISE EXCEPTION 'interim school issuance is allowed only in isolated test_mode with a decision reference';
 END IF;
 -- 평가가 없거나, 확인/원천 피드백이 해당 회차에 연결되지 않으면 최종 확정하지 않는다.
 SELECT count(*) INTO v_unconfirmed FROM scheduled_occurrences o
 LEFT JOIN school_day_assessments a ON a.family_id=o.family_id AND a.occurrence_id=o.occurrence_id
 LEFT JOIN parent_confirmations pc ON (pc.confirmation_id,pc.family_id)=(a.parent_confirmation_id,a.family_id)
 LEFT JOIN source_events pe ON (pe.source_event_id,pe.family_id)=(pc.source_event_id,pc.family_id)
 WHERE o.family_id=p_family_id AND o.child_id=p_child_id AND o.stable_scope_code=p_scope_code
   AND (o.scheduled_for AT TIME ZONE p_timezone)::date >= p_starts_on AND (o.scheduled_for AT TIME ZONE p_timezone)::date < p_ends_on
   AND o.state <> 'CANCELLED'
   AND (a.assessment_id IS NULL OR a.feedback='UNCONFIRMED' OR a.parent_confirmation_id IS NULL OR pc.decision<>'RECOGNIZED'
        OR pe.event_type<>'SCHOOL_FEEDBACK' OR pe.occurrence_id IS DISTINCT FROM o.occurrence_id);
 IF p_final AND v_unconfirmed > 0 THEN RAISE EXCEPTION 'cannot final-close: % school occurrence(s) unresolved', v_unconfirmed; END IF;
 -- 칭찬은 학교 규칙 scope + SCHOOL 타입 원천만 세며, 미확인/문제와 동시인 날은 최종 보류한다.
 SELECT count(*) INTO v_bad_praise FROM sticker_awards sa
 JOIN sticker_types st ON (st.sticker_type_id,st.family_id)=(sa.sticker_type_id,sa.family_id) AND st.code='SCHOOL'
 JOIN source_events e ON (e.source_event_id,e.family_id)=(sa.source_event_id,sa.family_id) AND e.event_type='SCHOOL_PRAISE'
 JOIN rule_versions prv ON (prv.rule_version_id,prv.family_id)=(e.rule_version_id,e.family_id)
 JOIN parent_confirmations praise_pc ON (praise_pc.confirmation_id,praise_pc.family_id)=(sa.parent_confirmation_id,sa.family_id)
   AND praise_pc.source_event_id=e.source_event_id AND praise_pc.decision='RECOGNIZED'
 LEFT JOIN school_day_assessments a ON a.family_id=e.family_id AND a.occurrence_id=e.occurrence_id
 LEFT JOIN parent_confirmations feedback_pc ON (feedback_pc.confirmation_id,feedback_pc.family_id)=(a.parent_confirmation_id,a.family_id)
   AND feedback_pc.decision='RECOGNIZED'
 LEFT JOIN source_events feedback_e ON (feedback_e.source_event_id,feedback_e.family_id)=(feedback_pc.source_event_id,feedback_pc.family_id)
   AND feedback_e.event_type='SCHOOL_FEEDBACK' AND feedback_e.occurrence_id=e.occurrence_id
 WHERE sa.family_id=p_family_id AND sa.child_id=p_child_id
   AND (e.occurred_at AT TIME ZONE p_timezone)::date >= p_starts_on AND (e.occurred_at AT TIME ZONE p_timezone)::date < p_ends_on
   AND (praise_pc.confirmation_id IS NULL OR a.assessment_id IS NULL OR a.feedback IS DISTINCT FROM 'NO_PROBLEM'::feedback_state
        OR a.parent_confirmation_id IS NULL OR feedback_pc.confirmation_id IS NULL OR feedback_e.source_event_id IS NULL);
 IF v_bad_praise>0 THEN RAISE EXCEPTION 'school praise requires a parent-confirmed NO_PROBLEM assessment; problem/unknown+praise remains unresolved'; END IF;
 SELECT COALESCE(sum(a.basic_sticker_count),0)+COALESCE((SELECT count(*) FROM sticker_awards sa
   JOIN sticker_types st ON (st.sticker_type_id,st.family_id)=(sa.sticker_type_id,sa.family_id) AND st.code='SCHOOL'
   JOIN source_events e ON (e.source_event_id,e.family_id)=(sa.source_event_id,sa.family_id) AND e.event_type='SCHOOL_PRAISE'
   JOIN rule_versions prv ON (prv.rule_version_id,prv.family_id)=(e.rule_version_id,e.family_id)
   JOIN rule_identities pri ON (pri.rule_id,pri.family_id)=(prv.rule_id,prv.family_id) AND pri.stable_scope_code=p_scope_code
   JOIN parent_confirmations praise_pc ON (praise_pc.confirmation_id,praise_pc.family_id)=(sa.parent_confirmation_id,sa.family_id)
     AND praise_pc.source_event_id=e.source_event_id AND praise_pc.decision='RECOGNIZED'
   JOIN school_day_assessments a ON a.family_id=e.family_id AND a.occurrence_id=e.occurrence_id
     AND a.feedback='NO_PROBLEM' AND a.parent_confirmation_id IS NOT NULL
   JOIN parent_confirmations feedback_pc ON (feedback_pc.confirmation_id,feedback_pc.family_id)=(a.parent_confirmation_id,a.family_id)
     AND feedback_pc.decision='RECOGNIZED'
   JOIN source_events feedback_e ON (feedback_e.source_event_id,feedback_e.family_id)=(feedback_pc.source_event_id,feedback_pc.family_id)
     AND feedback_e.event_type='SCHOOL_FEEDBACK' AND feedback_e.occurrence_id=e.occurrence_id
   WHERE sa.family_id=p_family_id AND sa.child_id=p_child_id
     AND (e.occurred_at AT TIME ZONE p_timezone)::date >= p_starts_on AND (e.occurred_at AT TIME ZONE p_timezone)::date < p_ends_on),0)
 INTO v_total FROM school_day_assessments a WHERE a.family_id=p_family_id AND a.child_id=p_child_id AND a.stable_scope_code=p_scope_code
   AND a.business_date >= p_starts_on AND a.business_date < p_ends_on AND a.feedback <> 'UNCONFIRMED' AND a.parent_confirmation_id IS NOT NULL;
 v_target:=CASE WHEN v_total >=8 THEN 15000 WHEN v_total >=5 THEN 10000 ELSE 0 END;
 SELECT COALESCE(sum(r.quantity + COALESCE((SELECT sum(c.signed_quantity) FROM reward_correction_events c WHERE c.family_id=r.family_id AND c.reward_right_id=r.reward_right_id),0)),0)
   INTO v_issued FROM reward_rights r WHERE r.family_id=p_family_id AND r.aggregation_period_id=v_period AND r.status='ISSUED' AND r.unit='COUPAY_KRW';
 IF v_target < v_issued THEN UPDATE aggregation_periods SET review_required=true WHERE aggregation_period_id=v_period;
   RETURN jsonb_build_object('period_id',v_period,'stickers',v_total,'target_total',v_target,'issued_total',v_issued,'new_right',0,'status','REVIEW_REQUIRED'); END IF;
 v_new:=greatest(0,v_target-v_issued);
 IF v_new>0 THEN
   -- 기간 내 예정회차가 고정한 정확한 한 rule version만 채택한다. 임의 LIMIT 1 선택은 금지한다.
   SELECT count(DISTINCT o.rule_version_id),min(o.rule_version_id) INTO v_rule_count,v_rule FROM scheduled_occurrences o
    WHERE o.family_id=p_family_id AND o.child_id=p_child_id AND o.stable_scope_code=p_scope_code AND o.state<>'CANCELLED'
      AND (o.scheduled_for AT TIME ZONE p_timezone)::date >= p_starts_on AND (o.scheduled_for AT TIME ZONE p_timezone)::date < p_ends_on;
   IF v_rule_count<>1 THEN RAISE EXCEPTION 'exactly one adopted school rule version must resolve for issuing period'; END IF;
   PERFORM assert_rule_operable(p_family_id,v_rule);
   SELECT count(*),min(av.asset_version_id),min(av.display_name),min(av.delivery_method) INTO v_effect_count,v_asset,v_name,v_delivery
    FROM rule_effects re JOIN asset_versions av ON (av.asset_version_id,av.family_id)=(re.asset_version_id,re.family_id)
   WHERE re.family_id=p_family_id AND re.rule_version_id=v_rule AND re.effect='REWARD' AND re.unit='COUPAY_KRW'
     AND re.condition_code=CASE WHEN v_target>=15000 THEN 'TARGET_TOTAL_8_PLUS' ELSE 'TARGET_TOTAL_5_TO_7' END AND re.quantity=v_target;
   IF v_effect_count<>1 THEN RAISE EXCEPTION 'exact school COUPAY effect/version resolver missing or ambiguous'; END IF;
   INSERT INTO reward_rights(reward_right_id,family_id,child_id,aggregation_period_id,rule_version_id,asset_version_id,source_key,quantity,unit,display_name_snapshot,delivery_method_snapshot)
   VALUES ('right-'||md5(v_period||':'||v_target::text),p_family_id,p_child_id,v_period,v_rule,v_asset,'school-period:'||v_period||':target:'||v_target::text,v_new,'COUPAY_KRW',v_name,v_delivery);
 END IF;
 IF p_final THEN UPDATE aggregation_periods SET final_closed=true WHERE aggregation_period_id=v_period; END IF;
 RETURN jsonb_build_object('period_id',v_period,'stickers',v_total,'target_total',v_target,'issued_total',v_issued+v_new,'new_right',v_new,'status',CASE WHEN p_final THEN 'FINAL' ELSE 'TEST_ONLY_INTERIM' END);
END $$;

CREATE OR REPLACE FUNCTION school_execution_outstanding(p_family_id text,p_aggregation_period_id text) RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pr_design, pg_temp AS $$
DECLARE v_rights numeric; v_done numeric;
BEGIN
 PERFORM assert_parent(p_family_id);
 SELECT COALESCE(sum(r.quantity + COALESCE((SELECT sum(c.signed_quantity) FROM reward_correction_events c WHERE c.family_id=r.family_id AND c.reward_right_id=r.reward_right_id),0)),0)
   INTO v_rights FROM reward_rights r WHERE r.family_id=p_family_id AND r.aggregation_period_id=p_aggregation_period_id AND r.status='ISSUED' AND r.unit='COUPAY_KRW';
 SELECT COALESCE(sum(x.quantity),0) INTO v_done FROM actual_reward_executions x JOIN reward_rights r ON (r.reward_right_id,r.family_id)=(x.reward_right_id,x.family_id)
  WHERE x.family_id=p_family_id AND r.aggregation_period_id=p_aggregation_period_id;
 RETURN greatest(0,v_rights-v_done);
END $$;

-- 총 미이행액은 배치 합계이며, 실제 행은 각 권리의 남은 상한을 넘지 않게 분할된다.
CREATE OR REPLACE FUNCTION execute_school_outstanding(p_family_id text,p_aggregation_period_id text,p_idempotency_key text,p_external_reference text DEFAULT NULL) RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pr_design, pg_temp AS $$
DECLARE v_parent text; v_outstanding numeric; v_right record; v_existing school_execution_batches%ROWTYPE;
        v_review boolean; v_batch text; v_left numeric; v_take numeric; v_allocated numeric:=0;
BEGIN
 v_parent:=assert_parent(p_family_id);
 SELECT * INTO v_existing FROM school_execution_batches WHERE family_id=p_family_id AND idempotency_key=p_idempotency_key FOR UPDATE;
 IF FOUND THEN
   IF v_existing.aggregation_period_id IS DISTINCT FROM p_aggregation_period_id OR v_existing.external_reference IS DISTINCT FROM p_external_reference THEN
     RAISE EXCEPTION 'idempotency request mismatch: period or external reference differs' USING ERRCODE='22000';
   END IF;
   RETURN v_existing.quantity;
 END IF;
 SELECT review_required INTO v_review FROM aggregation_periods WHERE family_id=p_family_id AND aggregation_period_id=p_aggregation_period_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'aggregation period is outside family'; END IF;
 IF v_review THEN RAISE EXCEPTION 'cannot execute a REVIEW_REQUIRED period'; END IF;
 v_outstanding:=school_execution_outstanding(p_family_id,p_aggregation_period_id);
 v_batch:='batch-'||md5(p_family_id||p_idempotency_key);
 INSERT INTO school_execution_batches(execution_batch_id,family_id,aggregation_period_id,idempotency_key,external_reference,quantity,executed_by_membership_id)
 VALUES (v_batch,p_family_id,p_aggregation_period_id,p_idempotency_key,p_external_reference,v_outstanding,v_parent);
 v_left:=v_outstanding;
 FOR v_right IN
   SELECT r.reward_right_id,GREATEST(0::numeric,r.quantity+COALESCE((SELECT sum(c.signed_quantity) FROM reward_correction_events c WHERE c.family_id=r.family_id AND c.reward_right_id=r.reward_right_id),0)-COALESCE((SELECT sum(x.quantity) FROM actual_reward_executions x WHERE x.family_id=r.family_id AND x.reward_right_id=r.reward_right_id),0)) AS remaining
   FROM reward_rights r WHERE r.family_id=p_family_id AND r.aggregation_period_id=p_aggregation_period_id AND r.status='ISSUED' AND r.unit='COUPAY_KRW'
   ORDER BY r.issued_at,r.reward_right_id FOR UPDATE
 LOOP
   EXIT WHEN v_left<=0;
   v_take:=least(v_left,v_right.remaining);
   IF v_take>0 THEN
     INSERT INTO actual_reward_executions(execution_id,family_id,execution_batch_id,reward_right_id,idempotency_key,quantity,executed_by_membership_id,external_reference)
     VALUES ('exec-'||md5(v_batch||v_right.reward_right_id),p_family_id,v_batch,v_right.reward_right_id,p_idempotency_key,v_take,v_parent,p_external_reference);
     v_left:=v_left-v_take; v_allocated:=v_allocated+v_take;
   END IF;
 END LOOP;
 IF v_allocated IS DISTINCT FROM v_outstanding THEN RAISE EXCEPTION 'right allocation changed while executing'; END IF;
 RETURN v_allocated;
END $$;

-- Client/raw-table boundary. Application roles receive only explicit RPC EXECUTE grants.
REVOKE ALL ON ALL TABLES IN SCHEMA pr_design FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA pr_design FROM PUBLIC;
-- Deployment boundary: grant EXECUTE only to an authenticated app role after it exists.
-- ALTER DEFAULT PRIVILEGES IN SCHEMA pr_design REVOKE ALL ON TABLES FROM PUBLIC;
-- GRANT USAGE ON SCHEMA pr_design TO authenticated;
-- GRANT EXECUTE ON FUNCTION recognize_lifestyle_event(text,text,text,timestamptz,text,jsonb), approve_penalty_event(text,text,text,timestamptz,text,jsonb,text), settle_school_period(text,text,text,date,date,text,boolean,boolean,text), school_execution_outstanding(text,text), execute_school_outstanding(text,text,text,text) TO authenticated;
