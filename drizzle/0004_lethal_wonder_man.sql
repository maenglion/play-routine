ALTER TABLE `evaluations` ADD `idempotency_key` varchar(191) NOT NULL;--> statement-breakpoint
ALTER TABLE `evaluations` ADD CONSTRAINT `evaluations_idempotency_uq` UNIQUE(`idempotency_key`);