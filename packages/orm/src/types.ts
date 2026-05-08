import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import * as schema from './schema.js';

export type SessionRow = InferSelectModel<typeof schema.sessions>;
export type NewSession = InferInsertModel<typeof schema.sessions>;

export type AgentRunRow = InferSelectModel<typeof schema.agentRuns>;
export type NewAgentRun = InferInsertModel<typeof schema.agentRuns>;

export type WorkspaceRow = InferSelectModel<typeof schema.workspaces>;
export type NewWorkspace = InferInsertModel<typeof schema.workspaces>;

export type MessageRow = InferSelectModel<typeof schema.messages>;
export type NewMessage = InferInsertModel<typeof schema.messages>;

export type MessagePartRow = InferSelectModel<typeof schema.messageParts>;
export type NewMessagePart = InferInsertModel<typeof schema.messageParts>;

export type SessionEventRow = InferSelectModel<typeof schema.sessionEvents>;
export type NewSessionEvent = InferInsertModel<typeof schema.sessionEvents>;

export type ToolCallRow = InferSelectModel<typeof schema.toolCalls>;
export type NewToolCall = InferInsertModel<typeof schema.toolCalls>;

export type ApprovalRow = InferSelectModel<typeof schema.approvals>;
export type NewApproval = InferInsertModel<typeof schema.approvals>;
