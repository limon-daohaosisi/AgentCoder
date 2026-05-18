import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PlanDto, SessionPlanFileDto } from '@opencode/shared';
import { ServiceError } from '../../lib/service-error.js';
import { workspaceRepository } from '../../repositories/workspace-repository.js';
import { sessionRepository } from '../../repositories/session-repository.js';

const PLAN_DIRECTORY = '.mycoding/plans';
const DEFAULT_PLAN_TEMPLATE = `# Plan

## Goal

## Constraints

## Approach

## Risks

## Execution Outline
`;

function getSessionWorkspaceRoot(sessionId: string) {
  const session = sessionRepository.getById(sessionId);

  if (!session) {
    throw new ServiceError(`Session not found: ${sessionId}`, 404);
  }

  const workspace = workspaceRepository.getById(session.workspaceId);

  if (!workspace) {
    throw new ServiceError(`Workspace not found for session ${sessionId}`, 404);
  }

  return workspace.rootPath;
}

async function fileExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export const planFileService = {
  buildRelativeFilePath(planId: string) {
    return path.posix.join(PLAN_DIRECTORY, `${planId}.md`);
  },

  buildPlanDto(plan: PlanDto): PlanDto {
    return {
      ...plan,
      filePath: this.buildRelativeFilePath(plan.id)
    };
  },

  async ensurePlanFile(plan: PlanDto) {
    const workspaceRoot = getSessionWorkspaceRoot(plan.sessionId);
    const relativeFilePath = this.buildRelativeFilePath(plan.id);
    const absoluteFilePath = path.join(workspaceRoot, relativeFilePath);

    if (await fileExists(absoluteFilePath)) {
      return {
        exists: true,
        filePath: relativeFilePath
      };
    }

    await mkdir(path.dirname(absoluteFilePath), { recursive: true });
    await writeFile(absoluteFilePath, DEFAULT_PLAN_TEMPLATE, 'utf8');

    return {
      exists: false,
      filePath: relativeFilePath
    };
  },

  async getPlanFile(plan: PlanDto): Promise<SessionPlanFileDto> {
    const workspaceRoot = getSessionWorkspaceRoot(plan.sessionId);
    const relativeFilePath = this.buildRelativeFilePath(plan.id);
    const absoluteFilePath = path.join(workspaceRoot, relativeFilePath);
    const existedBeforeEnsure = await fileExists(absoluteFilePath);

    await this.ensurePlanFile(plan);

    return {
      content: await readFile(absoluteFilePath, 'utf8'),
      exists: existedBeforeEnsure,
      filePath: relativeFilePath,
      plan: this.buildPlanDto(plan)
    };
  }
};
