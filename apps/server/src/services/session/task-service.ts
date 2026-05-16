import type { SessionVariant, TaskDto, TaskStatus } from '@opencode/shared';
import { randomUUID } from 'node:crypto';
import { Database } from '../../db/runtime.js';
import { ServiceError } from '../../lib/service-error.js';
import { messageRepository } from '../../repositories/message-repository.js';
import { sessionRepository } from '../../repositories/session-repository.js';
import { taskRepository } from '../../repositories/task-repository.js';
import { sessionEventService } from '../session-events/event-service.js';
import { planService } from './plan-service.js';

type CurrentTaskContext = {
  currentPlanId?: string;
  currentTaskId?: string;
  variant: SessionVariant;
};

type CreateTaskInput = {
  acceptanceCriteria?: string[];
  description?: string;
  position?: number;
  sessionId: string;
  status?: 'ready' | 'todo';
  title: string;
};

type UpdateTaskInput = {
  acceptanceCriteria?: string[];
  completedAt?: null | string;
  description?: null | string;
  lastErrorText?: null | string;
  position?: number;
  sessionId: string;
  startedAt?: null | string;
  status?: TaskStatus;
  summaryText?: null | string;
  taskId: string;
  title?: string;
};

type StopTaskInput = {
  reason: string;
  sessionId: string;
  summaryText?: string;
  taskId: string;
};

const buildMutableStatuses = new Set<TaskStatus>([
  'running',
  'waiting_approval',
  'blocked',
  'failed',
  'done',
  'ready',
  'todo'
]);

function getSessionOrThrow(sessionId: string) {
  const session = sessionRepository.getById(sessionId);

  if (!session) {
    throw new ServiceError(`Session not found: ${sessionId}`, 404);
  }

  return session;
}

function getLatestVariant(sessionId: string, fallback: SessionVariant) {
  const lastUserVariant = messageRepository
    .listBySession(sessionId)
    .filter((message) => message.role === 'user')
    .at(-1)?.runtime?.variant;

  return lastUserVariant ?? fallback;
}

function getTaskOrThrow(sessionId: string, taskId: string) {
  const task = taskRepository.getByIdForSession(sessionId, taskId);

  if (!task) {
    throw new ServiceError(`Task not found: ${taskId}`, 404);
  }

  return task;
}

function assertPlanMode(variant: SessionVariant) {
  if (variant !== 'plan') {
    throw new ServiceError(
      'This task mutation is only allowed in plan mode.',
      409
    );
  }
}

function assertBuildMode(variant: SessionVariant) {
  if (variant !== 'build') {
    throw new ServiceError(
      'This task mutation is only allowed in build mode.',
      409
    );
  }
}

function appendSessionUpdated(sessionId: string, updatedAt: string) {
  sessionEventService.append({
    sessionId,
    type: 'session.updated',
    updatedAt
  });
}

export const taskService = {
  createTask(input: CreateTaskInput): TaskDto {
    return Database.transaction(() => {
      const session = getSessionOrThrow(input.sessionId);
      const variant = getLatestVariant(input.sessionId, session.defaultVariant);

      assertPlanMode(variant);

      const { plan, session: updatedSession } = planService.getOrCreateCurrentPlan(
        input.sessionId
      );
      const position =
        input.position ?? taskRepository.getNextPositionForPlan(plan.id);
      const now = new Date().toISOString();
      const task = taskRepository.create({
        acceptanceCriteria: input.acceptanceCriteria ?? [],
        completedAt: null,
        description: input.description ?? null,
        id: randomUUID(),
        lastErrorText: null,
        planId: plan.id,
        position,
        sessionId: input.sessionId,
        startedAt: null,
        status: input.status ?? 'todo',
        summaryText: null,
        title: input.title.trim(),
        updatedAt: now
      });

      if (!updatedSession.currentTaskId) {
        const pointedSession = sessionRepository.updateResumeState({
          currentTaskId: task.id,
          id: updatedSession.id,
          updatedAt: now
        });

        if (pointedSession) {
          appendSessionUpdated(pointedSession.id, pointedSession.updatedAt);
        }
      }

      return task;
    });
  },

  getCurrentTaskContext(sessionId: string): CurrentTaskContext {
    const session = getSessionOrThrow(sessionId);
    return {
      currentPlanId: session.currentPlanId,
      currentTaskId: session.currentTaskId,
      variant: getLatestVariant(sessionId, session.defaultVariant)
    };
  },

  getTask(taskId: string): TaskDto | null {
    return taskRepository.getById(taskId);
  },

  getTaskForSession(sessionId: string, taskId: string): TaskDto | null {
    return taskRepository.getByIdForSession(sessionId, taskId);
  },

  listTasksForPlan(planId: string): TaskDto[] {
    return taskRepository.listByPlan(planId);
  },

  listTasksForSession(sessionId: string): { currentTaskId?: string; tasks: TaskDto[] } {
    const { plan, session } = planService.getOrCreateCurrentPlan(sessionId);
    return {
      currentTaskId: session.currentTaskId,
      tasks: taskRepository.listByPlan(plan.id)
    };
  },

  stopTask(input: StopTaskInput): TaskDto {
    return Database.transaction(() => {
      const session = getSessionOrThrow(input.sessionId);
      const variant = getLatestVariant(input.sessionId, session.defaultVariant);
      const existing = getTaskOrThrow(input.sessionId, input.taskId);

      assertBuildMode(variant);

      if (
        existing.status !== 'running' &&
        existing.status !== 'waiting_approval'
      ) {
        throw new ServiceError(
          'TaskStop only applies to running or waiting_approval tasks.',
          409
        );
      }

      const now = new Date().toISOString();
      const task = taskRepository.update({
        completedAt: null,
        id: existing.id,
        lastErrorText: input.reason.trim(),
        status: 'blocked',
        summaryText: input.summaryText?.trim() || existing.summaryText || null,
        updatedAt: now
      });

      if (!task) {
        throw new ServiceError(`Task not found: ${existing.id}`, 404);
      }

      if (session.currentTaskId === task.id) {
        const updatedSession = sessionRepository.updateResumeState({
          currentTaskId: null,
          id: session.id,
          updatedAt: now
        });

        if (updatedSession) {
          appendSessionUpdated(updatedSession.id, updatedSession.updatedAt);
        }
      }

      return task;
    });
  },

  updateTask(input: UpdateTaskInput): TaskDto {
    return Database.transaction(() => {
      const session = getSessionOrThrow(input.sessionId);
      const variant = getLatestVariant(input.sessionId, session.defaultVariant);
      const existing = getTaskOrThrow(input.sessionId, input.taskId);
      const now = new Date().toISOString();

      if (!buildMutableStatuses.has(input.status ?? existing.status)) {
        throw new ServiceError('Invalid task status update.', 400);
      }

      if (variant === 'plan') {
        const task = taskRepository.update({
          acceptanceCriteria: input.acceptanceCriteria,
          completedAt: input.completedAt,
          description: input.description,
          id: existing.id,
          lastErrorText: input.lastErrorText,
          position: input.position,
          startedAt: input.startedAt,
          status: input.status,
          summaryText: input.summaryText,
          title: input.title?.trim(),
          updatedAt: now
        });

        if (!task) {
          throw new ServiceError(`Task not found: ${existing.id}`, 404);
        }

        const currentTaskId =
          task.status === 'running' || task.status === 'waiting_approval'
            ? task.id
            : session.currentTaskId === task.id &&
                (task.status === 'done' ||
                  task.status === 'failed' ||
                  task.status === 'blocked')
              ? null
              : undefined;

        if (currentTaskId !== undefined) {
          const updatedSession = sessionRepository.updateResumeState({
            currentTaskId,
            id: session.id,
            updatedAt: now
          });

          if (updatedSession) {
            appendSessionUpdated(updatedSession.id, updatedSession.updatedAt);
          }
        }

        return task;
      }

      const attemptedStructureMutation =
        input.title !== undefined ||
        input.description !== undefined ||
        input.acceptanceCriteria !== undefined ||
        input.position !== undefined;

      if (attemptedStructureMutation) {
        throw new ServiceError(
          'Build mode only allows execution-field task updates.',
          409
        );
      }

      const task = taskRepository.update({
        completedAt: input.completedAt,
        id: existing.id,
        lastErrorText: input.lastErrorText,
        startedAt: input.startedAt,
        status: input.status,
        summaryText: input.summaryText,
        updatedAt: now
      });

      if (!task) {
        throw new ServiceError(`Task not found: ${existing.id}`, 404);
      }

      const currentTaskId =
        task.status === 'running' || task.status === 'waiting_approval'
          ? task.id
          : session.currentTaskId === task.id &&
              (task.status === 'done' ||
                task.status === 'failed' ||
                task.status === 'blocked')
            ? null
            : undefined;

      if (currentTaskId !== undefined) {
        const updatedSession = sessionRepository.updateResumeState({
          currentTaskId,
          id: session.id,
          updatedAt: now
        });

        if (updatedSession) {
          appendSessionUpdated(updatedSession.id, updatedSession.updatedAt);
        }
      }

      return task;
    });
  }
};
