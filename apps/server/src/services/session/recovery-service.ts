import type {
  ApprovalDto,
  MessagePart,
  SessionCheckpoint,
  SessionDto,
  SessionEventEnvelope,
  ToolCallDto
} from '@opencode/shared';
import { parseSessionCheckpoint, validateApprovalResume } from '@opencode/agent';
import { sessionRecoveryRepository } from '../../repositories/session-recovery-repository.js';
import { approvalRepository } from '../../repositories/approval-repository.js';
import { sessionEventService } from '../session-events/event-service.js';
import { messagePartService } from './message/part-service.js';

type StartupRecoveryReport = {
  blockedRuns: number;
  blockedSessions: number;
  interruptedRuns: number;
  multipleOpenRunSessions: number;
  recoveredAt: string;
  staleExecutingSessions: number;
  waitingApprovalsKept: number;
};

type WaitingApprovalValidation =
  | {
      approval: ApprovalDto;
      checkpoint: SessionCheckpoint;
      kind: 'valid';
      part: Extract<MessagePart, { type: 'tool' }>;
      toolCall: ToolCallDto;
    }
  | { error: string; kind: 'invalid' };

type SessionRecoveryDecision =
  | {
      clearCheckpointRunIds?: string[];
      diagnostics: string[];
      interruptedRunIds: string[];
      keptWaitingApprovalRunIds?: string[];
      kind: 'recover_interrupted';
      sessionStatus: 'blocked' | 'idle' | 'waiting_approval';
    }
  | {
      blockedRunIds: string[];
      clearCheckpointRunIds?: string[];
      diagnostics: string[];
      interruptedRunIds?: string[];
      kind: 'block_invalid_waiting_approval';
    }
  | {
      diagnostics: string[];
      keptWaitingApprovalRunIds: string[];
      kind: 'keep_waiting_approval';
      reason: 'multiple_open_runs' | 'server_startup_recovery';
    };

const interruptedRunErrorText = 'Previous run was interrupted by server restart.';
const invalidWaitingApprovalErrorText =
  'Invalid waiting approval checkpoint during startup recovery.';
const staleExecutingErrorText =
  'Session was left in executing state without an active run.';
const staleWaitingApprovalErrorText =
  'Session was left in waiting approval state without an active run.';

function composeErrorText(base: string, diagnostics: string[]) {
  if (diagnostics.length === 0) {
    return base;
  }

  return `${base} Diagnostics: ${diagnostics.join(' | ')}`;
}

function buildDiagnosticsPrefix(session: SessionDto) {
  return `session=${session.id}`;
}

function validateWaitingApprovalRun(input: {
  checkpoint: SessionCheckpoint | undefined;
  part?: MessagePart | null;
  pendingApprovals: ApprovalDto[];
  session: SessionDto;
  toolCall?: ToolCallDto | null;
}): WaitingApprovalValidation {
  const approval = input.pendingApprovals[0];

  if (!approval) {
    return {
      error: 'Expected one pending approval, found 0.',
      kind: 'invalid'
    };
  }

  if (input.pendingApprovals.length !== 1) {
    return {
      error: `Expected one pending approval, found ${input.pendingApprovals.length}.`,
      kind: 'invalid'
    };
  }

  if (!input.toolCall) {
    return {
      error: 'Session checkpoint does not match approval.',
      kind: 'invalid'
    };
  }

  if (input.toolCall.status !== 'pending_approval') {
    return {
      error: 'Tool call is no longer waiting for approval.',
      kind: 'invalid'
    };
  }

  const validation = validateApprovalResume({
    approval,
    checkpoint: input.checkpoint,
    part: input.part,
    pendingApprovals: input.pendingApprovals,
    session: input.session,
    toolCall: input.toolCall
  });

  if (!validation.ok) {
    return { error: validation.reason, kind: 'invalid' };
  }

  return {
    approval,
    checkpoint: validation.context.checkpoint,
    kind: 'valid',
    part: validation.context.part,
    toolCall: validation.context.toolCall
  };
}

function decideSessionRecovery(input: {
  openRuns: ReturnType<
    typeof sessionRecoveryRepository.listSessionsWithOpenRuns
  >[number]['openRuns'];
  session: SessionDto;
}): SessionRecoveryDecision {
  const diagnostics: string[] = [];
  const invalidDiagnostics: string[] = [];
  const interruptedRunIds: string[] = [];
  const blockedRunIds: string[] = [];
  const clearCheckpointRunIds: string[] = [];
  const keptWaitingApprovalRunIds: string[] = [];
  const prefix = buildDiagnosticsPrefix(input.session);
  const multipleOpenRuns = input.openRuns.length > 1;

  if (multipleOpenRuns) {
    diagnostics.push(`${prefix}: multiple_open_runs`);
  }

  for (const candidate of input.openRuns) {
    const { run } = candidate;

    if (run.status === 'waiting_approval') {
      blockedRunIds.push(run.id);
      const checkpoint = parseSessionCheckpoint(run.lastCheckpointJson);
      const sessionCheckpoint = parseSessionCheckpoint(input.session.lastCheckpointJson);

      if (!sessionCheckpoint) {
        invalidDiagnostics.push(
          `${prefix}: run=${run.id} invalid_waiting_approval_checkpoint: Session checkpoint does not match approval.`
        );
        continue;
      }

      if (
        checkpoint?.kind !== sessionCheckpoint.kind ||
        checkpoint?.approvalId !== sessionCheckpoint.approvalId ||
        checkpoint?.messageId !== sessionCheckpoint.messageId ||
        checkpoint?.modelToolCallId !== sessionCheckpoint.modelToolCallId ||
        checkpoint?.partId !== sessionCheckpoint.partId ||
        checkpoint?.toolCallId !== sessionCheckpoint.toolCallId
      ) {
        invalidDiagnostics.push(
          `${prefix}: run=${run.id} invalid_waiting_approval_checkpoint: Session checkpoint does not match approval.`
        );
        continue;
      }

      const part = checkpoint?.partId
        ? messagePartService.getPart(checkpoint.partId)
        : null;
      const toolCall = checkpoint?.toolCallId
        ? candidate.openToolCalls.find((openCall) => openCall.id === checkpoint.toolCallId) ??
          null
        : null;
      const validation = validateWaitingApprovalRun({
        checkpoint,
        part,
        pendingApprovals: approvalRepository.listPendingBySession(input.session.id),
        session: input.session,
        toolCall
      });

      if (validation.kind === 'valid') {
        keptWaitingApprovalRunIds.push(run.id);
        continue;
      }

      invalidDiagnostics.push(
        `${prefix}: run=${run.id} invalid_waiting_approval_checkpoint: ${validation.error}`
      );
      continue;
    }

    interruptedRunIds.push(run.id);
    blockedRunIds.push(run.id);
    clearCheckpointRunIds.push(run.id);
  }

  if (invalidDiagnostics.length > 0) {
    return {
      blockedRunIds,
      clearCheckpointRunIds,
      diagnostics: [...diagnostics, ...invalidDiagnostics],
      interruptedRunIds,
      kind: 'block_invalid_waiting_approval'
    };
  }

  if (interruptedRunIds.length > 0) {
    return {
      clearCheckpointRunIds,
      diagnostics,
      interruptedRunIds,
      keptWaitingApprovalRunIds:
        keptWaitingApprovalRunIds.length > 0 ? keptWaitingApprovalRunIds : undefined,
      kind: 'recover_interrupted',
      sessionStatus:
        keptWaitingApprovalRunIds.length > 0 ? 'waiting_approval' : 'idle'
    };
  }

  return {
    diagnostics,
    keptWaitingApprovalRunIds,
    kind: 'keep_waiting_approval',
    reason: multipleOpenRuns ? 'multiple_open_runs' : 'server_startup_recovery'
  };
}

function publishRecoveryEnvelopes(envelopes: Iterable<SessionEventEnvelope>) {
  sessionEventService.publishPersistedMany(envelopes);
}

export const sessionRecoveryService = {
  recoverInterruptedSessionsOnStartup(): StartupRecoveryReport {
    const recoveredAt = new Date().toISOString();
    const report: StartupRecoveryReport = {
      blockedRuns: 0,
      blockedSessions: 0,
      interruptedRuns: 0,
      multipleOpenRunSessions: 0,
      recoveredAt,
      staleExecutingSessions: 0,
      waitingApprovalsKept: 0
    };

    for (const candidate of sessionRecoveryRepository.listSessionsWithOpenRuns()) {
      try {
        const decision = decideSessionRecovery(candidate);

        if (candidate.openRuns.length > 1) {
          report.multipleOpenRunSessions += 1;
        }

        switch (decision.kind) {
          case 'block_invalid_waiting_approval': {
            const result = sessionRecoveryRepository.blockInvalidWaitingApproval({
              blockedRunIds: decision.blockedRunIds,
              clearCheckpointRunIds: decision.clearCheckpointRunIds,
              diagnostics: decision.diagnostics,
              errorText: composeErrorText(
                invalidWaitingApprovalErrorText,
                decision.diagnostics
              ),
              interruptedRunIds: decision.interruptedRunIds,
              recoveredAt,
              sessionId: candidate.session.id
            });

            report.blockedRuns += result.blockedRuns.length;
            report.blockedSessions += result.session?.status === 'blocked' ? 1 : 0;
            report.interruptedRuns += decision.interruptedRunIds?.length ?? 0;
            publishRecoveryEnvelopes(result.envelopes);
            break;
          }
          case 'recover_interrupted': {
            const result = sessionRecoveryRepository.recoverInterruptedRuns({
              clearSessionCheckpoint: decision.sessionStatus !== 'waiting_approval',
              diagnostics: decision.diagnostics,
              errorText: composeErrorText(
                interruptedRunErrorText,
                decision.diagnostics
              ),
              interruptedRunIds: decision.interruptedRunIds,
              keptWaitingApprovalRunIds: decision.keptWaitingApprovalRunIds,
              reason:
                candidate.openRuns.length > 1
                  ? 'multiple_open_runs'
                  : 'server_startup_recovery',
              recoveredAt,
              sessionId: candidate.session.id,
              sessionStatus: decision.sessionStatus
            });

            report.blockedRuns += result.blockedRuns.length;
            report.interruptedRuns += decision.interruptedRunIds.length;
            report.waitingApprovalsKept +=
              decision.keptWaitingApprovalRunIds?.length ?? 0;
            publishRecoveryEnvelopes(result.envelopes);
            break;
          }
          case 'keep_waiting_approval': {
            const result = sessionRecoveryRepository.keepWaitingApproval({
              diagnostics: decision.diagnostics,
              keptWaitingApprovalRunIds: decision.keptWaitingApprovalRunIds,
              reason: decision.reason,
              recoveredAt,
              sessionId: candidate.session.id
            });

            report.waitingApprovalsKept += decision.keptWaitingApprovalRunIds.length;
            publishRecoveryEnvelopes(result.envelopes);
            break;
          }
        }
      } catch (error) {
        console.error(
          `Startup recovery failed for session ${candidate.session.id}:`,
          error
        );
      }
    }

    for (const session of sessionRecoveryRepository.listStaleExecutingSessions()) {
      try {
        const diagnostics = [
          `${buildDiagnosticsPrefix(session)}: stale_executing_session`
        ];
        const result = sessionRecoveryRepository.recoverStaleSession({
          diagnostics,
          errorText: composeErrorText(staleExecutingErrorText, diagnostics),
          reason: 'stale_executing_session',
          recoveredAt,
          sessionId: session.id,
          status: 'idle'
        });

        report.staleExecutingSessions += 1;
        publishRecoveryEnvelopes(result.envelopes);
      } catch (error) {
        console.error(
          `Startup recovery failed for stale executing session ${session.id}:`,
          error
        );
      }
    }

    for (const session of sessionRecoveryRepository.listStaleWaitingApprovalSessions()) {
      try {
        const diagnostics = [
          `${buildDiagnosticsPrefix(session)}: stale_waiting_approval_session`
        ];
        const result = sessionRecoveryRepository.recoverStaleSession({
          diagnostics,
          errorText: composeErrorText(staleWaitingApprovalErrorText, diagnostics),
          reason: 'invalid_waiting_approval_checkpoint',
          recoveredAt,
          sessionId: session.id,
          status: 'blocked'
        });

        report.blockedSessions += result.session?.status === 'blocked' ? 1 : 0;
        publishRecoveryEnvelopes(result.envelopes);
      } catch (error) {
        console.error(
          `Startup recovery failed for stale waiting approval session ${session.id}:`,
          error
        );
      }
    }

    return report;
  }
};

export type { StartupRecoveryReport };
