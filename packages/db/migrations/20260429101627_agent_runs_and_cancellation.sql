-- Disable the enforcement of foreign-keys constraints
PRAGMA foreign_keys = off;
-- Create "new_approvals" table
CREATE TABLE `new_approvals` (`id` text NOT NULL, `session_id` text NOT NULL, `task_id` text NULL, `run_id` text NULL, `tool_call_id` text NOT NULL, `kind` text NOT NULL, `status` text NOT NULL DEFAULT ('pending'), `decision_scope` text NOT NULL DEFAULT ('once'), `payload_json` text NOT NULL, `suggested_rule_json` text NULL, `decided_by` text NULL, `decision_reason_text` text NULL, `created_at` text NOT NULL, `decided_at` text NULL, PRIMARY KEY (`id`), CONSTRAINT `approvals_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON DELETE CASCADE, CONSTRAINT `approvals_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `tasks` (`id`) ON DELETE SET NULL, CONSTRAINT `approvals_run_id_fkey` FOREIGN KEY (`run_id`) REFERENCES `agent_runs` (`id`) ON DELETE SET NULL, CONSTRAINT `approvals_tool_call_id_fkey` FOREIGN KEY (`tool_call_id`) REFERENCES `tool_calls` (`id`) ON DELETE CASCADE, CONSTRAINT `approvals_valid_kind` CHECK (kind IN ('write_file', 'run_command')), CONSTRAINT `approvals_valid_status` CHECK (status IN ('pending', 'approved', 'rejected')), CONSTRAINT `approvals_valid_decision_scope` CHECK (decision_scope IN ('once', 'session_rule')));
-- Copy rows from old table "approvals" to new temporary table "new_approvals"
INSERT INTO `new_approvals` (`id`, `session_id`, `task_id`, `tool_call_id`, `kind`, `status`, `decision_scope`, `payload_json`, `suggested_rule_json`, `decided_by`, `decision_reason_text`, `created_at`, `decided_at`) SELECT `id`, `session_id`, `task_id`, `tool_call_id`, `kind`, `status`, `decision_scope`, `payload_json`, `suggested_rule_json`, `decided_by`, `decision_reason_text`, `created_at`, `decided_at` FROM `approvals`;
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
-- Create "new_session_events" table
CREATE TABLE `new_session_events` (`id` text NOT NULL, `session_id` text NOT NULL, `task_id` text NULL, `run_id` text NULL, `sequence_no` integer NOT NULL, `type` text NOT NULL, `level` text NOT NULL DEFAULT ('info'), `entity_type` text NULL, `entity_id` text NULL, `headline` text NULL, `detail_text` text NULL, `payload_json` text NOT NULL DEFAULT ('{}'), `created_at` text NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `session_events_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON DELETE CASCADE, CONSTRAINT `session_events_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `tasks` (`id`) ON DELETE SET NULL, CONSTRAINT `session_events_run_id_fkey` FOREIGN KEY (`run_id`) REFERENCES `agent_runs` (`id`) ON DELETE SET NULL, CONSTRAINT `session_events_valid_level` CHECK (level IN ('debug', 'info', 'warning', 'error')));
-- Copy rows from old table "session_events" to new temporary table "new_session_events"
INSERT INTO `new_session_events` (`id`, `session_id`, `task_id`, `sequence_no`, `type`, `level`, `entity_type`, `entity_id`, `headline`, `detail_text`, `payload_json`, `created_at`) SELECT `id`, `session_id`, `task_id`, `sequence_no`, `type`, `level`, `entity_type`, `entity_id`, `headline`, `detail_text`, `payload_json`, `created_at` FROM `session_events`;
-- Drop "session_events" table after copying rows
DROP TABLE `session_events`;
-- Rename temporary table "new_session_events" to "session_events"
ALTER TABLE `new_session_events` RENAME TO `session_events`;
-- Create index "session_events_session_sequence_idx" to table: "session_events"
CREATE UNIQUE INDEX `session_events_session_sequence_idx` ON `session_events` (`session_id`, `sequence_no`);
-- Create index "idx_session_events_session_sequence" to table: "session_events"
CREATE INDEX `idx_session_events_session_sequence` ON `session_events` (`session_id`, `sequence_no`);
-- Create index "idx_session_events_task_sequence" to table: "session_events"
CREATE INDEX `idx_session_events_task_sequence` ON `session_events` (`task_id`, `sequence_no`);
-- Create index "idx_session_events_run_sequence" to table: "session_events"
CREATE INDEX `idx_session_events_run_sequence` ON `session_events` (`run_id`, `sequence_no`);
-- Create "new_sessions" table
CREATE TABLE `new_sessions` (`id` text NOT NULL, `workspace_id` text NOT NULL, `title` text NOT NULL, `goal_text` text NOT NULL, `status` text NOT NULL DEFAULT ('planning'), `current_plan_id` text NULL, `current_task_id` text NULL, `last_error_text` text NULL, `last_checkpoint_json` text NULL, `created_at` text NOT NULL, `updated_at` text NOT NULL, `archived_at` text NULL, PRIMARY KEY (`id`), CONSTRAINT `sessions_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE, CONSTRAINT `sessions_valid_status` CHECK (status IN ('planning', 'idle', 'executing', 'waiting_approval', 'blocked', 'failed', 'completed', 'archived')));
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
-- Create "new_messages" table
CREATE TABLE `new_messages` (`id` text NOT NULL, `session_id` text NOT NULL, `task_id` text NULL, `run_id` text NULL, `role` text NOT NULL, `kind` text NOT NULL DEFAULT ('message'), `parent_message_id` text NULL, `agent_name` text NULL, `model_provider_id` text NULL, `model_id` text NULL, `status` text NOT NULL DEFAULT ('completed'), `finish_reason` text NULL, `error_text` text NULL, `summary` integer NOT NULL DEFAULT 0, `compacted_by_message_id` text NULL, `model_response_id` text NULL, `provider_metadata_json` text NULL, `token_usage_json` text NULL, `runtime_json` text NULL, `content_json` text NOT NULL, `created_at` text NOT NULL, `updated_at` text NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `messages_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON DELETE CASCADE, CONSTRAINT `messages_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `tasks` (`id`) ON DELETE SET NULL, CONSTRAINT `messages_run_id_fkey` FOREIGN KEY (`run_id`) REFERENCES `agent_runs` (`id`) ON DELETE SET NULL, CONSTRAINT `messages_valid_role` CHECK (role IN ('user', 'assistant')), CONSTRAINT `messages_valid_status` CHECK (status IN ('running', 'completed', 'failed', 'cancelled')));
-- Copy rows from old table "messages" to new temporary table "new_messages"
INSERT INTO `new_messages` (`id`, `session_id`, `task_id`, `role`, `kind`, `parent_message_id`, `agent_name`, `model_provider_id`, `model_id`, `status`, `finish_reason`, `error_text`, `summary`, `compacted_by_message_id`, `model_response_id`, `provider_metadata_json`, `token_usage_json`, `runtime_json`, `content_json`, `created_at`, `updated_at`) SELECT `id`, `session_id`, `task_id`, `role`, `kind`, `parent_message_id`, `agent_name`, `model_provider_id`, `model_id`, `status`, `finish_reason`, `error_text`, `summary`, `compacted_by_message_id`, `model_response_id`, `provider_metadata_json`, `token_usage_json`, `runtime_json`, `content_json`, `created_at`, `updated_at` FROM `messages`;
-- Drop "messages" table after copying rows
DROP TABLE `messages`;
-- Rename temporary table "new_messages" to "messages"
ALTER TABLE `new_messages` RENAME TO `messages`;
-- Create index "idx_messages_session_created_at" to table: "messages"
CREATE INDEX `idx_messages_session_created_at` ON `messages` (`session_id`, `created_at`);
-- Create index "idx_messages_task_created_at" to table: "messages"
CREATE INDEX `idx_messages_task_created_at` ON `messages` (`task_id`, `created_at`);
-- Create index "idx_messages_run_created_at" to table: "messages"
CREATE INDEX `idx_messages_run_created_at` ON `messages` (`run_id`, `created_at`);
-- Create "new_tool_calls" table
CREATE TABLE `new_tool_calls` (`id` text NOT NULL, `session_id` text NOT NULL, `task_id` text NULL, `run_id` text NULL, `message_id` text NULL, `message_part_id` text NULL, `model_tool_call_id` text NULL, `provider_metadata_json` text NULL, `tool_name` text NOT NULL, `input_json` text NOT NULL, `status` text NOT NULL, `requires_approval` integer NOT NULL DEFAULT 0, `result_json` text NULL, `error_text` text NULL, `started_at` text NULL, `completed_at` text NULL, `created_at` text NOT NULL, `updated_at` text NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `tool_calls_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON DELETE CASCADE, CONSTRAINT `tool_calls_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `tasks` (`id`) ON DELETE SET NULL, CONSTRAINT `tool_calls_run_id_fkey` FOREIGN KEY (`run_id`) REFERENCES `agent_runs` (`id`) ON DELETE SET NULL, CONSTRAINT `tool_calls_message_id_fkey` FOREIGN KEY (`message_id`) REFERENCES `messages` (`id`) ON DELETE SET NULL, CONSTRAINT `tool_calls_message_part_id_fkey` FOREIGN KEY (`message_part_id`) REFERENCES `message_parts` (`id`) ON DELETE SET NULL, CONSTRAINT `tool_calls_valid_tool_name` CHECK (tool_name IN ('read_file', 'write_file', 'run_command')), CONSTRAINT `tool_calls_valid_status` CHECK (status IN ('pending', 'pending_approval', 'approved', 'rejected', 'running', 'completed', 'failed')), CONSTRAINT `tool_calls_valid_requires_approval` CHECK (requires_approval IN (0, 1)));
-- Copy rows from old table "tool_calls" to new temporary table "new_tool_calls"
INSERT INTO `new_tool_calls` (`id`, `session_id`, `task_id`, `message_id`, `message_part_id`, `model_tool_call_id`, `provider_metadata_json`, `tool_name`, `input_json`, `status`, `requires_approval`, `result_json`, `error_text`, `started_at`, `completed_at`, `created_at`, `updated_at`) SELECT `id`, `session_id`, `task_id`, `message_id`, `message_part_id`, `model_tool_call_id`, `provider_metadata_json`, `tool_name`, `input_json`, `status`, `requires_approval`, `result_json`, `error_text`, `started_at`, `completed_at`, `created_at`, `updated_at` FROM `tool_calls`;
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
-- Create "new_message_parts" table
CREATE TABLE `new_message_parts` (`id` text NOT NULL, `session_id` text NOT NULL, `message_id` text NOT NULL, `run_id` text NULL, `type` text NOT NULL, `order_index` integer NOT NULL, `data_json` text NOT NULL, `created_at` text NOT NULL, `updated_at` text NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `message_parts_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON DELETE CASCADE, CONSTRAINT `message_parts_message_id_fkey` FOREIGN KEY (`message_id`) REFERENCES `messages` (`id`) ON DELETE CASCADE, CONSTRAINT `message_parts_run_id_fkey` FOREIGN KEY (`run_id`) REFERENCES `agent_runs` (`id`) ON DELETE SET NULL);
-- Copy rows from old table "message_parts" to new temporary table "new_message_parts"
INSERT INTO `new_message_parts` (`id`, `session_id`, `message_id`, `type`, `order_index`, `data_json`, `created_at`, `updated_at`) SELECT `id`, `session_id`, `message_id`, `type`, `order_index`, `data_json`, `created_at`, `updated_at` FROM `message_parts`;
-- Drop "message_parts" table after copying rows
DROP TABLE `message_parts`;
-- Rename temporary table "new_message_parts" to "message_parts"
ALTER TABLE `new_message_parts` RENAME TO `message_parts`;
-- Create index "idx_message_parts_message_order" to table: "message_parts"
CREATE INDEX `idx_message_parts_message_order` ON `message_parts` (`message_id`, `order_index`, `id`);
-- Create index "idx_message_parts_session_created" to table: "message_parts"
CREATE INDEX `idx_message_parts_session_created` ON `message_parts` (`session_id`, `created_at`, `id`);
-- Create index "idx_message_parts_run_order" to table: "message_parts"
CREATE INDEX `idx_message_parts_run_order` ON `message_parts` (`run_id`, `order_index`);
-- Create "agent_runs" table
CREATE TABLE `agent_runs` (`id` text NOT NULL, `session_id` text NOT NULL, `trigger_message_id` text NULL, `status` text NOT NULL, `started_at` text NOT NULL, `ended_at` text NULL, `cancelled_at` text NULL, `error_text` text NULL, `last_checkpoint_json` text NULL, `created_at` text NOT NULL, `updated_at` text NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `agent_runs_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON DELETE CASCADE, CONSTRAINT `agent_runs_trigger_message_id_fkey` FOREIGN KEY (`trigger_message_id`) REFERENCES `messages` (`id`) ON DELETE SET NULL, CONSTRAINT `agent_runs_valid_status` CHECK (status IN ('running', 'waiting_approval', 'completed', 'cancelled', 'failed', 'blocked')));
-- Create index "idx_agent_runs_session_created_at" to table: "agent_runs"
CREATE INDEX `idx_agent_runs_session_created_at` ON `agent_runs` (`session_id`, `created_at`);
-- Create index "idx_agent_runs_session_status" to table: "agent_runs"
CREATE INDEX `idx_agent_runs_session_status` ON `agent_runs` (`session_id`, `status`);
-- Create index "idx_agent_runs_trigger_message_id" to table: "agent_runs"
CREATE INDEX `idx_agent_runs_trigger_message_id` ON `agent_runs` (`trigger_message_id`);
-- Enable back the enforcement of foreign-keys constraints
PRAGMA foreign_keys = on;
