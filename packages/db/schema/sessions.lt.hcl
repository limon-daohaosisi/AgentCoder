table "sessions" {
  schema = schema.main

  column "id" {
    type = text
    null = false
  }

  column "workspace_id" {
    type = text
    null = false
  }

  column "title" {
    type = text
    null = false
  }

  column "goal_text" {
    type = text
    null = false
  }

  column "status" {
    type    = text
    null    = false
    default = sql("'planning'")
  }

  column "current_plan_id" {
    type = text
    null = true
  }

  column "current_task_id" {
    type = text
    null = true
  }

  column "last_error_text" {
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

  column "archived_at" {
    type = text
    null = true
  }

  primary_key {
    columns = [column.id]
  }

  foreign_key "sessions_workspace_id_fkey" {
    columns     = [column.workspace_id]
    ref_columns = [table.workspaces.column.id]
    on_delete   = CASCADE
  }

  check "sessions_valid_status" {
    expr = "status IN ('planning', 'idle', 'executing', 'waiting_approval', 'blocked', 'failed', 'completed', 'archived')"
  }

  index "idx_sessions_workspace_updated_at" {
    columns = [column.workspace_id, column.updated_at]
  }

  index "idx_sessions_status" {
    columns = [column.status]
  }
}
