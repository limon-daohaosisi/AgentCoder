import type {
  AgentRunDto,
  ApprovalDto,
  MessageDto,
  ToolCallDto
} from './dto.js';

export type SessionEvent =
  | { type: 'run.created'; sessionId: string; run: AgentRunDto }
  | { type: 'run.completed'; sessionId: string; run: AgentRunDto }
  | {
      type: 'run.cancelled';
      sessionId: string;
      run: AgentRunDto;
      reason: string;
    }
  | { type: 'run.failed'; sessionId: string; run: AgentRunDto; error: string }
  | { type: 'message.created'; sessionId: string; message: MessageDto }
  | {
      type: 'message.delta';
      sessionId: string;
      messageId: string;
      delta: string;
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
  | { type: 'session.failed'; sessionId: string; error: string; runId?: string }
  | {
      type: 'session.resumable';
      sessionId: string;
      checkpoint: unknown;
      runId?: string;
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
