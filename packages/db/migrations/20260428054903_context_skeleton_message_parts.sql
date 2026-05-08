-- Disable the enforcement of foreign-keys constraints
PRAGMA foreign_keys = off;
-- Create "new_messages" table
CREATE TABLE `new_messages` (`id` text NOT NULL, `session_id` text NOT NULL, `task_id` text NULL, `role` text NOT NULL, `kind` text NOT NULL DEFAULT ('message'), `parent_message_id` text NULL, `agent_name` text NULL, `model_provider_id` text NULL, `model_id` text NULL, `status` text NOT NULL DEFAULT ('completed'), `finish_reason` text NULL, `error_text` text NULL, `summary` integer NOT NULL DEFAULT 0, `compacted_by_message_id` text NULL, `model_response_id` text NULL, `provider_metadata_json` text NULL, `token_usage_json` text NULL, `runtime_json` text NULL, `content_json` text NOT NULL, `created_at` text NOT NULL, `updated_at` text NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `messages_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON DELETE CASCADE, CONSTRAINT `messages_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `tasks` (`id`) ON DELETE SET NULL, CONSTRAINT `messages_valid_role` CHECK (role IN ('user', 'assistant')), CONSTRAINT `messages_valid_status` CHECK (status IN ('running', 'completed', 'failed', 'cancelled')));
-- Copy rows from old table "messages" to new temporary table "new_messages"
INSERT INTO `new_messages` (`id`, `session_id`, `task_id`, `role`, `kind`, `content_json`, `created_at`, `updated_at`) SELECT `id`, `session_id`, `task_id`, `role`, `kind`, `content_json`, `created_at`, `created_at` FROM `messages`;
-- Drop "messages" table after copying rows
DROP TABLE `messages`;
-- Rename temporary table "new_messages" to "messages"
ALTER TABLE `new_messages` RENAME TO `messages`;
-- Create index "idx_messages_session_created_at" to table: "messages"
CREATE INDEX `idx_messages_session_created_at` ON `messages` (`session_id`, `created_at`);
-- Create index "idx_messages_task_created_at" to table: "messages"
CREATE INDEX `idx_messages_task_created_at` ON `messages` (`task_id`, `created_at`);
-- Create "new_tool_calls" table
CREATE TABLE `new_tool_calls` (`id` text NOT NULL, `session_id` text NOT NULL, `task_id` text NULL, `message_id` text NULL, `message_part_id` text NULL, `model_tool_call_id` text NULL, `provider_metadata_json` text NULL, `tool_name` text NOT NULL, `input_json` text NOT NULL, `status` text NOT NULL, `requires_approval` integer NOT NULL DEFAULT 0, `result_json` text NULL, `error_text` text NULL, `started_at` text NULL, `completed_at` text NULL, `created_at` text NOT NULL, `updated_at` text NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `tool_calls_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON DELETE CASCADE, CONSTRAINT `tool_calls_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `tasks` (`id`) ON DELETE SET NULL, CONSTRAINT `tool_calls_message_id_fkey` FOREIGN KEY (`message_id`) REFERENCES `messages` (`id`) ON DELETE SET NULL, CONSTRAINT `tool_calls_message_part_id_fkey` FOREIGN KEY (`message_part_id`) REFERENCES `message_parts` (`id`) ON DELETE SET NULL, CONSTRAINT `tool_calls_valid_tool_name` CHECK (tool_name IN ('read_file', 'write_file', 'run_command')), CONSTRAINT `tool_calls_valid_status` CHECK (status IN ('pending', 'pending_approval', 'approved', 'rejected', 'running', 'completed', 'failed')), CONSTRAINT `tool_calls_valid_requires_approval` CHECK (requires_approval IN (0, 1)));
-- Copy rows from old table "tool_calls" to new temporary table "new_tool_calls"
INSERT INTO `new_tool_calls` (`id`, `session_id`, `task_id`, `message_id`, `tool_name`, `input_json`, `status`, `requires_approval`, `result_json`, `error_text`, `started_at`, `completed_at`, `created_at`, `updated_at`) SELECT `id`, `session_id`, `task_id`, `message_id`, `tool_name`, `input_json`, `status`, `requires_approval`, `result_json`, `error_text`, `started_at`, `completed_at`, `created_at`, `updated_at` FROM `tool_calls`;
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
-- Create "message_parts" table
CREATE TABLE `message_parts` (`id` text NOT NULL, `session_id` text NOT NULL, `message_id` text NOT NULL, `type` text NOT NULL, `order_index` integer NOT NULL, `data_json` text NOT NULL, `created_at` text NOT NULL, `updated_at` text NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `message_parts_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON DELETE CASCADE, CONSTRAINT `message_parts_message_id_fkey` FOREIGN KEY (`message_id`) REFERENCES `messages` (`id`) ON DELETE CASCADE);
-- Create index "idx_message_parts_message_order" to table: "message_parts"
CREATE INDEX `idx_message_parts_message_order` ON `message_parts` (`message_id`, `order_index`, `id`);
-- Create index "idx_message_parts_session_created" to table: "message_parts"
CREATE INDEX `idx_message_parts_session_created` ON `message_parts` (`session_id`, `created_at`, `id`);
-- Enable back the enforcement of foreign-keys constraints
PRAGMA foreign_keys = on;
