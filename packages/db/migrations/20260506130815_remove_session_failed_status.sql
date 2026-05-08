-- Disable the enforcement of foreign-keys constraints
PRAGMA foreign_keys = off;
-- Create "new_sessions" table
CREATE TABLE `new_sessions` (`id` text NOT NULL, `workspace_id` text NOT NULL, `title` text NOT NULL, `goal_text` text NOT NULL, `status` text NOT NULL DEFAULT ('planning'), `current_plan_id` text NULL, `current_task_id` text NULL, `last_error_text` text NULL, `last_checkpoint_json` text NULL, `created_at` text NOT NULL, `updated_at` text NOT NULL, `archived_at` text NULL, PRIMARY KEY (`id`), CONSTRAINT `sessions_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE, CONSTRAINT `sessions_valid_status` CHECK (status IN ('planning', 'idle', 'executing', 'waiting_approval', 'blocked', 'completed', 'archived')));
-- Copy rows from old table "sessions" to new temporary table "new_sessions"
INSERT INTO `new_sessions` (`id`, `workspace_id`, `title`, `goal_text`, `status`, `current_plan_id`, `current_task_id`, `last_error_text`, `last_checkpoint_json`, `created_at`, `updated_at`, `archived_at`) SELECT `id`, `workspace_id`, `title`, `goal_text`, `status`, `current_plan_id`, `current_task_id`, `last_error_text`, `last_checkpoint_json`, `created_at`, `updated_at`, `archived_at` FROM `sessions`;
-- Drop "sessions" table after copying rows
DROP TABLE `sessions`;
-- Rename temporary table "new_sessions" to "sessions"
ALTER TABLE `new_sessions` RENAME TO `sessions`;
-- Create index "idx_sessions_workspace_updated_at" to table: "sessions"
CREATE INDEX `idx_sessions_workspace_updated_at` ON `sessions` (`workspace_id`, `updated_at`);
-- Create index "idx_sessions_status" to table: "sessions"
CREATE INDEX `idx_sessions_status` ON `sessions` (`status`);
-- Enable back the enforcement of foreign-keys constraints
PRAGMA foreign_keys = on;
