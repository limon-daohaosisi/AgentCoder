-- Disable the enforcement of foreign-keys constraints
PRAGMA foreign_keys = off;
-- Create "new_sessions" table
CREATE TABLE `new_sessions` (`id` text NOT NULL, `workspace_id` text NOT NULL, `title` text NOT NULL, `goal_text` text NOT NULL, `kind` text NOT NULL DEFAULT ('primary'), `parent_session_id` text NULL, `parent_tool_call_id` text NULL, `subagent_type` text NULL, `default_variant` text NOT NULL DEFAULT ('plan'), `status` text NOT NULL DEFAULT ('planning'), `current_plan_id` text NULL, `current_task_id` text NULL, `last_error_text` text NULL, `last_checkpoint_json` text NULL, `revert_json` text NULL, `created_at` text NOT NULL, `updated_at` text NOT NULL, `archived_at` text NULL, PRIMARY KEY (`id`), CONSTRAINT `sessions_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE, CONSTRAINT `sessions_parent_session_id_fkey` FOREIGN KEY (`parent_session_id`) REFERENCES `sessions` (`id`) ON DELETE SET NULL, CONSTRAINT `sessions_valid_status` CHECK (status IN ('planning', 'idle', 'executing', 'waiting_approval', 'blocked', 'completed', 'archived')), CONSTRAINT `sessions_valid_kind` CHECK (kind IN ('primary', 'subagent')), CONSTRAINT `sessions_valid_default_variant` CHECK (default_variant IN ('plan', 'build')), CONSTRAINT `sessions_valid_subagent_type` CHECK (subagent_type IS NULL OR subagent_type IN ('explore')));
-- Copy rows from old table "sessions" to new temporary table "new_sessions"
INSERT INTO `new_sessions` (`id`, `workspace_id`, `title`, `goal_text`, `default_variant`, `status`, `current_plan_id`, `current_task_id`, `last_error_text`, `last_checkpoint_json`, `revert_json`, `created_at`, `updated_at`, `archived_at`) SELECT `id`, `workspace_id`, `title`, `goal_text`, `default_variant`, `status`, `current_plan_id`, `current_task_id`, `last_error_text`, `last_checkpoint_json`, `revert_json`, `created_at`, `updated_at`, `archived_at` FROM `sessions`;
-- Drop "sessions" table after copying rows
DROP TABLE `sessions`;
-- Rename temporary table "new_sessions" to "sessions"
ALTER TABLE `new_sessions` RENAME TO `sessions`;
-- Create index "idx_sessions_workspace_updated_at" to table: "sessions"
CREATE INDEX `idx_sessions_workspace_updated_at` ON `sessions` (`workspace_id`, `updated_at`);
-- Create index "idx_sessions_status" to table: "sessions"
CREATE INDEX `idx_sessions_status` ON `sessions` (`status`);
-- Create index "idx_sessions_parent_session" to table: "sessions"
CREATE INDEX `idx_sessions_parent_session` ON `sessions` (`parent_session_id`);
-- Create "new_tool_calls" table
CREATE TABLE `new_tool_calls` (`id` text NOT NULL, `session_id` text NOT NULL, `task_id` text NULL, `run_id` text NULL, `message_id` text NULL, `message_part_id` text NULL, `model_tool_call_id` text NULL, `batch_json` text NULL, `provider_metadata_json` text NULL, `tool_name` text NOT NULL, `input_json` text NOT NULL, `status` text NOT NULL, `requires_approval` integer NOT NULL DEFAULT 0, `result_json` text NULL, `error_text` text NULL, `started_at` text NULL, `completed_at` text NULL, `created_at` text NOT NULL, `updated_at` text NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `tool_calls_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON DELETE CASCADE, CONSTRAINT `tool_calls_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `tasks` (`id`) ON DELETE SET NULL, CONSTRAINT `tool_calls_run_id_fkey` FOREIGN KEY (`run_id`) REFERENCES `agent_runs` (`id`) ON DELETE SET NULL, CONSTRAINT `tool_calls_message_id_fkey` FOREIGN KEY (`message_id`) REFERENCES `messages` (`id`) ON DELETE SET NULL, CONSTRAINT `tool_calls_message_part_id_fkey` FOREIGN KEY (`message_part_id`) REFERENCES `message_parts` (`id`) ON DELETE SET NULL, CONSTRAINT `tool_calls_valid_tool_name` CHECK (tool_name IN ('agent', 'batch', 'read', 'glob', 'grep', 'task_create', 'task_list', 'task_get', 'task_update', 'task_stop', 'apply_patch', 'bash', 'write', 'edit', 'plan_exit')), CONSTRAINT `tool_calls_valid_status` CHECK (status IN ('pending', 'pending_approval', 'approved', 'rejected', 'running', 'completed', 'failed')), CONSTRAINT `tool_calls_valid_requires_approval` CHECK (requires_approval IN (0, 1)));
-- Copy rows from old table "tool_calls" to new temporary table "new_tool_calls"
INSERT INTO `new_tool_calls` (`id`, `session_id`, `task_id`, `run_id`, `message_id`, `message_part_id`, `model_tool_call_id`, `batch_json`, `provider_metadata_json`, `tool_name`, `input_json`, `status`, `requires_approval`, `result_json`, `error_text`, `started_at`, `completed_at`, `created_at`, `updated_at`) SELECT `id`, `session_id`, `task_id`, `run_id`, `message_id`, `message_part_id`, `model_tool_call_id`, `batch_json`, `provider_metadata_json`, `tool_name`, `input_json`, `status`, `requires_approval`, `result_json`, `error_text`, `started_at`, `completed_at`, `created_at`, `updated_at` FROM `tool_calls`;
-- Drop "tool_calls" table after copying rows
DROP TABLE `tool_calls`;
-- Rename temporary table "new_tool_calls" to "tool_calls"
ALTER TABLE `new_tool_calls` RENAME TO `tool_calls`;
-- Create index "idx_tool_calls_session_created_at" to table: "tool_calls"
CREATE INDEX `idx_tool_calls_session_created_at` ON `tool_calls` (`session_id`, `created_at`);
-- Create index "idx_tool_calls_task_status" to table: "tool_calls"
CREATE INDEX `idx_tool_calls_task_status` ON `tool_calls` (`task_id`, `status`);
-- Create index "idx_tool_calls_message_part_id" to table: "tool_calls"
CREATE INDEX `idx_tool_calls_message_part_id` ON `tool_calls` (`message_part_id`);
-- Create index "idx_tool_calls_run_status" to table: "tool_calls"
CREATE INDEX `idx_tool_calls_run_status` ON `tool_calls` (`run_id`, `status`);
-- Enable back the enforcement of foreign-keys constraints
PRAGMA foreign_keys = on;
