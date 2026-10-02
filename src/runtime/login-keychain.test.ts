/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/login-keychain.test.ts
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

const { probeLoginKeychain, __loginKeychainTest__ } = await import('./login-keychain.js');

afterEach(() => {
  __loginKeychainTest__.setRunner(null);
  __loginKeychainTest__.setPlatform(null);
});

for (const [code, state] of [[0, 'unlocked'], [51, 'locked'], [36, 'locked'], [50, 'unknown'], [null, 'unknown']] as const) {
  test(`the security tool exiting ${code} reads as ${state}`, async () => {
    __loginKeychainTest__.setPlatform(() => 'darwin');
    const calls: string[][] = [];
    __loginKeychainTest__.setRunner(async (file, args) => { calls.push([file, ...args]); return { code }; });
    const probe = await probeLoginKeychain({ fresh: true });
    assert.equal(probe.state, state);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]![0], '/usr/bin/security');
    assert.equal(calls[0]![1], 'show-keychain-info', 'only the read-only settings question is asked');
    assert.match(calls[0]![2]!, /Library\/Keychains\/login\.keychain-db$/);
  });
}

test('the answer is reused for a minute and asked again on request', async () => {
  __loginKeychainTest__.setPlatform(() => 'darwin');
  let calls = 0;
  let code = 51;
  __loginKeychainTest__.setRunner(async () => { calls += 1; return { code }; });
  assert.equal((await probeLoginKeychain({ fresh: true })).state, 'locked');
  code = 0;
  assert.equal((await probeLoginKeychain()).state, 'locked', 'cached');
  assert.equal(calls, 1);
  assert.equal((await probeLoginKeychain({ fresh: true })).state, 'unlocked');
  assert.equal(calls, 2);
});

test('off macOS there is no keychain to report and nothing is run', async () => {
  __loginKeychainTest__.setPlatform(() => 'linux');
  let calls = 0;
  __loginKeychainTest__.setRunner(async () => { calls += 1; return { code: 0 }; });
  const probe = await probeLoginKeychain({ fresh: true });
  assert.equal(probe.state, 'unknown');
  assert.equal(probe.keychainPath, null);
  assert.equal(calls, 0);
});

test('a probe that throws reads as unknown, never as locked', async () => {
  __loginKeychainTest__.setPlatform(() => 'darwin');
  __loginKeychainTest__.setRunner(async () => { throw new Error('spawn failed'); });
  assert.equal((await probeLoginKeychain({ fresh: true })).state, 'unknown');
});
