import type {
  ContextSystemBlock,
  PromptBundle,
  PromptMemorySource,
  PromptSourceDebug
} from './schema.js';

type PromptBundleResolverInput = {
  coreBlock: ContextSystemBlock;
  memorySources: PromptMemorySource[];
  stableSystemBlocks?: ContextSystemBlock[];
  runtimeInstructionBlocks: ContextSystemBlock[];
};

function toMemoryBlock(source: PromptMemorySource): ContextSystemBlock {
  return {
    source: 'memory',
    text: source.text
  };
}

function toDebugSource(
  block: ContextSystemBlock,
  input: {
    origin?: string;
    sourceId: string;
    truncated?: boolean;
  }
): PromptSourceDebug {
  return {
    kind: block.source,
    origin: input.origin,
    sourceId: input.sourceId,
    truncated: input.truncated
  };
}

export function resolvePromptBundle(
  input: PromptBundleResolverInput
): PromptBundle {
  const systemBlocks: ContextSystemBlock[] = [
    input.coreBlock,
    ...input.memorySources.map(toMemoryBlock),
    ...(input.stableSystemBlocks ?? []),
    ...input.runtimeInstructionBlocks
  ];

  const debugSources: PromptSourceDebug[] = [
    toDebugSource(input.coreBlock, { sourceId: 'core_system_prompt' }),
    ...input.memorySources.map((source) =>
      toDebugSource(toMemoryBlock(source), {
        origin: source.origin,
        sourceId: source.sourceId,
        truncated: source.truncated
      })
    ),
    ...(input.stableSystemBlocks ?? []).map((block, index) =>
      toDebugSource(block, {
        sourceId: `${block.source}_stable_${index + 1}`
      })
    ),
    ...input.runtimeInstructionBlocks.map((block, index) =>
      toDebugSource(block, {
        sourceId: `${block.source}_${index + 1}`
      })
    )
  ];

  return {
    debugSources,
    systemBlocks
  };
}
