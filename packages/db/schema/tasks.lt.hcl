table "tasks" {
  schema = schema.main

  column "id" {
    type = text
    null = false
  }

  column "session_id" {
    type = text
    null = false
  }

  column "plan_id" {
    type = text
    null = false
  }

  column "position" {
    type = integer
    null = false
  }

  column "title" {
    type = text
    null = false
  }

  column "description" {
    type = text
    null = true
  }

  column "acceptance_criteria_json" {
    type    = text
    null    = false
    default = sql("'[]'")
  }

  column "status" {
    type    = text
    null    = false
    default = sql("'todo'")
  }

  column "summary_text" {
    type = text
    null = true
  }

  column "last_error_text" {
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

  column "updated_at" {
    type = text
    null = false
  }

  primary_key {
    columns = [column.id]
  }

  foreign_key "tasks_session_id_fkey" {
    columns     = [column.session_id]
    ref_columns = [table.sessions.column.id]
    on_delete   = CASCADE
  }

  foreign_key "tasks_plan_id_fkey" {
    columns     = [column.plan_id]
    ref_columns = [table.plans.column.id]
    on_delete   = CASCADE
  }

  check "tasks_valid_status" {
    expr = "status IN ('todo', 'ready', 'running', 'blocked', 'waiting_approval', 'done', 'failed')"
  }

  index "tasks_plan_position_idx" {
    columns = [column.plan_id, column.position]
    unique  = true
  }

  index "idx_tasks_session_position" {
    columns = [column.session_id, column.position]
  }

  index "idx_tasks_session_status" {
    columns = [column.session_id, column.status]
  }
}
