-- Adds custom-function support to notifications: the `authoring_mode` and
-- `function_source` columns, and makes `payload` nullable (a function-mode
-- notification builds its payload in the sandbox and stores no template).
--
-- SQLite can't drop a NOT NULL constraint in place, so this recreates the
-- table. The INSERT deliberately omits `authoring_mode` and `function_source`
-- (they don't exist on the old table) so every existing row takes their
-- defaults: `authoring_mode = 'builder'`, `function_source = NULL`.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`trigger_events` text DEFAULT '[]' NOT NULL,
	`authoring_mode` text DEFAULT 'builder' NOT NULL,
	`conditions` text DEFAULT '[]' NOT NULL,
	`function_source` text,
	`payload` text,
	`channels` text DEFAULT '[]' NOT NULL,
	`channel_overrides` text DEFAULT '{}' NOT NULL,
	`matched_count` integer DEFAULT 0 NOT NULL,
	`enqueued_count` integer DEFAULT 0 NOT NULL,
	`sent_count` integer DEFAULT 0 NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`skipped_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_notifications`("id", "name", "status", "trigger_events", "conditions", "payload", "channels", "channel_overrides", "matched_count", "enqueued_count", "sent_count", "failed_count", "skipped_count", "created_at", "updated_at") SELECT "id", "name", "status", "trigger_events", "conditions", "payload", "channels", "channel_overrides", "matched_count", "enqueued_count", "sent_count", "failed_count", "skipped_count", "created_at", "updated_at" FROM `notifications`;--> statement-breakpoint
DROP TABLE `notifications`;--> statement-breakpoint
ALTER TABLE `__new_notifications` RENAME TO `notifications`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `notifications_status_idx` ON `notifications` (`status`);
