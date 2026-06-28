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

const { reindexVault, chunkMarkdown } = await import('./indexer.js');
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

test('chunkMarkdown: windowed sub-chunks (beyond the first) regain the heading breadcrumb; first window + short sections unchanged', () => {
  // A long section (well over the 1200-char window) under nested headings.
  const long = 'Lorem ipsum dolor sit amet. '.repeat(120); // ~3360 chars → multiple windows
  const md = ['# Project Atlas', '', '## Field Notes', '', long].join('\n');
  const windows = chunkMarkdown(md).filter((c) => c.title === 'Field Notes');
  assert.ok(windows.length >= 2, 'the long section windows into multiple chunks');
  // First window keeps the literal heading line (byte-identical to old behavior).
  assert.match(windows[0].content, /^## Field Notes/);
  // The bug fix: windows 2+ used to be indexed with NO heading context; now they
  // lead with the full ancestry breadcrumb.
  for (const c of windows.slice(1)) {
    assert.match(c.content, /^Project Atlas > Field Notes/, 'later windows regain section context');
  }
  // Budget respected (breadcrumb accounted for).
  for (const c of windows) assert.ok(c.content.length <= 1200, `chunk ${c.content.length} > 1200`);
});

test('chunkMarkdown: a windowed deep section carries full ancestry; short siblings stay unchanged + leak nothing', () => {
  const long = 'renewal detail line. '.repeat(140); // long → windows under a deep heading
  const md = [
    '# Clients', '', '## Acme', '', '### Renewal', '', long, '',
    '## Globex', '', 'Globex is a new lead.',
  ].join('\n');
  const chunks = chunkMarkdown(md);
  const renewal = chunks.filter((c) => c.title === 'Renewal');
  assert.ok(renewal.length >= 2, 'deep section windows');
  assert.match(renewal[0].content, /^### Renewal/, 'first window keeps the heading line');
  assert.match(renewal[1].content, /^Clients > Acme > Renewal/, 'later windows carry the FULL ancestry');
  // Globex is a short H2 sibling — single chunk, unchanged, and the deeper
  // "Renewal"/"Acme" must NOT leak into it (the stack reset deeper levels).
  const globex = chunks.find((c) => c.title === 'Globex');
  assert.match(globex!.content, /^## Globex/);
  assert.doesNotMatch(globex!.content, /Acme|Renewal/);
});

