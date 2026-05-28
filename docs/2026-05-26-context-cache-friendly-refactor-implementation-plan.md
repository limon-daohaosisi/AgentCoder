# Context Cache Friendly Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the RFC for cache-friendly context assembly, stable full tool exposure, runtime attachments, lazy plan file creation, and nested AGENTS.md injection.

**Architecture:** Keep stable rules in `system`, move volatile runtime state into durable synthetic user-side runtime context messages, stop variant-based tool visibility churn, and make nested AGENTS memory path-triggered. Reuse existing message persistence/event machinery rather than inventing a parallel attachment channel.

**Tech Stack:** TypeScript, pnpm monorepo, AI SDK request adapter, Hono server, SQLite/Drizzle repositories, Node test runner.

---

## Task 1: Add runtime context message part and prompt/runtime source plumbing

**Files:**

- Modify: `packages/shared/src/dto.ts`
- Modify: `packages/agent/src/context/schema.ts`
- Modify: `packages/agent/src/context/builder.ts`
- Modify: `packages/agent/src/context/ai-sdk-request-adapter.ts`
- Modify: `apps/web/src/features/chat/message-list.tsx`
- Test: `apps/server/src/__tests__/ai-sdk-adapter.test.ts`

## Task 2: Split stable system from volatile runtime context

**Files:**

- Modify: `packages/agent/src/context/system-context.ts`
- Modify: `packages/agent/src/context/prompt-bundle.ts`
- Modify: `apps/server/src/services/agent/prompt-source-service.ts`
- Create: `apps/server/src/services/agent/runtime-context-service.ts`
- Modify: `apps/server/src/wiring/agent.ts`
- Test: `apps/server/src/__tests__/ai-sdk-adapter.test.ts`

## Task 3: Make tools model-visible by default and push plan/build restrictions into execution policy

**Files:**

- Modify: `packages/agent/src/context/tool-registry.ts`
- Modify: `packages/agent/src/tools/bash/index.ts`
- Modify: `packages/agent/src/tools/apply_patch/index.ts`
- Create: `packages/agent/src/tools/shared/mode-policy.ts`
- Modify: `packages/agent/src/tools/plan_exit/index.ts`
- Test: `apps/server/src/__tests__/task-tool-registry.test.ts`
- Test: `apps/server/src/__tests__/session-processor.test.ts`

## Task 4: Change plan file lifecycle to lazy creation by model

**Files:**

- Modify: `apps/server/src/services/session/plan-file-service.ts`
- Modify: `apps/server/src/services/session/plan-service.ts`
- Modify: `apps/server/src/services/agent/interaction-service.ts`
- Modify: `packages/agent/src/tools/shared/plan-file-policy.ts`
- Test: `apps/server/src/__tests__/session-plan-board.test.ts`
- Test: `apps/server/src/__tests__/session-processor.test.ts`

## Task 5: Add read-triggered nested AGENTS.md runtime attachments

**Files:**

- Modify: `packages/shared/src/dto.ts`
- Modify: `packages/agent/src/tools/core.ts`
- Modify: `packages/agent/src/tools/read/index.ts`
- Create: `apps/server/src/services/agent/nested-agents-memory-service.ts`
- Modify: `apps/server/src/services/agent/prompt-source-service.ts`
- Modify: `apps/server/src/wiring/agent.ts`
- Test: `apps/server/src/__tests__/workspace-memory-service.test.ts`
- Test: `apps/server/src/__tests__/ai-sdk-adapter.test.ts`

## Task 6: Add/adjust focused verification and run targeted tests

**Files:**

- Modify: tests created above as needed
- Verify with: `pnpm --filter @opencode/server test -- src/__tests__/ai-sdk-adapter.test.ts src/__tests__/task-tool-registry.test.ts src/__tests__/session-processor.test.ts src/__tests__/workspace-memory-service.test.ts src/__tests__/session-plan-board.test.ts`
