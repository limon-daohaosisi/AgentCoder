import type { FileAttachment, ToolName } from '@opencode/shared';
import type * as z from 'zod';
import type {
  DiagnosticsProvider,
  ToolDiagnostic
} from './shared/diagnostics.js';
import type {
  FileSnapshotArtifact,
  FileSnapshotStore,
  FileSnapshotStoreLookup
} from './shared/file-snapshot.js';
import type { TaskDto } from '@opencode/shared';

export type ToolApproval = 'never' | 'required';

export type ToolOutputVisibility = 'content' | 'json_fields' | 'text_only';

export type ToolJsonFieldSpec = {
  as?: string;
  from: string;
  maxChars?: number;
};

export type ToolAttachmentPolicy = {
  allowedMimePrefixes?: string[];
  includeTextFallback?: boolean;
  maxAttachments?: number;
  visibleToModel: boolean;
};

export type ToolTextPolicy = {
  maxChars: number;
  visibleToModel: boolean;
};

export type ToolErrorVisibility = 'error_text_only' | 'execution_denied_only';

export type ToolErrorPolicy = {
  visibleToModel: ToolErrorVisibility;
};

export type ToolOutputPolicy = {
  attachments?: ToolAttachmentPolicy;
  errors?: ToolErrorPolicy;
  jsonFields?: ToolJsonFieldSpec[];
  mode: ToolOutputVisibility;
  text?: ToolTextPolicy;
};

export const DEFAULT_TOOL_OUTPUT_POLICY: ToolOutputPolicy = {
  attachments: { visibleToModel: false },
  errors: { visibleToModel: 'error_text_only' },
  mode: 'text_only',
  text: { maxChars: 8_000, visibleToModel: true }
};

export type ApprovalToolName = Extract<
  ToolName,
  'apply_patch' | 'bash' | 'edit' | 'plan_exit' | 'write'
>;

export type ToolPresentation = {
  attachments?: FileAttachment[];
  metadata?: Record<string, unknown>;
  outputText: string;
  payload?: Record<string, unknown>;
};

export type ToolServices = {
  collectDiagnostics?(paths: string[]): Promise<ToolDiagnostic[]>;
  createFileSnapshot?(input: {
    sessionId: string;
    snapshot: FileSnapshotArtifact;
    toolCallId: string;
  }): Promise<{ artifactId: string }>;
  getLatestFileSnapshot?(input: {
    path: string;
    requireFullRead?: boolean;
    sessionId: string;
  }): Promise<FileSnapshotStoreLookup | null>;
  registerReadTarget?(input: { filePath: string; sessionId: string }): void;
  getSessionTaskContext?(input: { sessionId: string }): Promise<{
    currentPlanId?: string;
    currentTaskId?: string;
    variant: 'build' | 'plan';
  }>;
  getSessionPlanContext?(input: { sessionId: string }): Promise<{
    filePath?: string;
    variant: 'build' | 'plan';
  }>;
  getSessionPlanApprovalPayload?(input: {
    sessionId: string;
    summary?: string;
  }): Promise<Record<string, unknown>>;
  taskCreate?(input: {
    acceptanceCriteria?: string[];
    description?: string;
    position?: number;
    sessionId: string;
    status?: 'ready' | 'todo';
    title: string;
  }): Promise<TaskDto>;
  taskGet?(input: {
    sessionId: string;
    taskId: string;
  }): Promise<TaskDto | null>;
  taskList?(input: { sessionId: string }): Promise<{
    currentTaskId?: string;
    tasks: TaskDto[];
  }>;
  taskStop?(input: {
    reason: string;
    sessionId: string;
    summaryText?: string;
    taskId: string;
  }): Promise<TaskDto>;
  taskUpdate?(input: {
    acceptanceCriteria?: string[];
    completedAt?: string | null;
    description?: string | null;
    lastErrorText?: string | null;
    position?: number;
    sessionId: string;
    startedAt?: string | null;
    status?:
      | 'blocked'
      | 'done'
      | 'failed'
      | 'ready'
      | 'running'
      | 'todo'
      | 'waiting_approval';
    summaryText?: string | null;
    taskId: string;
    title?: string;
  }): Promise<TaskDto>;
};

export type ToolExecutionContext = {
  abortSignal?: AbortSignal;
  diagnostics: DiagnosticsProvider;
  fileSnapshots: FileSnapshotStore;
  now(): string;
  planContext?: {
    filePath?: string;
    variant: 'build' | 'plan';
  };
  sessionId: string;
  services: ToolServices;
  toolCallId: string;
  workspaceRoot: string;
};

export type ToolDefinition<
  TInputSchema extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput extends Record<string, unknown> = Record<string, unknown>
> = {
  approval: ToolApproval;
  buildApproval?(input: {
    context: ToolExecutionContext;
    input: z.infer<TInputSchema>;
  }): Promise<Record<string, unknown>>;
  description: string;
  execute(input: {
    approvalPayload?: Record<string, unknown>;
    context: ToolExecutionContext;
    input: z.infer<TInputSchema>;
  }): Promise<TOutput>;
  inputSchema: TInputSchema;
  name: ToolName;
  outputPolicy?: ToolOutputPolicy;
  present(input: {
    context: ToolExecutionContext;
    input: z.infer<TInputSchema>;
    output: TOutput;
  }): ToolPresentation;
  resolveApproval?(input: {
    context: ToolExecutionContext;
    input: z.infer<TInputSchema>;
  }): Promise<ToolApproval>;
};

export const noOpDiagnosticsProvider: DiagnosticsProvider = {
  async collectForFiles() {
    return [];
  }
};

export const noOpFileSnapshotStore: FileSnapshotStore = {
  async create() {
    return { artifactId: '' };
  },
  async getLatestForPath() {
    return null;
  }
};

export async function buildToolExecutionContext(input: {
  now?: () => string;
  services?: ToolServices;
  signal?: AbortSignal;
  sessionId: string;
  toolCallId: string;
  workspaceRoot: string;
}): Promise<ToolExecutionContext> {
  const planContext = await input.services?.getSessionPlanContext?.({
    sessionId: input.sessionId
  });

  return {
    abortSignal: input.signal,
    diagnostics: {
      collectForFiles:
        input.services?.collectDiagnostics ??
        noOpDiagnosticsProvider.collectForFiles
    },
    fileSnapshots: {
      create:
        input.services?.createFileSnapshot ?? noOpFileSnapshotStore.create,
      getLatestForPath:
        input.services?.getLatestFileSnapshot ??
        noOpFileSnapshotStore.getLatestForPath
    },
    now: input.now ?? (() => new Date().toISOString()),
    planContext,
    sessionId: input.sessionId,
    services: input.services ?? {},
    toolCallId: input.toolCallId,
    workspaceRoot: input.workspaceRoot
  };
}

export type AnyToolDefinition = ToolDefinition<
  z.ZodTypeAny,
  Record<string, unknown>
>;
