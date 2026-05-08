import { createOpenAI } from '@ai-sdk/openai';
import { ProxyAgent } from 'undici';

function getProxyUrl() {
  return (
    process.env.HTTPS_PROXY?.trim() ||
    process.env.https_proxy?.trim() ||
    process.env.HTTP_PROXY?.trim() ||
    process.env.http_proxy?.trim() ||
    undefined
  );
}

export function createLanguageModel(input: {
  modelId: string;
  providerId: string;
}) {
  if (input.providerId !== 'openai') {
    throw new Error(`Unsupported provider: ${input.providerId}`);
  }

  const proxyUrl = getProxyUrl();
  const openai = createOpenAI({
    apiKey: process.env.OPENAI_API_KEY?.trim(),
    baseURL: process.env.OPENAI_BASE_URL?.trim() || undefined,
    fetch: proxyUrl
      ? (url, init) =>
          fetch(url, {
            ...init,
            dispatcher: new ProxyAgent(proxyUrl)
          } as RequestInit & { dispatcher: ProxyAgent })
      : undefined
  });

  return openai(input.modelId);
}
