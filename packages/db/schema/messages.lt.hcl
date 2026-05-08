table "messages" {
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

  column "role" {
    type = text
    null = false
  }

  column "kind" {
    type    = text
    null    = false
    default = sql("'message'")
  }

  column "parent_message_id" {
    type = text
    null = true
  }

  column "agent_name" {
    type = text
    null = true
  }

  column "model_provider_id" {
    type = text
    null = true
  }

  column "model_id" {
    type = text
    null = true
  }

  column "status" {
    type    = text
    null    = false
    default = sql("'completed'")
  }

  column "finish_reason" {
    type = text
    null = true
  }

  column "error_text" {
    type = text
    null = true
  }

  column "summary" {
    type    = integer
    null    = false
    default = 0
  }

  column "compacted_by_message_id" {
    type = text
    null = true
  }

  column "model_response_id" {
    type = text
    null = true
  }

  column "provider_metadata_json" {
    type = text
    null = true
  }

  column "token_usage_json" {
    type = text
    null = true
  }

  column "runtime_json" {
    type = text
    null = true
  }

  column "content_json" {
    type = text
    null = false
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

  foreign_key "messages_session_id_fkey" {
    columns     = [column.session_id]
    ref_columns = [table.sessions.column.id]
    on_delete   = CASCADE
  }

  foreign_key "messages_task_id_fkey" {
    columns     = [column.task_id]
    ref_columns = [table.tasks.column.id]
    on_delete   = SET_NULL
  }

  foreign_key "messages_run_id_fkey" {
    columns     = [column.run_id]
    ref_columns = [table.agent_runs.column.id]
    on_delete   = SET_NULL
  }

  check "messages_valid_role" {
    expr = "role IN ('user', 'assistant')"
  }

  check "messages_valid_status" {
    expr = "status IN ('running', 'completed', 'failed', 'cancelled')"
  }

  index "idx_messages_session_created_at" {
    columns = [column.session_id, column.created_at]
  }

  index "idx_messages_task_created_at" {
    columns = [column.task_id, column.created_at]
  }

  index "idx_messages_run_created_at" {
    columns = [column.run_id, column.created_at]
  }
}
