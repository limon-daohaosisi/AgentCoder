import { relations } from 'drizzle-orm/relations';
import {
  toolCalls,
  agentRuns,
  approvals,
  tasks,
  sessions,
  artifacts,
  plans,
  sessionEvents,
  workspaces,
  messages,
  messageParts
} from './schema.js';

export const agentRunsRelations = relations(agentRuns, ({ one, many }) => ({
  approvals: many(approvals),
  messageParts: many(messageParts),
  messages: many(messages),
  sessionEvents: many(sessionEvents),
  session: one(sessions, {
    fields: [agentRuns.sessionId],
    references: [sessions.id]
  }),
  toolCalls: many(toolCalls),
  triggerMessage: one(messages, {
    fields: [agentRuns.triggerMessageId],
    references: [messages.id]
  })
}));

export const approvalsRelations = relations(approvals, ({ one }) => ({
  toolCall: one(toolCalls, {
    fields: [approvals.toolCallId],
    references: [toolCalls.id]
  }),
  task: one(tasks, {
    fields: [approvals.taskId],
    references: [tasks.id]
  }),
  session: one(sessions, {
    fields: [approvals.sessionId],
    references: [sessions.id]
  }),
  run: one(agentRuns, {
    fields: [approvals.runId],
    references: [agentRuns.id]
  })
}));

export const toolCallsRelations = relations(toolCalls, ({ one, many }) => ({
  approvals: many(approvals),
  artifacts: many(artifacts),
  messagePart: one(messageParts, {
    fields: [toolCalls.messagePartId],
    references: [messageParts.id]
  }),
  message: one(messages, {
    fields: [toolCalls.messageId],
    references: [messages.id]
  }),
  task: one(tasks, {
    fields: [toolCalls.taskId],
    references: [tasks.id]
  }),
  session: one(sessions, {
    fields: [toolCalls.sessionId],
    references: [sessions.id]
  }),
  run: one(agentRuns, {
    fields: [toolCalls.runId],
    references: [agentRuns.id]
  })
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  approvals: many(approvals),
  artifacts: many(artifacts),
  sessionEvents: many(sessionEvents),
  task: one(tasks, {
    fields: [tasks.parentTaskId],
    references: [tasks.id],
    relationName: 'tasks_parentTaskId_tasks_id'
  }),
  tasks: many(tasks, {
    relationName: 'tasks_parentTaskId_tasks_id'
  }),
  plan: one(plans, {
    fields: [tasks.planId],
    references: [plans.id]
  }),
  session: one(sessions, {
    fields: [tasks.sessionId],
    references: [sessions.id]
  }),
  messages: many(messages),
  toolCalls: many(toolCalls)
}));

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  approvals: many(approvals),
  agentRuns: many(agentRuns),
  artifacts: many(artifacts),
  plans: many(plans),
  sessionEvents: many(sessionEvents),
  workspace: one(workspaces, {
    fields: [sessions.workspaceId],
    references: [workspaces.id]
  }),
  tasks: many(tasks),
  messages: many(messages),
  toolCalls: many(toolCalls),
  messageParts: many(messageParts)
}));

export const artifactsRelations = relations(artifacts, ({ one }) => ({
  toolCall: one(toolCalls, {
    fields: [artifacts.toolCallId],
    references: [toolCalls.id]
  }),
  task: one(tasks, {
    fields: [artifacts.taskId],
    references: [tasks.id]
  }),
  session: one(sessions, {
    fields: [artifacts.sessionId],
    references: [sessions.id]
  })
}));

export const plansRelations = relations(plans, ({ one, many }) => ({
  session: one(sessions, {
    fields: [plans.sessionId],
    references: [sessions.id]
  }),
  tasks: many(tasks)
}));

export const sessionEventsRelations = relations(sessionEvents, ({ one }) => ({
  task: one(tasks, {
    fields: [sessionEvents.taskId],
    references: [tasks.id]
  }),
  session: one(sessions, {
    fields: [sessionEvents.sessionId],
    references: [sessions.id]
  }),
  run: one(agentRuns, {
    fields: [sessionEvents.runId],
    references: [agentRuns.id]
  })
}));

export const workspacesRelations = relations(workspaces, ({ many }) => ({
  sessions: many(sessions)
}));

export const messagesRelations = relations(messages, ({ one, many }) => ({
  task: one(tasks, {
    fields: [messages.taskId],
    references: [tasks.id]
  }),
  session: one(sessions, {
    fields: [messages.sessionId],
    references: [sessions.id]
  }),
  run: one(agentRuns, {
    fields: [messages.runId],
    references: [agentRuns.id]
  }),
  toolCalls: many(toolCalls),
  messageParts: many(messageParts)
}));

export const messagePartsRelations = relations(
  messageParts,
  ({ one, many }) => ({
    toolCalls: many(toolCalls),
    message: one(messages, {
      fields: [messageParts.messageId],
      references: [messages.id]
    }),
    session: one(sessions, {
      fields: [messageParts.sessionId],
      references: [sessions.id]
    }),
    run: one(agentRuns, {
      fields: [messageParts.runId],
      references: [agentRuns.id]
    })
  })
);
