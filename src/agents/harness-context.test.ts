/**
 * Run: npx tsx --test src/agents/harness-context.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
const { saveProactivityPolicy } = await import('./proactivity-policy.js');

test('Autonomy section: YOLO tells the model it has STANDING approval and not to seek sign-off', () => {
  saveProactivityPolicy({ autoApproveScope: 'yolo' });
  try {
    const context = renderHarnessMemoryContext();
    assert.match(context, /## Autonomy/);
    assert.match(context, /STANDING APPROVAL/);
    assert.match(context, /do NOT use ask_user_question to get sign-off/i);
    assert.match(context, /request_approval \(it auto-approves/);
  } finally {
    saveProactivityPolicy({ autoApproveScope: 'balanced' });
  }
});

test('Autonomy section: balanced (default) renders NO autonomy line (byte-identical common case)', () => {
  saveProactivityPolicy({ autoApproveScope: 'balanced' });
  const context = renderHarnessMemoryContext();
  assert.doesNotMatch(context, /## Autonomy/);
});

test('persistent context includes compact installed skills index', () => {
  const skillDir = path.join(TMP_HOME, 'skills', 'proposal-style');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: Proposal Style',
      'description: Brand rules for polished proposal artifacts.',
      '---',
      '',
      'Full body should remain behind skill_read.',
    ].join('\n'),
    'utf-8',
  );

  const context = renderHarnessMemoryContext();
  assert.match(context, /## Available Skills/);
  assert.match(context, /`proposal-style`: Brand rules for polished proposal artifacts\./);
  assert.doesNotMatch(context, /Full body should remain behind skill_read/);
});

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
