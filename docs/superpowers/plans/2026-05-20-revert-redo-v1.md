# Revert Redo V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-pass `revert/redo` flow that rolls a session back to a chosen user message, restores workspace files to the pre-message snapshot, and keeps the full durable transcript while projecting reverted state in the API and UI.

**Architecture:** Implement user-message scoped workspace snapshots in the server, store revert state on the session, and project reverted messages in reads instead of destructively deleting history. `revert` restores the workspace to the target message's pre-run snapshot and marks the session as reverted; `redo` restores the workspace to the snapshot taken immediately before revert and clears the reverted projection.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, SQLite, React, TanStack Query, SSE, local git-based workspace snapshot store

---

## File Structure

**Create**

- `apps/server/src/services/agent/workspace-snapshot-service.ts`
- `apps/server/src/services/session/revert-service.ts`
- `apps/server/src/__tests__/session-revert-service.test.ts`

**Modify**

- `packages/shared/src/dto.ts`
- `packages/shared/src/events.ts`
- `packages/orm/src/schema.ts`
- `packages/db/schema/sessions.lt.hcl`
- `packages/db/migrations/<new_migration>.sql`
- `packages/db/migrations/atlas.sum`
- `apps/server/src/services/session/service.ts`
- `apps/server/src/repositories/session-repository.ts`
- `apps/server/src/repositories/session-recovery-repository.ts`
- `apps/server/src/services/session/message/service.ts`
- `apps/server/src/services/agent/interaction-service.ts`
- `apps/server/src/routes/sessions/sessions.route.ts`
- `apps/server/src/routes/sessions/sessions.handler.ts`
- `apps/server/src/routes/sessions/sessions.schema.ts`
- `apps/server/src/services/session-events/event-service.ts`
- `apps/server/src/app.ts`
- `apps/web/src/lib/api.ts`
- `apps/web/src/hooks/use-session-stream.ts`
- `apps/web/src/router.tsx`
- `apps/web/src/features/chat/message-list.tsx`

**Responsibilities**

- `workspace-snapshot-service.ts`: Track and restore workspace file snapshots using an isolated git object store rooted outside the user's repo metadata.
- `revert-service.ts`: Orchestrate `revert` and `redo`, validate session state, call snapshot service, persist session revert state, and emit session events.
- `dto.ts` / `events.ts`: Add shared revert DTOs and SSE event types.
- `schema.ts` / `sessions.lt.hcl` / `session-repository.ts` / `session-recovery-repository.ts`: Persist session revert state durably and keep session DTO mapping aligned everywhere it is reconstructed.
- `message/service.ts`: Project reverted history in read paths without deleting durable message rows, using a persisted anchor instead of UUID ordering assumptions.
- session routes/handlers/schema: Add HTTP endpoints for revert and redo.
- web files: Expose revert/redo in the client, react to revert events, and project reverted messages in the timeline.

### Task 1: Add Shared Revert Types

**Files:**

- Modify: `packages/shared/src/dto.ts`
- Modify: `packages/shared/src/events.ts`
- Test: `apps/server/src/__tests__/session-services.test.ts`

- [ ] **Step 1: Add DTOs for session revert state and revert responses**

Add shared types to `packages/shared/src/dto.ts`:

```ts
export type SessionRevertDto = {
  beforeSnapshotId: string;
  createdAt: string;
  diffText?: string;
  redoSnapshotId?: string;
  targetMessageId: string;
};

export type RevertSessionResponse = {
  revert: SessionRevertDto;
  session: SessionDto;
};

export type RestoreRevertResponse = {
  restored: true;
  session: SessionDto;
};
```

Also add `revert?: SessionRevertDto` to `SessionDto`.

Add snapshot metadata to `MessageRuntimeMetadata` instead of adding a new top-level message column in v1:

```ts
beforeSnapshotId?: string;
```

- [ ] **Step 2: Add session revert SSE event types**

Extend `packages/shared/src/events.ts` with:

```ts
  | {
      type: 'session.reverted';
      revert: SessionRevertDto;
      sessionId: string;
    }
  | {
      type: 'session.revert_restored';
      sessionId: string;
    }
```

- [ ] **Step 3: Run shared typecheck through server tests**

Run: `pnpm --filter @opencode/server test -- session-services.test.ts`

Expected: Existing tests compile; failures are acceptable if they point to missing server-side schema/repository support added in later tasks.

- [ ] **Step 4: Commit shared type additions**

```bash
git add packages/shared/src/dto.ts packages/shared/src/events.ts apps/server/src/__tests__/session-services.test.ts
git commit -m "feat: add shared revert session types"
```

### Task 2: Persist Session Revert State

**Files:**

- Modify: `packages/orm/src/schema.ts`
- Modify: `packages/db/schema/sessions.lt.hcl`
- Create: `packages/db/migrations/<new_migration>.sql`
- Modify: `packages/db/migrations/atlas.sum`
- Modify: `apps/server/src/repositories/session-repository.ts`
- Modify: `apps/server/src/repositories/session-recovery-repository.ts`
- Modify: `apps/server/src/services/session/service.ts`
- Test: `apps/server/src/__tests__/session-services.test.ts`

- [ ] **Step 1: Add durable `revert_json` column to sessions schema**

Update the session schema definitions to add a nullable text column:

```ts
revertJson: text('revert_json'),
```

and mirror it in `packages/db/schema/sessions.lt.hcl`:

```hcl
  column "revert_json" {
    type = text
    null = true
  }
```

- [ ] **Step 2: Generate a new migration following `packages/db/AGENTS.md`**

From `packages/db`, generate a new migration instead of editing old SQL:

```bash
cd packages/db
atlas migrate diff add_session_revert_state --env local
```

Review the generated SQL under `packages/db/migrations/` and verify:

- it adds `revert_json` safely for SQLite
- no historical migration file is edited
- `atlas.sum` updates correctly

If you manually edit the generated SQL, refresh checksums:

```bash
cd packages/db
atlas migrate hash --dir "file://migrations"
```

- [ ] **Step 3: Map `revert_json` in every session repository mapper**

In `apps/server/src/repositories/session-repository.ts`, parse and serialize the new field:

```ts
revert: row.revertJson
  ? parseJsonValue<SessionRevertDto>(row.revertJson, undefined)
  : undefined,
```

and add repository update helpers:

```ts
setRevert(input: { id: string; revert: SessionRevertDto | null; updatedAt: string })
clearRevert(input: { id: string; updatedAt: string })
```

Mirror the same `revertJson -> SessionDto.revert` mapping change in `apps/server/src/repositories/session-recovery-repository.ts` so recovery code does not drift from the main repository.

- [ ] **Step 4: Expose session revert updates from session service**

In `apps/server/src/services/session/service.ts`, add methods:

```ts
setSessionRevert(input: { revert: SessionRevertDto; sessionId: string })
clearSessionRevert(sessionId: string)
```

These should delegate to the repository helpers and keep `updatedAt` current.

- [ ] **Step 5: Add repository/service tests for round-tripping revert state**

Extend `apps/server/src/__tests__/session-services.test.ts` with assertions that:

- a session can persist `revert`
- a session can clear `revert`
- other session fields remain intact

- [ ] **Step 6: Sync ORM and verify the generated migration is applied in test setup**

Run:

```bash
pnpm db:sync
```

Then confirm test helpers still apply all migrations rather than depending on a base snapshot only.

- [ ] **Step 7: Run the focused test file**

Run: `pnpm --filter @opencode/server test -- session-services.test.ts`

Expected: PASS

- [ ] **Step 8: Commit session revert persistence**

```bash
git add packages/orm/src/schema.ts packages/db/schema/sessions.lt.hcl packages/db/migrations apps/server/src/repositories/session-repository.ts apps/server/src/repositories/session-recovery-repository.ts apps/server/src/services/session/service.ts apps/server/src/__tests__/session-services.test.ts
git commit -m "feat: persist session revert state"
```

### Task 3: Add Workspace Snapshot Service

**Files:**

- Create: `apps/server/src/services/agent/workspace-snapshot-service.ts`
- Test: `apps/server/src/__tests__/session-revert-service.test.ts`

- [ ] **Step 1: Write failing snapshot service tests**

Create `apps/server/src/__tests__/session-revert-service.test.ts` with tests that:

- track a snapshot in a git-backed temp workspace
- modify a tracked file
- restore the workspace to the snapshot
- verify the file content is restored

Test shape:

```ts
test('workspaceSnapshotService restores tracked files to a previous snapshot', async () => {
  // create temp git repo
  // write baseline file
  // snapshot
  // modify file
  // restore
  // assert original content returned
});
```

- [ ] **Step 2: Implement isolated snapshot tracking**

Create `apps/server/src/services/agent/workspace-snapshot-service.ts` with a small API:

```ts
export const workspaceSnapshotService = {
  async track(input: { workspaceRoot: string }) { ... },
  async restore(input: { snapshotId: string; workspaceRoot: string }) { ... },
  async diff(input: { snapshotId: string; workspaceRoot: string }) { ... }
};
```

Implementation constraints:

- require the workspace to be a git repo for v1
- use a private git dir under app data or `.opencode-web-lite/snapshots/<workspace-hash>`
- never mutate the user's `.git/index`
- stage visible tracked + untracked files under `workspaceRoot`
- restore only workspace files

- [ ] **Step 3: Keep v1 intentionally narrow**

Make the service explicitly reject unsupported cases:

- missing git repo
- snapshot restore failure

Return actionable errors like:

```ts
throw new ServiceError(
  'Workspace revert requires a git-backed workspace in revert v1.',
  409
);
```

- [ ] **Step 4: Run the snapshot test file**

Run: `pnpm --filter @opencode/server test -- session-revert-service.test.ts`

Expected: FAIL first, then PASS after implementation

- [ ] **Step 5: Commit workspace snapshot service**

```bash
git add apps/server/src/services/agent/workspace-snapshot-service.ts apps/server/src/__tests__/session-revert-service.test.ts
git commit -m "feat: add workspace snapshot service for revert"
```

### Task 4: Capture User-Message Snapshots Before Execution

**Files:**

- Modify: `apps/server/src/services/agent/interaction-service.ts`
- Modify: `apps/server/src/services/session/message/service.ts`
- Modify: `apps/server/src/repositories/message-repository.ts`
- Modify: `packages/shared/src/dto.ts`
- Test: `apps/server/src/__tests__/session-revert-service.test.ts`

- [ ] **Step 1: Persist snapshot metadata in `runtime_json` for user messages**

Extend `MessageRuntimeMetadata` so the server can associate a user message with its pre-execution snapshot without adding a new DB column in v1:

```ts
beforeSnapshotId?: string;
```

Do not add a new top-level message column for this in v1; keep storage inside existing `runtime_json`.

- [ ] **Step 2: Persist snapshot metadata when creating the user message**

In `sessionInteractionService.prompt(...)`, before starting the run:

- resolve workspace root
- call `workspaceSnapshotService.track({ workspaceRoot })`
- merge `beforeSnapshotId` into the created user message runtime metadata

If snapshot tracking fails with a supported `ServiceError`, abort prompt submission and surface the error.

- [ ] **Step 3: Add tests proving a new user message stores `beforeSnapshotId`**

Add a test that submits a session message, then reads messages back and asserts the latest user message has `runtime.beforeSnapshotId`.

- [ ] **Step 4: Run the revert-focused server tests**

Run: `pnpm --filter @opencode/server test -- session-revert-service.test.ts`

Expected: PASS

- [ ] **Step 5: Commit message snapshot capture**

```bash
git add apps/server/src/services/agent/interaction-service.ts apps/server/src/services/session/message/service.ts apps/server/src/repositories/message-repository.ts packages/shared/src/dto.ts apps/server/src/__tests__/session-revert-service.test.ts
git commit -m "feat: capture pre-message workspace snapshots"
```

### Task 5: Implement Session Revert and Redo Services

**Files:**

- Create: `apps/server/src/services/session/revert-service.ts`
- Modify: `apps/server/src/services/session/message/service.ts`
- Modify: `apps/server/src/services/session-events/event-service.ts`
- Test: `apps/server/src/__tests__/session-revert-service.test.ts`

- [ ] **Step 1: Add failing revert/redo service tests**

Add tests covering:

- revert to a target user message restores workspace files
- revert marks the session with revert state
- redo restores the workspace to the pre-revert state
- revert refuses to run when a session has an active run

- [ ] **Step 2: Implement `revert-service.ts` orchestration**

Create service methods:

```ts
revertToMessage(input: { messageId: string; sessionId: string })
restoreRevert(input: { sessionId: string })
```

`revertToMessage` should:

- load session and messages
- assert target message exists and is a user message
- assert no active run is present
- assert target message has `runtime.beforeSnapshotId`
- take a `redoSnapshotId` from current workspace state
- restore to `beforeSnapshotId`
- compute optional diff text from `redoSnapshotId`
- persist session revert state
- append `session.reverted` and `session.updated`

`restoreRevert` should:

- load session revert state
- restore `redoSnapshotId`
- clear revert state
- append `session.revert_restored` and `session.updated`

- [ ] **Step 3: Define an explicit projection anchor instead of relying on UUID ordering**

Do not compare message UUIDs lexicographically. UUID/random IDs in this project are not a safe ordering primitive.

For v1, store `targetMessageId` durably and compute the visible message projection by:

- loading messages in repository order (`created_at`, insertion order tie-break)
- finding the index of `targetMessageId`
- projecting only messages before that index while the session is reverted

Reuse this same ordered projection logic in both the session message service and any other server read path that needs the active transcript.

- [ ] **Step 4: Project reverted message history without deleting rows**

In `apps/server/src/services/session/message/service.ts`, add a projected read path for session messages:

- if `session.revert.targetMessageId` exists, only return messages before the target anchor in durable session order
- keep durable rows intact in the database

Do not mutate or delete message rows in v1.

- [ ] **Step 5: Clear active revert state before accepting a fresh user prompt**

In `apps/server/src/services/agent/interaction-service.ts`, before creating a new user message:

- if the session currently has `revert` state, clear it first
- do not auto-restore the workspace snapshot; the user is explicitly branching from the reverted state

This prevents a stale revert projection from hiding the newly submitted prompt.

- [ ] **Step 6: Emit and replay new session revert events**

Ensure the event service and SSE replay path handle:

- `session.reverted`
- `session.revert_restored`

- [ ] **Step 7: Run the focused revert tests**

Run: `pnpm --filter @opencode/server test -- session-revert-service.test.ts`

Expected: PASS

- [ ] **Step 8: Commit revert/redo service**

```bash
git add apps/server/src/services/session/revert-service.ts apps/server/src/services/session/message/service.ts apps/server/src/services/session-events/event-service.ts apps/server/src/__tests__/session-revert-service.test.ts
git commit -m "feat: add session revert and redo orchestration"
```

### Task 6: Expose Revert and Redo HTTP APIs

**Files:**

- Modify: `apps/server/src/routes/sessions/sessions.schema.ts`
- Modify: `apps/server/src/routes/sessions/sessions.handler.ts`
- Modify: `apps/server/src/routes/sessions/sessions.route.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/src/__tests__/agent-routes.test.ts`

- [ ] **Step 1: Add request schemas for revert and restore**

Extend `sessions.schema.ts` with:

```ts
revertSession: {
  param: z.object({ sessionId: z.string().uuid() }),
  json: z.object({ messageId: z.string().uuid() })
},
restoreRevert: {
  param: z.object({ sessionId: z.string().uuid() }),
  json: z.object({})
}
```

- [ ] **Step 2: Add handlers that call the revert service**

In `sessions.handler.ts`, add:

```ts
export const revertSession = ...
export const restoreRevert = ...
```

Return `200` with the shared response DTOs.

- [ ] **Step 3: Register routes**

In `sessions.route.ts`, add:

```ts
.post('/:sessionId/revert', ...handlers.revertSession)
.post('/:sessionId/revert/restore', ...handlers.restoreRevert)
```

- [ ] **Step 4: Add route tests**

Extend `apps/server/src/__tests__/agent-routes.test.ts` or create a sessions-route test asserting:

- valid request delegates to service
- invalid request returns validation error
- service errors surface correct HTTP status

- [ ] **Step 5: Prefer a dedicated sessions-route test if it avoids coupling to agent routes**

If the existing agent route tests are organized around `/api/sessions/:sessionId/messages` and `/stream`, create a new `apps/server/src/__tests__/sessions-routes.test.ts` instead of overloading `agent-routes.test.ts`.

- [ ] **Step 6: Run route tests**

Run: `pnpm --filter @opencode/server test -- agent-routes.test.ts sessions-routes.test.ts`

Expected: PASS

- [ ] **Step 7: Commit the HTTP surface**

```bash
git add apps/server/src/routes/sessions/sessions.schema.ts apps/server/src/routes/sessions/sessions.handler.ts apps/server/src/routes/sessions/sessions.route.ts apps/server/src/app.ts apps/server/src/__tests__/agent-routes.test.ts
git commit -m "feat: expose revert and redo session APIs"
```

### Task 7: Wire Revert and Redo into the Web Client

**Files:**

- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/hooks/use-session-stream.ts`
- Modify: `apps/web/src/lib/message-projection.ts`
- Modify: `apps/web/src/router.tsx`
- Modify: `apps/web/src/features/chat/message-list.tsx`

- [ ] **Step 1: Add client API functions**

Extend `apps/web/src/lib/api.ts`:

```ts
export function revertSession(sessionId: string, input: { messageId: string }) {
  return fetchData<RevertSessionResponse>(`/sessions/${sessionId}/revert`, { ... });
}

export function restoreRevert(sessionId: string) {
  return fetchData<RestoreRevertResponse>(`/sessions/${sessionId}/revert/restore`, { ... });
}
```

- [ ] **Step 2: Make the stream hook treat revert events as cache-relevant**

Update `SESSION_EVENT_NAMES`, `isCacheRelevantEvent`, and `isMessageCacheRelevantEvent` in `use-session-stream.ts` to include:

- `session.reverted`
- `session.revert_restored`

- [ ] **Step 3: Prevent stale SSE events from re-projecting reverted messages**

Update `apps/web/src/lib/message-projection.ts` so revert-aware message projection does not resurrect messages from the pre-revert event buffer.

Choose one of these explicit strategies and implement it consistently:

- reset the in-memory event buffer in `useSessionStream` when `session.reverted` or `session.revert_restored` arrives, or
- teach `projectMessages(...)` to accept the active `session.revert.targetMessageId` anchor and ignore projected messages at or after that anchor

Do not rely on the base query alone; the current stream projection layer can replay older `message.*` events back into the UI.

- [ ] **Step 4: Add router mutations and banner state**

In `apps/web/src/router.tsx`:

- add `useMutation` hooks for revert and restore
- invalidate `session`, `messages`, and `resume-session`
- surface a lightweight banner when `currentSession.revert` exists

- [ ] **Step 5: Add a simple message-level revert affordance**

In `message-list.tsx`, for user messages:

- show a small action button or menu item for `Revert to here`
- hide or disable it while the session is running

Do not build a complex revert dock in v1; a banner plus per-message action is enough.

- [ ] **Step 6: Filter revert actions to user messages only**

Use existing message metadata already available in `MessageList` and `router.tsx`; do not infer revert targets from assistant messages in v1.

- [ ] **Step 7: Run web typecheck**

Run: `pnpm --filter @opencode/web typecheck`

Expected: PASS

- [ ] **Step 8: Commit the web client integration**

```bash
git add apps/web/src/lib/api.ts apps/web/src/hooks/use-session-stream.ts apps/web/src/lib/message-projection.ts apps/web/src/router.tsx apps/web/src/features/chat/message-list.tsx
git commit -m "feat: add web revert and redo controls"
```

### Task 8: End-to-End Verification and Documentation

**Files:**

- Modify: `docs/superpowers/plans/2026-05-20-revert-redo-v1.md`
- Test: `apps/server/src/__tests__/session-revert-service.test.ts`
- Test: `apps/server/src/__tests__/agent-routes.test.ts`

- [ ] **Step 1: Run the focused backend test suite**

Run: `pnpm --filter @opencode/server test -- session-revert-service.test.ts agent-routes.test.ts`

Expected: PASS

- [ ] **Step 2: Run repo typechecks affected by the change**

Run: `pnpm --filter @opencode/server typecheck`

Expected: PASS

Run: `pnpm --filter @opencode/web typecheck`

Expected: PASS

Run: `pnpm --filter @opencode/agent typecheck`

Expected: PASS

- [ ] **Step 3: Manual verification checklist**

Validate these scenarios locally:

- create a session and submit a user message that edits a tracked file
- revert to that user message and verify the file content restores
- verify reverted messages disappear from the active timeline projection
- redo and verify the file content and timeline restore
- run a `bash` command that only changes workspace files and verify revert restores those files
- confirm the UI does not claim to revert non-file system side effects

- [ ] **Step 4: Record residual constraints in the plan**

Add a short note to this plan stating v1 constraints:

- only git-backed workspaces are supported
- revert only restores workspace files
- ignored/generated/system/global side effects are out of scope
- `runtime.beforeSnapshotId` is the v1 message anchor; no message table column was added for per-message snapshots

- [ ] **Step 5: Commit final verification updates**

```bash
git add docs/superpowers/plans/2026-05-20-revert-redo-v1.md
git commit -m "docs: finalize revert redo v1 plan"
```

## Self-Review

- Spec coverage: This plan covers the agreed v1 scope only: user-message scoped revert, workspace file restore, redo, server persistence, SSE, and web projection. It intentionally does not cover tool-level revert, database rollback, package-manager global state rollback, or non-git workspace support.
- Placeholder scan: No `TBD` or deferred implementation placeholders remain; every task includes concrete files, commands, and boundaries.
- Type consistency: The plan consistently uses `SessionRevertDto`, `beforeSnapshotId`, `redoSnapshotId`, `session.reverted`, and `session.revert_restored`.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-20-revert-redo-v1.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
