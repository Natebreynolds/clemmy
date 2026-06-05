/**
 * Run: npx tsx --test src/tools/active-task-tools.test.ts
 *
 * The hybrid model-driven layer over the deterministic Active Task scratchpad:
 * set / update (merge) / clear, plus the parseActiveTaskSection round-trip the
 * update path and the execution-brief hand-off both rely on.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-active-task-tool-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { applyActiveTaskAction } = await import('./active-task-tools.js');
const { parseActiveTaskSection, readActiveTaskSection, hasActiveTaskSection } = await import('../memory/working-memory.js');

test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

test('set pins a resource reference the model captured', () => {
  const sid = 'sess-tool-set';
  const out = applyActiveTaskAction(sid, {
    action: 'set',
    list_reference: '1AbcD_efGhIjKlMnOpQrStUvWxYz0123456789xyz',
    recipients: null, count: 25, exclusivity: 'only', note: 'send the Q2 outreach to this sheet',
  });
  assert.match(out, /pinned: reference/);
  const spec = parseActiveTaskSection(sid);
  assert.ok(spec);
  assert.equal(spec!.resourceRef, '1AbcD_efGhIjKlMnOpQrStUvWxYz0123456789xyz');
  assert.equal(spec!.count, 25);
  assert.equal(spec!.exclusivity, 'only');
});

test('update merges with what is already pinned (does not wipe unset fields)', () => {
  const sid = 'sess-tool-update';
  applyActiveTaskAction(sid, { action: 'set', list_reference: 'SHEET-1', recipients: null, count: 10, exclusivity: null, note: 'pull the list' });
  // Only change the count; leave the reference alone.
  const out = applyActiveTaskAction(sid, { action: 'update', list_reference: null, recipients: null, count: 15, exclusivity: null, note: null });
  assert.match(out, /updated/);
  const spec = parseActiveTaskSection(sid);
  assert.equal(spec!.resourceRef, 'SHEET-1', 'reference preserved across update');
  assert.equal(spec!.count, 15, 'count updated');
});

test('clear removes the pin', () => {
  const sid = 'sess-tool-clear';
  applyActiveTaskAction(sid, { action: 'set', list_reference: 'SHEET-X', recipients: null, count: null, exclusivity: null, note: null });
  assert.equal(hasActiveTaskSection(sid), true);
  const out = applyActiveTaskAction(sid, { action: 'clear', list_reference: null, recipients: null, count: null, exclusivity: null, note: null });
  assert.match(out, /cleared/);
  assert.equal(hasActiveTaskSection(sid), false);
});

test('refuses to pin an empty/ambiguous task', () => {
  const sid = 'sess-tool-empty';
  const out = applyActiveTaskAction(sid, { action: 'set', list_reference: null, recipients: null, count: null, exclusivity: null, note: 'do the thing' });
  assert.match(out, /Nothing concrete to pin/);
  assert.equal(hasActiveTaskSection(sid), false);
});

test('parseActiveTaskSection round-trips an inline recipient set', () => {
  const sid = 'sess-tool-roundtrip';
  applyActiveTaskAction(sid, {
    action: 'set', list_reference: null,
    recipients: ['Alice Anderson', 'Bob Brennan', 'Carol Chen'],
    count: 3, exclusivity: null, note: 'email these three',
  });
  const section = readActiveTaskSection(sid);
  assert.ok(section?.includes('Alice Anderson'));
  const spec = parseActiveTaskSection(sid);
  assert.deepEqual(spec!.recipients, ['Alice Anderson', 'Bob Brennan', 'Carol Chen']);
  assert.equal(spec!.count, 3);
});
