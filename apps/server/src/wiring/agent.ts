import {
  Lifecycle,
  RunLoop,
  SessionProcessor,
  ToolExecutor,
  type LifecycleDeps,
  type RunLoopDeps,
  type SessionProcessorDeps
} from '@opencode/agent';
import { ServiceError } from '../lib/service-error.js';
import { approvalRepository } from '../repositories/approval-repository.js';
import { workspaceRepository } from '../repositories/workspace-repository.js';
import { createLanguageModel } from '../services/ai/provider.js';
import { streamModelResponse } from '../services/ai/response-stream.js';
import { messageService } from '../services/session/message/service.js';
import { messagePartService } from '../services/session/message/part-service.js';
import { sessionEventService } from '../services/session-events/event-service.js';
import { sessionService } from '../services/session/service.js';
import { agentRunService } from '../services/agent/run-service.js';
import { toolStateService } from '../services/agent/tool-state-service.js';

export function buildSessionProcessorDeps(
  overrides: Partial<SessionProcessorDeps> = {}
): SessionProcessorDeps {
  return {
    appendMessagePart: (input) => messagePartService.appendPart(input),
    appendSessionEvent: (event) => sessionEventService.append(event),
    createApproval: (input) => approvalRepository.create(input),
    createMessage: (input) => messageService.createMessage(input),
    createToolPartWithToolCall: (input) =>
      toolStateService.createToolPartWithToolCall(input),
    streamModelResponse,
    updateMessagePart: (part) => messagePartService.updatePart(part),
    updateMessageRuntime: (input) => messageService.updateMessageRuntime(input),
    updateToolPartWithToolCall: (input) =>
      toolStateService.updateToolPartWithToolCall(input),
    ...overrides
  };
}

export const sessionProcessor = new SessionProcessor(
  buildSessionProcessorDeps()
);

export const toolExecutor = new ToolExecutor({
  appendSessionEvent: (event) => sessionEventService.append(event),
  getMessagePart: (partId) => messagePartService.getPart(partId),
  updateToolPartWithToolCall: (input) =>
    toolStateService.updateToolPartWithToolCall(input)
});

function getWorkspaceRootPath(sessionId: string) {
  const session = sessionService.getSession(sessionId);

  if (!session) {
    throw new ServiceError(`Session not found: ${sessionId}`, 404);
  }

  const workspace = workspaceRepository.getById(session.workspaceId);

  if (!workspace) {
    throw new ServiceError(`Workspace not found for session ${sessionId}`, 404);
  }

  return workspace.rootPath;
}

export function buildLifecycleDeps(
  overrides: Partial<LifecycleDeps> = {}
): LifecycleDeps {
  return {
    appendSessionEvent: (event) => sessionEventService.append(event),
    getMessagePart: (partId) => messagePartService.getPart(partId),
    getSession: (sessionId) => sessionService.getSession(sessionId),
    getWorkspaceRootPath,
    markRunBlocked: (input) => agentRunService.markBlocked(input),
    markRunCancelled: (input) => agentRunService.markCancelled(input),
    markRunCompleted: (input) => agentRunService.markCompleted(input),
    markRunFailed: (input) => agentRunService.markFailed(input),
    markRunWaitingApproval: (input) =>
      agentRunService.markWaitingApproval({
        checkpoint: input.lastCheckpoint,
        runId: input.runId
      }),
    toolExecutor,
    updateSessionRuntimeState: (input) =>
      sessionService.updateSessionRuntimeState(input),
    ...overrides
  };
}

export function buildRunLoopDeps(
  overrides: Partial<RunLoopDeps> = {}
): RunLoopDeps {
  return {
    getSession: (sessionId) => sessionService.getSession(sessionId),
    listMessages: (sessionId) => messageService.listMessages(sessionId),
    modelFactory: createLanguageModel,
    repairDanglingToolPart: (input) => {
      if (input.part.state.status !== 'error') {
        return input.part;
      }

      return toolStateService.updateToolPartWithToolCall({
        part: input.part,
        toolCall: {
          completedAt: input.part.state.completedAt,
          errorText: input.part.state.errorText,
          id: input.part.toolCallId,
          result: input.part.state.payload,
          startedAt: input.part.state.startedAt,
          status: 'failed',
          updatedAt: input.part.updatedAt
        }
      }).part;
    },
    ...overrides
  };
}

export const runLoop = new RunLoop(
  sessionProcessor,
  toolExecutor,
  buildRunLoopDeps()
);
export const lifecycle = new Lifecycle(runLoop, buildLifecycleDeps());
