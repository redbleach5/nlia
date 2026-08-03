CREATE TABLE `agent_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`episode_id` text NOT NULL,
	`goal` text NOT NULL,
	`template_name` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`tools_whitelist` text,
	`fs_scope` text,
	`max_steps` integer DEFAULT 25 NOT NULL,
	`max_duration_sec` integer DEFAULT 3600 NOT NULL,
	`current_step` integer DEFAULT 0 NOT NULL,
	`events_json` text DEFAULT '[]' NOT NULL,
	`decision_ids_json` text DEFAULT '[]' NOT NULL,
	`result_summary` text,
	`error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_tasks_episode_id_idx` ON `agent_tasks` (`episode_id`);--> statement-breakpoint
CREATE INDEX `agent_tasks_status_idx` ON `agent_tasks` (`status`);