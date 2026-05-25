import type {
  AgentRunDto,
  ApprovalDto,
  MessageDto,
  MessagePart,
  SessionRevertDto,
  ToolCallDto
} from './dto.js';

export type MessagePartDeltaField = 'text' | 'reasoning.text';

export type SessionEvent =
  | { type: 'run.created'; sessionId: string; run: AgentRunDto }
  | { type: 'run.completed'; sessionId: string; run: AgentRunDto }
  | {
      type: 'run.cancelled';
      sessionId: string;
      run: AgentRunDto;
      reason: string;
    }
  | { type: 'run.blocked'; sessionId: string; run: AgentRunDto; error: string }
  | { type: 'run.failed'; sessionId: string; run: AgentRunDto; error: string }
  | { type: 'message.created'; sessionId: string; message: MessageDto }
  | {
      type: 'message.part.created';
      sessionId: string;
      messageId: string;
      part: MessagePart;
      runId?: string;
    }
  | {
      type: 'message.part.delta';
      sessionId: string;
      messageId: string;
      partId: string;
      field: MessagePartDeltaField;
      delta: string;
      runId?: string;
    }
  | {
      type: 'message.part.updated';
      sessionId: string;
      messageId: string;
      part: MessagePart;
      runId?: string;
    }
  | {
      type: 'message.completed';
      sessionId: string;
      messageId: string;
      runId?: string;
    }
  | {
      type: 'message.cancelled';
      sessionId: string;
      messageId: string;
      runId?: string;
    }
  | {
      type: 'tool.pending';
      sessionId: string;
      toolCall: ToolCallDto;
      approval: ApprovalDto;
      runId?: string;
    }
  | {
      type: 'approval.created';
      sessionId: string;
      approval: ApprovalDto;
      runId?: string;
    }
  | {
      type: 'approval.resolved';
      sessionId: string;
      approvalId: string;
      decision: 'approved' | 'rejected';
      runId?: string;
    }
  | {
      type: 'tool.running';
      sessionId: string;
      toolCallId: string;
      runId?: string;
    }
  | {
      type: 'tool.completed';
      sessionId: string;
      toolCall: ToolCallDto;
      runId?: string;
    }
  | {
      type: 'tool.failed';
      sessionId: string;
      toolCallId: string;
      error: string;
      runId?: string;
    }
  | {
      type: 'session.recovered';
      diagnostics?: string[];
      interruptedRunIds: string[];
      keptWaitingApprovalRunIds?: string[];
      reason:
        | 'invalid_waiting_approval_checkpoint'
        | 'multiple_open_runs'
        | 'server_startup_recovery'
        | 'stale_executing_session';
      recoveredAt: string;
      sessionId: string;
    }
  | {
      type: 'session.resumable';
      sessionId: string;
      checkpoint: unknown;
      runId?: string;
    }
  | {
      type: 'session.reverted';
      revert: SessionRevertDto;
      sessionId: string;
    }
  | {
      type: 'session.revert_restored';
      sessionId: string;
    }
  | {
      type: 'session.updated';
      sessionId: string;
      updatedAt?: string;
      timestamp?: string;
      runId?: string;
    };

export type SessionEventEnvelope = {
  createdAt: string;
  event: SessionEvent;
  sequenceNo: number;
};
