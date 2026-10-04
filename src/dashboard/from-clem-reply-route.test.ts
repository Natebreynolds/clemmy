/**
 * Run: node scripts/run-tests-isolated.mjs src/dashboard/from-clem-reply-route.test.ts
 *
 * The Mac and the phone send From Clem replies through one handler; a reply
 * without an item or words is refused before anything is read or settled.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clem-from-clem-reply-route-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });
test.after(() => rmSync(TMP, { recursive: true, force: true }));

const { handleFromClemReply } = await import('./from-clem-reply-route.js');

test('a reply needs an item and words, from either app', async () => {
  for (const surface of ['desktop', 'mobile'] as const) {
    assert.equal((await handleFromClemReply({ text: 'yes' }, { surface })).status, 400);
    assert.equal((await handleFromClemReply({ key: 'notif:x', text: '   ' }, { surface })).status, 400);
    assert.equal((await handleFromClemReply(null, { surface })).status, 400);
  }
});

test('a reply to an item that is no longer there says so', async () => {
  const result = await handleFromClemReply({ key: 'notif:gone', text: 'do it', decision: 'do_it' }, { surface: 'mobile' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { outcome: 'gone' });
});
