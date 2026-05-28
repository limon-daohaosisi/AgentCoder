# Durable Runtime Context And System Rebalancing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebalance context assembly so session-stable dynamic context moves back into `system`, while true runtime attachments become durable message records instead of being rebuilt transiently on every turn.

**Architecture:** Keep `core + root AGENTS.md + session-stable dynamic context + mode rules + format` in the system prefix, and persist event-like or path-triggered runtime context as synthetic durable user messages backed by the existing `messages`/`message_parts` storage model. Reuse current message, part, and session-event infrastructure rather than maintaining a second in-memory-only attachment channel.

**Tech Stack:** TypeScript, pnpm monorepo, AI SDK, Hono server, SQLite/Drizzle repositories, Node test runner.

---

## Scope Summary

This plan implements two deliberate shifts relative to the current branch state:

1. **Move session-stable dynamic context back into `system`:**
   - model id / provider id
   - workspace root
   - agent name
   - simple platform/environment description
   - optionally stable per-session mode state that does not flip every turn

2. **Persist true attachments/runtime context as durable transcript messages:**
   - plan/build transition reminders
   - plan file reference reminders
   - nested `AGENTS.md` path-triggered memory
   - future read-triggered or hook-triggered runtime context

The target model is closer to `claude-code`:

- stable or session-stable context lives in system/systemContext
- event-like and path-triggered context lives in transcript messages
- compact can clear or summarize them because they are real persisted messages

---

## Current Storage And Context Constraints

Before implementing, preserve these observed facts from the current codebase:

### Existing durable storage primitives

- `messages` table stores message-level metadata such as `role`, `runtimeJson`, `providerMetadataJson`, `tokenUsageJson`, and `contentJson`.
  - Files: `apps/server/src/repositories/message-repository.ts`, `packages/orm/src/schema.ts`
- `message_parts` table stores the durable ordered content blocks for each message.
  - File: `apps/server/src/repositories/message-part-repository.ts`
- `messageService.createMessage(...)` already creates a durable message and durable parts in one transaction.
  - File: `apps/server/src/services/session/message/service.ts`
- `sessionEventService.append(...)` already publishes and persists transcript events after message creation.
  - File: `apps/server/src/services/session-events/event-service.ts`
- `SessionCompaction` already knows how to persist synthetic post-compact context as a normal transcript message.
  - File: `packages/agent/src/session-compaction.ts`

### Current non-durable runtime attachment behavior

- `ContextBuilder.build()` calls `listRuntimeContextSources(...)`, synthesizes a `runtimeContextMessage`, and injects it into the outgoing request only for the current build.
  - File: `packages/agent/src/context/builder.ts`
- These runtime context messages are **not** written through `messageService.createMessage(...)`.
- Therefore they are **not** part of the durable transcript, not replayable from the DB, and not naturally visible to compaction except when recomputed.

### Consequence

The current branch state has a split-brain context model:

- some synthetic context is durable (`post_compact_context`)
- most runtime attachment context is ephemeral and rebuilt each turn

This plan removes that inconsistency.

---

## File Structure

### Existing files to modify

- `packages/agent/src/context/system-context.ts`
- `packages/agent/src/context/prompt-bundle.ts`
- `packages/agent/src/context/builder.ts`
- `packages/agent/src/context/schema.ts`
- `packages/agent/src/context/ai-sdk-request-adapter.ts`
- `packages/shared/src/dto.ts`
- `apps/server/src/services/agent/runtime-context-service.ts`
- `apps/server/src/services/agent/prompt-source-service.ts`
- `apps/server/src/services/agent/interaction-service.ts`
- `apps/server/src/services/session/message/service.ts`
- `apps/server/src/services/session-events/event-service.ts`
- `apps/server/src/wiring/agent.ts`
- `packages/agent/src/session-compaction.ts`
- `packages/agent/src/tools/read/index.ts`

### Existing files to keep but repurpose

- `apps/server/src/services/agent/nested-agents-memory-service.ts`
  - Keep path-triggered discovery and dedup logic.
  - Stop using it as a purely transient source feeder.
  - Make it produce inputs for durable synthetic messages.

### New files to add

- `apps/server/src/services/agent/runtime-context-message-service.ts`
  - Durable synthetic message creator and deduper for runtime attachment messages.
- `packages/agent/src/context/session-stable-system-context.ts`
  - Helper for session-stable dynamic system blocks, extracted from current runtime context logic.
- `apps/server/src/__tests__/runtime-context-message-service.test.ts`
  - Focused durability/dedup tests.

---

## Task 1: Move Session-Stable Dynamic Context Back Into System

**Files:**

- Modify: `packages/agent/src/context/system-context.ts`
- Create: `packages/agent/src/context/session-stable-system-context.ts`
- Modify: `packages/agent/src/context/prompt-bundle.ts`
- Test: `apps/server/src/__tests__/ai-sdk-adapter.test.ts`

- [ ] **Step 1: Define the session-stable set explicitly**

Session-stable dynamic context for system should include:

```ts
const stableDynamicSystemFields = {
  model: `${providerId}/${modelId}`,
  workspaceRoot,
  agentName,
  platform: process.platform
};
```

Do **not** include in this set:

- plan/build transition reminder
- nested AGENTS memory
- read-triggered path context
- one-turn operational events

- [ ] **Step 2: Extract a helper that builds stable dynamic system blocks**

Create `packages/agent/src/context/session-stable-system-context.ts` with a helper shaped like:

```ts
import type { ContextSystemBlock } from './schema.js';

export function buildSessionStableSystemBlocks(input: {
  agentName: string;
  model: { modelId: string; providerId: string };
  workspaceRoot: string;
}): ContextSystemBlock[] {
  return [
    {
      source: 'instruction',
      text: [
        'Runtime environment:',
        `- Model: ${input.model.providerId}/${input.model.modelId}`,
        `- Working directory: ${input.workspaceRoot}`,
        `- Agent: ${input.agentName}`,
        `- Platform: ${process.platform}`
      ].join('\n')
    }
  ];
}
```

- [ ] **Step 3: Rewire system block assembly to use the helper**

In `packages/agent/src/context/system-context.ts`, compose system blocks as:

```ts
return [
  buildCoreSystemBlock(),
  ...buildSessionStableSystemBlocks({...}),
  ...buildRuntimeInstructionBlocks({...})
]
```

And ensure `buildRuntimeInstructionBlocks(...)` only retains system-worthy rules:

- mode rules
- user system
- format schema

- [ ] **Step 4: Ensure prompt bundle ordering reflects stable prefix intent**

Update `resolvePromptBundle(...)` ordering to be:

```ts
[
  core,
  root memory,
  stable dynamic system blocks,
  mode rules,
  user_system,
  format
]
```

- [ ] **Step 5: Update tests to assert new system ordering**

Adjust `apps/server/src/__tests__/ai-sdk-adapter.test.ts` so expectations match the new stable system structure, especially:

- root `AGENTS.md` still in system
- environment/model context back in system
- mode transition no longer required to be injected via transient runtime context

---

## Task 2: Introduce Durable Runtime Context Messages

**Files:**

- Create: `apps/server/src/services/agent/runtime-context-message-service.ts`
- Modify: `apps/server/src/services/session/message/service.ts`
- Modify: `apps/server/src/services/session-events/event-service.ts`
- Test: `apps/server/src/__tests__/runtime-context-message-service.test.ts`

- [ ] **Step 1: Define the durable attachment message model**

Use normal transcript messages with:

```ts
role: 'user'
runtime: {
  format: { type: 'text' },
  runtimeContextInjected: true,
  variant: currentVariant,
}
content: [
  {
    type: 'runtime_context',
    synthetic: true,
    kind: 'mode_transition' | 'plan_file' | 'nested_agents_memory' | ...,
    text,
    metadata,
  }
]
```

This is intentionally **not** a new table.

- [ ] **Step 2: Create the durable writer service**

Create `runtime-context-message-service.ts` with APIs like:

```ts
persistRuntimeContextMessage(input: {
  sessionId: string;
  runId?: string;
  variant?: 'plan' | 'build';
  key: string;
  parts: Array<{
    kind: RuntimeContextKind;
    metadata?: Record<string, unknown>;
    text: string;
  }>;
}): MessageDto
```

Also add dedup logic so repeated identical runtime context messages are not re-appended every turn.

Suggested dedup key:

```ts
const dedupKey = `${kind}:${stableHash(text + JSON.stringify(metadata ?? {}))}`;
```

Persist the dedup key in `part.metadata.runtimeContextDedupKey`.

- [ ] **Step 3: Add lookup helpers in message service**

Extend `messageService` with helper queries such as:

```ts
findLatestRuntimeContextMessage(sessionId: string, dedupKey: string): MessageDto | null
listRuntimeContextMessages(sessionId: string): MessageDto[]
```

These should reuse `messageRepository` + `messagePartRepository`, not invent a side store.

- [ ] **Step 4: Emit proper events after persistence**

After creating a durable runtime context message, append:

- `message.created`
- `message.part.created`
- `message.completed`

Re-use the existing event flow shape already used by compaction synthetic messages.

- [ ] **Step 5: Add focused tests for durability and dedup**

Create `runtime-context-message-service.test.ts` covering:

- creating a runtime context message writes durable message + part rows
- same dedup key does not create a duplicate message
- changed text/metadata does create a new message

---

## Task 3: Stop Rebuilding Runtime Attachments Ephemerally In ContextBuilder

**Files:**

- Modify: `packages/agent/src/context/builder.ts`
- Modify: `apps/server/src/services/agent/prompt-source-service.ts`
- Modify: `apps/server/src/services/agent/runtime-context-service.ts`
- Test: `apps/server/src/__tests__/ai-sdk-adapter.test.ts`

- [ ] **Step 1: Remove transient `runtimeContextMessage` injection from `ContextBuilder.build()`**

Delete the path that does:

```ts
const runtimeContextSources = listRuntimeContextSources(...)
const runtimeContextMessage = ...
insertRuntimeContextMessage(messages, runtimeContextMessage)
```

`ContextBuilder` should build from durable transcript + system only.

- [ ] **Step 2: Re-scope `runtimeContextService`**

Make `runtimeContextService` produce one of two things:

- session-stable system fields (for system helper)
- durable runtime-context message payloads (for persistence service)

It should no longer be a direct ephemeral message source for `ContextBuilder`.

- [ ] **Step 3: Keep `ENABLE_RUNTIME_CONTEXT_INJECTION` only as a compatibility flag if still needed**

If retained, redefine it to mean:

- whether runtime context persistence pipeline runs
- not whether `ContextBuilder` does ephemeral insertion

If not needed after refactor, remove it.

- [ ] **Step 4: Update tests to assert that runtime context is now transcript-backed**

Tests should verify:

- `ContextBuilder` no longer manufactures runtime context on the fly
- runtime context appears only if durable synthetic messages exist in storage

---

## Task 4: Persist Mode Transition And Plan File Attachments As Durable Messages

**Files:**

- Modify: `apps/server/src/services/agent/interaction-service.ts`
- Modify: `apps/server/src/wiring/agent.ts`
- Modify: `apps/server/src/services/session/plan-service.ts`
- Test: `apps/server/src/__tests__/session-services.test.ts`
- Test: `apps/server/src/__tests__/session-processor.test.ts`

- [ ] **Step 1: Persist build-transition reminder when approval flips plan -> build**

In `SessionInteractionService.resolveApproval()`, where plan exit currently creates a synthetic text message, convert it to use the durable runtime context message service.

Target payload:

```ts
parts: [
  {
    kind: 'mode_transition',
    metadata: { approvalId, planId, planFilePath },
    text: 'The plan has been approved. Begin implementation according to the current plan file and task list.'
  }
];
```

- [ ] **Step 2: Persist plan file reference only when it actually changes**

When current plan file becomes relevant, persist a `plan_file` runtime context message only if:

- there is no prior durable one for the same file path
- or the referenced plan id/file path changed

- [ ] **Step 3: Ensure these durable runtime context messages remain visible after restarts**

Because they live in `messages`/`message_parts`, startup recovery and replay should automatically include them. Add tests proving they survive a fresh `ContextBuilder.build()` from storage.

---

## Task 5: Persist Nested AGENTS.md Attachments Instead Of Injecting Them Transiently

**Files:**

- Modify: `apps/server/src/services/agent/nested-agents-memory-service.ts`
- Modify: `packages/agent/src/tools/read/index.ts`
- Modify: `apps/server/src/wiring/agent.ts`
- Test: `apps/server/src/__tests__/ai-sdk-adapter.test.ts`
- Test: `apps/server/src/__tests__/session-services.test.ts`

- [ ] **Step 1: Keep path-triggered discovery, but change output contract**

`nestedAgentsMemoryService` should continue to:

- track read-triggered file paths
- walk `workspaceRoot -> targetPath` directory chain
- dedup nested `AGENTS.md`

But instead of feeding transient runtime sources directly into `ContextBuilder`, it should produce payloads for `runtimeContextMessageService.persistRuntimeContextMessage(...)`.

- [ ] **Step 2: Decide persistence timing**

Recommended timing:

- after successful `read`
- before the next model turn begins

This keeps the discovered memory durable and replayable.

- [ ] **Step 3: Persist each newly discovered nested memory block as a durable synthetic user message**

Suggested shape:

```ts
role: 'user';
content: [
  {
    type: 'runtime_context',
    synthetic: true,
    kind: 'nested_agents_memory',
    metadata: { path: 'packages/agent/AGENTS.md', truncated: false },
    text: '<project-memory source="AGENTS.md" path="packages/agent/AGENTS.md">...'
  }
];
```

- [ ] **Step 4: Keep dedup session-local and transcript-level**

Use both:

- in-memory `loadedMemoryPaths` to avoid repeated work during a live session
- transcript dedup key to avoid duplicate durable messages after rebuild/recovery

- [ ] **Step 5: Verify transcript-backed nested memory appears in subsequent turns without recomputation**

Tests should prove:

- read a deep file
- durable nested memory message is written
- next `ContextBuilder.build()` includes it from DB-backed messages
- no extra duplicate message is written if the same path is read again

---

## Task 6: Redefine Compact Semantics For Durable Runtime Context Messages

**Files:**

- Modify: `packages/agent/src/session-compaction.ts`
- Modify: `apps/server/src/services/agent/nested-agents-memory-service.ts`
- Test: `apps/server/src/__tests__/session-services.test.ts`
- Test: `apps/server/src/__tests__/run-loop.test.ts`

- [ ] **Step 1: Stop treating all runtime context as ephemeral post-build material**

Because runtime context becomes durable transcript, compaction should now see it naturally via `listMessages(...)`.

- [ ] **Step 2: Keep clearing in-memory nested-memory tracking after compact**

Preserve:

```ts
resetRuntimeContextState(sessionId);
```

But reinterpret it as clearing only in-memory discovery state, not deleting durable messages.

- [ ] **Step 3: Decide which durable runtime context messages survive compaction untouched**

Recommended first-pass rule:

- `mode_transition` and `plan_file` remain durable unless explicitly compacted away by transcript compaction boundaries
- `nested_agents_memory` remains in transcript like any other durable synthetic message
- do not recreate them post-compact unless a new trigger occurs

- [ ] **Step 4: Keep `post_compact_context` as a special synthetic summary helper**

This existing mechanism is still useful, but it should be conceptually separate from durable runtime attachment messages.

- [ ] **Step 5: Add tests showing compact clears discovery state but not durable transcript history**

Test shape:

- persist nested memory message
- compact session
- verify message history still contains that durable synthetic message if not compacted away
- verify in-memory trigger state is reset
- verify later re-read can create a fresh message only when dedup rules allow

---

## Task 7: Verification And Cache-Debug Follow-Up

**Files:**

- Modify: tests above as needed
- Verify with exact commands below

- [ ] **Step 1: Run focused tests for message durability and system rebalance**

Run:

```bash
node --import tsx --test --test-concurrency=1 src/__tests__/ai-sdk-adapter.test.ts
node --import tsx --test --test-concurrency=1 src/__tests__/session-services.test.ts
node --import tsx --test --test-concurrency=1 src/__tests__/session-processor.test.ts
node --import tsx --test --test-concurrency=1 src/__tests__/session-plan-board.test.ts
node --import tsx --test --test-concurrency=1 src/__tests__/task-tool-registry.test.ts
node --import tsx --test --test-concurrency=1 src/__tests__/run-loop.test.ts
```

Expected: PASS for all six files.

- [ ] **Step 2: Add one end-to-end manual verification checklist**

Manual verification after implementation:

```text
1. Start server with default settings.
2. Send a first user prompt.
3. Confirm model/environment info appears in system-derived cacheDebug, not as runtime_context message.
4. Trigger a nested AGENTS.md discovery via read.
5. Confirm a durable synthetic runtime_context user message is written to DB.
6. Send the next prompt and verify ContextBuilder reads that durable message from storage.
7. Compact the session.
8. Confirm discovery state resets but durable transcript remains coherent.
```

- [ ] **Step 3: Self-review against current branch state**

Checklist:

- no remaining transient `runtimeContextMessage` insertion in `ContextBuilder`
- stable dynamic system fields are no longer emitted as durable runtime messages
- nested memory and mode transition attachments use durable message creation path
- compact reset only clears in-memory trigger/dedup state
- no new storage table was introduced unnecessarily

---

## Open Questions To Resolve During Implementation

1. Should `workspaceRoot` always stay in system, or should it become opt-in if user worries about cache churn across workspace switches?
2. Should `plan_file` durable runtime messages be unique per `planId`, per `filePath`, or both?
3. Should `mode_state` be durable at all, or should only `mode_transition` be durable while current mode remains system-only?

Recommended answers for implementation:

- `workspaceRoot`: keep in system for now
- `plan_file`: dedup by `planId + filePath`
- `mode_state`: do **not** persist durably in v1; keep current mode in system, persist only transitions/events

---

## Self-Review

Spec coverage check:

- Covers moving session-stable dynamic data back into system.
- Covers making runtime attachments durable via existing `messages` + `message_parts` storage.
- Covers nested `AGENTS.md` path-triggered persistence.
- Covers compact reset semantics under the durable model.
- Covers tests and verification.

Placeholder scan:

- No TBD/TODO placeholders remain.
- Each task names concrete files and concrete behavioral targets.

Type consistency check:

- Uses existing `MessageDto` / `MessagePart` / `runtime_context` naming already present in the current branch.
- Keeps `role: 'user'` for durable runtime context attachments to align with current transcript semantics.
