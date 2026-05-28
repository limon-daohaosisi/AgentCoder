import type { PromptMemorySource, RuntimeContextSource } from '@opencode/agent';
import type { MessageRuntimeMetadata, SessionDto } from '@opencode/shared';
import { runtimeContextService } from './runtime-context-service.js';
import { workspaceMemoryService } from './workspace-memory-service.js';

type ListPromptMemorySourcesInput = {
  agentName: string;
  lastUserRuntime?: MessageRuntimeMetadata;
  model: { modelId: string; providerId: string };
  session: SessionDto;
  sessionId: string;
  workspaceRoot: string;
};

export const promptSourceService = {
  listPromptMemorySources(
    input: ListPromptMemorySourcesInput
  ): PromptMemorySource[] {
    return workspaceMemoryService.listPromptMemorySources(input.workspaceRoot);
  },

  buildRuntimeContextSources(
    input: ListPromptMemorySourcesInput & {
      planFilePath?: string;
      previousUserRuntime?: MessageRuntimeMetadata;
    }
  ): RuntimeContextSource[] {
    return runtimeContextService.listRuntimeContextSources(input);
  }
};
