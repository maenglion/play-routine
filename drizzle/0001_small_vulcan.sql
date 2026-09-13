CREATE TABLE `activity_assignments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`child_id` int NOT NULL,
	`activity_template_id` int NOT NULL,
	`scheduled_date` date NOT NULL,
	`occurrence_no` int NOT NULL DEFAULT 1,
	`status` enum('SCHEDULED','COMPLETED','SKIPPED','CANCELLED') NOT NULL DEFAULT 'SCHEDULED',
	`is_required` boolean NOT NULL DEFAULT false,
	`note` text,
	`legacy_task_id` varchar(140),
	`created_by_user_id` int NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `activity_assignments_id` PRIMARY KEY(`id`),
	CONSTRAINT `activity_assignments_occurrence_uq` UNIQUE(`child_id`,`activity_template_id`,`scheduled_date`,`occurrence_no`),
	CONSTRAINT `activity_assignments_legacy_uq` UNIQUE(`legacy_task_id`)
);
--> statement-breakpoint
CREATE TABLE `activity_templates` (
	`id` int AUTO_INCREMENT NOT NULL,
	`family_id` int NOT NULL,
	`code` varchar(100) NOT NULL,
	`title` varchar(160) NOT NULL,
	`description` text,
	`category` varchar(120),
	`default_duration_minutes` int,
	`status` enum('ACTIVE','ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
	`legacy_node_id` varchar(100),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `activity_templates_id` PRIMARY KEY(`id`),
	CONSTRAINT `activity_templates_family_code_uq` UNIQUE(`family_id`,`code`),
	CONSTRAINT `activity_templates_family_legacy_uq` UNIQUE(`family_id`,`legacy_node_id`)
);
--> statement-breakpoint
CREATE TABLE `children` (
	`id` int AUTO_INCREMENT NOT NULL,
	`family_id` int NOT NULL,
	`display_name` varchar(80) NOT NULL,
	`birth_date` date,
	`status` enum('ACTIVE','ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
	`legacy_child_id` varchar(80),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `children_id` PRIMARY KEY(`id`),
	CONSTRAINT `children_family_legacy_uq` UNIQUE(`family_id`,`legacy_child_id`)
);
--> statement-breakpoint
CREATE TABLE `concept_nodes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`family_id` int NOT NULL,
	`concept_type` enum('ACTIVITY','GOAL','CAPABILITY','STATE','FOCUS_WINDOW') NOT NULL,
	`code` varchar(100) NOT NULL,
	`label` varchar(160) NOT NULL,
	`description` text,
	`metadata` json,
	`status` enum('ACTIVE','ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
	`legacy_node_id` varchar(100),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `concept_nodes_id` PRIMARY KEY(`id`),
	CONSTRAINT `concept_nodes_family_code_uq` UNIQUE(`family_id`,`code`),
	CONSTRAINT `concept_nodes_family_legacy_uq` UNIQUE(`family_id`,`legacy_node_id`)
);
--> statement-breakpoint
CREATE TABLE `concept_relations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`family_id` int NOT NULL,
	`from_concept_id` int NOT NULL,
	`relation_type` enum('TRAINS','CONTRIBUTES_TO','REQUIRES','AFFECTS','MITIGATES') NOT NULL,
	`to_concept_id` int NOT NULL,
	`weight_permille` int NOT NULL DEFAULT 1000,
	`condition_json` json,
	`legacy_edge_id` varchar(100),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `concept_relations_id` PRIMARY KEY(`id`),
	CONSTRAINT `concept_relations_path_uq` UNIQUE(`family_id`,`from_concept_id`,`relation_type`,`to_concept_id`),
	CONSTRAINT `concept_relations_weight_ck` CHECK(`concept_relations`.`weight_permille` BETWEEN 0 AND 1000)
);
--> statement-breakpoint
CREATE TABLE `coupon_issues` (
	`id` int AUTO_INCREMENT NOT NULL,
	`coupon_template_id` int NOT NULL,
	`serial_code` varchar(120) NOT NULL,
	`child_id` int,
	`status` enum('ISSUED','ASSIGNED','REDEEMED','CANCELLED','EXPIRED','VOID') NOT NULL DEFAULT 'ISSUED',
	`issued_by_user_id` int NOT NULL,
	`assigned_by_user_id` int,
	`issued_at` timestamp NOT NULL DEFAULT (now()),
	`assigned_at` timestamp,
	`expires_at` timestamp,
	`legacy_coupon_id` varchar(120),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `coupon_issues_id` PRIMARY KEY(`id`),
	CONSTRAINT `coupon_issues_serial_uq` UNIQUE(`serial_code`),
	CONSTRAINT `coupon_issues_legacy_uq` UNIQUE(`legacy_coupon_id`)
);
--> statement-breakpoint
CREATE TABLE `coupon_redemptions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`coupon_issue_id` int NOT NULL,
	`child_id` int NOT NULL,
	`ledger_event_id` int NOT NULL,
	`status` enum('REDEEMED','REVERSED') NOT NULL DEFAULT 'REDEEMED',
	`redeemed_by_user_id` int NOT NULL,
	`redeemed_at` timestamp NOT NULL DEFAULT (now()),
	`reversed_at` timestamp,
	`reversal_reason` text,
	CONSTRAINT `coupon_redemptions_id` PRIMARY KEY(`id`),
	CONSTRAINT `coupon_redemptions_issue_uq` UNIQUE(`coupon_issue_id`),
	CONSTRAINT `coupon_redemptions_event_uq` UNIQUE(`ledger_event_id`)
);
--> statement-breakpoint
CREATE TABLE `coupon_state_transitions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`coupon_issue_id` int NOT NULL,
	`from_status` enum('ISSUED','ASSIGNED','REDEEMED','CANCELLED','EXPIRED','VOID'),
	`to_status` enum('ISSUED','ASSIGNED','REDEEMED','CANCELLED','EXPIRED','VOID') NOT NULL,
	`reason` text,
	`actor_user_id` int NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `coupon_state_transitions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `coupon_templates` (
	`id` int AUTO_INCREMENT NOT NULL,
	`family_id` int NOT NULL,
	`code` varchar(80) NOT NULL,
	`title` varchar(120) NOT NULL,
	`asset_type` enum('TIME_MINUTE','MONEY_KRW') NOT NULL DEFAULT 'TIME_MINUTE',
	`redemption_amount` int NOT NULL,
	`status` enum('ACTIVE','ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `coupon_templates_id` PRIMARY KEY(`id`),
	CONSTRAINT `coupon_templates_family_code_uq` UNIQUE(`family_id`,`code`),
	CONSTRAINT `coupon_templates_redemption_negative_ck` CHECK(`coupon_templates`.`redemption_amount` < 0)
);
--> statement-breakpoint
CREATE TABLE `evaluations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`child_id` int NOT NULL,
	`assignment_id` int,
	`rubric_version_id` int NOT NULL,
	`rubric_level_id` int,
	`applicability` enum('APPLICABLE','NOT_APPLICABLE') NOT NULL DEFAULT 'APPLICABLE',
	`status` enum('DRAFT','SUBMITTED','REVERSED') NOT NULL DEFAULT 'DRAFT',
	`note` text,
	`evaluator_user_id` int NOT NULL,
	`evaluated_at` timestamp,
	`reversed_at` timestamp,
	`reversal_reason` text,
	`legacy_log_id` varchar(120),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `evaluations_id` PRIMARY KEY(`id`),
	CONSTRAINT `evaluations_assignment_rubric_uq` UNIQUE(`assignment_id`,`rubric_version_id`),
	CONSTRAINT `evaluations_legacy_uq` UNIQUE(`legacy_log_id`)
);
--> statement-breakpoint
CREATE TABLE `families` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(120) NOT NULL,
	`owner_user_id` int NOT NULL,
	`timezone` varchar(64) NOT NULL DEFAULT 'Asia/Seoul',
	`status` enum('ACTIVE','ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `families_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `family_memberships` (
	`id` int AUTO_INCREMENT NOT NULL,
	`family_id` int NOT NULL,
	`user_id` int NOT NULL,
	`role` enum('OWNER','GUARDIAN','VIEWER') NOT NULL,
	`status` enum('INVITED','ACTIVE','SUSPENDED','REVOKED') NOT NULL DEFAULT 'ACTIVE',
	`joined_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `family_memberships_id` PRIMARY KEY(`id`),
	CONSTRAINT `family_memberships_family_user_uq` UNIQUE(`family_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `guardian_child_permissions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`membership_id` int NOT NULL,
	`child_id` int NOT NULL,
	`can_view` boolean NOT NULL DEFAULT true,
	`can_evaluate` boolean NOT NULL DEFAULT false,
	`can_manage_rules` boolean NOT NULL DEFAULT false,
	`can_manage_coupons` boolean NOT NULL DEFAULT false,
	`can_receive_notifications` boolean NOT NULL DEFAULT true,
	`granted_by_user_id` int NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `guardian_child_permissions_id` PRIMARY KEY(`id`),
	CONSTRAINT `guardian_child_permissions_membership_child_uq` UNIQUE(`membership_id`,`child_id`)
);
--> statement-breakpoint
CREATE TABLE `guardian_invitations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`family_id` int NOT NULL,
	`email` varchar(320) NOT NULL,
	`role` enum('GUARDIAN','VIEWER') NOT NULL,
	`token_hash` varchar(128) NOT NULL,
	`status` enum('PENDING','ACCEPTED','EXPIRED','CANCELLED') NOT NULL DEFAULT 'PENDING',
	`invited_by_user_id` int NOT NULL,
	`accepted_by_user_id` int,
	`expires_at` timestamp NOT NULL,
	`accepted_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `guardian_invitations_id` PRIMARY KEY(`id`),
	CONSTRAINT `guardian_invitations_token_hash_uq` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `ledger_entries` (
	`id` int AUTO_INCREMENT NOT NULL,
	`event_id` int NOT NULL,
	`child_id` int NOT NULL,
	`asset_type` enum('TIME_MINUTE','MONEY_KRW') NOT NULL,
	`amount` int NOT NULL,
	`balance_after` int NOT NULL,
	`sequence_no` int NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ledger_entries_id` PRIMARY KEY(`id`),
	CONSTRAINT `ledger_entries_event_asset_uq` UNIQUE(`event_id`,`asset_type`),
	CONSTRAINT `ledger_entries_child_asset_sequence_uq` UNIQUE(`child_id`,`asset_type`,`sequence_no`),
	CONSTRAINT `ledger_entries_amount_nonzero_ck` CHECK(`ledger_entries`.`amount` <> 0)
);
--> statement-breakpoint
CREATE TABLE `ledger_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`child_id` int NOT NULL,
	`event_type` enum('EVALUATION','COUPON_REDEMPTION','ADJUSTMENT','MIGRATION','REVERSAL') NOT NULL,
	`idempotency_key` varchar(191) NOT NULL,
	`evaluation_id` int,
	`reversal_of_event_id` int,
	`reason_code` varchar(100) NOT NULL,
	`reason_text` text,
	`rule_snapshot` json,
	`actor_user_id` int NOT NULL,
	`effective_at` timestamp NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ledger_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `ledger_events_idempotency_uq` UNIQUE(`idempotency_key`),
	CONSTRAINT `ledger_events_evaluation_uq` UNIQUE(`evaluation_id`),
	CONSTRAINT `ledger_events_reversal_uq` UNIQUE(`reversal_of_event_id`)
);
--> statement-breakpoint
CREATE TABLE `notification_deliveries` (
	`id` int AUTO_INCREMENT NOT NULL,
	`notification_id` int NOT NULL,
	`channel` enum('IN_APP','EMAIL','SMS') NOT NULL,
	`status` enum('PENDING','SENT','FAILED','SKIPPED') NOT NULL DEFAULT 'PENDING',
	`attempt_count` int NOT NULL DEFAULT 0,
	`provider_message_id` varchar(191),
	`last_error` text,
	`sent_at` timestamp,
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `notification_deliveries_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `notification_preferences` (
	`id` int AUTO_INCREMENT NOT NULL,
	`family_id` int NOT NULL,
	`user_id` int NOT NULL,
	`in_app_enabled` boolean NOT NULL DEFAULT true,
	`email_enabled` boolean NOT NULL DEFAULT false,
	`sms_enabled` boolean NOT NULL DEFAULT false,
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `notification_preferences_id` PRIMARY KEY(`id`),
	CONSTRAINT `notification_preferences_family_user_uq` UNIQUE(`family_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` int AUTO_INCREMENT NOT NULL,
	`recipient_user_id` int NOT NULL,
	`child_id` int NOT NULL,
	`notification_type` enum('EVALUATION','PENALTY','COUPON','LOW_BALANCE','SYSTEM') NOT NULL,
	`title` varchar(160) NOT NULL,
	`body` text NOT NULL,
	`status` enum('UNREAD','READ','ARCHIVED') NOT NULL DEFAULT 'UNREAD',
	`evaluation_id` int,
	`ledger_event_id` int,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`read_at` timestamp,
	CONSTRAINT `notifications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `rubric_levels` (
	`id` int AUTO_INCREMENT NOT NULL,
	`rubric_version_id` int NOT NULL,
	`code` varchar(60) NOT NULL,
	`label` varchar(120) NOT NULL,
	`description` text,
	`outcome_type` enum('REWARD','NEUTRAL','PENALTY') NOT NULL,
	`sort_order` int NOT NULL DEFAULT 0,
	`legacy_condition_id` varchar(100),
	CONSTRAINT `rubric_levels_id` PRIMARY KEY(`id`),
	CONSTRAINT `rubric_levels_version_code_uq` UNIQUE(`rubric_version_id`,`code`)
);
--> statement-breakpoint
CREATE TABLE `rubric_versions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`rubric_id` int NOT NULL,
	`version_no` int NOT NULL,
	`status` enum('DRAFT','PUBLISHED','RETIRED') NOT NULL DEFAULT 'DRAFT',
	`valid_from` date,
	`valid_until` date,
	`created_by_user_id` int NOT NULL,
	`published_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `rubric_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `rubric_versions_rubric_version_uq` UNIQUE(`rubric_id`,`version_no`)
);
--> statement-breakpoint
CREATE TABLE `rubrics` (
	`id` int AUTO_INCREMENT NOT NULL,
	`family_id` int NOT NULL,
	`code` varchar(100) NOT NULL,
	`title` varchar(160) NOT NULL,
	`description` text,
	`status` enum('ACTIVE','ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `rubrics_id` PRIMARY KEY(`id`),
	CONSTRAINT `rubrics_family_code_uq` UNIQUE(`family_id`,`code`)
);
--> statement-breakpoint
CREATE TABLE `rule_effects` (
	`id` int AUTO_INCREMENT NOT NULL,
	`rubric_level_id` int NOT NULL,
	`asset_type` enum('TIME_MINUTE','MONEY_KRW') NOT NULL,
	`amount` int NOT NULL,
	`effect_order` int NOT NULL DEFAULT 1,
	`legacy_rule_id` varchar(100),
	CONSTRAINT `rule_effects_id` PRIMARY KEY(`id`),
	CONSTRAINT `rule_effects_level_asset_order_uq` UNIQUE(`rubric_level_id`,`asset_type`,`effect_order`),
	CONSTRAINT `rule_effects_amount_nonzero_ck` CHECK(`rule_effects`.`amount` <> 0)
);
--> statement-breakpoint
CREATE TABLE `wallet_balances` (
	`id` int AUTO_INCREMENT NOT NULL,
	`child_id` int NOT NULL,
	`asset_type` enum('TIME_MINUTE','MONEY_KRW') NOT NULL,
	`balance` int NOT NULL DEFAULT 0,
	`last_sequence_no` int NOT NULL DEFAULT 0,
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `wallet_balances_id` PRIMARY KEY(`id`),
	CONSTRAINT `wallet_balances_child_asset_uq` UNIQUE(`child_id`,`asset_type`)
);
--> statement-breakpoint
ALTER TABLE `activity_assignments` ADD CONSTRAINT `activity_assignments_child_id_children_id_fk` FOREIGN KEY (`child_id`) REFERENCES `children`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `activity_assignments` ADD CONSTRAINT `activity_assignments_activity_template_id_activity_templates_id_fk` FOREIGN KEY (`activity_template_id`) REFERENCES `activity_templates`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `activity_assignments` ADD CONSTRAINT `activity_assignments_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `activity_templates` ADD CONSTRAINT `activity_templates_family_id_families_id_fk` FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `children` ADD CONSTRAINT `children_family_id_families_id_fk` FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `concept_nodes` ADD CONSTRAINT `concept_nodes_family_id_families_id_fk` FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `concept_relations` ADD CONSTRAINT `concept_relations_family_id_families_id_fk` FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `concept_relations` ADD CONSTRAINT `concept_relations_from_concept_id_concept_nodes_id_fk` FOREIGN KEY (`from_concept_id`) REFERENCES `concept_nodes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `concept_relations` ADD CONSTRAINT `concept_relations_to_concept_id_concept_nodes_id_fk` FOREIGN KEY (`to_concept_id`) REFERENCES `concept_nodes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `coupon_issues` ADD CONSTRAINT `coupon_issues_coupon_template_id_coupon_templates_id_fk` FOREIGN KEY (`coupon_template_id`) REFERENCES `coupon_templates`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `coupon_issues` ADD CONSTRAINT `coupon_issues_child_id_children_id_fk` FOREIGN KEY (`child_id`) REFERENCES `children`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `coupon_issues` ADD CONSTRAINT `coupon_issues_issued_by_user_id_users_id_fk` FOREIGN KEY (`issued_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `coupon_issues` ADD CONSTRAINT `coupon_issues_assigned_by_user_id_users_id_fk` FOREIGN KEY (`assigned_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `coupon_redemptions` ADD CONSTRAINT `coupon_redemptions_coupon_issue_id_coupon_issues_id_fk` FOREIGN KEY (`coupon_issue_id`) REFERENCES `coupon_issues`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `coupon_redemptions` ADD CONSTRAINT `coupon_redemptions_child_id_children_id_fk` FOREIGN KEY (`child_id`) REFERENCES `children`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `coupon_redemptions` ADD CONSTRAINT `coupon_redemptions_ledger_event_id_ledger_events_id_fk` FOREIGN KEY (`ledger_event_id`) REFERENCES `ledger_events`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `coupon_redemptions` ADD CONSTRAINT `coupon_redemptions_redeemed_by_user_id_users_id_fk` FOREIGN KEY (`redeemed_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `coupon_state_transitions` ADD CONSTRAINT `coupon_state_transitions_coupon_issue_id_coupon_issues_id_fk` FOREIGN KEY (`coupon_issue_id`) REFERENCES `coupon_issues`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `coupon_state_transitions` ADD CONSTRAINT `coupon_state_transitions_actor_user_id_users_id_fk` FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `coupon_templates` ADD CONSTRAINT `coupon_templates_family_id_families_id_fk` FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `evaluations` ADD CONSTRAINT `evaluations_child_id_children_id_fk` FOREIGN KEY (`child_id`) REFERENCES `children`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `evaluations` ADD CONSTRAINT `evaluations_assignment_id_activity_assignments_id_fk` FOREIGN KEY (`assignment_id`) REFERENCES `activity_assignments`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `evaluations` ADD CONSTRAINT `evaluations_rubric_version_id_rubric_versions_id_fk` FOREIGN KEY (`rubric_version_id`) REFERENCES `rubric_versions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `evaluations` ADD CONSTRAINT `evaluations_rubric_level_id_rubric_levels_id_fk` FOREIGN KEY (`rubric_level_id`) REFERENCES `rubric_levels`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `evaluations` ADD CONSTRAINT `evaluations_evaluator_user_id_users_id_fk` FOREIGN KEY (`evaluator_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `families` ADD CONSTRAINT `families_owner_user_id_users_id_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `family_memberships` ADD CONSTRAINT `family_memberships_family_id_families_id_fk` FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `family_memberships` ADD CONSTRAINT `family_memberships_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `guardian_child_permissions` ADD CONSTRAINT `guardian_child_permissions_membership_id_family_memberships_id_fk` FOREIGN KEY (`membership_id`) REFERENCES `family_memberships`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `guardian_child_permissions` ADD CONSTRAINT `guardian_child_permissions_child_id_children_id_fk` FOREIGN KEY (`child_id`) REFERENCES `children`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `guardian_child_permissions` ADD CONSTRAINT `guardian_child_permissions_granted_by_user_id_users_id_fk` FOREIGN KEY (`granted_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `guardian_invitations` ADD CONSTRAINT `guardian_invitations_family_id_families_id_fk` FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `guardian_invitations` ADD CONSTRAINT `guardian_invitations_invited_by_user_id_users_id_fk` FOREIGN KEY (`invited_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `guardian_invitations` ADD CONSTRAINT `guardian_invitations_accepted_by_user_id_users_id_fk` FOREIGN KEY (`accepted_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ledger_entries` ADD CONSTRAINT `ledger_entries_event_id_ledger_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `ledger_events`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ledger_entries` ADD CONSTRAINT `ledger_entries_child_id_children_id_fk` FOREIGN KEY (`child_id`) REFERENCES `children`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ledger_events` ADD CONSTRAINT `ledger_events_child_id_children_id_fk` FOREIGN KEY (`child_id`) REFERENCES `children`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ledger_events` ADD CONSTRAINT `ledger_events_evaluation_id_evaluations_id_fk` FOREIGN KEY (`evaluation_id`) REFERENCES `evaluations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ledger_events` ADD CONSTRAINT `ledger_events_actor_user_id_users_id_fk` FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notification_deliveries` ADD CONSTRAINT `notification_deliveries_notification_id_notifications_id_fk` FOREIGN KEY (`notification_id`) REFERENCES `notifications`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notification_preferences` ADD CONSTRAINT `notification_preferences_family_id_families_id_fk` FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notification_preferences` ADD CONSTRAINT `notification_preferences_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_recipient_user_id_users_id_fk` FOREIGN KEY (`recipient_user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_child_id_children_id_fk` FOREIGN KEY (`child_id`) REFERENCES `children`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_evaluation_id_evaluations_id_fk` FOREIGN KEY (`evaluation_id`) REFERENCES `evaluations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_ledger_event_id_ledger_events_id_fk` FOREIGN KEY (`ledger_event_id`) REFERENCES `ledger_events`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rubric_levels` ADD CONSTRAINT `rubric_levels_rubric_version_id_rubric_versions_id_fk` FOREIGN KEY (`rubric_version_id`) REFERENCES `rubric_versions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rubric_versions` ADD CONSTRAINT `rubric_versions_rubric_id_rubrics_id_fk` FOREIGN KEY (`rubric_id`) REFERENCES `rubrics`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rubric_versions` ADD CONSTRAINT `rubric_versions_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rubrics` ADD CONSTRAINT `rubrics_family_id_families_id_fk` FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rule_effects` ADD CONSTRAINT `rule_effects_rubric_level_id_rubric_levels_id_fk` FOREIGN KEY (`rubric_level_id`) REFERENCES `rubric_levels`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `wallet_balances` ADD CONSTRAINT `wallet_balances_child_id_children_id_fk` FOREIGN KEY (`child_id`) REFERENCES `children`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `activity_assignments_child_date_idx` ON `activity_assignments` (`child_id`,`scheduled_date`);--> statement-breakpoint
CREATE INDEX `children_family_idx` ON `children` (`family_id`);--> statement-breakpoint
CREATE INDEX `coupon_issues_child_status_idx` ON `coupon_issues` (`child_id`,`status`);--> statement-breakpoint
CREATE INDEX `coupon_state_transitions_issue_idx` ON `coupon_state_transitions` (`coupon_issue_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `evaluations_child_evaluated_idx` ON `evaluations` (`child_id`,`evaluated_at`);--> statement-breakpoint
CREATE INDEX `families_owner_idx` ON `families` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `family_memberships_user_idx` ON `family_memberships` (`user_id`);--> statement-breakpoint
CREATE INDEX `guardian_child_permissions_child_idx` ON `guardian_child_permissions` (`child_id`);--> statement-breakpoint
CREATE INDEX `guardian_invitations_family_status_idx` ON `guardian_invitations` (`family_id`,`status`);--> statement-breakpoint
CREATE INDEX `ledger_entries_child_asset_idx` ON `ledger_entries` (`child_id`,`asset_type`);--> statement-breakpoint
CREATE INDEX `ledger_events_child_effective_idx` ON `ledger_events` (`child_id`,`effective_at`);--> statement-breakpoint
CREATE INDEX `notification_deliveries_status_idx` ON `notification_deliveries` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `notifications_recipient_status_idx` ON `notifications` (`recipient_user_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `rubric_levels_outcome_idx` ON `rubric_levels` (`outcome_type`);