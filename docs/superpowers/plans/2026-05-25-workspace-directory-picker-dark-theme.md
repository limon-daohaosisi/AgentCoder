# Workspace Directory Picker Dark Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace manual workspace path input with a server-backed directory picker modal and shift the homepage workspace entry flow to a dark console-style theme.

**Architecture:** Add a small server-side browse endpoint that returns one directory level at a time starting from the repo root by default, then build a modal-driven homepage flow that consumes it and only submits the final absolute directory path to the existing workspace create endpoint. Keep the browse DTOs in `@opencode/shared`, keep filesystem validation in the server workspace service, and keep modal state local to the homepage UI.

**Tech Stack:** Hono, Node filesystem APIs, Zod, React 19, TanStack Query, TanStack Router, TailwindCSS, Node test runner, TypeScript

---

### Task 1: Shared Browse Contract

**Files:**

- Modify: `packages/shared/src/contracts.ts`
- Modify: `packages/shared/src/dto.ts`
- Test: `apps/server/src/__tests__/workspace-session-crud.test.ts`

- [ ] **Step 1: Write the failing test**

Add a new server test that expects `GET /api/workspaces/browse` to return the repo-root default directory plus child directories, and another assertion that `GET /api/workspaces/browse?path=<workspaceRoot>` returns the requested path.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @opencode/server test -- src/__tests__/workspace-session-crud.test.ts`
Expected: FAIL because `/api/workspaces/browse` does not exist yet.

- [ ] **Step 3: Write minimal shared types**

Add a browse query schema and browse DTO types for:

- `path?: string`
- `currentPath: string`
- `parentPath?: string`
- `segments: Array<{ name: string; path: string }>`
- `directories: Array<{ name: string; path: string }>`
- `rootLabel: string`

- [ ] **Step 4: Run type-aware verification**

Run: `pnpm --filter @opencode/server typecheck`
Expected: It may still fail on missing server implementation, but shared exports should parse cleanly.

### Task 2: Server Browse Endpoint

**Files:**

- Modify: `apps/server/src/services/workspace/service.ts`
- Modify: `apps/server/src/routes/workspaces/workspaces.schema.ts`
- Modify: `apps/server/src/routes/workspaces/workspaces.handler.ts`
- Modify: `apps/server/src/routes/workspaces/workspaces.route.ts`
- Test: `apps/server/src/__tests__/workspace-session-crud.test.ts`

- [ ] **Step 1: Implement the minimal browse service**

Add a service method that:

- Defaults to `process.cwd()` when `path` is missing
- Resolves and validates the requested directory
- Builds one-level directory results only
- Builds breadcrumb segments and parent path
- Throws `ServiceError` for nonexistent and non-directory paths

- [ ] **Step 2: Expose the route**

Add `GET /api/workspaces/browse` with query validation using the shared schema.

- [ ] **Step 3: Run focused tests**

Run: `pnpm --filter @opencode/server test -- src/__tests__/workspace-session-crud.test.ts`
Expected: PASS for the new browse assertions and the existing workspace CRUD assertions.

- [ ] **Step 4: Run server typecheck**

Run: `pnpm --filter @opencode/server typecheck`
Expected: PASS.

### Task 3: Frontend API and Modal State

**Files:**

- Modify: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/features/workspaces/directory-picker-modal.tsx`
- Modify: `apps/web/src/router.tsx`

- [ ] **Step 1: Add the failing frontend type usage**

Introduce a typed API helper for the browse endpoint and wire placeholder usage from `HomePage` so TypeScript references the new DTO.

- [ ] **Step 2: Run frontend typecheck to verify red state**

Run: `pnpm --filter @opencode/web typecheck`
Expected: FAIL until the modal component and state wiring exist.

- [ ] **Step 3: Implement the modal**

Build a local-state modal that:

- Opens on homepage button click
- Loads the default browse payload on open
- Supports entering directories, breadcrumb jumps, repo-root jump
- Tracks `currentPath`, `selectedPath`, `loading`, `error`
- Returns the selected path to the homepage on confirm

- [ ] **Step 4: Re-run frontend typecheck**

Run: `pnpm --filter @opencode/web typecheck`
Expected: PASS for modal and API wiring.

### Task 4: Homepage Dark Theme Conversion

**Files:**

- Modify: `apps/web/src/router.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/components/app-shell.tsx`

- [ ] **Step 1: Apply the homepage flow change**

Replace the manual path input form with:

- Primary button: `选择目录`
- Selected path summary block
- Secondary action: `创建或打开 Workspace`
- Recent workspaces kept as a secondary section

- [ ] **Step 2: Apply dark surface styling**

Shift the homepage surfaces, borders, and text hierarchy toward the approved near-black palette while preserving existing font families.

- [ ] **Step 3: Run frontend typecheck**

Run: `pnpm --filter @opencode/web typecheck`
Expected: PASS.

### Task 5: End-to-End Verification

**Files:**

- Modify: `apps/server/src/__tests__/workspace-session-crud.test.ts`
- Modify: `apps/web/src/router.tsx` (only if verification exposes missing edge handling)

- [ ] **Step 1: Verify backend behavior**

Run: `pnpm --filter @opencode/server test -- src/__tests__/workspace-session-crud.test.ts`
Expected: PASS.

- [ ] **Step 2: Verify frontend buildability**

Run: `pnpm --filter @opencode/web typecheck`
Expected: PASS.

- [ ] **Step 3: Verify combined workspace changes**

Run: `pnpm typecheck`
Expected: PASS, or report unrelated pre-existing failures separately if they appear outside this change.
