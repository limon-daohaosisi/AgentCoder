import type {
  PlanExitApprovalPayload,
  PlanDto,
  SessionPlanFileDto,
  SessionDto,
  SessionPlanBoardDto,
  TaskDto
} from '@opencode/shared';
import { randomUUID } from 'node:crypto';
import { Database } from '../../db/runtime.js';
import { ServiceError } from '../../lib/service-error.js';
import { approvalRepository } from '../../repositories/approval-repository.js';
import { planRepository } from '../../repositories/plan-repository.js';
import { sessionRepository } from '../../repositories/session-repository.js';
import { taskRepository } from '../../repositories/task-repository.js';
import { runtimeContextMessageService } from '../agent/runtime-context-message-service.js';
import { planFileService } from './plan-file-service.js';

type CurrentPlanContext = {
  plan: PlanDto;
  session: SessionDto;
};

function getSessionOrThrow(sessionId: string): SessionDto {
  const session = sessionRepository.getById(sessionId);

  if (!session) {
    throw new ServiceError(`Session not found: ${sessionId}`, 404);
  }

  return session;
}

function resolveCurrentTask(session: SessionDto, tasks: TaskDto[]) {
  if (!session.currentTaskId) {
    return undefined;
  }

  return (
    tasks.find((task) => task.id === session.currentTaskId) ??
    taskRepository.getById(session.currentTaskId) ??
    undefined
  );
}

function withFilePath(plan: PlanDto): PlanDto {
  return planFileService.buildPlanDto(plan);
}

function createCurrentPlan(
  session: SessionDto,
  now: string
): CurrentPlanContext {
  const plan = planRepository.create({
    confirmedAt: null,
    createdAt: now,
    id: randomUUID(),
    sessionId: session.id,
    source: 'model',
    status: 'draft',
    summaryText: null,
    supersededAt: null,
    version: planRepository.getNextVersionForSession(session.id)
  });

  const updatedSession = sessionRepository.updateResumeState({
    currentPlanId: plan.id,
    id: session.id,
    updatedAt: now
  });

  if (!updatedSession) {
    throw new ServiceError(`Session not found: ${session.id}`, 404);
  }

  return {
    plan,
    session: updatedSession
  };
}

export const planService = {
  getOrCreateCurrentPlan(sessionId: string): CurrentPlanContext {
    const session = getSessionOrThrow(sessionId);

    if (session.currentPlanId) {
      const currentPlan = planRepository.getById(session.currentPlanId);

      if (currentPlan && currentPlan.sessionId === session.id) {
        return {
          plan: withFilePath(currentPlan),
          session
        };
      }
    }

    return Database.transaction(() => {
      const freshSession = getSessionOrThrow(sessionId);

      if (freshSession.currentPlanId) {
        const currentPlan = planRepository.getById(freshSession.currentPlanId);

        if (currentPlan && currentPlan.sessionId === freshSession.id) {
          return {
            plan: withFilePath(currentPlan),
            session: freshSession
          };
        }
      }

      const created = createCurrentPlan(freshSession, new Date().toISOString());

      return {
        ...created,
        plan: withFilePath(created.plan)
      };
    });
  },

  getSessionPlanBoard(sessionId: string): SessionPlanBoardDto {
    const { plan, session } = this.getOrCreateCurrentPlan(sessionId);
    const tasks = taskRepository.listByPlan(plan.id);
    const waitingApprovalTaskIds = [
      ...new Set(
        approvalRepository
          .listPendingBySession(session.id)
          .flatMap((approval) => (approval.taskId ? [approval.taskId] : []))
      )
    ];

    return {
      currentPlan: plan,
      currentTask: resolveCurrentTask(session, tasks),
      session,
      tasks,
      waitingApprovalTaskIds
    };
  },

  async getSessionPlanFile(sessionId: string): Promise<SessionPlanFileDto> {
    const { plan } = this.getOrCreateCurrentPlan(sessionId);
    const planFile = await planFileService.getPlanFile(plan);

    if (planFile.exists) {
      runtimeContextMessageService.persistPlanFileReference({
        filePath: planFile.filePath,
        planId: plan.id,
        sessionId,
        variant: 'plan'
      });
    }

    return planFile;
  },

  async buildPlanExitApprovalPayload(input: {
    sessionId: string;
    summary?: string;
  }): Promise<PlanExitApprovalPayload> {
    const { plan } = this.getOrCreateCurrentPlan(input.sessionId);
    const planFile = await this.getSessionPlanFile(input.sessionId);

    if (!planFile.exists) {
      throw new ServiceError(
        'Current plan file does not exist yet. Create it before requesting plan_exit.',
        409
      );
    }

    return {
      ...(input.summary ? { summary: input.summary.trim() } : {}),
      planContent: planFile.content,
      planFilePath: planFile.filePath,
      planId: plan.id
    };
  }
};
