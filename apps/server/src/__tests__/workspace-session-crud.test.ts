import assert from 'node:assert/strict';
import path from 'node:path';
import test, { beforeEach } from 'node:test';
import { dbTestContext, resetTestDatabase } from './db-test-context.js';
import { parseJson } from './server-test-helpers.js';

const { app, environment } = dbTestContext;
const repoRoot = path.resolve(import.meta.dirname, '../../../..');

beforeEach(() => {
  resetTestDatabase();
});

test('workspace + session CRUD smoke path persists in sqlite', async () => {
  const browseDefaultResponse = await app.request('/api/workspaces/browse');
  assert.equal(browseDefaultResponse.status, 200);

  const browseDefaultPayload = await parseJson<{
    currentPath: string;
    directories: Array<{ name: string; path: string }>;
    rootLabel: string;
    segments: Array<{ name: string; path: string }>;
  }>(browseDefaultResponse);

  assert.equal(browseDefaultPayload.data?.currentPath, repoRoot);
  assert.equal(browseDefaultPayload.data?.rootLabel, 'Current Repo');
  assert.ok(
    browseDefaultPayload.data?.directories.some(
      (directory) => directory.name === 'apps'
    )
  );
  assert.equal(browseDefaultPayload.data?.segments.at(-1)?.path, repoRoot);

  const createWorkspaceResponse = await app.request('/api/workspaces', {
    body: JSON.stringify({ rootPath: environment.workspaceRoot }),
    headers: {
      'content-type': 'application/json'
    },
    method: 'POST'
  });

  assert.equal(createWorkspaceResponse.status, 201);

  const createdWorkspace = await parseJson<{
    createdAt: string;
    id: string;
    lastOpenedAt: string;
    name: string;
    rootPath: string;
    updatedAt: string;
  }>(createWorkspaceResponse);

  assert.ok(createdWorkspace.data);
  assert.equal(createdWorkspace.data.rootPath, environment.workspaceRoot);
  assert.equal(
    createdWorkspace.data.name,
    path.basename(environment.workspaceRoot)
  );

  const duplicateWorkspaceResponse = await app.request('/api/workspaces', {
    body: JSON.stringify({ rootPath: environment.workspaceRoot }),
    headers: {
      'content-type': 'application/json'
    },
    method: 'POST'
  });

  assert.equal(duplicateWorkspaceResponse.status, 201);

  const duplicateWorkspace = await parseJson<{
    id: string;
    rootPath: string;
  }>(duplicateWorkspaceResponse);

  assert.equal(duplicateWorkspace.data?.id, createdWorkspace.data.id);
  assert.equal(duplicateWorkspace.data?.rootPath, environment.workspaceRoot);

  const listWorkspacesResponse = await app.request('/api/workspaces');
  assert.equal(listWorkspacesResponse.status, 200);

  const listedWorkspaces = await parseJson<
    Array<{ id: string; rootPath: string }>
  >(listWorkspacesResponse);

  assert.equal(listedWorkspaces.data?.length, 1);
  assert.equal(listedWorkspaces.data?.[0]?.id, createdWorkspace.data.id);

  const treeResponse = await app.request(
    `/api/workspaces/${createdWorkspace.data.id}/tree`
  );
  assert.equal(treeResponse.status, 200);

  const treePayload = await parseJson<
    Array<{
      children?: Array<{ name: string; type: 'directory' | 'file' }>;
      name: string;
      type: 'directory' | 'file';
    }>
  >(treeResponse);

  assert.equal(
    treePayload.data?.[0]?.name,
    path.basename(environment.workspaceRoot)
  );
  assert.ok(
    treePayload.data?.[0]?.children?.some((node) => node.name === 'src')
  );

  const browseWorkspaceResponse = await app.request(
    `/api/workspaces/browse?path=${encodeURIComponent(environment.workspaceRoot)}`
  );
  assert.equal(browseWorkspaceResponse.status, 200);

  const browseWorkspacePayload = await parseJson<{
    currentPath: string;
    directories: Array<{ name: string; path: string }>;
    parentPath?: string;
  }>(browseWorkspaceResponse);

  assert.equal(
    browseWorkspacePayload.data?.currentPath,
    environment.workspaceRoot
  );
  assert.equal(
    browseWorkspacePayload.data?.parentPath,
    path.dirname(environment.workspaceRoot)
  );
  assert.ok(
    browseWorkspacePayload.data?.directories.some(
      (directory) => directory.name === 'src'
    )
  );

  const createSessionResponse = await app.request('/api/sessions', {
    body: JSON.stringify({
      goalText: 'Review workspace + session CRUD smoke path',
      workspaceId: createdWorkspace.data.id
    }),
    headers: {
      'content-type': 'application/json'
    },
    method: 'POST'
  });

  assert.equal(createSessionResponse.status, 201);

  const createdSession = await parseJson<{
    createdAt: string;
    goalText: string;
    id: string;
    status: string;
    title: string;
    workspaceId: string;
  }>(createSessionResponse);

  assert.ok(createdSession.data);
  assert.equal(createdSession.data.workspaceId, createdWorkspace.data.id);
  assert.equal(
    createdSession.data.goalText,
    'Review workspace + session CRUD smoke path'
  );
  assert.equal(createdSession.data.status, 'planning');
  assert.equal(
    createdSession.data.title,
    'Review workspace + session CRUD smoke path'
  );

  const listSessionsResponse = await app.request(
    `/api/sessions?workspaceId=${createdWorkspace.data.id}`
  );
  assert.equal(listSessionsResponse.status, 200);

  const listedSessions =
    await parseJson<Array<{ id: string }>>(listSessionsResponse);

  assert.equal(listedSessions.data?.length, 1);
  assert.equal(listedSessions.data?.[0]?.id, createdSession.data.id);

  const getSessionResponse = await app.request(
    `/api/sessions/${createdSession.data.id}`
  );
  assert.equal(getSessionResponse.status, 200);

  const fetchedSession = await parseJson<{ id: string; status: string }>(
    getSessionResponse
  );

  assert.equal(fetchedSession.data?.id, createdSession.data.id);
  assert.equal(fetchedSession.data?.status, 'planning');

  const resumeResponse = await app.request(
    `/api/sessions/${createdSession.data.id}/resume`,
    {
      method: 'POST'
    }
  );
  assert.equal(resumeResponse.status, 200);

  const resumePayload = await parseJson<{
    canResume: boolean;
    checkpoint?: string;
    session?: { id: string };
  }>(resumeResponse);

  assert.equal(resumePayload.data?.canResume, false);
  assert.equal(resumePayload.data?.session?.id, createdSession.data.id);
  assert.equal(resumePayload.data?.checkpoint, undefined);

  const createSessionWithoutTitleResponse = await app.request('/api/sessions', {
    body: JSON.stringify({
      goalText:
        '   Review   workspace    session   CRUD   smoke   path   with   extra   whitespace   and   a   very   long   first   line   that   should   be   truncated   by   the   service   \nSecond line should be ignored',
      workspaceId: createdWorkspace.data.id
    }),
    headers: {
      'content-type': 'application/json'
    },
    method: 'POST'
  });

  assert.equal(createSessionWithoutTitleResponse.status, 201);

  const autoTitledSession = await parseJson<{
    title: string;
  }>(createSessionWithoutTitleResponse);

  assert.equal(
    autoTitledSession.data?.title,
    'Review workspace session CRUD smoke path with extra white...'
  );
});

test('workspace + session routes enforce the minimum Day 2 error contract', async () => {
  const invalidBrowseResponse = await app.request(
    `/api/workspaces/browse?path=${encodeURIComponent(
      path.join(environment.workspaceRoot, 'missing')
    )}`
  );

  assert.equal(invalidBrowseResponse.status, 400);
  assert.equal(
    (await parseJson(invalidBrowseResponse)).error,
    `Workspace path does not exist: ${path.join(environment.workspaceRoot, 'missing')}`
  );

  const missingWorkspacePathResponse = await app.request('/api/workspaces', {
    body: JSON.stringify({}),
    headers: {
      'content-type': 'application/json'
    },
    method: 'POST'
  });

  assert.equal(missingWorkspacePathResponse.status, 400);
  assert.equal(
    (await parseJson(missingWorkspacePathResponse)).error,
    'Validation failed'
  );

  const missingWorkspaceIdResponse = await app.request('/api/sessions');
  assert.equal(missingWorkspaceIdResponse.status, 400);
  assert.equal(
    (await parseJson(missingWorkspaceIdResponse)).error,
    'Validation failed'
  );

  const missingGoalTextResponse = await app.request('/api/sessions', {
    body: JSON.stringify({ workspaceId: 'missing-workspace' }),
    headers: {
      'content-type': 'application/json'
    },
    method: 'POST'
  });

  assert.equal(missingGoalTextResponse.status, 400);
  assert.equal(
    (await parseJson(missingGoalTextResponse)).error,
    'Validation failed'
  );

  const missingWorkspaceSessionResponse = await app.request('/api/sessions', {
    body: JSON.stringify({
      goalText: 'Create a session against a missing workspace',
      workspaceId: 'missing-workspace'
    }),
    headers: {
      'content-type': 'application/json'
    },
    method: 'POST'
  });

  assert.equal(missingWorkspaceSessionResponse.status, 404);
  assert.equal(
    (await parseJson(missingWorkspaceSessionResponse)).error,
    'Workspace not found: missing-workspace'
  );

  const missingSessionResponse = await app.request(
    '/api/sessions/missing-session'
  );
  assert.equal(missingSessionResponse.status, 404);
  assert.equal(
    (await parseJson(missingSessionResponse)).error,
    'Session not found'
  );

  const resumeMissingSessionResponse = await app.request(
    '/api/sessions/missing-session/resume',
    {
      method: 'POST'
    }
  );

  assert.equal(resumeMissingSessionResponse.status, 200);

  const missingResumePayload = await parseJson<{
    canResume: boolean;
    session?: { id: string };
  }>(resumeMissingSessionResponse);

  assert.equal(missingResumePayload.data?.canResume, false);
  assert.equal(missingResumePayload.data?.session, undefined);
});
