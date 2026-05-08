export const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini';

export function getOpenAIModel() {
  return process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
}

export function getDefaultModel() {
  return {
    modelId: getOpenAIModel(),
    providerId: 'openai'
  };
}
