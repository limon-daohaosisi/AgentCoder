import {
  agentRuns,
  approvals,
  messages,
  messageParts,
  sessions,
  sessionEvents,
  toolCalls
} from '@opencode/orm';
import type {
  AgentRunRow,
  ApprovalRow,
  MessagePartRow,
  MessageRow,
  SessionRow,
  ToolCallRow
} from '@opencode/orm';
import type {
  AgentRunDto,
  AgentRunStatus,
  ApprovalDto,
  ApprovalStatus,
  MessageDto,
  MessagePart,
  MessageRuntimeMetadata,
  MessageStatus,
  SessionDto,
  SessionEvent,
  SessionEventEnvelope,
  SessionStatus,
  TokenUsageDto,
  ToolCallDto,
  ToolCallStatus
} from '@opencode/shared';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { Database } from '../db/runtime.js';
import { parseJsonValue, stringifyJsonValue } from '../lib/json.js';

const openRunStatuses: AgentRunStatus[] = ['running', 'waiting_approval'];
const openToolCallStatuses: ToolCallStatus[] = [
  'pending',
  'pending_approval',
  'approved',
  'running'
];

export type StartupRecoveryRunCandidate = {
  openToolCalls: ToolCallDto[];
  openToolParts: Extract<MessagePart, { type: 'tool' }>[];
  pendingApprovals: ApprovalDto[];
  run: AgentRunDto;
  runningMessages: MessageDto[];
};

export type StartupRecoverySessionCandidate = {
  openRuns: StartupRecoveryRunCandidate[];
  session: SessionDto;
};

type RecoveryReason = Extract<
  SessionEvent,
  { type: 'session.recovered' }
>['reason'];

type AppendRecoveryEventInput = {
  createdAt: string;
  detailText?: null | string;
  entityId?: null | string;
  entityType?: null | string;
  event: SessionEvent;
  headline?: null | string;
  level?: 'debug' | 'error' | 'info' | 'warning';
  runId?: null | string;
  sessionId: string;
};

type RecoverInterruptedRunsInput = {
  clearSessionCheckpoint: boolean;
  diagnostics: string[];
  errorText: string;
  interruptedRunIds: string[];
  keptWaitingApprovalRunIds?: string[];
  reason: RecoveryReason;
  recoveredAt: string;
  sessionId: string;
  sessionStatus: Extract<
    SessionStatus,
    'blocked' | 'idle' | 'waiting_approval'
  >;
};

type BlockInvalidWaitingApprovalInput = {
  blockedRunIds: string[];
  clearCheckpointRunIds?: string[];
  diagnostics: string[];
  errorText: string;
  interruptedRunIds?: string[];
  recoveredAt: string;
  sessionId: string;
};

type KeepWaitingApprovalInput = {
  diagnostics: string[];
  keptWaitingApprovalRunIds: string[];
  reason: RecoveryReason;
  recoveredAt: string;
  sessionId: string;
};

type RecoverStaleSessionInput = {
  diagnostics: string[];
  errorText: string;
  reason: RecoveryReason;
  recoveredAt: string;
  sessionId: string;
  status: Extract<SessionStatus, 'blocked' | 'idle'>;
};

type RecoveryWriteResult = {
  blockedRuns: AgentRunDto[];
  envelopes: SessionEventEnvelope[];
  session: SessionDto | null;
};

function mapNullableString(value: null | string) {
  return value ?? undefined;
}

function mapNullableRecord(value: null | string) {
  return value ? parseJsonValue<Record<string, unknown>>(value, {}) : undefined;
}

function mapSessionRow(row: SessionRow): SessionDto {
  return {
    archivedAt: mapNullableString(row.archivedAt),
    createdAt: row.createdAt,
    currentPlanId: mapNullableString(row.currentPlanId),
    currentTaskId: mapNullableString(row.currentTaskId),
    goalText: row.goalText,
    id: row.id,
    lastCheckpointJson: mapNullableString(row.lastCheckpointJson),
    lastErrorText: mapNullableString(row.lastErrorText),
    status: row.status as SessionStatus,
    title: row.title,
    updatedAt: row.updatedAt,
    workspaceId: row.workspaceId
  };
}

function mapAgentRunRow(row: AgentRunRow): AgentRunDto {
  return {
    cancelledAt: mapNullableString(row.cancelledAt),
    createdAt: row.createdAt,
    endedAt: mapNullableString(row.endedAt),
    errorText: mapNullableString(row.errorText),
    id: row.id,
    lastCheckpointJson: mapNullableString(row.lastCheckpointJson),
    sessionId: row.sessionId,
    startedAt: row.startedAt,
    status: row.status as AgentRunStatus,
    triggerMessageId: mapNullableString(row.triggerMessageId),
    updatedAt: row.updatedAt
  };
}

function mapMessageRow(row: MessageRow): MessageDto {
  const providerMetadata = row.providerMetadataJson
    ? parseJsonValue<Record<string, unknown>>(row.providerMetadataJson, {})
    : undefined;
  const runtime = row.runtimeJson
    ? parseJsonValue<MessageRuntimeMetadata>(row.runtimeJson, {})
    : undefined;
  const tokenUsage = row.tokenUsageJson
    ? parseJsonValue<TokenUsageDto>(row.tokenUsageJson, {
        input: 0,
        output: 0
      })
    : undefined;

  return {
    agentName: mapNullableString(row.agentName),
    compactedByMessageId: mapNullableString(row.compactedByMessageId),
    content: parseJsonValue<MessagePart[]>(row.contentJson, []),
    createdAt: row.createdAt,
    errorText: mapNullableString(row.errorText),
    finishReason: mapNullableString(row.finishReason),
    id: row.id,
    kind: 'message',
    model:
      row.modelProviderId && row.modelId
        ? {
            modelId: row.modelId,
            providerId: row.modelProviderId
          }
        : undefined,
    modelResponseId: mapNullableString(row.modelResponseId),
    parentMessageId: mapNullableString(row.parentMessageId),
    providerMetadata,
    role: row.role as MessageDto['role'],
    runId: mapNullableString(row.runId),
    runtime,
    sessionId: row.sessionId,
    status: row.status as MessageStatus,
    summary: row.summary === 1 ? true : undefined,
    tokenUsage,
    updatedAt: row.updatedAt
  };
}

function mapMessagePartRow(row: MessagePartRow): MessagePart {
  return parseJsonValue<MessagePart>(row.dataJson, {
    createdAt: row.createdAt,
    id: row.id,
    messageId: row.messageId,
    order: row.orderIndex,
    sessionId: row.sessionId,
    text: '',
    type: 'text',
    updatedAt: row.updatedAt
  });
}

function mapToolCallRow(row: ToolCallRow): ToolCallDto {
  return {
    createdAt: row.createdAt,
    errorText: mapNullableString(row.errorText),
    id: row.id,
    input: parseJsonValue<Record<string, unknown>>(row.inputJson, {}),
    messageId: mapNullableString(row.messageId),
    messagePartId: mapNullableString(row.messagePartId),
    modelToolCallId: mapNullableString(row.modelToolCallId),
    providerMetadata: mapNullableRecord(row.providerMetadataJson),
    requiresApproval: row.requiresApproval === 1,
    result: mapNullableRecord(row.resultJson),
    runId: mapNullableString(row.runId),
    sessionId: row.sessionId,
    status: row.status as ToolCallStatus,
    toolName: row.toolName as ToolCallDto['toolName'],
    updatedAt: row.updatedAt
  };
}

function mapApprovalRow(row: ApprovalRow): ApprovalDto {
  return {
    createdAt: row.createdAt,
    decidedAt: mapNullableString(row.decidedAt),
    decidedBy: mapNullableString(row.decidedBy),
    decisionReasonText: mapNullableString(row.decisionReasonText),
    decisionScope: row.decisionScope as ApprovalDto['decisionScope'],
    id: row.id,
    kind: row.kind as ApprovalDto['kind'],
    payload: parseJsonValue<Record<string, unknown>>(row.payloadJson, {}),
    runId: mapNullableString(row.runId),
    sessionId: row.sessionId,
    status: row.status as ApprovalStatus,
    suggestedRuleJson: mapNullableString(row.suggestedRuleJson),
    taskId: mapNullableString(row.taskId),
    toolCallId: row.toolCallId
  };
}

function listRunningMessagesByRun(runId: string): MessageDto[] {
  return Database.use((db) =>
    db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.runId, runId),
          eq(messages.role, 'assistant'),
          eq(messages.status, 'running')
        )
      )
      .orderBy(asc(messages.createdAt), asc(messages.id))
      .all()
      .map(mapMessageRow)
  );
}

function listOpenToolPartsByRun(
  runId: string
): Extract<MessagePart, { type: 'tool' }>[] {
  return Database.use((db) =>
    db
      .select()
      .from(messageParts)
      .where(and(eq(messageParts.runId, runId), eq(messageParts.type, 'tool')))
      .orderBy(asc(messageParts.createdAt), asc(messageParts.id))
      .all()
      .map(mapMessagePartRow)
      .filter(
        (part): part is Extract<MessagePart, { type: 'tool' }> =>
          part.type === 'tool' &&
          (part.state.status === 'pending' || part.state.status === 'running')
      )
  );
}

function listOpenToolCallsByRun(runId: string): ToolCallDto[] {
  return Database.use((db) =>
    db
      .select()
      .from(toolCalls)
      .where(
        and(
          eq(toolCalls.runId, runId),
          inArray(toolCalls.status, openToolCallStatuses)
        )
      )
      .orderBy(asc(toolCalls.createdAt), asc(toolCalls.id))
      .all()
      .map(mapToolCallRow)
  );
}

function listPendingApprovalsByRun(runId: string): ApprovalDto[] {
  return Database.use((db) =>
    db
      .select()
      .from(approvals)
      .where(and(eq(approvals.runId, runId), eq(approvals.status, 'pending')))
      .orderBy(asc(approvals.createdAt), asc(approvals.id))
      .all()
      .map(mapApprovalRow)
  );
}

function appendRecoveredEvent(input: {
  diagnostics: string[];
  interruptedRunIds: string[];
  keptWaitingApprovalRunIds?: string[];
  reason: RecoveryReason;
  recoveredAt: string;
  sessionId: string;
}): SessionEvent {
  return {
    diagnostics: input.diagnostics.length > 0 ? input.diagnostics : undefined,
    interruptedRunIds: input.interruptedRunIds,
    keptWaitingApprovalRunIds:
      input.keptWaitingApprovalRunIds &&
      input.keptWaitingApprovalRunIds.length > 0
        ? input.keptWaitingApprovalRunIds
        : undefined,
    reason: input.reason,
    recoveredAt: input.recoveredAt,
    sessionId: input.sessionId,
    type: 'session.recovered'
  };
}

function appendRecoveryEvent(
  envelopes: SessionEventEnvelope[],
  input: AppendRecoveryEventInput
): SessionEventEnvelope {
  return Database.use((db) => {
    const previous = db
      .select({ sequenceNo: sessionEvents.sequenceNo })
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, input.sessionId))
      .orderBy(desc(sessionEvents.sequenceNo))
      .get();
    const sequenceNo = (previous?.sequenceNo ?? 0) + 1;

    db.insert(sessionEvents)
      .values({
        createdAt: input.createdAt,
        detailText: input.detailText ?? null,
        entityId: input.entityId ?? null,
        entityType: input.entityType ?? null,
        headline: input.headline ?? null,
        id: `${input.sessionId}:${sequenceNo}`,
        level: input.level ?? 'info',
        payloadJson: stringifyJsonValue(input.event),
        runId: input.runId ?? null,
        sequenceNo,
        sessionId: input.sessionId,
        taskId: null,
        type: input.event.type
      })
      .run();

    const envelope = {
      createdAt: input.createdAt,
      event: input.event,
      sequenceNo
    };
    envelopes.push(envelope);
    return envelope;
  });
}

export const sessionRecoveryRepository = {
  listSessionsWithOpenRuns(): StartupRecoverySessionCandidate[] {
    const runs = Database.use((db) =>
      db
        .select()
        .from(agentRuns)
        .where(inArray(agentRuns.status, openRunStatuses))
        .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
        .all()
    );
    const candidates = new Map<string, StartupRecoverySessionCandidate>();

    for (const runRow of runs) {
      const sessionRow = Database.use((db) =>
        db
          .select()
          .from(sessions)
          .where(eq(sessions.id, runRow.sessionId))
          .get()
      );

      if (!sessionRow) {
        continue;
      }

      const candidate =
        candidates.get(runRow.sessionId) ??
        ({
          openRuns: [],
          session: mapSessionRow(sessionRow)
        } satisfies StartupRecoverySessionCandidate);

      candidate.openRuns.push({
        openToolCalls: listOpenToolCallsByRun(runRow.id),
        openToolParts: listOpenToolPartsByRun(runRow.id),
        pendingApprovals: listPendingApprovalsByRun(runRow.id),
        run: mapAgentRunRow(runRow),
        runningMessages: listRunningMessagesByRun(runRow.id)
      });
      candidates.set(runRow.sessionId, candidate);
    }

    return [...candidates.values()];
  },

  listStaleExecutingSessions(): SessionDto[] {
    const openSessionIds = new Set(
      Database.use((db) =>
        db
          .select({ sessionId: agentRuns.sessionId })
          .from(agentRuns)
          .where(inArray(agentRuns.status, openRunStatuses))
          .all()
          .map((row) => row.sessionId)
      )
    );

    return Database.use((db) =>
      db
        .select()
        .from(sessions)
        .where(eq(sessions.status, 'executing'))
        .orderBy(desc(sessions.updatedAt), desc(sessions.id))
        .all()
        .filter((session) => !openSessionIds.has(session.id))
        .map(mapSessionRow)
    );
  },

  listStaleWaitingApprovalSessions(): SessionDto[] {
    const openSessionIds = new Set(
      Database.use((db) =>
        db
          .select({ sessionId: agentRuns.sessionId })
          .from(agentRuns)
          .where(inArray(agentRuns.status, openRunStatuses))
          .all()
          .map((row) => row.sessionId)
      )
    );

    return Database.use((db) =>
      db
        .select()
        .from(sessions)
        .where(eq(sessions.status, 'waiting_approval'))
        .orderBy(desc(sessions.updatedAt), desc(sessions.id))
        .all()
        .filter((session) => !openSessionIds.has(session.id))
        .map(mapSessionRow)
    );
  },

  recoverInterruptedRuns(
    input: RecoverInterruptedRunsInput
  ): RecoveryWriteResult {
    return Database.transaction(() => {
      return Database.use((db) => {
        const envelopes: SessionEventEnvelope[] = [];
        const blockedRuns: AgentRunDto[] = [];

        for (const runId of input.interruptedRunIds) {
          const runRow = db
            .update(agentRuns)
            .set({
              endedAt: input.recoveredAt,
              errorText: input.errorText,
              lastCheckpointJson: null,
              status: 'blocked',
              updatedAt: input.recoveredAt
            })
            .where(
              and(
                eq(agentRuns.id, runId),
                inArray(agentRuns.status, openRunStatuses)
              )
            )
            .returning()
            .get();
          const run = runRow ? mapAgentRunRow(runRow) : null;

          if (run) {
            blockedRuns.push(run);
          }

          const rejectedApprovalRows = db
            .update(approvals)
            .set({
              decidedAt: input.recoveredAt,
              decisionReasonText: input.errorText,
              status: 'rejected'
            })
            .where(
              and(eq(approvals.runId, runId), eq(approvals.status, 'pending'))
            )
            .returning()
            .all();

          for (const approvalRow of rejectedApprovalRows) {
            appendRecoveryEvent(envelopes, {
              createdAt: input.recoveredAt,
              detailText: 'rejected',
              entityId: approvalRow.id,
              entityType: 'approval',
              event: {
                approvalId: approvalRow.id,
                decision: 'rejected',
                runId,
                sessionId: approvalRow.sessionId,
                type: 'approval.resolved'
              },
              headline: 'Approval resolved',
              runId,
              sessionId: approvalRow.sessionId
            });
          }

          const cancelledMessageRows = db
            .update(messages)
            .set({
              errorText: null,
              finishReason: 'cancelled',
              status: 'cancelled',
              updatedAt: input.recoveredAt
            })
            .where(
              and(
                eq(messages.runId, runId),
                eq(messages.role, 'assistant'),
                eq(messages.status, 'running')
              )
            )
            .returning()
            .all();

          for (const messageRow of cancelledMessageRows) {
            appendRecoveryEvent(envelopes, {
              createdAt: input.recoveredAt,
              entityId: messageRow.id,
              entityType: 'message',
              event: {
                messageId: messageRow.id,
                runId,
                sessionId: messageRow.sessionId,
                type: 'message.cancelled'
              },
              headline: 'Message cancelled',
              runId,
              sessionId: messageRow.sessionId
            });
          }

          const toolFailedByPart = new Set<string>();
          const toolPartRows = db
            .select()
            .from(messageParts)
            .where(
              and(eq(messageParts.runId, runId), eq(messageParts.type, 'tool'))
            )
            .orderBy(asc(messageParts.createdAt), asc(messageParts.id))
            .all();

          for (const toolPartRow of toolPartRows) {
            const toolPart = mapMessagePartRow(toolPartRow);

            if (
              toolPart.type !== 'tool' ||
              (toolPart.state.status !== 'pending' &&
                toolPart.state.status !== 'running')
            ) {
              continue;
            }

            const interruptedPart: Extract<MessagePart, { type: 'tool' }> = {
              ...toolPart,
              state: {
                completedAt: input.recoveredAt,
                errorText: input.errorText,
                input: toolPart.state.input,
                payload: { error: input.errorText, ok: false },
                reason: 'interrupted',
                startedAt:
                  toolPart.state.status === 'running'
                    ? toolPart.state.startedAt
                    : undefined,
                status: 'error'
              },
              updatedAt: input.recoveredAt
            };

            db.update(messageParts)
              .set({
                dataJson: stringifyJsonValue(interruptedPart),
                updatedAt: input.recoveredAt
              })
              .where(eq(messageParts.id, interruptedPart.id))
              .run();

            toolFailedByPart.add(interruptedPart.toolCallId);
            appendRecoveryEvent(envelopes, {
              createdAt: input.recoveredAt,
              entityId: interruptedPart.id,
              entityType: 'message_part',
              event: {
                messageId: interruptedPart.messageId,
                part: interruptedPart,
                runId,
                sessionId: interruptedPart.sessionId,
                type: 'message.part.updated'
              },
              headline: 'Message part updated',
              level: 'warning',
              runId,
              sessionId: interruptedPart.sessionId
            });
            appendRecoveryEvent(envelopes, {
              createdAt: input.recoveredAt,
              detailText: input.errorText,
              entityId: interruptedPart.toolCallId,
              entityType: 'tool_call',
              event: {
                error: input.errorText,
                runId,
                sessionId: interruptedPart.sessionId,
                toolCallId: interruptedPart.toolCallId,
                type: 'tool.failed'
              },
              headline: 'Tool failed',
              level: 'error',
              runId,
              sessionId: interruptedPart.sessionId
            });
          }

          const failedToolCallRows = db
            .update(toolCalls)
            .set({
              completedAt: input.recoveredAt,
              errorText: input.errorText,
              resultJson: stringifyJsonValue({
                error: input.errorText,
                ok: false
              }),
              status: 'failed',
              updatedAt: input.recoveredAt
            })
            .where(
              and(
                eq(toolCalls.runId, runId),
                inArray(toolCalls.status, openToolCallStatuses)
              )
            )
            .returning()
            .all();

          for (const toolCallRow of failedToolCallRows) {
            if (toolFailedByPart.has(toolCallRow.id)) {
              continue;
            }

            appendRecoveryEvent(envelopes, {
              createdAt: input.recoveredAt,
              detailText: input.errorText,
              entityId: toolCallRow.id,
              entityType: 'tool_call',
              event: {
                error: input.errorText,
                runId,
                sessionId: toolCallRow.sessionId,
                toolCallId: toolCallRow.id,
                type: 'tool.failed'
              },
              headline: 'Tool failed',
              level: 'error',
              runId,
              sessionId: toolCallRow.sessionId
            });
          }

          if (run) {
            appendRecoveryEvent(envelopes, {
              createdAt: input.recoveredAt,
              detailText: input.errorText,
              entityId: run.id,
              entityType: 'agent_run',
              event: {
                error: input.errorText,
                run,
                sessionId: input.sessionId,
                type: 'run.blocked'
              },
              headline: 'Run blocked',
              level: 'warning',
              runId: run.id,
              sessionId: input.sessionId
            });
          }
        }

        const sessionChanges: {
          lastCheckpointJson?: null;
          lastErrorText: string;
          status: SessionStatus;
          updatedAt: string;
        } = {
          lastErrorText: input.errorText,
          status: input.sessionStatus,
          updatedAt: input.recoveredAt
        };

        if (input.clearSessionCheckpoint) {
          sessionChanges.lastCheckpointJson = null;
        }

        const sessionRow = db
          .update(sessions)
          .set(sessionChanges)
          .where(eq(sessions.id, input.sessionId))
          .returning()
          .get();
        const session = sessionRow ? mapSessionRow(sessionRow) : null;

        appendRecoveryEvent(envelopes, {
          createdAt: input.recoveredAt,
          detailText: input.diagnostics.join('; ') || input.errorText,
          entityId: input.sessionId,
          entityType: 'session',
          event: appendRecoveredEvent({
            diagnostics: input.diagnostics,
            interruptedRunIds: input.interruptedRunIds,
            keptWaitingApprovalRunIds: input.keptWaitingApprovalRunIds,
            reason: input.reason,
            recoveredAt: input.recoveredAt,
            sessionId: input.sessionId
          }),
          headline: 'Session recovered',
          level: 'warning',
          sessionId: input.sessionId
        });

        if (session) {
          appendRecoveryEvent(envelopes, {
            createdAt: input.recoveredAt,
            entityId: input.sessionId,
            entityType: 'session',
            event: {
              runId:
                input.interruptedRunIds.length === 1
                  ? input.interruptedRunIds[0]
                  : undefined,
              sessionId: input.sessionId,
              type: 'session.updated',
              updatedAt: session.updatedAt
            },
            headline: 'Session updated',
            runId:
              input.interruptedRunIds.length === 1
                ? input.interruptedRunIds[0]
                : undefined,
            sessionId: input.sessionId
          });
        }

        return { blockedRuns, envelopes, session };
      });
    });
  },

  blockInvalidWaitingApproval(
    input: BlockInvalidWaitingApprovalInput
  ): RecoveryWriteResult {
    return Database.transaction(() => {
      return Database.use((db) => {
        const envelopes: SessionEventEnvelope[] = [];
        const blockedRuns: AgentRunDto[] = [];
        const clearCheckpointRunIds = new Set(
          input.clearCheckpointRunIds ?? []
        );
        const interruptedRunIds = new Set(input.interruptedRunIds ?? []);

        for (const runId of input.blockedRunIds) {
          const runChanges: {
            endedAt: string;
            errorText: string;
            lastCheckpointJson?: null;
            status: AgentRunStatus;
            updatedAt: string;
          } = {
            endedAt: input.recoveredAt,
            errorText: input.errorText,
            status: 'blocked',
            updatedAt: input.recoveredAt
          };

          if (clearCheckpointRunIds.has(runId)) {
            runChanges.lastCheckpointJson = null;
          }

          const runRow = db
            .update(agentRuns)
            .set(runChanges)
            .where(
              and(
                eq(agentRuns.id, runId),
                inArray(agentRuns.status, openRunStatuses)
              )
            )
            .returning()
            .get();
          const run = runRow ? mapAgentRunRow(runRow) : null;

          if (run) {
            blockedRuns.push(run);
            appendRecoveryEvent(envelopes, {
              createdAt: input.recoveredAt,
              detailText: input.errorText,
              entityId: run.id,
              entityType: 'agent_run',
              event: {
                error: input.errorText,
                run,
                sessionId: input.sessionId,
                type: 'run.blocked'
              },
              headline: 'Run blocked',
              level: 'warning',
              runId: run.id,
              sessionId: input.sessionId
            });
          }

          if (!interruptedRunIds.has(runId)) {
            continue;
          }

          const cancelledMessageRows = db
            .update(messages)
            .set({
              errorText: null,
              finishReason: 'cancelled',
              status: 'cancelled',
              updatedAt: input.recoveredAt
            })
            .where(
              and(
                eq(messages.runId, runId),
                eq(messages.role, 'assistant'),
                eq(messages.status, 'running')
              )
            )
            .returning()
            .all();

          for (const messageRow of cancelledMessageRows) {
            appendRecoveryEvent(envelopes, {
              createdAt: input.recoveredAt,
              entityId: messageRow.id,
              entityType: 'message',
              event: {
                messageId: messageRow.id,
                runId,
                sessionId: messageRow.sessionId,
                type: 'message.cancelled'
              },
              headline: 'Message cancelled',
              runId,
              sessionId: messageRow.sessionId
            });
          }

          const toolFailedByPart = new Set<string>();
          const toolPartRows = db
            .select()
            .from(messageParts)
            .where(
              and(eq(messageParts.runId, runId), eq(messageParts.type, 'tool'))
            )
            .orderBy(asc(messageParts.createdAt), asc(messageParts.id))
            .all();

          for (const toolPartRow of toolPartRows) {
            const toolPart = mapMessagePartRow(toolPartRow);

            if (
              toolPart.type !== 'tool' ||
              (toolPart.state.status !== 'pending' &&
                toolPart.state.status !== 'running')
            ) {
              continue;
            }

            const interruptedPart: Extract<MessagePart, { type: 'tool' }> = {
              ...toolPart,
              state: {
                completedAt: input.recoveredAt,
                errorText: input.errorText,
                input: toolPart.state.input,
                payload: { error: input.errorText, ok: false },
                reason: 'interrupted',
                startedAt:
                  toolPart.state.status === 'running'
                    ? toolPart.state.startedAt
                    : undefined,
                status: 'error'
              },
              updatedAt: input.recoveredAt
            };

            db.update(messageParts)
              .set({
                dataJson: stringifyJsonValue(interruptedPart),
                updatedAt: input.recoveredAt
              })
              .where(eq(messageParts.id, interruptedPart.id))
              .run();

            toolFailedByPart.add(interruptedPart.toolCallId);
            appendRecoveryEvent(envelopes, {
              createdAt: input.recoveredAt,
              entityId: interruptedPart.id,
              entityType: 'message_part',
              event: {
                messageId: interruptedPart.messageId,
                part: interruptedPart,
                runId,
                sessionId: interruptedPart.sessionId,
                type: 'message.part.updated'
              },
              headline: 'Message part updated',
              level: 'warning',
              runId,
              sessionId: interruptedPart.sessionId
            });
            appendRecoveryEvent(envelopes, {
              createdAt: input.recoveredAt,
              detailText: input.errorText,
              entityId: interruptedPart.toolCallId,
              entityType: 'tool_call',
              event: {
                error: input.errorText,
                runId,
                sessionId: interruptedPart.sessionId,
                toolCallId: interruptedPart.toolCallId,
                type: 'tool.failed'
              },
              headline: 'Tool failed',
              level: 'error',
              runId,
              sessionId: interruptedPart.sessionId
            });
          }

          const failedToolCallRows = db
            .update(toolCalls)
            .set({
              completedAt: input.recoveredAt,
              errorText: input.errorText,
              resultJson: stringifyJsonValue({
                error: input.errorText,
                ok: false
              }),
              status: 'failed',
              updatedAt: input.recoveredAt
            })
            .where(
              and(
                eq(toolCalls.runId, runId),
                inArray(toolCalls.status, openToolCallStatuses)
              )
            )
            .returning()
            .all();

          for (const toolCallRow of failedToolCallRows) {
            if (toolFailedByPart.has(toolCallRow.id)) {
              continue;
            }

            appendRecoveryEvent(envelopes, {
              createdAt: input.recoveredAt,
              detailText: input.errorText,
              entityId: toolCallRow.id,
              entityType: 'tool_call',
              event: {
                error: input.errorText,
                runId,
                sessionId: toolCallRow.sessionId,
                toolCallId: toolCallRow.id,
                type: 'tool.failed'
              },
              headline: 'Tool failed',
              level: 'error',
              runId,
              sessionId: toolCallRow.sessionId
            });
          }

          const rejectedApprovalRows = db
            .update(approvals)
            .set({
              decidedAt: input.recoveredAt,
              decisionReasonText: input.errorText,
              status: 'rejected'
            })
            .where(
              and(eq(approvals.runId, runId), eq(approvals.status, 'pending'))
            )
            .returning()
            .all();

          for (const approvalRow of rejectedApprovalRows) {
            appendRecoveryEvent(envelopes, {
              createdAt: input.recoveredAt,
              detailText: 'rejected',
              entityId: approvalRow.id,
              entityType: 'approval',
              event: {
                approvalId: approvalRow.id,
                decision: 'rejected',
                runId,
                sessionId: approvalRow.sessionId,
                type: 'approval.resolved'
              },
              headline: 'Approval resolved',
              runId,
              sessionId: approvalRow.sessionId
            });
          }
        }

        const sessionRow = db
          .update(sessions)
          .set({
            lastErrorText: input.errorText,
            status: 'blocked',
            updatedAt: input.recoveredAt
          })
          .where(eq(sessions.id, input.sessionId))
          .returning()
          .get();
        const session = sessionRow ? mapSessionRow(sessionRow) : null;

        appendRecoveryEvent(envelopes, {
          createdAt: input.recoveredAt,
          detailText: input.diagnostics.join('; ') || input.errorText,
          entityId: input.sessionId,
          entityType: 'session',
          event: appendRecoveredEvent({
            diagnostics: input.diagnostics,
            interruptedRunIds: input.interruptedRunIds ?? [],
            reason: 'invalid_waiting_approval_checkpoint',
            recoveredAt: input.recoveredAt,
            sessionId: input.sessionId
          }),
          headline: 'Session recovered',
          level: 'warning',
          sessionId: input.sessionId
        });

        if (session) {
          appendRecoveryEvent(envelopes, {
            createdAt: input.recoveredAt,
            entityId: input.sessionId,
            entityType: 'session',
            event: {
              sessionId: input.sessionId,
              type: 'session.updated',
              updatedAt: session.updatedAt
            },
            headline: 'Session updated',
            sessionId: input.sessionId
          });
        }

        return { blockedRuns, envelopes, session };
      });
    });
  },

  keepWaitingApproval(input: KeepWaitingApprovalInput): RecoveryWriteResult {
    return Database.transaction(() => {
      return Database.use((db) => {
        const envelopes: SessionEventEnvelope[] = [];

        const sessionRow = db
          .update(sessions)
          .set({
            lastErrorText: null,
            status: 'waiting_approval',
            updatedAt: input.recoveredAt
          })
          .where(eq(sessions.id, input.sessionId))
          .returning()
          .get();
        const session = sessionRow ? mapSessionRow(sessionRow) : null;

        appendRecoveryEvent(envelopes, {
          createdAt: input.recoveredAt,
          detailText: input.diagnostics.join('; ') || null,
          entityId: input.sessionId,
          entityType: 'session',
          event: appendRecoveredEvent({
            diagnostics: input.diagnostics,
            interruptedRunIds: [],
            keptWaitingApprovalRunIds: input.keptWaitingApprovalRunIds,
            reason: input.reason,
            recoveredAt: input.recoveredAt,
            sessionId: input.sessionId
          }),
          headline: 'Session recovered',
          level: 'warning',
          sessionId: input.sessionId
        });

        if (session) {
          appendRecoveryEvent(envelopes, {
            createdAt: input.recoveredAt,
            entityId: input.sessionId,
            entityType: 'session',
            event: {
              runId:
                input.keptWaitingApprovalRunIds.length === 1
                  ? input.keptWaitingApprovalRunIds[0]
                  : undefined,
              sessionId: input.sessionId,
              type: 'session.updated',
              updatedAt: session.updatedAt
            },
            headline: 'Session updated',
            runId:
              input.keptWaitingApprovalRunIds.length === 1
                ? input.keptWaitingApprovalRunIds[0]
                : undefined,
            sessionId: input.sessionId
          });
        }

        return { blockedRuns: [], envelopes, session };
      });
    });
  },

  recoverStaleSession(input: RecoverStaleSessionInput): RecoveryWriteResult {
    return Database.transaction(() => {
      return Database.use((db) => {
        const envelopes: SessionEventEnvelope[] = [];

        const sessionRow = db
          .update(sessions)
          .set({
            lastCheckpointJson: input.status === 'idle' ? null : undefined,
            lastErrorText: input.errorText,
            status: input.status,
            updatedAt: input.recoveredAt
          })
          .where(eq(sessions.id, input.sessionId))
          .returning()
          .get();
        const session = sessionRow ? mapSessionRow(sessionRow) : null;

        appendRecoveryEvent(envelopes, {
          createdAt: input.recoveredAt,
          detailText: input.diagnostics.join('; ') || input.errorText,
          entityId: input.sessionId,
          entityType: 'session',
          event: appendRecoveredEvent({
            diagnostics: input.diagnostics,
            interruptedRunIds: [],
            reason: input.reason,
            recoveredAt: input.recoveredAt,
            sessionId: input.sessionId
          }),
          headline: 'Session recovered',
          level: 'warning',
          sessionId: input.sessionId
        });

        if (session) {
          appendRecoveryEvent(envelopes, {
            createdAt: input.recoveredAt,
            entityId: input.sessionId,
            entityType: 'session',
            event: {
              sessionId: input.sessionId,
              type: 'session.updated',
              updatedAt: session.updatedAt
            },
            headline: 'Session updated',
            sessionId: input.sessionId
          });
        }

        return { blockedRuns: [], envelopes, session };
      });
    });
  }
};
