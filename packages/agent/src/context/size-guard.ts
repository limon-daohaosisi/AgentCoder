import type { AiSdkTurnRequest, BuiltContext, ResolvedTool } from './schema.js';

export type ContextSizeGuardConfig = {
  maxEstimatedChars: number;
  maxEstimatedTokens: number;
  maxEstimatedToolSchemaChars: number;
};

const defaultConfig: ContextSizeGuardConfig = {
  maxEstimatedChars: 300_000,
  maxEstimatedTokens: 75_000,
  maxEstimatedToolSchemaChars: 80_000
};

function estimateRequestChars(request: AiSdkTurnRequest) {
  return request.system.length + JSON.stringify(request.messages).length;
}

export class ContextSizeGuard {
  constructor(private readonly config = defaultConfig) {}

  assertFits(input: {
    context: BuiltContext;
    request: AiSdkTurnRequest;
    resolvedTools: ResolvedTool[];
  }) {
    const toolSchemaChars = JSON.stringify(
      input.resolvedTools.map((tool) => tool.inputSchema)
    ).length;
    const requestChars = estimateRequestChars(input.request);

    if (
      input.context.estimate.chars > this.config.maxEstimatedChars ||
      input.context.estimate.tokens > this.config.maxEstimatedTokens ||
      toolSchemaChars > this.config.maxEstimatedToolSchemaChars ||
      requestChars > this.config.maxEstimatedChars
    ) {
      throw new Error('context_too_large_compact_not_implemented');
    }
  }
}
