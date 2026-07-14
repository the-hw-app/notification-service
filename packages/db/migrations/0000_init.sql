CREATE TABLE `channel_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`credentials` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_credentials_channel_idx` ON `channel_credentials` (`channel`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`distinct_id` text NOT NULL,
	`channel` text NOT NULL,
	`token` text NOT NULL,
	`subscription` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_seen_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_token_unique` ON `devices` (`token`);--> statement-breakpoint
CREATE INDEX `devices_distinct_id_idx` ON `devices` (`distinct_id`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`trigger_events` text DEFAULT '[]' NOT NULL,
	`conditions` text DEFAULT '[]' NOT NULL,
	`payload` text NOT NULL,
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
CREATE INDEX `notifications_status_idx` ON `notifications` (`status`);--> statement-breakpoint
CREATE TABLE `sends` (
	`id` text PRIMARY KEY NOT NULL,
	`notification_id` text NOT NULL,
	`distinct_id` text NOT NULL,
	`device_id` text,
	`channel` text,
	`status` text NOT NULL,
	`error_code` text,
	`error_message` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sends_notification_idx` ON `sends` (`notification_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `sends_created_idx` ON `sends` (`created_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`distinct_id` text NOT NULL,
	`properties` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_distinct_id_unique` ON `users` (`distinct_id`);