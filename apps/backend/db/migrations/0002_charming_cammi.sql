CREATE TABLE `code_references` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`file_path` text NOT NULL,
	`line` integer NOT NULL,
	`column` integer DEFAULT 0 NOT NULL,
	`kind` text NOT NULL,
	FOREIGN KEY (`symbol_id`) REFERENCES `code_symbols`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `code_references_symbol_id_idx` ON `code_references` (`symbol_id`);--> statement-breakpoint
CREATE INDEX `code_references_resource_id_idx` ON `code_references` (`resource_id`);--> statement-breakpoint
CREATE INDEX `code_references_file_path_idx` ON `code_references` (`file_path`);--> statement-breakpoint
CREATE TABLE `code_symbols` (
	`id` text PRIMARY KEY NOT NULL,
	`resource_id` text NOT NULL,
	`file_path` text NOT NULL,
	`language` text NOT NULL,
	`symbol_type` text NOT NULL,
	`name` text NOT NULL,
	`is_exported` integer DEFAULT false NOT NULL,
	`line_start` integer NOT NULL,
	`line_end` integer NOT NULL,
	`signature` text,
	`content_hash` text NOT NULL,
	FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `code_symbols_resource_id_idx` ON `code_symbols` (`resource_id`);--> statement-breakpoint
CREATE INDEX `code_symbols_name_idx` ON `code_symbols` (`name`);--> statement-breakpoint
CREATE INDEX `code_symbols_file_path_idx` ON `code_symbols` (`file_path`);