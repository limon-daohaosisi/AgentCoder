import type { SessionCheckpoint } from '@opencode/shared';

type BuildSessionCheckpointInput = {
  approvalId?: string;
  kind: SessionCheckpoint['kind'];
  messageId?: string;
  modelToolCallId?: string;
  note?: string;
  partId?: string;
  taskId?: string;
  toolCallId?: string;
  updatedAt?: string;
};

export function buildSessionCheckpoint(
  input: BuildSessionCheckpointInput
): SessionCheckpoint {
  const checkpoint: SessionCheckpoint = {
    approvalId: input.approvalId,
    kind: input.kind,
    messageId: input.messageId,
    modelToolCallId: input.modelToolCallId,
    note: input.note,
    partId: input.partId,
    taskId: input.taskId,
    toolCallId: input.toolCallId,
    updatedAt: input.updatedAt ?? new Date().toISOString()
  };

  return checkpoint;
}

export function parseSessionCheckpoint(raw: null | string | undefined) {
  if (!raw) {
    return undefined;
  }

  try {
    return (JSON.parse(raw) as SessionCheckpoint | null) ?? undefined;
  } catch {
    return undefined;
  }
}
