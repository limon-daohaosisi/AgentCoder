import { relations } from 'drizzle-orm/relations';
import {
  toolCalls,
  artifacts,
  tasks,
  sessions,
  plans,
  agentRuns,
  sessionEvents,
  messages,
  messageParts,
  workspaces,
  approvals
} from './schema.js';

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

export const toolCallsRelations = relations(toolCalls, ({ one, many }) => ({
  artifacts: many(artifacts),
  approvals: many(approvals),
  messagePart: one(messageParts, {
    fields: [toolCalls.messagePartId],
    references: [messageParts.id]
  }),
  message: one(messages, {
    fields: [toolCalls.messageId],
    references: [messages.id]
  }),
  agentRun: one(agentRuns, {
    fields: [toolCalls.runId],
    references: [agentRuns.id]
  }),
  task: one(tasks, {
    fields: [toolCalls.taskId],
    references: [tasks.id]
  }),
  session: one(sessions, {
    fields: [toolCalls.sessionId],
    references: [sessions.id]
  })
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  artifacts: many(artifacts),
  sessionEvents: many(sessionEvents),
  messages: many(messages),
  plan: one(plans, {
    fields: [tasks.planId],
    references: [plans.id]
  }),
  session: one(sessions, {
    fields: [tasks.sessionId],
    references: [sessions.id]
  }),
  approvals: many(approvals),
  toolCalls: many(toolCalls)
}));

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  artifacts: many(artifacts),
  plans: many(plans),
  sessionEvents: many(sessionEvents),
  messages: many(messages),
  messageParts: many(messageParts),
  agentRuns: many(agentRuns),
  tasks: many(tasks),
  workspace: one(workspaces, {
    fields: [sessions.workspaceId],
    references: [workspaces.id]
  }),
  approvals: many(approvals),
  toolCalls: many(toolCalls)
}));

export const plansRelations = relations(plans, ({ one, many }) => ({
  session: one(sessions, {
    fields: [plans.sessionId],
    references: [sessions.id]
  }),
  tasks: many(tasks)
}));

export const sessionEventsRelations = relations(sessionEvents, ({ one }) => ({
  agentRun: one(agentRuns, {
    fields: [sessionEvents.runId],
    references: [agentRuns.id]
  }),
  task: one(tasks, {
    fields: [sessionEvents.taskId],
    references: [tasks.id]
  }),
  session: one(sessions, {
    fields: [sessionEvents.sessionId],
    references: [sessions.id]
  })
}));

export const agentRunsRelations = relations(agentRuns, ({ one, many }) => ({
  sessionEvents: many(sessionEvents),
  messages: many(messages, {
    relationName: 'messages_runId_agentRuns_id'
  }),
  messageParts: many(messageParts),
  message: one(messages, {
    fields: [agentRuns.triggerMessageId],
    references: [messages.id],
    relationName: 'agentRuns_triggerMessageId_messages_id'
  }),
  session: one(sessions, {
    fields: [agentRuns.sessionId],
    references: [sessions.id]
  }),
  approvals: many(approvals),
  toolCalls: many(toolCalls)
}));

export const messagesRelations = relations(messages, ({ one, many }) => ({
  agentRun: one(agentRuns, {
    fields: [messages.runId],
    references: [agentRuns.id],
    relationName: 'messages_runId_agentRuns_id'
  }),
  task: one(tasks, {
    fields: [messages.taskId],
    references: [tasks.id]
  }),
  session: one(sessions, {
    fields: [messages.sessionId],
    references: [sessions.id]
  }),
  messageParts: many(messageParts),
  agentRuns: many(agentRuns, {
    relationName: 'agentRuns_triggerMessageId_messages_id'
  }),
  toolCalls: many(toolCalls)
}));

export const messagePartsRelations = relations(
  messageParts,
  ({ one, many }) => ({
    agentRun: one(agentRuns, {
      fields: [messageParts.runId],
      references: [agentRuns.id]
    }),
    message: one(messages, {
      fields: [messageParts.messageId],
      references: [messages.id]
    }),
    session: one(sessions, {
      fields: [messageParts.sessionId],
      references: [sessions.id]
    }),
    toolCalls: many(toolCalls)
  })
);

export const workspacesRelations = relations(workspaces, ({ many }) => ({
  sessions: many(sessions)
}));

export const approvalsRelations = relations(approvals, ({ one }) => ({
  toolCall: one(toolCalls, {
    fields: [approvals.toolCallId],
    references: [toolCalls.id]
  }),
  agentRun: one(agentRuns, {
    fields: [approvals.runId],
    references: [agentRuns.id]
  }),
  task: one(tasks, {
    fields: [approvals.taskId],
    references: [tasks.id]
  }),
  session: one(sessions, {
    fields: [approvals.sessionId],
    references: [sessions.id]
  })
}));
