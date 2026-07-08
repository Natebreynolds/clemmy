import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, existsSync } from 'node:fs';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-hotset-lru-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const { recordToolHit, getHotSet, _resetHotSetForTest } = await import('./tool-hotset.js');

test('records most-recent-first and dedupes', () => {
  _resetHotSetForTest();
  const sid = 'lru-a';
  recordToolHit(sid, 'alpha');
  recordToolHit(sid, 'beta');
  recordToolHit(sid, 'alpha'); // re-hit moves alpha to front, no dup
  assert.deepEqual(getHotSet(sid), ['alpha', 'beta']);
});

test('caps at 16 names per session', () => {
  _resetHotSetForTest();
  const sid = 'lru-b';
  for (let i = 0; i < 25; i++) recordToolHit(sid, `tool_${i}`);
  const hot = getHotSet(sid);
  assert.equal(hot.length, 16);
  // most recent (tool_24) at front, oldest kept is tool_9
  assert.equal(hot[0], 'tool_24');
  assert.equal(hot[hot.length - 1], 'tool_9');
});

test('persists across an in-memory cache reset (reads back from disk)', () => {
  _resetHotSetForTest();
  const sid = 'lru-c';
  recordToolHit(sid, 'persisted_tool');
  assert.ok(existsSync(path.join(TMP_HOME, 'state', 'tool-hotset.json')));
  _resetHotSetForTest(); // force a fresh load from disk
  assert.deepEqual(getHotSet(sid), ['persisted_tool']);
});

test('sessions are isolated from each other', () => {
  _resetHotSetForTest();
  recordToolHit('lru-d1', 'x');
  recordToolHit('lru-d2', 'y');
  assert.deepEqual(getHotSet('lru-d1'), ['x']);
  assert.deepEqual(getHotSet('lru-d2'), ['y']);
});

test('blank session or tool name is a no-op', () => {
  _resetHotSetForTest();
  recordToolHit('', 'x');
  recordToolHit('lru-e', '');
  assert.deepEqual(getHotSet('lru-e'), []);
});
