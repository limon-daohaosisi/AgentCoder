-- Disable the enforcement of foreign-keys constraints
PRAGMA foreign_keys = off;
-- Create "new_approvals" table
CREATE TABLE `new_approvals` (`id` text NOT NULL, `session_id` text NOT NULL, `task_id` text NULL, `run_id` text NULL, `tool_call_id` text NOT NULL, `kind` text NOT NULL, `status` text NOT NULL DEFAULT ('pending'), `decision_scope` text NOT NULL DEFAULT ('once'), `payload_json` text NOT NULL, `suggested_rule_json` text NULL, `decided_by` text NULL, `decision_reason_text` text NULL, `created_at` text NOT NULL, `decided_at` text NULL, PRIMARY KEY (`id`), CONSTRAINT `approvals_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON DELETE CASCADE, CONSTRAINT `approvals_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `tasks` (`id`) ON DELETE SET NULL, CONSTRAINT `approvals_run_id_fkey` FOREIGN KEY (`run_id`) REFERENCES `agent_runs` (`id`) ON DELETE SET NULL, CONSTRAINT `approvals_tool_call_id_fkey` FOREIGN KEY (`tool_call_id`) REFERENCES `tool_calls` (`id`) ON DELETE CASCADE, CONSTRAINT `approvals_valid_kind` CHECK (kind IN ('apply_patch', 'bash', 'write', 'edit')), CONSTRAINT `approvals_valid_status` CHECK (status IN ('pending', 'approved', 'rejected')), CONSTRAINT `approvals_valid_decision_scope` CHECK (decision_scope IN ('once', 'session_rule')));
-- Copy rows from old table "approvals" to new temporary table "new_approvals"
INSERT INTO `new_approvals` (`id`, `session_id`, `task_id`, `run_id`, `tool_call_id`, `kind`, `status`, `decision_scope`, `payload_json`, `suggested_rule_json`, `decided_by`, `decision_reason_text`, `created_at`, `decided_at`) SELECT `id`, `session_id`, `task_id`, `run_id`, `tool_call_id`, `kind`, `status`, `decision_scope`, `payload_json`, `suggested_rule_json`, `decided_by`, `decision_reason_text`, `created_at`, `decided_at` FROM `approvals`;
-- Drop "approvals" table after copying rows
DROP TABLE `approvals`;
-- Rename temporary table "new_approvals" to "approvals"
ALTER TABLE `new_approvals` RENAME TO `approvals`;
-- Create index "idx_approvals_session_status_created_at" to table: "approvals"
CREATE INDEX `idx_approvals_session_status_created_at` ON `approvals` (`session_id`, `status`, `created_at`);
-- Create index "idx_approvals_tool_call_id" to table: "approvals"
CREATE INDEX `idx_approvals_tool_call_id` ON `approvals` (`tool_call_id`);
-- Create index "idx_approvals_run_status" to table: "approvals"
CREATE INDEX `idx_approvals_run_status` ON `approvals` (`run_id`, `status`);
-- Create "new_tool_calls" table
CREATE TABLE `new_tool_calls` (`id` text NOT NULL, `session_id` text NOT NULL, `task_id` text NULL, `run_id` text NULL, `message_id` text NULL, `message_part_id` text NULL, `model_tool_call_id` text NULL, `provider_metadata_json` text NULL, `tool_name` text NOT NULL, `input_json` text NOT NULL, `status` text NOT NULL, `requires_approval` integer NOT NULL DEFAULT 0, `result_json` text NULL, `error_text` text NULL, `started_at` text NULL, `completed_at` text NULL, `created_at` text NOT NULL, `updated_at` text NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `tool_calls_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON DELETE CASCADE, CONSTRAINT `tool_calls_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `tasks` (`id`) ON DELETE SET NULL, CONSTRAINT `tool_calls_run_id_fkey` FOREIGN KEY (`run_id`) REFERENCES `agent_runs` (`id`) ON DELETE SET NULL, CONSTRAINT `tool_calls_message_id_fkey` FOREIGN KEY (`message_id`) REFERENCES `messages` (`id`) ON DELETE SET NULL, CONSTRAINT `tool_calls_message_part_id_fkey` FOREIGN KEY (`message_part_id`) REFERENCES `message_parts` (`id`) ON DELETE SET NULL, CONSTRAINT `tool_calls_valid_tool_name` CHECK (tool_name IN ('read', 'glob', 'grep', 'apply_patch', 'bash', 'write', 'edit')), CONSTRAINT `tool_calls_valid_status` CHECK (status IN ('pending', 'pending_approval', 'approved', 'rejected', 'running', 'completed', 'failed')), CONSTRAINT `tool_calls_valid_requires_approval` CHECK (requires_approval IN (0, 1)));
-- Copy rows from old table "tool_calls" to new temporary table "new_tool_calls"
INSERT INTO `new_tool_calls` (`id`, `session_id`, `task_id`, `run_id`, `message_id`, `message_part_id`, `model_tool_call_id`, `provider_metadata_json`, `tool_name`, `input_json`, `status`, `requires_approval`, `result_json`, `error_text`, `started_at`, `completed_at`, `created_at`, `updated_at`) SELECT `id`, `session_id`, `task_id`, `run_id`, `message_id`, `message_part_id`, `model_tool_call_id`, `provider_metadata_json`, `tool_name`, `input_json`, `status`, `requires_approval`, `result_json`, `error_text`, `started_at`, `completed_at`, `created_at`, `updated_at` FROM `tool_calls`;
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
