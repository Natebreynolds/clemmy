import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(
  path.join(os.tmpdir(), 'clem-workspace-source-recall-'),
);

const { recordMemoryEpisode } = await import('./temporal-memory.js');
const { recallMemory } = await import('./recall-memory.js');

test('Workspace episodes are discoverable by workspace and source identity without copying raw data into memory', async () => {
  const episode = recordMemoryEpisode({
    kind: 'reflection',
    subtype: 'workspace_observation',
    title: 'Workspace observation',
    sourceApp: 'workspace',
    sourceUri: 'workspace://paid-media/sources/google-ads/observations/obs-123',
    occurredAt: '2026-07-28T20:00:00.000Z',
    content: 'Workspace data changed: 1 addition, 0 removals, and 2 replacements.',
  });

  const recalled = await recallMemory(
    'What changed in the paid-media Google Ads workspace?',
    { stores: ['episode'], limit: 5, perStore: 10 },
  );

  const hit = recalled.hits.find(
    (candidate) => candidate.ref.type === 'episode' && candidate.ref.id === episode.id,
  );
  assert.ok(hit, 'source_uri identity should make the compact episode recallable');
  assert.equal(hit.text.includes('paid-media'), false, 'identity need not be copied into evidence text');
  assert.equal(hit.text.includes('Google Ads'), false, 'provider values stay out of memory prose');
  assert.equal(
    hit.evidence[0]?.sourceUri,
    'workspace://paid-media/sources/google-ads/observations/obs-123',
  );
});
