import { Database } from '../../db/runtime.js';
import { normalizePrompt, type Lifecycle } from '@opencode/agent';
import { randomUUID } from 'node:crypto';
import { ServiceError } from '../../lib/service-error.js';
import { messageService } from '../session/message/service.js';
import { sessionService } from '../session/service.js';
import { sessionRunner, type SessionRunner } from './runner.js';
import { agentRunService } from './run-service.js';
import { sessionEventService } from '../session-events/event-service.js';

type RunSubagentInput = {
  description: string;
  parentSignal?: AbortSignal;
  parentSessionId: string;
  parentToolCallId: string;
  prompt: string;
  subagentType: 'explore';
  workspaceRoot: string;
};

function buildSubagentTitle(input: {
  description: string;
  subagentType: 'explore';
}) {
  return `${input.description.trim()} (@${input.subagentType} subagent)`;
}

function extractCompletedAssistantSummary(sessionId: string) {
  const completedAssistant = [...messageService.listMessages(sessionId)]
    .reverse()
    .find(
      (message) =>
        message.role === 'assistant' && message.status === 'completed'
    );

  if (!completedAssistant) {
    throw new Error('Subagent completed without a final assistant message.');
  }

  const summaryText = completedAssistant.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');

  if (summaryText.trim().length === 0) {
    throw new Error('Subagent completed without summary text.');
  }

  return summaryText;
}

export class SubagentService {
  constructor(
    private readonly runner: SessionRunner = sessionRunner,
    private readonly runtimeLifecycle: Lifecycle
  ) {}

  async runSubagent(input: RunSubagentInput): Promise<{
    childRunId: string;
    sessionId: string;
    status: 'completed';
    summaryText: string;
    title: string;
  }> {
    const parentSession = sessionService.getSession(input.parentSessionId);

    if (!parentSession) {
      throw new ServiceError(
        `Session not found: ${input.parentSessionId}`,
        404
      );
    }

    const title = buildSubagentTitle({
      description: input.description,
      subagentType: input.subagentType
    });

    const childSessionId = randomUUID();
    const abortReason = () =>
      input.parentSignal?.reason instanceof Error
        ? input.parentSignal.reason.message
        : typeof input.parentSignal?.reason === 'string'
          ? input.parentSignal.reason
          : 'Run cancelled by user';

    const result = await this.runner.runExclusive(
      childSessionId,
      async () =>
        Database.transaction(() => {
          const childSession = sessionService.createSubagentSession({
            defaultVariant: parentSession.defaultVariant,
            goalText: input.prompt,
            id: childSessionId,
            parentSessionId: parentSession.id,
            parentToolCallId: input.parentToolCallId,
            subagentType: input.subagentType,
            title,
            workspaceId: parentSession.workspaceId
          });
          const childRun = agentRunService.createRun({
            sessionId: childSession.id
          });
          const normalized = normalizePrompt({
            agentName: input.subagentType,
            content: input.prompt,
            sessionId: childSession.id
          });
          const message = messageService.createMessage({
            ...normalized.message,
            content: normalized.parts,
            runId: childRun.id
          });
          const triggeredRun =
            agentRunService.setTriggerMessage({
              runId: childRun.id,
              triggerMessageId: message.id
            }) ?? childRun;

          sessionEventService.append({
            run: triggeredRun,
            sessionId: childSession.id,
            type: 'run.created'
          });
          sessionEventService.append({
            message,
            sessionId: childSession.id,
            type: 'message.created'
          });
          sessionService.updateSessionRuntimeState({
            lastErrorText: null,
            sessionId: childSession.id,
            status: 'executing'
          });

          return {
            ctx: {
              runId: triggeredRun.id,
              sessionId: childSession.id,
              title
            },
            runId: triggeredRun.id
          };
        }),
      async (ctx, signal) => {
        const onParentAbort = () => {
          this.runner.cancel(ctx.sessionId, abortReason());
        };

        input.parentSignal?.addEventListener('abort', onParentAbort, {
          once: true
        });

        if (input.parentSignal?.aborted) {
          onParentAbort();
        }

        try {
          await this.runtimeLifecycle.startPromptRun({
            runId: ctx.runId,
            signal,
            sessionId: ctx.sessionId
          });

          const run = agentRunService.getRun(ctx.runId);

          if (!run) {
            throw new Error(`Subagent run not found: ${ctx.runId}`);
          }

          if (run.status !== 'completed') {
            throw new Error(`Subagent run ended with status: ${run.status}`);
          }

          return {
            childRunId: ctx.runId,
            sessionId: ctx.sessionId,
            status: 'completed' as const,
            summaryText: extractCompletedAssistantSummary(ctx.sessionId),
            title: ctx.title
          };
        } finally {
          input.parentSignal?.removeEventListener('abort', onParentAbort);
        }
      }
    );

    return result;
  }
}
