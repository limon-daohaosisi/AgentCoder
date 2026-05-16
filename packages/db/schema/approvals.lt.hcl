table "approvals" {
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

  column "tool_call_id" {
    type = text
    null = false
  }

  column "kind" {
    type = text
    null = false
  }

  column "status" {
    type    = text
    null    = false
    default = sql("'pending'")
  }

  column "decision_scope" {
    type    = text
    null    = false
    default = sql("'once'")
  }

  column "payload_json" {
    type = text
    null = false
  }

  column "suggested_rule_json" {
    type = text
    null = true
  }

  column "decided_by" {
    type = text
    null = true
  }

  column "decision_reason_text" {
    type = text
    null = true
  }

  column "created_at" {
    type = text
    null = false
  }

  column "decided_at" {
    type = text
    null = true
  }

  primary_key {
    columns = [column.id]
  }

  foreign_key "approvals_session_id_fkey" {
    columns     = [column.session_id]
    ref_columns = [table.sessions.column.id]
    on_delete   = CASCADE
  }

  foreign_key "approvals_task_id_fkey" {
    columns     = [column.task_id]
    ref_columns = [table.tasks.column.id]
    on_delete   = SET_NULL
  }

  foreign_key "approvals_run_id_fkey" {
    columns     = [column.run_id]
    ref_columns = [table.agent_runs.column.id]
    on_delete   = SET_NULL
  }

  foreign_key "approvals_tool_call_id_fkey" {
    columns     = [column.tool_call_id]
    ref_columns = [table.tool_calls.column.id]
    on_delete   = CASCADE
  }

  check "approvals_valid_kind" {
    expr = "kind IN ('apply_patch', 'bash', 'write', 'edit', 'plan_exit')"
  }

  check "approvals_valid_status" {
    expr = "status IN ('pending', 'approved', 'rejected')"
  }

  check "approvals_valid_decision_scope" {
    expr = "decision_scope IN ('once', 'session_rule')"
  }

  index "idx_approvals_session_status_created_at" {
    columns = [column.session_id, column.status, column.created_at]
  }

  index "idx_approvals_tool_call_id" {
    columns = [column.tool_call_id]
  }

  index "idx_approvals_run_status" {
    columns = [column.run_id, column.status]
  }
}
