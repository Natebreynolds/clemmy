import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyStepOutput } from './step-output-verify.js';

test('absent contract → ok (today path, no enforcement)', () => {
  assert.deepEqual(verifyStepOutput(undefined, { anything: true }), { ok: true, problems: [] });
});

test('type check passes and fails', () => {
  assert.ok(verifyStepOutput({ type: 'array' }, [1, 2]).ok);
  assert.ok(verifyStepOutput({ type: 'object' }, { a: 1 }).ok);
  const bad = verifyStepOutput({ type: 'array' }, { a: 1 });
  assert.equal(bad.ok, false);
  assert.match(bad.problems[0], /expected output of type "array"/);
});

test('required_keys present passes; missing fails', () => {
  assert.ok(verifyStepOutput({ required_keys: ['id', 'name'] }, { id: 1, name: 'x' }).ok);
  const bad = verifyStepOutput({ required_keys: ['id', 'url'] }, { id: 1 });
  assert.equal(bad.ok, false);
  assert.match(bad.problems[0], /missing required output key "url"/);
});

test('required_keys on a non-object fails clearly', () => {
  const bad = verifyStepOutput({ required_keys: ['id'] }, 'just a string');
  assert.equal(bad.ok, false);
  assert.match(bad.problems[0], /not an object/);
});

test('verify.url_present accepts real http(s) URLs, rejects blanks/non-urls', () => {
  assert.ok(verifyStepOutput({ verify: { url_present: ['url'] } }, { url: 'https://example.com/x' }).ok);
  const blank = verifyStepOutput({ verify: { url_present: ['url'] } }, { url: '' });
  assert.equal(blank.ok, false);
  const notUrl = verifyStepOutput({ verify: { url_present: ['url'] } }, { url: 'blocked' });
  assert.equal(notUrl.ok, false);
  assert.match(notUrl.problems[0], /not a non-empty http\(s\) URL/);
});

test('verify.url_present resolves dot-notation paths', () => {
  const ok = verifyStepOutput({ verify: { url_present: ['result.deploy.url'] } }, { result: { deploy: { url: 'https://site.net' } } });
  assert.ok(ok.ok);
});

test('verify.path_exists uses the injected existence check', () => {
  const exists = (p: string) => p === '/tmp/real.txt';
  assert.ok(verifyStepOutput({ verify: { path_exists: ['file'] } }, { file: '/tmp/real.txt' }, exists).ok);
  const missing = verifyStepOutput({ verify: { path_exists: ['file'] } }, { file: '/tmp/nope.txt' }, exists);
  assert.equal(missing.ok, false);
  assert.match(missing.problems[0], /does not exist/);
});

test('the revill regression: claims success but returns no real URL → caught', () => {
  // deploy_to_netlify returned {status:"blocked"} with no url — the exact
  // class P4 exists to catch.
  const r = verifyStepOutput({ verify: { url_present: ['url'] } }, { status: 'blocked' });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /url_present/);
});

test('multiple problems accumulate', () => {
  const r = verifyStepOutput(
    { type: 'object', required_keys: ['id'], verify: { url_present: ['url'] } },
    { wrong: true },
  );
  assert.equal(r.ok, false);
  assert.ok(r.problems.length >= 2);
});
