table "session_events" {
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

  column "sequence_no" {
    type = integer
    null = false
  }

  column "type" {
    type = text
    null = false
  }

  column "level" {
    type    = text
    null    = false
    default = sql("'info'")
  }

  column "entity_type" {
    type = text
    null = true
  }

  column "entity_id" {
    type = text
    null = true
  }

  column "headline" {
    type = text
    null = true
  }

  column "detail_text" {
    type = text
    null = true
  }

  column "payload_json" {
    type    = text
    null    = false
    default = sql("'{}'")
  }

  column "created_at" {
    type = text
    null = false
  }

  primary_key {
    columns = [column.id]
  }

  foreign_key "session_events_session_id_fkey" {
    columns     = [column.session_id]
    ref_columns = [table.sessions.column.id]
    on_delete   = CASCADE
  }

  foreign_key "session_events_task_id_fkey" {
    columns     = [column.task_id]
    ref_columns = [table.tasks.column.id]
    on_delete   = SET_NULL
  }

  foreign_key "session_events_run_id_fkey" {
    columns     = [column.run_id]
    ref_columns = [table.agent_runs.column.id]
    on_delete   = SET_NULL
  }

  check "session_events_valid_level" {
    expr = "level IN ('debug', 'info', 'warning', 'error')"
  }

  index "session_events_session_sequence_idx" {
    columns = [column.session_id, column.sequence_no]
    unique  = true
  }

  index "idx_session_events_session_sequence" {
    columns = [column.session_id, column.sequence_no]
  }

  index "idx_session_events_task_sequence" {
    columns = [column.task_id, column.sequence_no]
  }

  index "idx_session_events_run_sequence" {
    columns = [column.run_id, column.sequence_no]
  }
}
