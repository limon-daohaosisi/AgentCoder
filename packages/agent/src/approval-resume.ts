import type {
  ApprovalDto,
  MessagePart,
  SessionCheckpoint,
  SessionDto,
  ToolCallDto
} from '@opencode/shared';

export type ApprovalResumeContext = {
  approval: ApprovalDto;
  checkpoint: SessionCheckpoint;
  part: Extract<MessagePart, { type: 'tool' }>;
  session: SessionDto;
  toolCall: ToolCallDto;
};

export type ApprovalResumeValidationResult =
  | { context: ApprovalResumeContext; ok: true }
  | { ok: false; reason: string };

export type ApprovalResumeValidationInput = {
  approval?: ApprovalDto | null;
  checkpoint?: SessionCheckpoint;
  part?: MessagePart | null;
  pendingApprovals?: readonly ApprovalDto[];
  session: SessionDto;
  toolCall?: ToolCallDto | null;
};

function isPendingApprovalToolCall(toolCall: ToolCallDto) {
  return (
    toolCall.status === 'pending_approval' || toolCall.status === 'pending'
  );
}

function hasApprovalCheckpointFields(
  checkpoint: SessionCheckpoint | undefined
): checkpoint is SessionCheckpoint & {
  approvalId: string;
  messageId: string;
  modelToolCallId: string;
  partId: string;
  toolCallId: string;
} {
  return Boolean(
    checkpoint?.kind === 'waiting_approval' &&
    checkpoint.approvalId &&
    checkpoint.messageId &&
    checkpoint.modelToolCallId &&
    checkpoint.partId &&
    checkpoint.toolCallId
  );
}

export function validateApprovalResume(
  input: ApprovalResumeValidationInput
): ApprovalResumeValidationResult {
  if (input.session.status !== 'waiting_approval') {
    return { ok: false, reason: 'Session is not waiting for approval.' };
  }

  if (!hasApprovalCheckpointFields(input.checkpoint)) {
    return {
      ok: false,
      reason: 'Session checkpoint does not match approval.'
    };
  }

  if (!input.approval) {
    return {
      ok: false,
      reason: 'Session checkpoint does not match approval.'
    };
  }

  if (input.approval.status !== 'pending') {
    return { ok: false, reason: 'Approval has already been decided.' };
  }

  if (input.pendingApprovals) {
    if (input.pendingApprovals.length !== 1) {
      return {
        ok: false,
        reason: `Expected one pending approval, found ${input.pendingApprovals.length}.`
      };
    }

    if (input.pendingApprovals[0]?.id !== input.approval.id) {
      return {
        ok: false,
        reason: 'Pending approval does not match session checkpoint.'
      };
    }
  }

  if (
    input.checkpoint.approvalId !== input.approval.id ||
    input.approval.sessionId !== input.session.id ||
    input.approval.toolCallId !== input.checkpoint.toolCallId
  ) {
    return {
      ok: false,
      reason: 'Session checkpoint does not match approval.'
    };
  }

  if (!input.toolCall) {
    return {
      ok: false,
      reason: 'Session checkpoint does not match approval.'
    };
  }

  if (input.toolCall.sessionId !== input.approval.sessionId) {
    return {
      ok: false,
      reason: 'Approval and tool call session mismatch.'
    };
  }

  if (input.toolCall.id !== input.approval.toolCallId) {
    return { ok: false, reason: 'Approval does not match tool call.' };
  }

  if (!input.toolCall.requiresApproval) {
    return { ok: false, reason: 'Tool call does not require approval.' };
  }

  if (!isPendingApprovalToolCall(input.toolCall)) {
    return {
      ok: false,
      reason: 'Tool call is no longer waiting for approval.'
    };
  }

  if (
    input.toolCall.messageId !== input.checkpoint.messageId ||
    input.toolCall.messagePartId !== input.checkpoint.partId ||
    input.toolCall.modelToolCallId !== input.checkpoint.modelToolCallId ||
    input.toolCall.sessionId !== input.session.id
  ) {
    return {
      ok: false,
      reason: 'Session checkpoint does not match approval.'
    };
  }

  if (!input.part || input.part.type !== 'tool') {
    return {
      ok: false,
      reason: `Pending ToolPart not found: ${input.checkpoint.partId}`
    };
  }

  if (input.part.state.status !== 'pending') {
    return { ok: false, reason: 'Approval ToolPart is no longer pending.' };
  }

  if (
    input.part.id !== input.checkpoint.partId ||
    input.part.messageId !== input.checkpoint.messageId ||
    input.part.toolCallId !== input.checkpoint.toolCallId ||
    input.part.modelToolCallId !== input.checkpoint.modelToolCallId ||
    input.part.toolCallId !== input.toolCall.id ||
    input.part.id !== input.toolCall.messagePartId ||
    input.part.messageId !== input.toolCall.messageId ||
    input.part.modelToolCallId !== input.toolCall.modelToolCallId ||
    input.part.sessionId !== input.toolCall.sessionId ||
    input.part.sessionId !== input.session.id ||
    input.part.toolName !== input.toolCall.toolName ||
    input.part.toolName !== input.approval.kind
  ) {
    return {
      ok: false,
      reason: 'Approval checkpoint does not match ToolPart.'
    };
  }

  return {
    context: {
      approval: input.approval,
      checkpoint: input.checkpoint,
      part: input.part,
      session: input.session,
      toolCall: input.toolCall
    },
    ok: true
  };
}
