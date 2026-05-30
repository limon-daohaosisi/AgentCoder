import {
  Lifecycle,
  prepareToolExecution,
  resolveToolApprovalMode,
  RunLoop,
  SessionCompaction,
  SessionProcessor,
  ToolExecutor,
  type FileSnapshotArtifact,
  type LifecycleDeps,
  type SessionCompactionDeps,
  type RunLoopDeps,
  type SessionProcessorDeps
} from '@opencode/agent';
import { Database } from '../db/runtime.js';
import { ServiceError } from '../lib/service-error.js';
import { workspaceRepository } from '../repositories/workspace-repository.js';
import { createLanguageModel } from '../services/ai/provider.js';
import { streamModelResponse } from '../services/ai/response-stream.js';
import { messageService } from '../services/session/message/service.js';
import { messagePartService } from '../services/session/message/part-service.js';
import { sessionEventService } from '../services/session-events/event-service.js';
import { taskService } from '../services/session/task-service.js';
import { sessionService } from '../services/session/service.js';
import { agentRunService } from '../services/agent/run-service.js';
import { fileSnapshotService } from '../services/agent/file-snapshot-service.js';
import { nestedAgentsMemoryService } from '../services/agent/nested-agents-memory-service.js';
import { promptSourceService } from '../services/agent/prompt-source-service.js';
import { runtimeContextMessageService } from '../services/agent/runtime-context-message-service.js';
import { sessionRunner } from '../services/agent/runner.js';
import { SubagentService } from '../services/agent/subagent-service.js';
import { toolStateService } from '../services/agent/tool-state-service.js';
import { planService } from '../services/session/plan-service.js';
import { toolCallRepository } from '../repositories/tool-call-repository.js';

let subagentService: SubagentService | null = null;

function buildToolServices() {
  return {
    createFileSnapshot: (snapshotInput: {
      sessionId: string;
      snapshot: FileSnapshotArtifact;
      toolCallId: string;
    }) => fileSnapshotService.createFromRead(snapshotInput),
    getLatestFileSnapshot: (snapshotInput: {
      path: string;
      requireFullRead?: boolean;
      sessionId: string;
    }) => fileSnapshotService.getLatestForPath(snapshotInput),
    registerReadTarget: (input: { filePath: string; sessionId: string }) => {
      nestedAgentsMemoryService.registerReadTarget(input);

      const session = sessionService.getSession(input.sessionId);

      if (!session) {
        return;
      }

      const lastUserRuntime = messageService
        .listMessages(input.sessionId)
        .filter((message) => message.role === 'user')
        .at(-1)?.runtime;
      const sources = promptSourceService.buildRuntimeContextSources({
        agentName: 'default',
        lastUserRuntime,
        model: {
          modelId: process.env.OPENAI_MODEL?.trim() || 'gpt-4.1-mini',
          providerId: 'openai'
        },
        previousUserRuntime: undefined,
        session,
        sessionId: input.sessionId,
        workspaceRoot: getWorkspaceRootPath(input.sessionId)
      });

      for (const source of sources) {
        runtimeContextMessageService.persistRuntimeContextMessage({
          key: source.sourceId,
          parts: [
            {
              kind: source.kind,
              metadata: source.metadata,
              text: source.text
            }
          ],
          sessionId: input.sessionId,
          variant: lastUserRuntime?.variant
        });
      }
    },
    getSessionPlanContext: (planContextInput: { sessionId: string }) =>
      Promise.resolve({
        filePath: planService.getOrCreateCurrentPlan(planContextInput.sessionId)
          .plan.filePath,
        variant: taskService.getCurrentTaskContext(planContextInput.sessionId)
          .variant
      }),
    getSessionPlanApprovalPayload: (input: {
      sessionId: string;
      summary?: string;
    }) => planService.buildPlanExitApprovalPayload(input),
    subagentRun: (input: {
      description: string;
      parentRunId?: string;
      parentSignal?: AbortSignal;
      parentSessionId: string;
      parentToolCallId: string;
      prompt: string;
      subagentType: 'explore';
      workspaceRoot: string;
    }) => {
      if (!subagentService) {
        throw new Error('subagent service is not configured.');
      }

      return subagentService.runSubagent(input);
    },
    getSessionTaskContext: (taskContextInput: { sessionId: string }) =>
      Promise.resolve(
        taskService.getCurrentTaskContext(taskContextInput.sessionId)
      ),
    taskCreate: (taskInput: Parameters<typeof taskService.createTask>[0]) =>
      Promise.resolve(taskService.createTask(taskInput)),
    taskGet: (
      taskInput: Parameters<
        typeof taskService.getTaskForSession
      >[0] extends never
        ? never
        : { sessionId: string; taskId: string }
    ) =>
      Promise.resolve(
        taskService.getTaskForSession(taskInput.sessionId, taskInput.taskId)
      ),
    taskList: (taskInput: { sessionId: string }) =>
      Promise.resolve(taskService.listTasksForSession(taskInput.sessionId)),
    taskStop: (taskInput: Parameters<typeof taskService.stopTask>[0]) =>
      Promise.resolve(taskService.stopTask(taskInput)),
    taskUpdate: (taskInput: Parameters<typeof taskService.updateTask>[0]) =>
      Promise.resolve(taskService.updateTask(taskInput))
  };
}

export function buildSessionProcessorDeps(
  overrides: Partial<SessionProcessorDeps> = {}
): SessionProcessorDeps {
  return {
    appendMessagePart: (input) => messagePartService.appendPart(input),
    appendSessionEvent: (event) => sessionEventService.append(event),
    createMessage: (input) => messageService.createMessage(input),
    getCurrentTaskContext: (sessionId) =>
      taskService.getCurrentTaskContext(sessionId),
    createToolPartWithToolCall: (input) =>
      toolStateService.createToolPartWithToolCall(input),
    persist: (callback) => Database.transaction(callback),
    prepareToolExecution: (input) =>
      prepareToolExecution({
        ...input,
        services: buildToolServices()
      }),
    resolveToolApprovalMode: (input) =>
      resolveToolApprovalMode({
        ...input,
        services: buildToolServices()
      }),
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
  getToolCall: (toolCallId) => toolCallRepository.getById(toolCallId),
  listOpenToolPartsByRun: (runId) =>
    toolStateService.listOpenToolPartsByRun(runId),
  persist: (callback) => Database.transaction(callback),
  services: buildToolServices(),
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
    finalizeRunState: (input) =>
      agentRunService.finalizeRunState({
        checkpoint: 'checkpoint' in input ? input.checkpoint : undefined,
        errorText: input.errorText,
        reason: input.reason,
        runId: input.runId,
        sessionId: input.sessionId,
        sessionStatus: input.sessionStatus
      } as never),
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
    pauseForApproval: (input) => agentRunService.pauseForApproval(input),
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
    getSessionPlanContext: (sessionId) => ({
      filePath: planService.getOrCreateCurrentPlan(sessionId).plan.filePath
    }),
    listPromptMemorySources: (input) =>
      promptSourceService.listPromptMemorySources(input),
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

export function buildSessionCompactionDeps(
  overrides: Partial<SessionCompactionDeps> = {}
): SessionCompactionDeps {
  return {
    appendSessionEvent: (event) => sessionEventService.append(event),
    createMessage: (input) => messageService.createMessage(input),
    getSession: (sessionId) => sessionService.getSession(sessionId),
    listMessages: (sessionId) => messageService.listMessages(sessionId),
    listRecentFileSnapshots: (input) =>
      fileSnapshotService.listRecentBySession(input),
    markMessagesCompacted: (input) =>
      messageService.markMessagesCompacted(input),
    modelFactory: createLanguageModel,
    persist: (callback) => Database.transaction(callback),
    processTurn: (input) => sessionProcessor.processTurn(input),
    resetRuntimeContextState: (sessionId) =>
      nestedAgentsMemoryService.clearSession(sessionId),
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
    streamModelResponse,
    updateMessagePart: (part) => messagePartService.updatePart(part),
    updateMessageRuntime: (input) => messageService.updateMessageRuntime(input),
    updateToolPartWithToolCall: (input) =>
      toolStateService.updateToolPartWithToolCall(input),
    ...overrides
  };
}

export const sessionCompaction = new SessionCompaction(
  buildSessionCompactionDeps()
);

export const runLoop = new RunLoop(
  sessionProcessor,
  toolExecutor,
  buildRunLoopDeps(),
  buildSessionCompactionDeps()
);
export const lifecycle = new Lifecycle(runLoop, buildLifecycleDeps());
subagentService = new SubagentService(sessionRunner, lifecycle);
