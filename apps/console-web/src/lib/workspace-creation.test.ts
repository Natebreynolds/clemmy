import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkspaceCreation } from './workspace-creation';

test('build creation preserves the authored description as objective and build prompt', () => {
  assert.deepEqual(
    resolveWorkspaceCreation({
      title: 'Content Calendar',
      description: 'Track and approve a week of social posts.',
      titleWasManuallyEdited: true,
    }, 'build'),
    {
      title: 'Content Calendar',
      objective: 'Track and approve a week of social posts.',
      build: 'Track and approve a week of social posts.',
    },
  );
});

test('blank creation ignores a selected recipe description/title and cannot launch a build', () => {
  assert.deepEqual(
    resolveWorkspaceCreation({
      title: 'Deal Board',
      description: 'A recipe prompt that would ask Clem to build a connected CRM board.',
      titleWasManuallyEdited: false,
    }, 'blank'),
    {
      title: 'New workspace',
      objective: undefined,
      build: undefined,
    },
  );
});

test('blank creation keeps only a title the user explicitly typed', () => {
  assert.deepEqual(
    resolveWorkspaceCreation({
      title: 'Scratchpad',
      description: 'A recipe prompt that must be ignored.',
      titleWasManuallyEdited: true,
    }, 'blank'),
    {
      title: 'Scratchpad',
      objective: undefined,
      build: undefined,
    },
  );
});
