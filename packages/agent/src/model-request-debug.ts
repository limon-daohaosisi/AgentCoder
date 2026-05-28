import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AiSdkTurnRequest } from './context/schema.js';

const DEBUG_REQUEST_ENV = 'OPENCODE_DEBUG_MODEL_REQUESTS';
const DEBUG_REQUEST_DIR = path.join(tmpdir(), 'mycoding', 'model-requests');

function isEnabled() {
  const value = process.env[DEBUG_REQUEST_ENV]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function sanitizeFileSegment(value: string | undefined, fallback: string) {
  if (!value) {
    return fallback;
  }

  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function toSentPayload(request: AiSdkTurnRequest) {
  const usesOpenAiInstructions =
    request.providerId === 'openai' &&
    typeof request.providerOptions?.openai === 'object' &&
    request.providerOptions.openai !== null &&
    !Array.isArray(request.providerOptions.openai) &&
    typeof (request.providerOptions.openai as { instructions?: unknown })
      .instructions === 'string';

  return {
    messages: request.messages,
    modelId: request.modelId,
    providerId: request.providerId,
    ...(request.providerOptions === undefined
      ? {}
      : { providerOptions: request.providerOptions }),
    ...(usesOpenAiInstructions ? {} : { system: request.system }),
    tools: request.tools
  };
}

export function dumpSentModelRequest(request: AiSdkTurnRequest) {
  if (!isEnabled()) {
    return;
  }

  mkdirSync(DEBUG_REQUEST_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const requestKind = sanitizeFileSegment(
    request.debugRequestKind,
    'unknown_request'
  );
  const sessionId = sanitizeFileSegment(
    request.debugSessionId,
    'unknown_session'
  );
  const runId = sanitizeFileSegment(request.debugRunId, 'unknown_run');
  const fileName = `${requestKind}__${sessionId}__${runId}__${timestamp}.json`;
  const filePath = path.join(DEBUG_REQUEST_DIR, fileName);

  writeFileSync(
    filePath,
    JSON.stringify(toSentPayload(request), null, 2),
    'utf8'
  );
}
