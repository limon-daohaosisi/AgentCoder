import type { RuntimeContextSource } from '@opencode/agent';
import type { MessageRuntimeMetadata, SessionDto } from '@opencode/shared';
import { nestedAgentsMemoryService } from './nested-agents-memory-service.js';

type ListRuntimeContextSourcesInput = {
  agentName: string;
  lastUserRuntime?: MessageRuntimeMetadata;
  model: { modelId: string; providerId: string };
  previousUserRuntime?: MessageRuntimeMetadata;
  session: SessionDto;
  sessionId: string;
  workspaceRoot: string;
};

export const runtimeContextService = {
  listRuntimeContextSources(
    input: ListRuntimeContextSourcesInput & { planFilePath?: string }
  ): RuntimeContextSource[] {
    const sources: RuntimeContextSource[] = [];
    const variant = input.lastUserRuntime?.variant;

    if (variant) {
      const transitionedFromPlan =
        input.previousUserRuntime?.variant === 'plan' && variant === 'build';

      if (transitionedFromPlan) {
        sources.push({
          kind: 'mode_transition',
          metadata: {
            planFilePath: input.planFilePath,
            variant
          },
          sourceId: 'runtime_mode_transition',
          text: [
            'Mode transition:',
            '- The session has just moved from plan mode to build mode.',
            '- You may now modify files and run commands.',
            input.planFilePath
              ? `- Approved plan file: ${input.planFilePath}`
              : '- No approved plan file path is currently available.'
          ].join('\n')
        });
      }
    }

    if (input.planFilePath) {
      sources.push({
        kind: 'plan_file',
        metadata: { filePath: input.planFilePath },
        sourceId: 'runtime_plan_file',
        text: `Current plan file path: ${input.planFilePath}`
      });
    }

    sources.push(
      ...nestedAgentsMemoryService.consumeRuntimeSources({
        sessionId: input.sessionId,
        workspaceRoot: input.workspaceRoot
      })
    );

    return sources;
  }
};
