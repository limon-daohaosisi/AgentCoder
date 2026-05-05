import { streamText, type StreamTextResult, type ToolSet } from 'ai';
import type { AiSdkTurnRequest } from './context/schema.js';

export type ModelResponseStream = StreamTextResult<ToolSet, never>;

export type StreamModelResponse = (
  request: AiSdkTurnRequest,
  options?: { signal?: AbortSignal }
) => ModelResponseStream;

export function streamModelResponse(
  request: AiSdkTurnRequest,
  options: { signal?: AbortSignal } = {}
): ModelResponseStream {
  const usesOpenAiInstructions =
    request.providerId === 'openai' &&
    typeof request.providerOptions?.openai === 'object' &&
    request.providerOptions.openai !== null &&
    !Array.isArray(request.providerOptions.openai) &&
    typeof (request.providerOptions.openai as { instructions?: unknown })
      .instructions === 'string';

  return streamText({
    abortSignal: options.signal,
    messages: request.messages,
    model: request.model,
    providerOptions: request.providerOptions as never,
    stopWhen: [],
    system: usesOpenAiInstructions ? undefined : request.system,
    toolChoice: 'auto',
    tools: request.tools
  }) as ModelResponseStream;
}
