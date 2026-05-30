import {
  sqliteTable,
  AnySQLiteColumn,
  index,
  foreignKey,
  check,
  text,
  uniqueIndex,
  integer
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const artifacts = sqliteTable(
  'artifacts',
  {
    id: text().primaryKey().notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => tasks.id, {
      onDelete: 'set null'
    }),
    toolCallId: text('tool_call_id').references(() => toolCalls.id, {
      onDelete: 'set null'
    }),
    kind: text().notNull(),
    title: text().notNull(),
    mimeType: text('mime_type').default('text/plain').notNull(),
    bodyText: text('body_text'),
    payloadJson: text('payload_json'),
    createdAt: text('created_at').notNull()
  },
  (table) => [
    index('idx_artifacts_task_created_at').on(table.taskId, table.createdAt),
    check(
      'artifacts_check_1',
      sql`kind IN ('diff', 'stdout', 'stderr', 'error', 'file_snapshot', 'plan_summary', 'task_summary', 'final_result'`
    ),
    check(
      'artifacts_check_2',
      sql`body_text IS NOT NULL OR payload_json IS NOT NULL`
    ),
    check('plans_check_3', sql`status IN ('draft', 'confirmed', 'superseded'`),
    check(
      'session_events_check_4',
      sql`level IN ('debug', 'info', 'warning', 'error'`
    ),
    check('messages_check_5', sql`role IN ('user', 'assistant'`),
    check(
      'messages_check_6',
      sql`status IN ('running', 'completed', 'failed', 'cancelled'`
    ),
    check(
      'agent_runs_check_7',
      sql`status IN ('running', 'waiting_approval', 'completed', 'cancelled', 'failed', 'blocked'`
    ),
    check(
      'tasks_check_8',
      sql`status IN ('todo', 'ready', 'running', 'blocked', 'waiting_approval', 'done', 'failed'`
    ),
    check(
      'approvals_check_9',
      sql`kind IN ('apply_patch', 'bash', 'write', 'edit', 'plan_exit'`
    ),
    check(
      'approvals_check_10',
      sql`status IN ('pending', 'approved', 'rejected'`
    ),
    check('approvals_check_11', sql`decision_scope IN ('once', 'session_rule'`),
    check(
      'sessions_check_12',
      sql`status IN ('planning', 'idle', 'executing', 'waiting_approval', 'blocked', 'completed', 'archived'`
    ),
    check('sessions_check_13', sql`kind IN ('primary', 'subagent'`),
    check('sessions_check_14', sql`default_variant IN ('plan', 'build'`),
    check(
      'sessions_check_15',
      sql`subagent_type IS NULL OR subagent_type IN ('explore'`
    ),
    check(
      'tool_calls_check_16',
      sql`tool_name IN ('agent', 'batch', 'read', 'glob', 'grep', 'task_create', 'task_list', 'task_get', 'task_update', 'task_stop', 'apply_patch', 'bash', 'write', 'edit', 'plan_exit'`
    ),
    check(
      'tool_calls_check_17',
      sql`status IN ('pending', 'pending_approval', 'approved', 'rejected', 'running', 'completed', 'failed'`
    ),
    check('tool_calls_check_18', sql`requires_approval IN (0, 1`)
  ]
);

export const plans = sqliteTable(
  'plans',
  {
    id: text().primaryKey().notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    version: integer().notNull(),
    status: text().default('draft').notNull(),
    summaryText: text('summary_text'),
    source: text().default('model').notNull(),
    createdAt: text('created_at').notNull(),
    confirmedAt: text('confirmed_at'),
    supersededAt: text('superseded_at')
  },
  (table) => [
    uniqueIndex('plans_session_version_idx').on(table.sessionId, table.version),
    check(
      'artifacts_check_1',
      sql`kind IN ('diff', 'stdout', 'stderr', 'error', 'file_snapshot', 'plan_summary', 'task_summary', 'final_result'`
    ),
    check(
      'artifacts_check_2',
      sql`body_text IS NOT NULL OR payload_json IS NOT NULL`
    ),
    check('plans_check_3', sql`status IN ('draft', 'confirmed', 'superseded'`),
    check(
      'session_events_check_4',
      sql`level IN ('debug', 'info', 'warning', 'error'`
    ),
    check('messages_check_5', sql`role IN ('user', 'assistant'`),
    check(
      'messages_check_6',
      sql`status IN ('running', 'completed', 'failed', 'cancelled'`
    ),
    check(
      'agent_runs_check_7',
      sql`status IN ('running', 'waiting_approval', 'completed', 'cancelled', 'failed', 'blocked'`
    ),
    check(
      'tasks_check_8',
      sql`status IN ('todo', 'ready', 'running', 'blocked', 'waiting_approval', 'done', 'failed'`
    ),
    check(
      'approvals_check_9',
      sql`kind IN ('apply_patch', 'bash', 'write', 'edit', 'plan_exit'`
    ),
    check(
      'approvals_check_10',
      sql`status IN ('pending', 'approved', 'rejected'`
    ),
    check('approvals_check_11', sql`decision_scope IN ('once', 'session_rule'`),
    check(
      'sessions_check_12',
      sql`status IN ('planning', 'idle', 'executing', 'waiting_approval', 'blocked', 'completed', 'archived'`
    ),
    check('sessions_check_13', sql`kind IN ('primary', 'subagent'`),
    check('sessions_check_14', sql`default_variant IN ('plan', 'build'`),
    check(
      'sessions_check_15',
      sql`subagent_type IS NULL OR subagent_type IN ('explore'`
    ),
    check(
      'tool_calls_check_16',
      sql`tool_name IN ('agent', 'batch', 'read', 'glob', 'grep', 'task_create', 'task_list', 'task_get', 'task_update', 'task_stop', 'apply_patch', 'bash', 'write', 'edit', 'plan_exit'`
    ),
    check(
      'tool_calls_check_17',
      sql`status IN ('pending', 'pending_approval', 'approved', 'rejected', 'running', 'completed', 'failed'`
    ),
    check('tool_calls_check_18', sql`requires_approval IN (0, 1`)
  ]
);

export const workspaces = sqliteTable(
  'workspaces',
  {
    id: text().primaryKey().notNull(),
    name: text().notNull(),
    rootPath: text('root_path').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    lastOpenedAt: text('last_opened_at').notNull()
  },
  (table) => [
    index('idx_workspaces_last_opened_at').on(table.lastOpenedAt),
    uniqueIndex('workspaces_root_path_idx').on(table.rootPath),
    check(
      'artifacts_check_1',
      sql`kind IN ('diff', 'stdout', 'stderr', 'error', 'file_snapshot', 'plan_summary', 'task_summary', 'final_result'`
    ),
    check(
      'artifacts_check_2',
      sql`body_text IS NOT NULL OR payload_json IS NOT NULL`
    ),
    check('plans_check_3', sql`status IN ('draft', 'confirmed', 'superseded'`),
    check(
      'session_events_check_4',
      sql`level IN ('debug', 'info', 'warning', 'error'`
    ),
    check('messages_check_5', sql`role IN ('user', 'assistant'`),
    check(
      'messages_check_6',
      sql`status IN ('running', 'completed', 'failed', 'cancelled'`
    ),
    check(
      'agent_runs_check_7',
      sql`status IN ('running', 'waiting_approval', 'completed', 'cancelled', 'failed', 'blocked'`
    ),
    check(
      'tasks_check_8',
      sql`status IN ('todo', 'ready', 'running', 'blocked', 'waiting_approval', 'done', 'failed'`
    ),
    check(
      'approvals_check_9',
      sql`kind IN ('apply_patch', 'bash', 'write', 'edit', 'plan_exit'`
    ),
    check(
      'approvals_check_10',
      sql`status IN ('pending', 'approved', 'rejected'`
    ),
    check('approvals_check_11', sql`decision_scope IN ('once', 'session_rule'`),
    check(
      'sessions_check_12',
      sql`status IN ('planning', 'idle', 'executing', 'waiting_approval', 'blocked', 'completed', 'archived'`
    ),
    check('sessions_check_13', sql`kind IN ('primary', 'subagent'`),
    check('sessions_check_14', sql`default_variant IN ('plan', 'build'`),
    check(
      'sessions_check_15',
      sql`subagent_type IS NULL OR subagent_type IN ('explore'`
    ),
    check(
      'tool_calls_check_16',
      sql`tool_name IN ('agent', 'batch', 'read', 'glob', 'grep', 'task_create', 'task_list', 'task_get', 'task_update', 'task_stop', 'apply_patch', 'bash', 'write', 'edit', 'plan_exit'`
    ),
    check(
      'tool_calls_check_17',
      sql`status IN ('pending', 'pending_approval', 'approved', 'rejected', 'running', 'completed', 'failed'`
    ),
    check('tool_calls_check_18', sql`requires_approval IN (0, 1`)
  ]
);

export const sessionEvents = sqliteTable(
  'session_events',
  {
    id: text().primaryKey().notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => tasks.id, {
      onDelete: 'set null'
    }),
    runId: text('run_id').references(() => agentRuns.id, {
      onDelete: 'set null'
    }),
    sequenceNo: integer('sequence_no').notNull(),
    type: text().notNull(),
    level: text().default('info').notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    headline: text(),
    detailText: text('detail_text'),
    payloadJson: text('payload_json').default('{}').notNull(),
    createdAt: text('created_at').notNull()
  },
  (table) => [
    index('idx_session_events_run_sequence').on(table.runId, table.sequenceNo),
    index('idx_session_events_task_sequence').on(
      table.taskId,
      table.sequenceNo
    ),
    index('idx_session_events_session_sequence').on(
      table.sessionId,
      table.sequenceNo
    ),
    uniqueIndex('session_events_session_sequence_idx').on(
      table.sessionId,
      table.sequenceNo
    ),
    check(
      'artifacts_check_1',
      sql`kind IN ('diff', 'stdout', 'stderr', 'error', 'file_snapshot', 'plan_summary', 'task_summary', 'final_result'`
    ),
    check(
      'artifacts_check_2',
      sql`body_text IS NOT NULL OR payload_json IS NOT NULL`
    ),
    check('plans_check_3', sql`status IN ('draft', 'confirmed', 'superseded'`),
    check(
      'session_events_check_4',
      sql`level IN ('debug', 'info', 'warning', 'error'`
    ),
    check('messages_check_5', sql`role IN ('user', 'assistant'`),
    check(
      'messages_check_6',
      sql`status IN ('running', 'completed', 'failed', 'cancelled'`
    ),
    check(
      'agent_runs_check_7',
      sql`status IN ('running', 'waiting_approval', 'completed', 'cancelled', 'failed', 'blocked'`
    ),
    check(
      'tasks_check_8',
      sql`status IN ('todo', 'ready', 'running', 'blocked', 'waiting_approval', 'done', 'failed'`
    ),
    check(
      'approvals_check_9',
      sql`kind IN ('apply_patch', 'bash', 'write', 'edit', 'plan_exit'`
    ),
    check(
      'approvals_check_10',
      sql`status IN ('pending', 'approved', 'rejected'`
    ),
    check('approvals_check_11', sql`decision_scope IN ('once', 'session_rule'`),
    check(
      'sessions_check_12',
      sql`status IN ('planning', 'idle', 'executing', 'waiting_approval', 'blocked', 'completed', 'archived'`
    ),
    check('sessions_check_13', sql`kind IN ('primary', 'subagent'`),
    check('sessions_check_14', sql`default_variant IN ('plan', 'build'`),
    check(
      'sessions_check_15',
      sql`subagent_type IS NULL OR subagent_type IN ('explore'`
    ),
    check(
      'tool_calls_check_16',
      sql`tool_name IN ('agent', 'batch', 'read', 'glob', 'grep', 'task_create', 'task_list', 'task_get', 'task_update', 'task_stop', 'apply_patch', 'bash', 'write', 'edit', 'plan_exit'`
    ),
    check(
      'tool_calls_check_17',
      sql`status IN ('pending', 'pending_approval', 'approved', 'rejected', 'running', 'completed', 'failed'`
    ),
    check('tool_calls_check_18', sql`requires_approval IN (0, 1`)
  ]
);

export const messages = sqliteTable(
  'messages',
  {
    id: text().primaryKey().notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => tasks.id, {
      onDelete: 'set null'
    }),
    runId: text('run_id').references((): AnySQLiteColumn => agentRuns.id, {
      onDelete: 'set null'
    }),
    role: text().notNull(),
    kind: text().default('message').notNull(),
    parentMessageId: text('parent_message_id'),
    agentName: text('agent_name'),
    modelProviderId: text('model_provider_id'),
    modelId: text('model_id'),
    status: text().default('completed').notNull(),
    finishReason: text('finish_reason'),
    errorText: text('error_text'),
    summary: integer().default(0).notNull(),
    compactedByMessageId: text('compacted_by_message_id'),
    modelResponseId: text('model_response_id'),
    providerMetadataJson: text('provider_metadata_json'),
    tokenUsageJson: text('token_usage_json'),
    runtimeJson: text('runtime_json'),
    contentJson: text('content_json').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [
    index('idx_messages_run_created_at').on(table.runId, table.createdAt),
    index('idx_messages_task_created_at').on(table.taskId, table.createdAt),
    index('idx_messages_session_created_at').on(
      table.sessionId,
      table.createdAt
    ),
    check(
      'artifacts_check_1',
      sql`kind IN ('diff', 'stdout', 'stderr', 'error', 'file_snapshot', 'plan_summary', 'task_summary', 'final_result'`
    ),
    check(
      'artifacts_check_2',
      sql`body_text IS NOT NULL OR payload_json IS NOT NULL`
    ),
    check('plans_check_3', sql`status IN ('draft', 'confirmed', 'superseded'`),
    check(
      'session_events_check_4',
      sql`level IN ('debug', 'info', 'warning', 'error'`
    ),
    check('messages_check_5', sql`role IN ('user', 'assistant'`),
    check(
      'messages_check_6',
      sql`status IN ('running', 'completed', 'failed', 'cancelled'`
    ),
    check(
      'agent_runs_check_7',
      sql`status IN ('running', 'waiting_approval', 'completed', 'cancelled', 'failed', 'blocked'`
    ),
    check(
      'tasks_check_8',
      sql`status IN ('todo', 'ready', 'running', 'blocked', 'waiting_approval', 'done', 'failed'`
    ),
    check(
      'approvals_check_9',
      sql`kind IN ('apply_patch', 'bash', 'write', 'edit', 'plan_exit'`
    ),
    check(
      'approvals_check_10',
      sql`status IN ('pending', 'approved', 'rejected'`
    ),
    check('approvals_check_11', sql`decision_scope IN ('once', 'session_rule'`),
    check(
      'sessions_check_12',
      sql`status IN ('planning', 'idle', 'executing', 'waiting_approval', 'blocked', 'completed', 'archived'`
    ),
    check('sessions_check_13', sql`kind IN ('primary', 'subagent'`),
    check('sessions_check_14', sql`default_variant IN ('plan', 'build'`),
    check(
      'sessions_check_15',
      sql`subagent_type IS NULL OR subagent_type IN ('explore'`
    ),
    check(
      'tool_calls_check_16',
      sql`tool_name IN ('agent', 'batch', 'read', 'glob', 'grep', 'task_create', 'task_list', 'task_get', 'task_update', 'task_stop', 'apply_patch', 'bash', 'write', 'edit', 'plan_exit'`
    ),
    check(
      'tool_calls_check_17',
      sql`status IN ('pending', 'pending_approval', 'approved', 'rejected', 'running', 'completed', 'failed'`
    ),
    check('tool_calls_check_18', sql`requires_approval IN (0, 1`)
  ]
);

export const messageParts = sqliteTable(
  'message_parts',
  {
    id: text().primaryKey().notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    runId: text('run_id').references(() => agentRuns.id, {
      onDelete: 'set null'
    }),
    type: text().notNull(),
    orderIndex: integer('order_index').notNull(),
    dataJson: text('data_json').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [
    index('idx_message_parts_run_order').on(table.runId, table.orderIndex),
    index('idx_message_parts_session_created').on(
      table.sessionId,
      table.createdAt,
      table.id
    ),
    index('idx_message_parts_message_order').on(
      table.messageId,
      table.orderIndex,
      table.id
    ),
    check(
      'artifacts_check_1',
      sql`kind IN ('diff', 'stdout', 'stderr', 'error', 'file_snapshot', 'plan_summary', 'task_summary', 'final_result'`
    ),
    check(
      'artifacts_check_2',
      sql`body_text IS NOT NULL OR payload_json IS NOT NULL`
    ),
    check('plans_check_3', sql`status IN ('draft', 'confirmed', 'superseded'`),
    check(
      'session_events_check_4',
      sql`level IN ('debug', 'info', 'warning', 'error'`
    ),
    check('messages_check_5', sql`role IN ('user', 'assistant'`),
    check(
      'messages_check_6',
      sql`status IN ('running', 'completed', 'failed', 'cancelled'`
    ),
    check(
      'agent_runs_check_7',
      sql`status IN ('running', 'waiting_approval', 'completed', 'cancelled', 'failed', 'blocked'`
    ),
    check(
      'tasks_check_8',
      sql`status IN ('todo', 'ready', 'running', 'blocked', 'waiting_approval', 'done', 'failed'`
    ),
    check(
      'approvals_check_9',
      sql`kind IN ('apply_patch', 'bash', 'write', 'edit', 'plan_exit'`
    ),
    check(
      'approvals_check_10',
      sql`status IN ('pending', 'approved', 'rejected'`
    ),
    check('approvals_check_11', sql`decision_scope IN ('once', 'session_rule'`),
    check(
      'sessions_check_12',
      sql`status IN ('planning', 'idle', 'executing', 'waiting_approval', 'blocked', 'completed', 'archived'`
    ),
    check('sessions_check_13', sql`kind IN ('primary', 'subagent'`),
    check('sessions_check_14', sql`default_variant IN ('plan', 'build'`),
    check(
      'sessions_check_15',
      sql`subagent_type IS NULL OR subagent_type IN ('explore'`
    ),
    check(
      'tool_calls_check_16',
      sql`tool_name IN ('agent', 'batch', 'read', 'glob', 'grep', 'task_create', 'task_list', 'task_get', 'task_update', 'task_stop', 'apply_patch', 'bash', 'write', 'edit', 'plan_exit'`
    ),
    check(
      'tool_calls_check_17',
      sql`status IN ('pending', 'pending_approval', 'approved', 'rejected', 'running', 'completed', 'failed'`
    ),
    check('tool_calls_check_18', sql`requires_approval IN (0, 1`)
  ]
);

export const agentRuns = sqliteTable(
  'agent_runs',
  {
    id: text().primaryKey().notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    triggerMessageId: text('trigger_message_id').references(
      (): AnySQLiteColumn => messages.id,
      { onDelete: 'set null' }
    ),
    status: text().notNull(),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    cancelledAt: text('cancelled_at'),
    errorText: text('error_text'),
    lastCheckpointJson: text('last_checkpoint_json'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [
    index('idx_agent_runs_trigger_message_id').on(table.triggerMessageId),
    index('idx_agent_runs_session_status').on(table.sessionId, table.status),
    index('idx_agent_runs_session_created_at').on(
      table.sessionId,
      table.createdAt
    ),
    check(
      'artifacts_check_1',
      sql`kind IN ('diff', 'stdout', 'stderr', 'error', 'file_snapshot', 'plan_summary', 'task_summary', 'final_result'`
    ),
    check(
      'artifacts_check_2',
      sql`body_text IS NOT NULL OR payload_json IS NOT NULL`
    ),
    check('plans_check_3', sql`status IN ('draft', 'confirmed', 'superseded'`),
    check(
      'session_events_check_4',
      sql`level IN ('debug', 'info', 'warning', 'error'`
    ),
    check('messages_check_5', sql`role IN ('user', 'assistant'`),
    check(
      'messages_check_6',
      sql`status IN ('running', 'completed', 'failed', 'cancelled'`
    ),
    check(
      'agent_runs_check_7',
      sql`status IN ('running', 'waiting_approval', 'completed', 'cancelled', 'failed', 'blocked'`
    ),
    check(
      'tasks_check_8',
      sql`status IN ('todo', 'ready', 'running', 'blocked', 'waiting_approval', 'done', 'failed'`
    ),
    check(
      'approvals_check_9',
      sql`kind IN ('apply_patch', 'bash', 'write', 'edit', 'plan_exit'`
    ),
    check(
      'approvals_check_10',
      sql`status IN ('pending', 'approved', 'rejected'`
    ),
    check('approvals_check_11', sql`decision_scope IN ('once', 'session_rule'`),
    check(
      'sessions_check_12',
      sql`status IN ('planning', 'idle', 'executing', 'waiting_approval', 'blocked', 'completed', 'archived'`
    ),
    check('sessions_check_13', sql`kind IN ('primary', 'subagent'`),
    check('sessions_check_14', sql`default_variant IN ('plan', 'build'`),
    check(
      'sessions_check_15',
      sql`subagent_type IS NULL OR subagent_type IN ('explore'`
    ),
    check(
      'tool_calls_check_16',
      sql`tool_name IN ('agent', 'batch', 'read', 'glob', 'grep', 'task_create', 'task_list', 'task_get', 'task_update', 'task_stop', 'apply_patch', 'bash', 'write', 'edit', 'plan_exit'`
    ),
    check(
      'tool_calls_check_17',
      sql`status IN ('pending', 'pending_approval', 'approved', 'rejected', 'running', 'completed', 'failed'`
    ),
    check('tool_calls_check_18', sql`requires_approval IN (0, 1`)
  ]
);

export const tasks = sqliteTable(
  'tasks',
  {
    id: text().primaryKey().notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    planId: text('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    title: text().notNull(),
    description: text(),
    acceptanceCriteriaJson: text('acceptance_criteria_json')
      .default('[]')
      .notNull(),
    status: text().default('todo').notNull(),
    summaryText: text('summary_text'),
    lastErrorText: text('last_error_text'),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [
    index('idx_tasks_session_status').on(table.sessionId, table.status),
    index('idx_tasks_session_position').on(table.sessionId, table.position),
    uniqueIndex('tasks_plan_position_idx').on(table.planId, table.position),
    check(
      'artifacts_check_1',
      sql`kind IN ('diff', 'stdout', 'stderr', 'error', 'file_snapshot', 'plan_summary', 'task_summary', 'final_result'`
    ),
    check(
      'artifacts_check_2',
      sql`body_text IS NOT NULL OR payload_json IS NOT NULL`
    ),
    check('plans_check_3', sql`status IN ('draft', 'confirmed', 'superseded'`),
    check(
      'session_events_check_4',
      sql`level IN ('debug', 'info', 'warning', 'error'`
    ),
    check('messages_check_5', sql`role IN ('user', 'assistant'`),
    check(
      'messages_check_6',
      sql`status IN ('running', 'completed', 'failed', 'cancelled'`
    ),
    check(
      'agent_runs_check_7',
      sql`status IN ('running', 'waiting_approval', 'completed', 'cancelled', 'failed', 'blocked'`
    ),
    check(
      'tasks_check_8',
      sql`status IN ('todo', 'ready', 'running', 'blocked', 'waiting_approval', 'done', 'failed'`
    ),
    check(
      'approvals_check_9',
      sql`kind IN ('apply_patch', 'bash', 'write', 'edit', 'plan_exit'`
    ),
    check(
      'approvals_check_10',
      sql`status IN ('pending', 'approved', 'rejected'`
    ),
    check('approvals_check_11', sql`decision_scope IN ('once', 'session_rule'`),
    check(
      'sessions_check_12',
      sql`status IN ('planning', 'idle', 'executing', 'waiting_approval', 'blocked', 'completed', 'archived'`
    ),
    check('sessions_check_13', sql`kind IN ('primary', 'subagent'`),
    check('sessions_check_14', sql`default_variant IN ('plan', 'build'`),
    check(
      'sessions_check_15',
      sql`subagent_type IS NULL OR subagent_type IN ('explore'`
    ),
    check(
      'tool_calls_check_16',
      sql`tool_name IN ('agent', 'batch', 'read', 'glob', 'grep', 'task_create', 'task_list', 'task_get', 'task_update', 'task_stop', 'apply_patch', 'bash', 'write', 'edit', 'plan_exit'`
    ),
    check(
      'tool_calls_check_17',
      sql`status IN ('pending', 'pending_approval', 'approved', 'rejected', 'running', 'completed', 'failed'`
    ),
    check('tool_calls_check_18', sql`requires_approval IN (0, 1`)
  ]
);

export const approvals = sqliteTable(
  'approvals',
  {
    id: text().primaryKey().notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => tasks.id, {
      onDelete: 'set null'
    }),
    runId: text('run_id').references(() => agentRuns.id, {
      onDelete: 'set null'
    }),
    toolCallId: text('tool_call_id')
      .notNull()
      .references(() => toolCalls.id, { onDelete: 'cascade' }),
    kind: text().notNull(),
    status: text().default('pending').notNull(),
    decisionScope: text('decision_scope').default('once').notNull(),
    payloadJson: text('payload_json').notNull(),
    suggestedRuleJson: text('suggested_rule_json'),
    decidedBy: text('decided_by'),
    decisionReasonText: text('decision_reason_text'),
    createdAt: text('created_at').notNull(),
    decidedAt: text('decided_at')
  },
  (table) => [
    index('idx_approvals_run_status').on(table.runId, table.status),
    index('idx_approvals_tool_call_id').on(table.toolCallId),
    index('idx_approvals_session_status_created_at').on(
      table.sessionId,
      table.status,
      table.createdAt
    ),
    check(
      'artifacts_check_1',
      sql`kind IN ('diff', 'stdout', 'stderr', 'error', 'file_snapshot', 'plan_summary', 'task_summary', 'final_result'`
    ),
    check(
      'artifacts_check_2',
      sql`body_text IS NOT NULL OR payload_json IS NOT NULL`
    ),
    check('plans_check_3', sql`status IN ('draft', 'confirmed', 'superseded'`),
    check(
      'session_events_check_4',
      sql`level IN ('debug', 'info', 'warning', 'error'`
    ),
    check('messages_check_5', sql`role IN ('user', 'assistant'`),
    check(
      'messages_check_6',
      sql`status IN ('running', 'completed', 'failed', 'cancelled'`
    ),
    check(
      'agent_runs_check_7',
      sql`status IN ('running', 'waiting_approval', 'completed', 'cancelled', 'failed', 'blocked'`
    ),
    check(
      'tasks_check_8',
      sql`status IN ('todo', 'ready', 'running', 'blocked', 'waiting_approval', 'done', 'failed'`
    ),
    check(
      'approvals_check_9',
      sql`kind IN ('apply_patch', 'bash', 'write', 'edit', 'plan_exit'`
    ),
    check(
      'approvals_check_10',
      sql`status IN ('pending', 'approved', 'rejected'`
    ),
    check('approvals_check_11', sql`decision_scope IN ('once', 'session_rule'`),
    check(
      'sessions_check_12',
      sql`status IN ('planning', 'idle', 'executing', 'waiting_approval', 'blocked', 'completed', 'archived'`
    ),
    check('sessions_check_13', sql`kind IN ('primary', 'subagent'`),
    check('sessions_check_14', sql`default_variant IN ('plan', 'build'`),
    check(
      'sessions_check_15',
      sql`subagent_type IS NULL OR subagent_type IN ('explore'`
    ),
    check(
      'tool_calls_check_16',
      sql`tool_name IN ('agent', 'batch', 'read', 'glob', 'grep', 'task_create', 'task_list', 'task_get', 'task_update', 'task_stop', 'apply_patch', 'bash', 'write', 'edit', 'plan_exit'`
    ),
    check(
      'tool_calls_check_17',
      sql`status IN ('pending', 'pending_approval', 'approved', 'rejected', 'running', 'completed', 'failed'`
    ),
    check('tool_calls_check_18', sql`requires_approval IN (0, 1`)
  ]
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text().primaryKey().notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    title: text().notNull(),
    goalText: text('goal_text').notNull(),
    kind: text().default('primary').notNull(),
    parentSessionId: text('parent_session_id'),
    parentToolCallId: text('parent_tool_call_id'),
    subagentType: text('subagent_type'),
    defaultVariant: text('default_variant').default('plan').notNull(),
    status: text().default('planning').notNull(),
    currentPlanId: text('current_plan_id'),
    currentTaskId: text('current_task_id'),
    lastErrorText: text('last_error_text'),
    lastCheckpointJson: text('last_checkpoint_json'),
    revertJson: text('revert_json'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    archivedAt: text('archived_at')
  },
  (table) => [
    index('idx_sessions_parent_session').on(table.parentSessionId),
    index('idx_sessions_status').on(table.status),
    index('idx_sessions_workspace_updated_at').on(
      table.workspaceId,
      table.updatedAt
    ),
    foreignKey(() => ({
      columns: [table.parentSessionId],
      foreignColumns: [table.id],
      name: 'sessions_parent_session_id_sessions_id_fk'
    })).onDelete('set null'),
    check(
      'artifacts_check_1',
      sql`kind IN ('diff', 'stdout', 'stderr', 'error', 'file_snapshot', 'plan_summary', 'task_summary', 'final_result'`
    ),
    check(
      'artifacts_check_2',
      sql`body_text IS NOT NULL OR payload_json IS NOT NULL`
    ),
    check('plans_check_3', sql`status IN ('draft', 'confirmed', 'superseded'`),
    check(
      'session_events_check_4',
      sql`level IN ('debug', 'info', 'warning', 'error'`
    ),
    check('messages_check_5', sql`role IN ('user', 'assistant'`),
    check(
      'messages_check_6',
      sql`status IN ('running', 'completed', 'failed', 'cancelled'`
    ),
    check(
      'agent_runs_check_7',
      sql`status IN ('running', 'waiting_approval', 'completed', 'cancelled', 'failed', 'blocked'`
    ),
    check(
      'tasks_check_8',
      sql`status IN ('todo', 'ready', 'running', 'blocked', 'waiting_approval', 'done', 'failed'`
    ),
    check(
      'approvals_check_9',
      sql`kind IN ('apply_patch', 'bash', 'write', 'edit', 'plan_exit'`
    ),
    check(
      'approvals_check_10',
      sql`status IN ('pending', 'approved', 'rejected'`
    ),
    check('approvals_check_11', sql`decision_scope IN ('once', 'session_rule'`),
    check(
      'sessions_check_12',
      sql`status IN ('planning', 'idle', 'executing', 'waiting_approval', 'blocked', 'completed', 'archived'`
    ),
    check('sessions_check_13', sql`kind IN ('primary', 'subagent'`),
    check('sessions_check_14', sql`default_variant IN ('plan', 'build'`),
    check(
      'sessions_check_15',
      sql`subagent_type IS NULL OR subagent_type IN ('explore'`
    ),
    check(
      'tool_calls_check_16',
      sql`tool_name IN ('agent', 'batch', 'read', 'glob', 'grep', 'task_create', 'task_list', 'task_get', 'task_update', 'task_stop', 'apply_patch', 'bash', 'write', 'edit', 'plan_exit'`
    ),
    check(
      'tool_calls_check_17',
      sql`status IN ('pending', 'pending_approval', 'approved', 'rejected', 'running', 'completed', 'failed'`
    ),
    check('tool_calls_check_18', sql`requires_approval IN (0, 1`)
  ]
);

export const toolCalls = sqliteTable(
  'tool_calls',
  {
    id: text().primaryKey().notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => tasks.id, {
      onDelete: 'set null'
    }),
    runId: text('run_id').references(() => agentRuns.id, {
      onDelete: 'set null'
    }),
    messageId: text('message_id').references(() => messages.id, {
      onDelete: 'set null'
    }),
    messagePartId: text('message_part_id').references(() => messageParts.id, {
      onDelete: 'set null'
    }),
    modelToolCallId: text('model_tool_call_id'),
    batchJson: text('batch_json'),
    providerMetadataJson: text('provider_metadata_json'),
    toolName: text('tool_name').notNull(),
    inputJson: text('input_json').notNull(),
    status: text().notNull(),
    requiresApproval: integer('requires_approval').default(0).notNull(),
    resultJson: text('result_json'),
    errorText: text('error_text'),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [
    index('idx_tool_calls_run_status').on(table.runId, table.status),
    index('idx_tool_calls_message_part_id').on(table.messagePartId),
    index('idx_tool_calls_task_status').on(table.taskId, table.status),
    index('idx_tool_calls_session_created_at').on(
      table.sessionId,
      table.createdAt
    ),
    check(
      'artifacts_check_1',
      sql`kind IN ('diff', 'stdout', 'stderr', 'error', 'file_snapshot', 'plan_summary', 'task_summary', 'final_result'`
    ),
    check(
      'artifacts_check_2',
      sql`body_text IS NOT NULL OR payload_json IS NOT NULL`
    ),
    check('plans_check_3', sql`status IN ('draft', 'confirmed', 'superseded'`),
    check(
      'session_events_check_4',
      sql`level IN ('debug', 'info', 'warning', 'error'`
    ),
    check('messages_check_5', sql`role IN ('user', 'assistant'`),
    check(
      'messages_check_6',
      sql`status IN ('running', 'completed', 'failed', 'cancelled'`
    ),
    check(
      'agent_runs_check_7',
      sql`status IN ('running', 'waiting_approval', 'completed', 'cancelled', 'failed', 'blocked'`
    ),
    check(
      'tasks_check_8',
      sql`status IN ('todo', 'ready', 'running', 'blocked', 'waiting_approval', 'done', 'failed'`
    ),
    check(
      'approvals_check_9',
      sql`kind IN ('apply_patch', 'bash', 'write', 'edit', 'plan_exit'`
    ),
    check(
      'approvals_check_10',
      sql`status IN ('pending', 'approved', 'rejected'`
    ),
    check('approvals_check_11', sql`decision_scope IN ('once', 'session_rule'`),
    check(
      'sessions_check_12',
      sql`status IN ('planning', 'idle', 'executing', 'waiting_approval', 'blocked', 'completed', 'archived'`
    ),
    check('sessions_check_13', sql`kind IN ('primary', 'subagent'`),
    check('sessions_check_14', sql`default_variant IN ('plan', 'build'`),
    check(
      'sessions_check_15',
      sql`subagent_type IS NULL OR subagent_type IN ('explore'`
    ),
    check(
      'tool_calls_check_16',
      sql`tool_name IN ('agent', 'batch', 'read', 'glob', 'grep', 'task_create', 'task_list', 'task_get', 'task_update', 'task_stop', 'apply_patch', 'bash', 'write', 'edit', 'plan_exit'`
    ),
    check(
      'tool_calls_check_17',
      sql`status IN ('pending', 'pending_approval', 'approved', 'rejected', 'running', 'completed', 'failed'`
    ),
    check('tool_calls_check_18', sql`requires_approval IN (0, 1`)
  ]
);
