/**
 * Run: npx tsx --test src/runtime/capability-preconditions.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSkillPreconditions } from './capability-preconditions.js';

test('no requires → ready (skills that declare nothing are unaffected)', () => {
  assert.deepEqual(checkSkillPreconditions(undefined), { ready: true, unmet: [] });
  assert.deepEqual(checkSkillPreconditions([]), { ready: true, unmet: [] });
  assert.deepEqual(checkSkillPreconditions('not-an-array'), { ready: true, unmet: [] });
});

test('a present env secret is met; a missing one is unmet', () => {
  const KEY = 'CLEMMY_PRECOND_TEST_KEY';
  const prev = process.env[KEY];
  try {
    process.env[KEY] = 'value';
    assert.deepEqual(checkSkillPreconditions([`secret:${KEY}`]), { ready: true, unmet: [] });

    delete process.env[KEY];
    const res = checkSkillPreconditions([`env:${KEY}`]);
    assert.equal(res.ready, false);
    assert.equal(res.unmet.length, 1);
    assert.match(res.unmet[0], new RegExp(KEY));
  } finally {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  }
});

test('a clearly-absent CLI is reported unmet', () => {
  const res = checkSkillPreconditions(['cli:this-cli-does-not-exist-xyzzy']);
  assert.equal(res.ready, false);
  assert.match(res.unmet[0], /this-cli-does-not-exist-xyzzy/);
});

test('unknown precondition kinds are ignored (forward-compatible)', () => {
  assert.deepEqual(checkSkillPreconditions(['weird:thing', 'noseparator']), { ready: true, unmet: [] });
});

test('mixed: collects every unmet item, ignoring the met ones', () => {
  const KEY = 'CLEMMY_PRECOND_TEST_PRESENT';
  const prev = process.env[KEY];
  try {
    process.env[KEY] = 'yes';
    const res = checkSkillPreconditions([
      `secret:${KEY}`,                       // met
      'cli:this-cli-does-not-exist-xyzzy',   // unmet
      'secret:CLEMMY_DEFINITELY_UNSET_KEY',  // unmet
    ]);
    assert.equal(res.ready, false);
    assert.equal(res.unmet.length, 2);
  } finally {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  }
});
