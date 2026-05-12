import type { PromptMemorySource } from '@opencode/agent';
import type { MessageRuntimeMetadata, SessionDto } from '@opencode/shared';
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
  }
};
