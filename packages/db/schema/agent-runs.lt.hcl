table "agent_runs" {
  schema = schema.main

  column "id" {
    type = text
    null = false
  }

  column "session_id" {
    type = text
    null = false
  }

  column "trigger_message_id" {
    type = text
    null = true
  }

  column "status" {
    type = text
    null = false
  }

  column "started_at" {
    type = text
    null = false
  }

  column "ended_at" {
    type = text
    null = true
  }

  column "cancelled_at" {
    type = text
    null = true
  }

  column "error_text" {
    type = text
    null = true
  }

  column "last_checkpoint_json" {
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

  foreign_key "agent_runs_session_id_fkey" {
    columns     = [column.session_id]
    ref_columns = [table.sessions.column.id]
    on_delete   = CASCADE
  }

  foreign_key "agent_runs_trigger_message_id_fkey" {
    columns     = [column.trigger_message_id]
    ref_columns = [table.messages.column.id]
    on_delete   = SET_NULL
  }

  check "agent_runs_valid_status" {
    expr = "status IN ('running', 'waiting_approval', 'completed', 'cancelled', 'failed', 'blocked')"
  }

  index "idx_agent_runs_session_created_at" {
    columns = [column.session_id, column.created_at]
  }

  index "idx_agent_runs_session_status" {
    columns = [column.session_id, column.status]
  }

  index "idx_agent_runs_trigger_message_id" {
    columns = [column.trigger_message_id]
  }
}
