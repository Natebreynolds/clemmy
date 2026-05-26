/**
 * Run: npx tsx --test src/agents/harness-context.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-harness-context-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resetMemoryDb } = await import('../memory/db.js');
const { createFocus } = await import('../memory/focus.js');
const { renderHarnessMemoryContext } = await import('./harness-context.js');

test('stale focus is not rendered as active persistent context', () => {
  resetMemoryDb();
  process.env.CLEMMY_FOCUS_CONFIRM_MS = '1';
  try {
    createFocus({
      resourceRef: 'https://docs.google.com/spreadsheets/d/stale-sheet',
      title: 'Market leader sheet',
      summary: 'Old sheet work',
      resourceKind: 'sheet',
    });
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }

    const context = renderHarnessMemoryContext();
    assert.match(context, /No confirmed active focus/);
    assert.match(context, /STALE focus #\d+: Market leader sheet/);
    assert.doesNotMatch(context, /ACTIVE focus #\d+: Market leader sheet/);
  } finally {
    delete process.env.CLEMMY_FOCUS_CONFIRM_MS;
  }
});

process.on('exit', () => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});
