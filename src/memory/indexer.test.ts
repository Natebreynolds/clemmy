/**
 * Run: npx tsx --test src/memory/indexer.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-indexer-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const { reindexVault } = await import('./indexer.js');
const { closeMemoryDb, openMemoryDb } = await import('./db.js');
const { VAULT_DIR } = await import('./vault.js');

test.after(() => {
  closeMemoryDb();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('reindexVault indexes Recall meeting transcripts', () => {
  const meetingDir = path.join(VAULT_DIR, '04-Meetings');
  mkdirSync(meetingDir, { recursive: true });
  const meetingPath = path.join(meetingDir, '2026-05-19-zoom-recall-abc123.md');
  writeFileSync(
    meetingPath,
    [
      '---',
      'type: meeting-transcript',
      'source: recall.ai-desktop-sdk',
      '---',
      '',
      '# Prospect Review',
      '',
      '## Transcript',
      '',
      '[2026-05-19T12:00:00.000Z] Nathan: Follow up with market leaders about SEO findings.',
      '',
    ].join('\n'),
    'utf-8',
  );

  const stats = reindexVault();
  assert.equal(stats.errors, 0);

  const rows = openMemoryDb().prepare(
    'SELECT path, content FROM vault_chunks WHERE path = ? ORDER BY chunk_index',
  ).all(meetingPath) as Array<{ path: string; content: string }>;
  assert.ok(rows.length > 0, 'meeting transcript should be indexed');
  assert.match(rows.map((row) => row.content).join('\n'), /market leaders about SEO findings/);
});

