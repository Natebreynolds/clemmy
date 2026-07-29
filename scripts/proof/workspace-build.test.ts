import test from 'node:test';
import assert from 'node:assert/strict';

import { workspaceComposioIsProvablyReadOnly } from '../../src/spaces/space-execution-policy.js';
import {
  WORKSPACE_BUILD_DATA_TOOL,
  WORKSPACE_BUILD_SOURCE_ID,
  workspaceBuildPrompt,
} from './scenarios/workspace-build.js';

test('workspace-build uses the supported read-only data path without weakening runner policy', () => {
  assert.equal(workspaceComposioIsProvablyReadOnly(WORKSPACE_BUILD_DATA_TOOL), true);
  const prompt = workspaceBuildPrompt();
  assert.match(prompt, new RegExp(`composio_slug: ${WORKSPACE_BUILD_DATA_TOOL}`));
  assert.match(prompt, new RegExp(`id: ${WORKSPACE_BUILD_SOURCE_ID}`));
  assert.match(prompt, /clem\.data\(\)/);
  assert.match(prompt, /do not create or use a runner/i);
  assert.doesNotMatch(prompt, /use a data source RUNNER/i);
});
