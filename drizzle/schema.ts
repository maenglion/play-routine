import { sql } from "drizzle-orm";
import {
  boolean,
  AnyMySqlColumn,
  check,
  date,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export const families = mysqlTable("families", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  ownerUserId: int("owner_user_id").notNull().references(() => users.id),
  timezone: varchar("timezone", { length: 64 }).default("Asia/Seoul").notNull(),
  status: mysqlEnum("status", ["ACTIVE", "ARCHIVED"]).default("ACTIVE").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
}, table => [index("families_owner_idx").on(table.ownerUserId)]);

export const familyMemberships = mysqlTable("family_memberships", {
  id: int("id").autoincrement().primaryKey(),
  familyId: int("family_id").notNull().references(() => families.id, { onDelete: "cascade" }),
  userId: int("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: mysqlEnum("role", ["OWNER", "GUARDIAN", "VIEWER"]).notNull(),
  status: mysqlEnum("status", ["INVITED", "ACTIVE", "SUSPENDED", "REVOKED"]).default("ACTIVE").notNull(),
  joinedAt: timestamp("joined_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex("family_memberships_family_user_uq").on(table.familyId, table.userId),
  index("family_memberships_user_idx").on(table.userId),
]);

export const children = mysqlTable("children", {
  id: int("id").autoincrement().primaryKey(),
  familyId: int("family_id").notNull().references(() => families.id, { onDelete: "cascade" }),
  displayName: varchar("display_name", { length: 80 }).notNull(),
  birthDate: date("birth_date", { mode: "string" }),
  status: mysqlEnum("status", ["ACTIVE", "ARCHIVED"]).default("ACTIVE").notNull(),
  legacyChildId: varchar("legacy_child_id", { length: 80 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex("children_family_legacy_uq").on(table.familyId, table.legacyChildId),
  index("children_family_idx").on(table.familyId),
]);

export const guardianChildPermissions = mysqlTable("guardian_child_permissions", {
  id: int("id").autoincrement().primaryKey(),
  membershipId: int("membership_id").notNull().references(() => familyMemberships.id, { onDelete: "cascade" }),
  childId: int("child_id").notNull().references(() => children.id, { onDelete: "cascade" }),
  canView: boolean("can_view").default(true).notNull(),
  canEvaluate: boolean("can_evaluate").default(false).notNull(),
  canManageRules: boolean("can_manage_rules").default(false).notNull(),
  canManageCoupons: boolean("can_manage_coupons").default(false).notNull(),
  canReceiveNotifications: boolean("can_receive_notifications").default(true).notNull(),
  grantedByUserId: int("granted_by_user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex("guardian_child_permissions_membership_child_uq").on(table.membershipId, table.childId),
  index("guardian_child_permissions_child_idx").on(table.childId),
]);

export const guardianInvitations = mysqlTable("guardian_invitations", {
  id: int("id").autoincrement().primaryKey(),
  familyId: int("family_id").notNull().references(() => families.id, { onDelete: "cascade" }),
  email: varchar("email", { length: 320 }).notNull(),
  role: mysqlEnum("role", ["GUARDIAN", "VIEWER"]).notNull(),
  tokenHash: varchar("token_hash", { length: 128 }).notNull(),
  status: mysqlEnum("status", ["PENDING", "ACCEPTED", "EXPIRED", "CANCELLED"]).default("PENDING").notNull(),
  invitedByUserId: int("invited_by_user_id").notNull().references(() => users.id),
  acceptedByUserId: int("accepted_by_user_id").references(() => users.id),
  expiresAt: timestamp("expires_at").notNull(),
  acceptedAt: timestamp("accepted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, table => [
  uniqueIndex("guardian_invitations_token_hash_uq").on(table.tokenHash),
  index("guardian_invitations_family_status_idx").on(table.familyId, table.status),
]);

export const conceptNodes = mysqlTable("concept_nodes", {
  id: int("id").autoincrement().primaryKey(),
  familyId: int("family_id").notNull().references(() => families.id, { onDelete: "cascade" }),
  conceptType: mysqlEnum("concept_type", ["ACTIVITY", "GOAL", "CAPABILITY", "STATE", "FOCUS_WINDOW"]).notNull(),
  code: varchar("code", { length: 100 }).notNull(),
  label: varchar("label", { length: 160 }).notNull(),
  description: text("description"),
  metadata: json("metadata"),
  status: mysqlEnum("status", ["ACTIVE", "ARCHIVED"]).default("ACTIVE").notNull(),
  legacyNodeId: varchar("legacy_node_id", { length: 100 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex("concept_nodes_family_code_uq").on(table.familyId, table.code),
  uniqueIndex("concept_nodes_family_legacy_uq").on(table.familyId, table.legacyNodeId),
]);

export const conceptRelations = mysqlTable("concept_relations", {
  id: int("id").autoincrement().primaryKey(),
  familyId: int("family_id").notNull().references(() => families.id, { onDelete: "cascade" }),
  fromConceptId: int("from_concept_id").notNull().references(() => conceptNodes.id, { onDelete: "cascade" }),
  relationType: mysqlEnum("relation_type", ["TRAINS", "CONTRIBUTES_TO", "REQUIRES", "AFFECTS", "MITIGATES"]).notNull(),
  toConceptId: int("to_concept_id").notNull().references(() => conceptNodes.id, { onDelete: "cascade" }),
  weightPermille: int("weight_permille").default(1000).notNull(),
  conditionJson: json("condition_json"),
  legacyEdgeId: varchar("legacy_edge_id", { length: 100 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, table => [
  uniqueIndex("concept_relations_path_uq").on(table.familyId, table.fromConceptId, table.relationType, table.toConceptId),
  check("concept_relations_weight_ck", sql`${table.weightPermille} BETWEEN 0 AND 1000`),
]);

export const activityTemplates = mysqlTable("activity_templates", {
  id: int("id").autoincrement().primaryKey(),
  familyId: int("family_id").notNull().references(() => families.id, { onDelete: "cascade" }),
  code: varchar("code", { length: 100 }).notNull(),
  title: varchar("title", { length: 160 }).notNull(),
  description: text("description"),
  category: varchar("category", { length: 120 }),
  defaultDurationMinutes: int("default_duration_minutes"),
  status: mysqlEnum("status", ["ACTIVE", "ARCHIVED"]).default("ACTIVE").notNull(),
  legacyNodeId: varchar("legacy_node_id", { length: 100 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex("activity_templates_family_code_uq").on(table.familyId, table.code),
  uniqueIndex("activity_templates_family_legacy_uq").on(table.familyId, table.legacyNodeId),
]);

export const activityAssignments = mysqlTable("activity_assignments", {
  id: int("id").autoincrement().primaryKey(),
  childId: int("child_id").notNull().references(() => children.id, { onDelete: "cascade" }),
  activityTemplateId: int("activity_template_id").notNull().references(() => activityTemplates.id),
  scheduledDate: date("scheduled_date", { mode: "string" }).notNull(),
  occurrenceNo: int("occurrence_no").default(1).notNull(),
  status: mysqlEnum("status", ["SCHEDULED", "COMPLETED", "SKIPPED", "CANCELLED"]).default("SCHEDULED").notNull(),
  isRequired: boolean("is_required").default(false).notNull(),
  note: text("note"),
  legacyTaskId: varchar("legacy_task_id", { length: 140 }),
  createdByUserId: int("created_by_user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex("activity_assignments_occurrence_uq").on(table.childId, table.activityTemplateId, table.scheduledDate, table.occurrenceNo),
  uniqueIndex("activity_assignments_legacy_uq").on(table.legacyTaskId),
  index("activity_assignments_child_date_idx").on(table.childId, table.scheduledDate),
]);

export const rubrics = mysqlTable("rubrics", {
  id: int("id").autoincrement().primaryKey(),
  familyId: int("family_id").notNull().references(() => families.id, { onDelete: "cascade" }),
  code: varchar("code", { length: 100 }).notNull(),
  title: varchar("title", { length: 160 }).notNull(),
  description: text("description"),
  status: mysqlEnum("status", ["ACTIVE", "ARCHIVED"]).default("ACTIVE").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
}, table => [uniqueIndex("rubrics_family_code_uq").on(table.familyId, table.code)]);

export const rubricVersions = mysqlTable("rubric_versions", {
  id: int("id").autoincrement().primaryKey(),
  rubricId: int("rubric_id").notNull().references(() => rubrics.id, { onDelete: "cascade" }),
  versionNo: int("version_no").notNull(),
  status: mysqlEnum("status", ["DRAFT", "PUBLISHED", "RETIRED"]).default("DRAFT").notNull(),
  validFrom: date("valid_from", { mode: "string" }),
  validUntil: date("valid_until", { mode: "string" }),
  createdByUserId: int("created_by_user_id").notNull().references(() => users.id),
  publishedAt: timestamp("published_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, table => [uniqueIndex("rubric_versions_rubric_version_uq").on(table.rubricId, table.versionNo)]);

export const rubricLevels = mysqlTable("rubric_levels", {
  id: int("id").autoincrement().primaryKey(),
  rubricVersionId: int("rubric_version_id").notNull().references(() => rubricVersions.id, { onDelete: "cascade" }),
  code: varchar("code", { length: 60 }).notNull(),
  label: varchar("label", { length: 120 }).notNull(),
  description: text("description"),
  outcomeType: mysqlEnum("outcome_type", ["REWARD", "NEUTRAL", "PENALTY"]).notNull(),
  sortOrder: int("sort_order").default(0).notNull(),
  legacyConditionId: varchar("legacy_condition_id", { length: 100 }),
}, table => [
  uniqueIndex("rubric_levels_version_code_uq").on(table.rubricVersionId, table.code),
  index("rubric_levels_outcome_idx").on(table.outcomeType),
]);

export const activityRubrics = mysqlTable("activity_rubrics", {
  id: int("id").autoincrement().primaryKey(),
  activityTemplateId: int("activity_template_id").notNull().references(() => activityTemplates.id, { onDelete: "cascade" }),
  rubricId: int("rubric_id").notNull().references(() => rubrics.id, { onDelete: "cascade" }),
  isRequired: boolean("is_required").default(true).notNull(),
  sortOrder: int("sort_order").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, table => [
  uniqueIndex("activity_rubrics_template_rubric_uq").on(table.activityTemplateId, table.rubricId),
]);

export const ruleEffects = mysqlTable("rule_effects", {
  id: int("id").autoincrement().primaryKey(),
  rubricLevelId: int("rubric_level_id").notNull().references(() => rubricLevels.id, { onDelete: "cascade" }),
  assetType: mysqlEnum("asset_type", ["TIME_MINUTE", "MONEY_KRW"]).notNull(),
  amount: int("amount").notNull(),
  effectOrder: int("effect_order").default(1).notNull(),
  legacyRuleId: varchar("legacy_rule_id", { length: 100 }),
}, table => [
  uniqueIndex("rule_effects_level_asset_order_uq").on(table.rubricLevelId, table.assetType, table.effectOrder),
  check("rule_effects_amount_nonzero_ck", sql`${table.amount} <> 0`),
]);

export const evaluations = mysqlTable("evaluations", {
  id: int("id").autoincrement().primaryKey(),
  idempotencyKey: varchar("idempotency_key", { length: 191 }).notNull(),
  childId: int("child_id").notNull().references(() => children.id, { onDelete: "cascade" }),
  assignmentId: int("assignment_id").references(() => activityAssignments.id),
  rubricVersionId: int("rubric_version_id").notNull().references(() => rubricVersions.id),
  rubricLevelId: int("rubric_level_id").references(() => rubricLevels.id),
  applicability: mysqlEnum("applicability", ["APPLICABLE", "NOT_APPLICABLE"]).default("APPLICABLE").notNull(),
  status: mysqlEnum("status", ["DRAFT", "SUBMITTED", "REVERSED"]).default("DRAFT").notNull(),
  note: text("note"),
  evaluatorUserId: int("evaluator_user_id").notNull().references(() => users.id),
  evaluatedAt: timestamp("evaluated_at"),
  reversedAt: timestamp("reversed_at"),
  reversalReason: text("reversal_reason"),
  legacyLogId: varchar("legacy_log_id", { length: 120 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex("evaluations_idempotency_uq").on(table.idempotencyKey),
  uniqueIndex("evaluations_assignment_rubric_uq").on(table.assignmentId, table.rubricVersionId),
  uniqueIndex("evaluations_legacy_uq").on(table.legacyLogId),
  index("evaluations_child_evaluated_idx").on(table.childId, table.evaluatedAt),
]);

export const ledgerEvents = mysqlTable("ledger_events", {
  id: int("id").autoincrement().primaryKey(),
  childId: int("child_id").notNull().references(() => children.id, { onDelete: "cascade" }),
  eventType: mysqlEnum("event_type", ["EVALUATION", "COUPON_REDEMPTION", "ADJUSTMENT", "MIGRATION", "REVERSAL"]).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 191 }).notNull(),
  evaluationId: int("evaluation_id").references(() => evaluations.id),
  reversalOfEventId: int("reversal_of_event_id").references((): AnyMySqlColumn => ledgerEvents.id),
  reasonCode: varchar("reason_code", { length: 100 }).notNull(),
  reasonText: text("reason_text"),
  ruleSnapshot: json("rule_snapshot"),
  actorUserId: int("actor_user_id").notNull().references(() => users.id),
  effectiveAt: timestamp("effective_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, table => [
  uniqueIndex("ledger_events_idempotency_uq").on(table.idempotencyKey),
  uniqueIndex("ledger_events_evaluation_uq").on(table.evaluationId),
  uniqueIndex("ledger_events_reversal_uq").on(table.reversalOfEventId),
  index("ledger_events_child_effective_idx").on(table.childId, table.effectiveAt),
]);

export const ledgerEntries = mysqlTable("ledger_entries", {
  id: int("id").autoincrement().primaryKey(),
  eventId: int("event_id").notNull().references(() => ledgerEvents.id, { onDelete: "cascade" }),
  childId: int("child_id").notNull().references(() => children.id, { onDelete: "cascade" }),
  assetType: mysqlEnum("asset_type", ["TIME_MINUTE", "MONEY_KRW"]).notNull(),
  amount: int("amount").notNull(),
  balanceAfter: int("balance_after").notNull(),
  sequenceNo: int("sequence_no").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, table => [
  uniqueIndex("ledger_entries_event_asset_uq").on(table.eventId, table.assetType),
  uniqueIndex("ledger_entries_child_asset_sequence_uq").on(table.childId, table.assetType, table.sequenceNo),
  index("ledger_entries_child_asset_idx").on(table.childId, table.assetType),
  check("ledger_entries_amount_nonzero_ck", sql`${table.amount} <> 0`),
]);

export const walletBalances = mysqlTable("wallet_balances", {
  id: int("id").autoincrement().primaryKey(),
  childId: int("child_id").notNull().references(() => children.id, { onDelete: "cascade" }),
  assetType: mysqlEnum("asset_type", ["TIME_MINUTE", "MONEY_KRW"]).notNull(),
  balance: int("balance").default(0).notNull(),
  lastSequenceNo: int("last_sequence_no").default(0).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex("wallet_balances_child_asset_uq").on(table.childId, table.assetType),
]);

export const couponTemplates = mysqlTable("coupon_templates", {
  id: int("id").autoincrement().primaryKey(),
  familyId: int("family_id").notNull().references(() => families.id, { onDelete: "cascade" }),
  code: varchar("code", { length: 80 }).notNull(),
  title: varchar("title", { length: 120 }).notNull(),
  assetType: mysqlEnum("asset_type", ["TIME_MINUTE", "MONEY_KRW"]).default("TIME_MINUTE").notNull(),
  redemptionAmount: int("redemption_amount").notNull(),
  status: mysqlEnum("status", ["ACTIVE", "ARCHIVED"]).default("ACTIVE").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex("coupon_templates_family_code_uq").on(table.familyId, table.code),
  check("coupon_templates_redemption_negative_ck", sql`${table.redemptionAmount} < 0`),
]);

export const couponIssues = mysqlTable("coupon_issues", {
  id: int("id").autoincrement().primaryKey(),
  couponTemplateId: int("coupon_template_id").notNull().references(() => couponTemplates.id),
  serialCode: varchar("serial_code", { length: 120 }).notNull(),
  childId: int("child_id").references(() => children.id),
  status: mysqlEnum("status", ["ISSUED", "ASSIGNED", "REDEEMED", "CANCELLED", "EXPIRED", "VOID"]).default("ISSUED").notNull(),
  issuedByUserId: int("issued_by_user_id").notNull().references(() => users.id),
  assignedByUserId: int("assigned_by_user_id").references(() => users.id),
  issuedAt: timestamp("issued_at").defaultNow().notNull(),
  assignedAt: timestamp("assigned_at"),
  expiresAt: timestamp("expires_at"),
  legacyCouponId: varchar("legacy_coupon_id", { length: 120 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex("coupon_issues_serial_uq").on(table.serialCode),
  uniqueIndex("coupon_issues_legacy_uq").on(table.legacyCouponId),
  index("coupon_issues_child_status_idx").on(table.childId, table.status),
]);

export const couponRedemptions = mysqlTable("coupon_redemptions", {
  id: int("id").autoincrement().primaryKey(),
  couponIssueId: int("coupon_issue_id").notNull().references(() => couponIssues.id),
  childId: int("child_id").notNull().references(() => children.id),
  ledgerEventId: int("ledger_event_id").notNull().references(() => ledgerEvents.id),
  status: mysqlEnum("status", ["REDEEMED", "REVERSED"]).default("REDEEMED").notNull(),
  redeemedByUserId: int("redeemed_by_user_id").notNull().references(() => users.id),
  redeemedAt: timestamp("redeemed_at").defaultNow().notNull(),
  reversedAt: timestamp("reversed_at"),
  reversalReason: text("reversal_reason"),
}, table => [
  uniqueIndex("coupon_redemptions_issue_uq").on(table.couponIssueId),
  uniqueIndex("coupon_redemptions_event_uq").on(table.ledgerEventId),
]);

export const couponStateTransitions = mysqlTable("coupon_state_transitions", {
  id: int("id").autoincrement().primaryKey(),
  couponIssueId: int("coupon_issue_id").notNull().references(() => couponIssues.id, { onDelete: "cascade" }),
  fromStatus: mysqlEnum("from_status", ["ISSUED", "ASSIGNED", "REDEEMED", "CANCELLED", "EXPIRED", "VOID"]),
  toStatus: mysqlEnum("to_status", ["ISSUED", "ASSIGNED", "REDEEMED", "CANCELLED", "EXPIRED", "VOID"]).notNull(),
  reason: text("reason"),
  actorUserId: int("actor_user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, table => [index("coupon_state_transitions_issue_idx").on(table.couponIssueId, table.createdAt)]);

export const notificationPreferences = mysqlTable("notification_preferences", {
  id: int("id").autoincrement().primaryKey(),
  familyId: int("family_id").notNull().references(() => families.id, { onDelete: "cascade" }),
  userId: int("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  inAppEnabled: boolean("in_app_enabled").default(true).notNull(),
  emailEnabled: boolean("email_enabled").default(false).notNull(),
  smsEnabled: boolean("sms_enabled").default(false).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
}, table => [uniqueIndex("notification_preferences_family_user_uq").on(table.familyId, table.userId)]);

export const notifications = mysqlTable("notifications", {
  id: int("id").autoincrement().primaryKey(),
  recipientUserId: int("recipient_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  childId: int("child_id").notNull().references(() => children.id, { onDelete: "cascade" }),
  notificationType: mysqlEnum("notification_type", ["EVALUATION", "PENALTY", "COUPON", "LOW_BALANCE", "SYSTEM"]).notNull(),
  title: varchar("title", { length: 160 }).notNull(),
  body: text("body").notNull(),
  status: mysqlEnum("status", ["UNREAD", "READ", "ARCHIVED"]).default("UNREAD").notNull(),
  evaluationId: int("evaluation_id").references(() => evaluations.id),
  ledgerEventId: int("ledger_event_id").references(() => ledgerEvents.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  readAt: timestamp("read_at"),
}, table => [index("notifications_recipient_status_idx").on(table.recipientUserId, table.status, table.createdAt)]);

export const notificationDeliveries = mysqlTable("notification_deliveries", {
  id: int("id").autoincrement().primaryKey(),
  notificationId: int("notification_id").notNull().references(() => notifications.id, { onDelete: "cascade" }),
  channel: mysqlEnum("channel", ["IN_APP", "EMAIL", "SMS"]).notNull(),
  status: mysqlEnum("status", ["PENDING", "SENT", "FAILED", "SKIPPED"]).default("PENDING").notNull(),
  attemptCount: int("attempt_count").default(0).notNull(),
  providerMessageId: varchar("provider_message_id", { length: 191 }),
  lastError: text("last_error"),
  sentAt: timestamp("sent_at"),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
}, table => [index("notification_deliveries_status_idx").on(table.status, table.updatedAt)]);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type Family = typeof families.$inferSelect;
export type Child = typeof children.$inferSelect;
export type Evaluation = typeof evaluations.$inferSelect;
export type LedgerEvent = typeof ledgerEvents.$inferSelect;
export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type CouponIssue = typeof couponIssues.$inferSelect;
