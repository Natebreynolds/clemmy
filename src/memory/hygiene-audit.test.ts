/**
 * Run: npx tsx --test src/memory/hygiene-audit.test.ts
 *
 * The reviewable audit trail for automatic memory hygiene: append-and-read
 * round-trip, newest-first read, and bounded growth. Best-effort: it must
 * never throw into a daemon tick.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-hygiene-audit-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { appendHygieneAudit, readHygieneAudit } = await import('./hygiene-audit.js');

test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

test('append + read round-trips an entry', () => {
  appendHygieneAudit({ at: '2026-06-04T05:00:00.000Z', kind: 'decay', ids: [1, 2, 3], detail: { deactivated: 3 } });
  const entries = readHygieneAudit();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'decay');
  assert.deepEqual(entries[0].ids, [1, 2, 3]);
});

test('read returns newest-first', () => {
  appendHygieneAudit({ at: '2026-06-04T06:00:00.000Z', kind: 'dedup', ids: [9] });
  const entries = readHygieneAudit();
  assert.equal(entries[0].kind, 'dedup', 'most recent entry is first');
  assert.equal(entries[0].ids[0], 9);
});

test('respects the read limit', () => {
  for (let i = 0; i < 10; i++) appendHygieneAudit({ at: new Date(0).toISOString(), kind: 'decay', ids: [i] });
  assert.ok(readHygieneAudit(3).length <= 3);
});

test('is best-effort and never throws', () => {
  assert.doesNotThrow(() => appendHygieneAudit({ at: 'x', kind: 'decay', ids: [] }));
  assert.doesNotThrow(() => readHygieneAudit());
});
