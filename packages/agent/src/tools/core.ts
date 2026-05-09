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

export type ToolApproval = 'never' | 'required';

export type ApprovalToolName = Extract<
  ToolName,
  'apply_patch' | 'bash' | 'edit' | 'write'
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
};

export type ToolExecutionContext = {
  abortSignal?: AbortSignal;
  diagnostics: DiagnosticsProvider;
  fileSnapshots: FileSnapshotStore;
  now(): string;
  sessionId: string;
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
  present(input: {
    context: ToolExecutionContext;
    input: z.infer<TInputSchema>;
    output: TOutput;
  }): ToolPresentation;
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

export function buildToolExecutionContext(input: {
  now?: () => string;
  services?: ToolServices;
  signal?: AbortSignal;
  sessionId: string;
  toolCallId: string;
  workspaceRoot: string;
}): ToolExecutionContext {
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
    sessionId: input.sessionId,
    toolCallId: input.toolCallId,
    workspaceRoot: input.workspaceRoot
  };
}

export type AnyToolDefinition = ToolDefinition<
  z.ZodTypeAny,
  Record<string, unknown>
>;
