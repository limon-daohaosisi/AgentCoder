table "message_parts" {
  schema = schema.main

  column "id" {
    type = text
    null = false
  }

  column "session_id" {
    type = text
    null = false
  }

  column "message_id" {
    type = text
    null = false
  }

  column "run_id" {
    type = text
    null = true
  }

  column "type" {
    type = text
    null = false
  }

  column "order_index" {
    type = integer
    null = false
  }

  column "data_json" {
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

  foreign_key "message_parts_session_id_fkey" {
    columns     = [column.session_id]
    ref_columns = [table.sessions.column.id]
    on_delete   = CASCADE
  }

  foreign_key "message_parts_message_id_fkey" {
    columns     = [column.message_id]
    ref_columns = [table.messages.column.id]
    on_delete   = CASCADE
  }

  foreign_key "message_parts_run_id_fkey" {
    columns     = [column.run_id]
    ref_columns = [table.agent_runs.column.id]
    on_delete   = SET_NULL
  }

  index "idx_message_parts_message_order" {
    columns = [column.message_id, column.order_index, column.id]
  }

  index "idx_message_parts_session_created" {
    columns = [column.session_id, column.created_at, column.id]
  }

  index "idx_message_parts_run_order" {
    columns = [column.run_id, column.order_index]
  }
}
