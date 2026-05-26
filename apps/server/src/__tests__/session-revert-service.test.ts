import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { dbTestContext, resetTestDatabase } from './db-test-context.js';
import { workspaceSnapshotService } from '../services/agent/workspace-snapshot-service.js';
import { workspaceService } from '../services/workspace/service.js';
import { sessionService } from '../services/session/service.js';
import { messageService } from '../services/session/message/service.js';
import { sessionRevertService } from '../services/session/revert-service.js';
import { SessionInteractionService } from '../services/agent/interaction-service.js';

const { environment } = dbTestContext;

beforeEach(() => {
  resetTestDatabase();
});

test('workspaceSnapshotService restores tracked files to a previous snapshot', async () => {
  const filePath = path.join(environment.workspaceRoot, 'src', 'index.ts');
  const originalContent = readFileSync(filePath, 'utf8');
  const snapshotId = await workspaceSnapshotService.track({
    workspaceRoot: environment.workspaceRoot
  });

  writeFileSync(filePath, 'export const ok = false;\n');

  const diffText = await workspaceSnapshotService.diff({
    snapshotId,
    workspaceRoot: environment.workspaceRoot
  });

  assert.match(diffText, /export const ok = false/u);

  await workspaceSnapshotService.restore({
    snapshotId,
    workspaceRoot: environment.workspaceRoot
  });

  assert.equal(readFileSync(filePath, 'utf8'), originalContent);
});

test('workspaceSnapshotService restores files in a non-git workspace', async () => {
  const workspaceRoot = path.join(
    tmpdir(),
    `opencode-non-git-workspace-${Date.now()}`
  );

  cpSync(environment.workspaceRoot, workspaceRoot, { recursive: true });
  rmSync(path.join(workspaceRoot, '.git'), { force: true, recursive: true });

  const filePath = path.join(workspaceRoot, 'src', 'index.ts');
  const createdDirPath = path.join(workspaceRoot, 'src', 'nested');
  const createdFilePath = path.join(createdDirPath, 'created.ts');
  const originalContent = readFileSync(filePath, 'utf8');

  try {
    const snapshotId = await workspaceSnapshotService.track({
      workspaceRoot
    });

    writeFileSync(filePath, 'export const ok = false;\n');
    mkdirSync(createdDirPath, { recursive: true });
    writeFileSync(createdFilePath, 'export const created = true;\n');

    const diffText = await workspaceSnapshotService.diff({
      snapshotId,
      workspaceRoot
    });

    assert.match(diffText, /export const ok = false/u);
    assert.match(diffText, /created\.ts/u);

    await workspaceSnapshotService.restore({
      snapshotId,
      workspaceRoot
    });

    assert.equal(readFileSync(filePath, 'utf8'), originalContent);
    assert.equal(existsSync(createdFilePath), false);
  } finally {
    rmSync(workspaceRoot, { force: true, recursive: true });
  }
});

test('workspaceSnapshotService restores unicode filenames with spaces in a git workspace', async () => {
  const workspaceRoot = mkdtempSync(
    path.join(tmpdir(), 'opencode-git-unicode-workspace-')
  );

  cpSync(environment.workspaceRoot, workspaceRoot, { recursive: true });

  try {
    rmSync(path.join(workspaceRoot, '.git'), { force: true, recursive: true });
    const gitInit = await import('node:child_process').then(
      ({ execFile }) =>
        new Promise<void>((resolve, reject) => {
          execFile('git', ['init'], { cwd: workspaceRoot }, (error) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          });
        })
    );
    void gitInit;

    const filePath = path.join(workspaceRoot, '新建 文本文档.txt');
    const snapshotId = await workspaceSnapshotService.track({
      workspaceRoot
    });

    writeFileSync(filePath, 'hello\n');

    await workspaceSnapshotService.diff({
      snapshotId,
      workspaceRoot
    });

    await workspaceSnapshotService.restore({
      snapshotId,
      workspaceRoot
    });

    assert.equal(existsSync(filePath), false);
  } finally {
    rmSync(workspaceRoot, { force: true, recursive: true });
  }
});

test('sessionRevertService reverts to a target user message and restores redo', async () => {
  const workspace = workspaceService.createWorkspace({
    rootPath: environment.workspaceRoot
  });
  const session = sessionService.createSession({
    goalText: 'Revert a session to a previous user message',
    workspaceId: workspace.id
  });
  const filePath = path.join(environment.workspaceRoot, 'src', 'index.ts');
  const initialContent = readFileSync(filePath, 'utf8');
  const beforeSnapshotId = await workspaceSnapshotService.track({
    workspaceRoot: environment.workspaceRoot
  });
  const targetMessage = messageService.createMessage({
    content: [{ text: 'Change the file', type: 'text' }],
    role: 'user',
    runtime: {
      beforeSnapshotId,
      variant: 'build'
    },
    sessionId: session.id
  });

  writeFileSync(filePath, 'export const ok = false;\n');
  messageService.createMessage({
    content: [{ text: 'Done', type: 'text' }],
    role: 'assistant',
    sessionId: session.id
  });

  const reverted = await sessionRevertService.revertToMessage({
    messageId: targetMessage.id,
    sessionId: session.id
  });

  assert.equal(readFileSync(filePath, 'utf8'), initialContent);
  assert.equal(reverted.session.revert?.targetMessageId, targetMessage.id);
  assert.equal(messageService.listMessages(session.id).length, 0);

  const restored = await sessionRevertService.restoreRevert({
    sessionId: session.id
  });

  assert.equal(restored.session.revert, undefined);
  assert.equal(readFileSync(filePath, 'utf8'), 'export const ok = false;\n');
});

test('reverted session can continue from the rollback point without restoring reverted context', async () => {
  const workspaceRoot = mkdtempSync(
    path.join(tmpdir(), 'opencode-revert-continue-')
  );
  cpSync(environment.workspaceRoot, workspaceRoot, { recursive: true });

  try {
    const workspace = workspaceService.createWorkspace({
      rootPath: workspaceRoot
    });
    const session = sessionService.createSession({
      defaultVariant: 'build',
      goalText: 'Continue after revert without reviving reverted context',
      workspaceId: workspace.id
    });
    const filePath = path.join(workspaceRoot, 'src', 'index.ts');
    const initialContent = readFileSync(filePath, 'utf8');
    const beforeSnapshotId = await workspaceSnapshotService.track({
      workspaceRoot
    });
    const targetMessage = messageService.createMessage({
      content: [{ text: 'Keep this branch point', type: 'text' }],
      role: 'user',
      runtime: {
        beforeSnapshotId,
        variant: 'build'
      },
      sessionId: session.id
    });

    writeFileSync(filePath, 'export const oldBranch = true;\n');
    messageService.createMessage({
      content: [{ text: 'Old branch assistant reply', type: 'text' }],
      role: 'assistant',
      sessionId: session.id
    });
    const reverted = await sessionRevertService.revertToMessage({
      messageId: targetMessage.id,
      sessionId: session.id
    });

    assert.equal(readFileSync(filePath, 'utf8'), initialContent);
    assert.equal(typeof reverted.session.revert?.redoSnapshotId, 'string');
    assert.equal(reverted.session.revert?.continuedAt, undefined);
    assert.deepEqual(
      messageService.listMessages(session.id).map((message) => message.id),
      []
    );

    const interactionService = new SessionInteractionService(undefined, {
      async startPromptRun() {
        sessionService.updateSessionRuntimeState({
          lastCheckpoint: null,
          lastErrorText: null,
          sessionId: session.id,
          status: 'idle'
        });
      }
    } as never);

    const submitted = await interactionService.prompt({
      content: 'Start a new branch from the rollback point',
      sessionId: session.id,
      variant: 'build'
    });

    assert.equal(submitted.accepted, true);
    assert.equal(
      sessionService.getSession(session.id)?.revert?.targetMessageId,
      targetMessage.id
    );
    assert.equal(
      sessionService.getSession(session.id)?.revert?.redoSnapshotId,
      undefined
    );
    assert.equal(
      typeof sessionService.getSession(session.id)?.revert?.continuedAt,
      'string'
    );
    const visibleMessages = messageService.listMessages(session.id);
    assert.equal(visibleMessages.length, 1);
    assert.equal(visibleMessages[0]?.role, 'user');
    assert.equal(
      visibleMessages[0]?.content[0]?.type === 'text'
        ? visibleMessages[0].content[0].text
        : undefined,
      'Start a new branch from the rollback point'
    );

    const allMessages = messageService.listMessages(session.id, {
      includeReverted: true
    });
    assert.equal(
      allMessages.some((message) => message.id === targetMessage.id),
      true
    );
    assert.equal(
      allMessages.some((message) =>
        message.content.some(
          (part) =>
            part.type === 'text' && part.text === 'Old branch assistant reply'
        )
      ),
      true
    );
    assert.equal(
      visibleMessages.some((message) =>
        message.content.some(
          (part) =>
            part.type === 'text' && part.text === 'Old branch assistant reply'
        )
      ),
      false
    );
    assert.equal(readFileSync(filePath, 'utf8'), initialContent);
  } finally {
    rmSync(workspaceRoot, { force: true, recursive: true });
  }
});
