CREATE TABLE `activity_rubrics` (
	`id` int AUTO_INCREMENT NOT NULL,
	`activity_template_id` int NOT NULL,
	`rubric_id` int NOT NULL,
	`is_required` boolean NOT NULL DEFAULT true,
	`sort_order` int NOT NULL DEFAULT 0,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `activity_rubrics_id` PRIMARY KEY(`id`),
	CONSTRAINT `activity_rubrics_template_rubric_uq` UNIQUE(`activity_template_id`,`rubric_id`)
);
--> statement-breakpoint
ALTER TABLE `activity_rubrics` ADD CONSTRAINT `activity_rubrics_activity_template_id_activity_templates_id_fk` FOREIGN KEY (`activity_template_id`) REFERENCES `activity_templates`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `activity_rubrics` ADD CONSTRAINT `activity_rubrics_rubric_id_rubrics_id_fk` FOREIGN KEY (`rubric_id`) REFERENCES `rubrics`(`id`) ON DELETE cascade ON UPDATE no action;