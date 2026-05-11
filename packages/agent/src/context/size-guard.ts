import type { AiSdkTurnRequest, BuiltContext, ResolvedTool } from './schema.js';

export type ContextSizeGuardConfig = {
  compactTriggerTokens: number;
  contextWindowTokens: number;
  hardFailTokens: number;
  maxEstimatedToolSchemaChars: number;
  reserveCompactTokens: number;
  reserveOutputTokens: number;
  softBudgetTokens: number;
};

const defaultConfig: ContextSizeGuardConfig = {
  compactTriggerTokens: 72_000,
  contextWindowTokens: 128_000,
  hardFailTokens: 96_000,
  maxEstimatedToolSchemaChars: 80_000,
  reserveCompactTokens: 16_000,
  reserveOutputTokens: 24_000,
  softBudgetTokens: 56_000
};

function estimateRequestChars(request: AiSdkTurnRequest) {
  return request.system.length + JSON.stringify(request.messages).length;
}

export type BudgetAnalysis = {
  estimatedRequestTokens: number;
  fits: boolean;
  hardFailTokens: number;
  recommendation:
    | 'fits'
    | 'needs_tool_result_compaction'
    | 'needs_full_compaction'
    | 'unrecoverable';
  softBudgetTokens: number;
};

function estimateTokens(chars: number) {
  return Math.ceil(chars / 4);
}

export class ContextSizeGuard {
  constructor(private readonly config = defaultConfig) {}

  analyze(input: {
    context: BuiltContext;
    request: AiSdkTurnRequest;
    resolvedTools: ResolvedTool[];
  }): BudgetAnalysis {
    const toolSchemaChars = JSON.stringify(
      input.resolvedTools.map((tool) => tool.inputSchema)
    ).length;
    const requestChars = estimateRequestChars(input.request);
    const estimatedRequestTokens = estimateTokens(
      requestChars + toolSchemaChars
    );

    if (toolSchemaChars > this.config.maxEstimatedToolSchemaChars) {
      return {
        estimatedRequestTokens,
        fits: false,
        hardFailTokens: this.config.hardFailTokens,
        recommendation: 'unrecoverable',
        softBudgetTokens: this.config.softBudgetTokens
      };
    }

    const totalEstimateTokens = Math.max(
      input.context.estimate.tokens,
      estimatedRequestTokens
    );

    if (totalEstimateTokens <= this.config.softBudgetTokens) {
      return {
        estimatedRequestTokens,
        fits: true,
        hardFailTokens: this.config.hardFailTokens,
        recommendation: 'fits',
        softBudgetTokens: this.config.softBudgetTokens
      };
    }

    if (totalEstimateTokens <= this.config.compactTriggerTokens) {
      return {
        estimatedRequestTokens,
        fits: false,
        hardFailTokens: this.config.hardFailTokens,
        recommendation: 'needs_tool_result_compaction',
        softBudgetTokens: this.config.softBudgetTokens
      };
    }

    if (totalEstimateTokens <= this.config.hardFailTokens) {
      return {
        estimatedRequestTokens,
        fits: false,
        hardFailTokens: this.config.hardFailTokens,
        recommendation: 'needs_full_compaction',
        softBudgetTokens: this.config.softBudgetTokens
      };
    }

    return {
      estimatedRequestTokens,
      fits: false,
      hardFailTokens: this.config.hardFailTokens,
      recommendation: 'unrecoverable',
      softBudgetTokens: this.config.softBudgetTokens
    };
  }
}
