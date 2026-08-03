CREATE TABLE `chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`resource_id` text NOT NULL,
	`content` text NOT NULL,
	`content_hash` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`parent_id` text,
	`position` integer DEFAULT 0 NOT NULL,
	`embedding` blob,
	`vec_rowid` integer,
	`indexed_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chunks_resource_id_idx` ON `chunks` (`resource_id`);--> statement-breakpoint
CREATE INDEX `chunks_content_hash_idx` ON `chunks` (`content_hash`);--> statement-breakpoint
CREATE INDEX `chunks_parent_id_idx` ON `chunks` (`parent_id`);--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text,
	`episode_id` text NOT NULL,
	`ts` integer DEFAULT (unixepoch()) NOT NULL,
	`situation` text NOT NULL,
	`options` text NOT NULL,
	`chosen` text NOT NULL,
	`rationale` text NOT NULL,
	`outcome` text,
	`model_role` text NOT NULL,
	FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `decisions_episode_id_idx` ON `decisions` (`episode_id`);--> statement-breakpoint
CREATE INDEX `decisions_task_id_idx` ON `decisions` (`task_id`);--> statement-breakpoint
CREATE INDEX `decisions_ts_idx` ON `decisions` (`ts`);--> statement-breakpoint
CREATE TABLE `emotional_memories` (
	`id` text PRIMARY KEY NOT NULL,
	`episode_id` text NOT NULL,
	`emotion` text NOT NULL,
	`intensity` real DEFAULT 0.5 NOT NULL,
	`trigger` text NOT NULL,
	`context` text NOT NULL,
	`emotion_vector_json` text,
	`embedding` blob,
	`consolidated` integer DEFAULT false NOT NULL,
	`source_ids` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `emotional_memories_episode_id_idx` ON `emotional_memories` (`episode_id`);--> statement-breakpoint
CREATE INDEX `emotional_memories_emotion_idx` ON `emotional_memories` (`emotion`);--> statement-breakpoint
CREATE INDEX `emotional_memories_intensity_idx` ON `emotional_memories` (`intensity`);--> statement-breakpoint
CREATE TABLE `episode_facts` (
	`id` text PRIMARY KEY NOT NULL,
	`episode_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `episode_facts_episode_key_uniq` ON `episode_facts` (`episode_id`,`key`);--> statement-breakpoint
CREATE INDEX `episode_facts_episode_id_idx` ON `episode_facts` (`episode_id`);--> statement-breakpoint
CREATE TABLE `episodes` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`mode` text DEFAULT 'chat' NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`summary` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`ended_at` integer,
	`last_message_at` integer
);
--> statement-breakpoint
CREATE INDEX `episodes_updated_at_idx` ON `episodes` (`updated_at`);--> statement-breakpoint
CREATE INDEX `episodes_is_default_idx` ON `episodes` (`is_default`);--> statement-breakpoint
CREATE TABLE `global_facts` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`confidence` real DEFAULT 0.6 NOT NULL,
	`hit_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`episode_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`attachments_json` text,
	`emotion_json` text,
	`tool_calls_json` text,
	`tokens_in` integer,
	`tokens_out` integer,
	`duration_ms` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_episode_id_idx` ON `messages` (`episode_id`);--> statement-breakpoint
CREATE INDEX `messages_created_at_idx` ON `messages` (`created_at`);--> statement-breakpoint
CREATE INDEX `messages_episode_created_idx` ON `messages` (`episode_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `resources` (
	`id` text PRIMARY KEY NOT NULL,
	`episode_id` text,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`config` text NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`chunk_count` integer DEFAULT 0 NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`error_message` text,
	`content_hash` text,
	`byte_size` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_indexed_at` integer,
	FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `resources_episode_id_idx` ON `resources` (`episode_id`);--> statement-breakpoint
CREATE INDEX `resources_kind_idx` ON `resources` (`kind`);--> statement-breakpoint
CREATE INDEX `resources_status_idx` ON `resources` (`status`);--> statement-breakpoint
CREATE TABLE `schema_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vector_memory` (
	`id` text PRIMARY KEY NOT NULL,
	`episode_id` text NOT NULL,
	`source_type` text NOT NULL,
	`text` text NOT NULL,
	`embedding` blob NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `vector_memory_episode_id_idx` ON `vector_memory` (`episode_id`);--> statement-breakpoint
CREATE INDEX `vector_memory_source_type_idx` ON `vector_memory` (`source_type`);