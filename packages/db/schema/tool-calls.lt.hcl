table "tool_calls" {
  schema = schema.main

  column "id" {
    type = text
    null = false
  }

  column "session_id" {
    type = text
    null = false
  }

  column "task_id" {
    type = text
    null = true
  }

  column "run_id" {
    type = text
    null = true
  }

  column "message_id" {
    type = text
    null = true
  }

  column "message_part_id" {
    type = text
    null = true
  }

  column "model_tool_call_id" {
    type = text
    null = true
  }

  column "batch_json" {
    type = text
    null = true
  }

  column "provider_metadata_json" {
    type = text
    null = true
  }

  column "tool_name" {
    type = text
    null = false
  }

  column "input_json" {
    type = text
    null = false
  }

  column "status" {
    type = text
    null = false
  }

  column "requires_approval" {
    type    = integer
    null    = false
    default = 0
  }

  column "result_json" {
    type = text
    null = true
  }

  column "error_text" {
    type = text
    null = true
  }

  column "started_at" {
    type = text
    null = true
  }

  column "completed_at" {
    type = text
    null = true
  }

  column "created_at" {
    type = text
    null = false
  }

  column "updated_at" {
    type = text
    null = false
  }

  primary_key {
    columns = [column.id]
  }

  foreign_key "tool_calls_session_id_fkey" {
    columns     = [column.session_id]
    ref_columns = [table.sessions.column.id]
    on_delete   = CASCADE
  }

  foreign_key "tool_calls_task_id_fkey" {
    columns     = [column.task_id]
    ref_columns = [table.tasks.column.id]
    on_delete   = SET_NULL
  }

  foreign_key "tool_calls_run_id_fkey" {
    columns     = [column.run_id]
    ref_columns = [table.agent_runs.column.id]
    on_delete   = SET_NULL
  }

  foreign_key "tool_calls_message_id_fkey" {
    columns     = [column.message_id]
    ref_columns = [table.messages.column.id]
    on_delete   = SET_NULL
  }

  foreign_key "tool_calls_message_part_id_fkey" {
    columns     = [column.message_part_id]
    ref_columns = [table.message_parts.column.id]
    on_delete   = SET_NULL
  }

  check "tool_calls_valid_tool_name" {
    expr = "tool_name IN ('batch', 'read', 'glob', 'grep', 'task_create', 'task_list', 'task_get', 'task_update', 'task_stop', 'apply_patch', 'bash', 'write', 'edit', 'plan_exit')"
  }

  check "tool_calls_valid_status" {
    expr = "status IN ('pending', 'pending_approval', 'approved', 'rejected', 'running', 'completed', 'failed')"
  }

  check "tool_calls_valid_requires_approval" {
    expr = "requires_approval IN (0, 1)"
  }

  index "idx_tool_calls_session_created_at" {
    columns = [column.session_id, column.created_at]
  }

  index "idx_tool_calls_task_status" {
    columns = [column.task_id, column.status]
  }

  index "idx_tool_calls_message_part_id" {
    columns = [column.message_part_id]
  }

  index "idx_tool_calls_run_status" {
    columns = [column.run_id, column.status]
  }
}
