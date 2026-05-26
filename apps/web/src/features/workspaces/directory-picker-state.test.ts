import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkspaceDirectoryBrowseDto } from '@opencode/shared';
import {
  applyDirectoryBrowseFailure,
  applyDirectoryBrowseSuccess
} from './directory-picker-state.js';

const browseResult: WorkspaceDirectoryBrowseDto = {
  currentPath: '/tmp/next',
  directories: [
    {
      name: 'child',
      path: '/tmp/next/child'
    }
  ],
  parentPath: '/tmp',
  rootLabel: 'Current Repo',
  segments: [
    {
      name: '/',
      path: '/'
    },
    {
      name: 'tmp',
      path: '/tmp'
    },
    {
      name: 'next',
      path: '/tmp/next'
    }
  ]
};

test('applyDirectoryBrowseSuccess syncs selected path to the newly loaded directory', () => {
  const nextState = applyDirectoryBrowseSuccess(
    {
      browseResult: null,
      currentPath: '/tmp',
      isLoading: true,
      selectedPath: '/tmp'
    },
    browseResult
  );

  assert.equal(nextState.currentPath, '/tmp/next');
  assert.equal(nextState.selectedPath, '/tmp/next');
  assert.equal(nextState.errorMessage, undefined);
  assert.equal(nextState.isLoading, false);
});

test('applyDirectoryBrowseFailure preserves the previous selected path', () => {
  const nextState = applyDirectoryBrowseFailure(
    {
      browseResult,
      currentPath: '/tmp/blocked',
      isLoading: true,
      selectedPath: '/tmp/next'
    },
    'permission denied'
  );

  assert.equal(nextState.selectedPath, '/tmp/next');
  assert.equal(nextState.errorMessage, 'permission denied');
  assert.equal(nextState.isLoading, false);
});
