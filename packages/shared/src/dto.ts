import type {
  AgentRunStatus,
  SessionStatus,
  SessionVariant
} from './contracts.js';

export type ToolCallStatus =
  | 'pending'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'running'
  | 'completed'
  | 'failed';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export type TaskStatus =
  | 'todo'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'waiting_approval'
  | 'done'
  | 'failed';

export type ToolName =
  | 'apply_patch'
  | 'bash'
  | 'edit'
  | 'glob'
  | 'grep'
  | 'plan_exit'
  | 'read'
  | 'task_create'
  | 'task_get'
  | 'task_list'
  | 'task_stop'
  | 'task_update'
  | 'write';

export type ApprovalKind = Extract<
  ToolName,
  'apply_patch' | 'bash' | 'edit' | 'plan_exit' | 'write'
>;

export type PlanExitApprovalPayload = {
  planContent: string;
  planFilePath: string;
  planId: string;
  summary?: string;
};

export type MessageRole = 'user' | 'assistant';
export type MessageStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export type MessageRuntimeMetadata = {
  beforeSnapshotId?: string;
  format?:
    | { type: 'text' }
    | { schema: Record<string, unknown>; type: 'json_schema' };
  toolOverrides?: Partial<Record<ToolName, boolean>>;
  userSystem?: string;
  variant?: SessionVariant;
};

export type FileAttachment = {
  filename?: string;
  mime: string;
  url: string;
};

export type PartBase = {
  createdAt: string;
  id: string;
  messageId: string;
  order: number;
  sessionId: string;
  type: string;
  updatedAt: string;
};

export type ToolState =
  | {
      input: Record<string, unknown>;
      rawInput?: string;
      status: 'pending';
    }
  | {
      input: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      startedAt: string;
      status: 'running';
      title?: string;
    }
  | {
      attachments?: FileAttachment[];
      completedAt: string;
      compactedAt?: string;
      input: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      outputText: string;
      payload?: Record<string, unknown>;
      startedAt: string;
      status: 'completed';
      title?: string;
    }
  | {
      completedAt: string;
      errorText: string;
      input: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      payload?: Record<string, unknown>;
      reason?: 'execution_denied' | 'tool_error' | 'interrupted';
      startedAt?: string;
      status: 'error';
    };

export type MessagePart =
  | (PartBase & {
      ignored?: boolean;
      metadata?: Record<string, unknown>;
      synthetic?: boolean;
      text: string;
      type: 'text';
    })
  | (PartBase & {
      filename?: string;
      mime: string;
      source?: {
        kind: 'resource' | 'upload';
        path?: string;
      };
      type: 'file';
      url: string;
    })
  | (PartBase & {
      metadata?: Record<string, unknown>;
      text: string;
      type: 'reasoning';
    })
  | (PartBase & {
      modelToolCallId: string;
      providerMetadata?: Record<string, unknown>;
      state: ToolState;
      toolCallId: string;
      toolName: ToolName;
      type: 'tool';
    })
  | {
      createdAt: string;
      diffArtifactId?: string;
      files: Array<{
        change: 'create' | 'delete' | 'update';
        path: string;
      }>;
      id: string;
      messageId: string;
      order: number;
      sessionId: string;
      type: 'patch';
      updatedAt: string;
    }
  | (PartBase & {
      auto: boolean;
      reason: 'budget' | 'manual' | 'overflow';
      targetMessageId?: string;
      type: 'compaction';
    })
  | (PartBase & {
      source: 'assistant' | 'compaction' | 'system';
      text: string;
      type: 'summary';
    });

type PartInputBaseKeys = Exclude<keyof PartBase, 'type'>;

export type CreateMessagePartInput =
  | ({
      createdAt?: string;
      id?: string;
      messageId?: string;
      order?: number;
      sessionId?: string;
      updatedAt?: string;
    } & Omit<Extract<MessagePart, { type: 'text' }>, PartInputBaseKeys>)
  | ({
      createdAt?: string;
      id?: string;
      messageId?: string;
      order?: number;
      sessionId?: string;
      updatedAt?: string;
    } & Omit<Extract<MessagePart, { type: 'file' }>, PartInputBaseKeys>)
  | ({
      createdAt?: string;
      id?: string;
      messageId?: string;
      order?: number;
      sessionId?: string;
      updatedAt?: string;
    } & Omit<Extract<MessagePart, { type: 'reasoning' }>, PartInputBaseKeys>)
  | ({
      createdAt?: string;
      id?: string;
      messageId?: string;
      order?: number;
      sessionId?: string;
      updatedAt?: string;
    } & Omit<Extract<MessagePart, { type: 'tool' }>, PartInputBaseKeys>)
  | ({
      createdAt?: string;
      id?: string;
      messageId?: string;
      order?: number;
      sessionId?: string;
      updatedAt?: string;
    } & Omit<Extract<MessagePart, { type: 'patch' }>, PartInputBaseKeys>)
  | ({
      createdAt?: string;
      id?: string;
      messageId?: string;
      order?: number;
      sessionId?: string;
      updatedAt?: string;
    } & Omit<Extract<MessagePart, { type: 'compaction' }>, PartInputBaseKeys>)
  | ({
      createdAt?: string;
      id?: string;
      messageId?: string;
      order?: number;
      sessionId?: string;
      updatedAt?: string;
    } & Omit<Extract<MessagePart, { type: 'summary' }>, PartInputBaseKeys>);

export type TokenUsageDto = {
  cacheRead?: number;
  cacheWrite?: number;
  input: number;
  output: number;
  reasoning?: number;
  total?: number;
};

export type WorkspaceDto = {
  createdAt: string;
  id: string;
  lastOpenedAt: string;
  name: string;
  rootPath: string;
  updatedAt: string;
};

export type WorkspaceDirectorySegmentDto = {
  name: string;
  path: string;
};

export type WorkspaceDirectoryEntryDto = {
  name: string;
  path: string;
};

export type WorkspaceDirectoryBrowseDto = {
  currentPath: string;
  directories: WorkspaceDirectoryEntryDto[];
  parentPath?: string;
  rootLabel: string;
  segments: WorkspaceDirectorySegmentDto[];
};

export type PlanDto = {
  createdAt: string;
  filePath?: string;
  id: string;
  sessionId: string;
  summaryText?: string;
};

export type SessionPlanFileDto = {
  content: string;
  exists: boolean;
  filePath: string;
  plan: PlanDto;
};

export type TaskDto = {
  acceptanceCriteria: string[];
  completedAt?: string;
  description?: string;
  id: string;
  lastErrorText?: string;
  planId: string;
  position: number;
  sessionId: string;
  startedAt?: string;
  status: TaskStatus;
  summaryText?: string;
  title: string;
  updatedAt: string;
};

export type SessionPlanBoardDto = {
  currentPlan?: PlanDto;
  currentTask?: TaskDto;
  session: SessionDto;
  tasks: TaskDto[];
  waitingApprovalTaskIds: string[];
};

export type SessionCheckpoint = {
  approvalId?: string;
  kind:
    | 'session_created'
    | 'planning'
    | 'waiting_plan_confirmation'
    | 'executing_task'
    | 'waiting_approval'
    | 'failed'
    | 'completed';
  messageId?: string;
  modelToolCallId?: string;
  note?: string;
  partId?: string;
  planId?: string;
  taskId?: string;
  toolCallId?: string;
  updatedAt: string;
};

export type SessionRevertDto = {
  beforeSnapshotId: string;
  createdAt: string;
  diffText?: string;
  redoSnapshotId?: string;
  targetMessageId: string;
};

export type SessionDto = {
  archivedAt?: string;
  createdAt: string;
  currentPlanId?: string;
  currentTaskId?: string;
  defaultVariant: SessionVariant;
  goalText: string;
  id: string;
  lastErrorText?: string;
  lastCheckpointJson?: string;
  revert?: SessionRevertDto;
  status: SessionStatus;
  title: string;
  updatedAt: string;
  workspaceId: string;
};

export type ResumeSessionDto = {
  canResume: boolean;
  checkpoint?: string;
  pendingApprovals?: ApprovalDto[];
  session?: SessionDto;
};

export type AgentRunDto = {
  cancelledAt?: string;
  createdAt: string;
  endedAt?: string;
  errorText?: string;
  id: string;
  lastCheckpointJson?: string;
  sessionId: string;
  startedAt: string;
  status: AgentRunStatus;
  triggerMessageId?: string;
  updatedAt: string;
};

export type MessageDto = {
  agentName?: string;
  compactedByMessageId?: string;
  content: MessagePart[];
  createdAt: string;
  errorText?: string;
  finishReason?: string;
  id: string;
  kind: 'message';
  model?: {
    modelId: string;
    providerId: string;
  };
  modelResponseId?: string;
  parentMessageId?: string;
  providerMetadata?: Record<string, unknown>;
  role: MessageRole;
  runId?: string;
  runtime?: MessageRuntimeMetadata;
  sessionId: string;
  status: MessageStatus;
  summary?: boolean;
  taskId?: string;
  tokenUsage?: TokenUsageDto;
  updatedAt: string;
};

export type SubmitSessionMessageResponse = {
  accepted: true;
  message: MessageDto;
  run: AgentRunDto;
};

export type RevertSessionResponse = {
  revert: SessionRevertDto;
  session: SessionDto;
};

export type RestoreRevertResponse = {
  restored: true;
  session: SessionDto;
};

export type CancelRunResponse = {
  cancelled: boolean;
  reason: 'active_run_cancelled' | 'approval_cancelled' | 'no_active_run';
  run?: AgentRunDto;
  session: SessionDto;
};

export type ToolCallDto = {
  createdAt: string;
  errorText?: string;
  id: string;
  input: Record<string, unknown>;
  messageId?: string;
  messagePartId?: string;
  modelToolCallId?: string;
  providerMetadata?: Record<string, unknown>;
  requiresApproval?: boolean;
  result?: Record<string, unknown>;
  runId?: string;
  sessionId: string;
  status: ToolCallStatus;
  taskId?: string;
  toolName: ToolName;
  updatedAt: string;
};

export type ApprovalDto = {
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  decisionReasonText?: string;
  decisionScope?: 'once' | 'session_rule';
  id: string;
  kind: ApprovalKind;
  payload: Record<string, unknown>;
  runId?: string;
  sessionId: string;
  status: ApprovalStatus;
  suggestedRuleJson?: string;
  taskId?: string;
  toolCallId: string;
};
