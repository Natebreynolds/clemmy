import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildingSpaceSlugs, type ActivityEntry } from './activity';

const entry = (over: Partial<ActivityEntry>): ActivityEntry => ({
  schemaVersion: 2, runKey: 'k', attemptId: 'a', kind: 'chat', lifecycle: 'running', liveness: 'live',
  needsAttention: false, headline: 'x', ...over,
} as ActivityEntry);

test('the Spaces being built right now come from live entries mounted on a workspace', () => {
  const building = buildingSpaceSlugs([
    entry({ validatedMount: { kind: 'workspace', workspaceSlug: 'deal-board' } }),
    entry({ validatedMount: { kind: 'workspace', workspaceSlug: 'old-report' }, liveness: 'stale' }),
    entry({ validatedMount: { kind: 'workflow' } }),
    entry({}),
  ]);
  assert.deepEqual([...building], ['deal-board']);
});
