import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { coerceOutputForContract, setStepOutputLiteralPathResolver, verifyStepOutput } from './step-output-verify.js';

test('a structured result satisfies a string contract as rendered text', () => {
  const contract = { type: 'string' as const, non_empty: [''] };
  const structured = [{ id: '', title: '(none)', status: 'none', blocker: 'No active goals found' }];
  const bound = coerceOutputForContract(structured, contract);
  assert.equal(typeof bound, 'string');
  assert.match(bound as string, /"blocker": "No active goals found"/);
  assert.ok(verifyStepOutput(contract, bound).ok);
  // A string stays a string; a string contract WITH required keys is left alone.
  assert.equal(coerceOutputForContract('already text', contract), 'already text');
  assert.deepEqual(coerceOutputForContract({ a: 1 }, { type: 'string', required_keys: ['a'] }), { a: 1 });
});

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
  const ok = verifyStepOutput({ verify: { url_present: ['result.deploy.url'] } }, { result: { deploy: { url: 'https://site.example' } } });
  assert.ok(ok.ok);
});

test('verify.path_exists uses the injected existence check', () => {
  const exists = (p: string) => p === '/tmp/real.txt';
  assert.ok(verifyStepOutput({ verify: { path_exists: ['file'] } }, { file: '/tmp/real.txt' }, exists).ok);
  const missing = verifyStepOutput({ verify: { path_exists: ['file'] } }, { file: '/tmp/nope.txt' }, exists);
  assert.equal(missing.ok, false);
  assert.match(missing.problems[0], /does not exist/);
});

test('file verification supports literal artifact paths and a path-valued root without inventing output fields', () => {
  const artifact = '/tmp/friday brief.md';
  const seen: string[] = [];
  const exists = (p: string) => { seen.push(p); return p === artifact; };
  assert.equal(verifyStepOutput({ type: 'string', verify: { path_exists: [artifact] } }, artifact, exists).ok, true);
  assert.equal(verifyStepOutput({ verify: { path_exists: ['.'] } }, artifact, exists).ok, true);
  assert.equal(verifyStepOutput({ verify: { path_exists: [''] } }, artifact, exists).ok, true);
  assert.deepEqual(seen, [artifact, artifact, artifact]);
  assert.equal(verifyStepOutput({ verify: { path_exists: ['/tmp/missing.md'] } }, 'Done', exists).ok, false);
  assert.equal(verifyStepOutput({ verify: { path_exists: ['artifact.path'] } }, { artifact: { path: '/tmp/missing.md' } }, exists).ok, false);
  assert.equal(verifyStepOutput({ verify: { path_exists: ['.'] } }, { claim: 'created' }, exists).ok, false);
});

test('the missing-artifact regression: claims success but returns no real URL → caught', () => {
  // deploy_to_netlify returned {status:"blocked"} with no url — the exact
  // class P4 exists to catch.
  const r = verifyStepOutput({ verify: { url_present: ['url'] } }, { status: 'blocked' });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /url_present/);
});

test('P1-9 non_empty: empty array/string/object fails, populated passes', () => {
  // The SF→Airtable shape: required_keys passes but the list is empty.
  const empty = verifyStepOutput(
    { required_keys: ['proposed_prospects'], non_empty: ['proposed_prospects'] },
    { proposed_prospects: [], dedupe_summary: 'Blocked: Salesforce expired' },
  );
  assert.equal(empty.ok, false);
  assert.match(empty.problems[0], /non_empty: output "proposed_prospects" is empty/);

  assert.ok(verifyStepOutput({ non_empty: ['rows'] }, { rows: [1, 2] }).ok);
  assert.equal(verifyStepOutput({ non_empty: ['note'] }, { note: '   ' }).ok, false);
  assert.equal(verifyStepOutput({ non_empty: ['obj'] }, { obj: {} }).ok, false);
  assert.ok(verifyStepOutput({ non_empty: ['obj'] }, { obj: { a: 1 } }).ok);
});

test('P1-9 non_empty: numbers/false are NOT empty', () => {
  assert.ok(verifyStepOutput({ non_empty: ['count'] }, { count: 0 }).ok);
  assert.ok(verifyStepOutput({ non_empty: ['flag'] }, { flag: false }).ok);
});

test('P1-9 non_empty: empty path "" targets the root value', () => {
  assert.equal(verifyStepOutput({ non_empty: [''] }, []).ok, false);
  assert.ok(verifyStepOutput({ non_empty: ['.'] }, [1]).ok);
});

test('P1-9 min_items: enforces minimum array length and rejects non-arrays', () => {
  assert.ok(verifyStepOutput({ min_items: { prospects: 1 } }, { prospects: [1] }).ok);
  const tooFew = verifyStepOutput({ min_items: { prospects: 3 } }, { prospects: [1, 2] });
  assert.equal(tooFew.ok, false);
  assert.match(tooFew.problems[0], /has 2 item\(s\), needs at least 3/);
  const notArr = verifyStepOutput({ min_items: { prospects: 1 } }, { prospects: 'nope' });
  assert.equal(notArr.ok, false);
  assert.match(notArr.problems[0], /is not an array/);
});

test('multiple problems accumulate', () => {
  const r = verifyStepOutput(
    { type: 'object', required_keys: ['id'], verify: { url_present: ['url'] } },
    { wrong: true },
  );
  assert.equal(r.ok, false);
  assert.ok(r.problems.length >= 2);
});


test('an explicit blocked envelope stays structured with no contract or a string contract', () => {
  const blocked = { blocked: true, reason: 'The write was refused.', intended_file: '/tmp/missing-brief.md' };
  for (const contract of [undefined, { type: 'string' as const }, { type: 'object' as const }]) {
    assert.deepEqual(coerceOutputForContract(blocked, contract), blocked);
    assert.deepEqual(coerceOutputForContract(JSON.stringify(blocked), contract), blocked);
  }
  assert.equal(coerceOutputForContract('Example: {"blocked":true}', undefined), 'Example: {"blocked":true}');
  assert.equal(coerceOutputForContract('{"blocked":false}', undefined), '{"blocked":false}');
});

test('a committed local-file receipt that names its path satisfies the natural save contract', () => {
  // Live 2026-09-22, "Handoff review fixture": the write_file call step
  // returned the host receipt envelope (artifactId, handle, contentDigest,
  // receipt, result), the authored contract asked for `path` and checked it
  // exists, and a write that had physically succeeded was reported failed.
  // The committed path is a fact of the receipt and must be on it.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clem-save-contract-'));
  const target = path.join(dir, 'summary.txt');
  writeFileSync(target, 'three\nlines\nhere\n', 'utf8');
  const envelope = {
    artifactId: 'artifact:local-file:abc',
    handle: 'lfr:abc',
    contentDigest: 'd'.repeat(64),
    receipt: '[exact-output-receipt:v1 nonce=x sha256=y]',
    path: target,
    result: `Committed file at ${target} (18 chars).`,
  };
  const contract = {
    type: 'object' as const,
    required_keys: ['path'],
    non_empty: ['path'],
    verify: { path_exists: ['path'], url_present: [] },
  };
  const verdict = verifyStepOutput(contract, envelope);
  assert.equal(verdict.ok, true, verdict.ok ? '' : verdict.problems.join('; '));
  rmSync(dir, { recursive: true, force: true });
});

test('a non-empty key the output does not have says which keys it did produce, and routes as before', async () => {
  // Live 2026-10-17: a Space feed's creation test failed on an absent
  // "upstream" key and was reported as a source that returned nothing.
  const { classifyContractProblems } = await import('./step-output-verify.js');
  const result = verifyStepOutput({ type: 'object', non_empty: ['upstream'] }, { clients: [{ name: 'Summit' }], updatedAt: '2026-10-17' });
  assert.equal(result.ok, false);
  assert.match(result.problems.join('\n'), /non_empty: output "upstream" is missing — the output has no "upstream" \(it has: "clients", "updatedAt"\)/);
  assert.equal(classifyContractProblems(result.problems), 'empty_output', 'routing is unchanged');
  const empty = verifyStepOutput({ type: 'object', non_empty: ['upstream'] }, { upstream: [] });
  assert.match(empty.problems.join('\n'), /non_empty: output "upstream" is empty \(no data produced\)/, 'a present but empty key is still empty');
});

test('verify.path_exists accepts the file\'s own relative path, resolved where relative writes land', () => {
  // Live 2026-10-21: two brains wrote the file path itself into path_exists
  // and the step failed as "not a file path string" because the entry was
  // read as a key name.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clem-path-exists-'));
  writeFileSync(path.join(dir, 'digest.md'), '- a\n');
  setStepOutputLiteralPathResolver((relative) => path.join(dir, relative));
  try {
    const contract = { type: 'object' as const, required_keys: ['path'], verify: { path_exists: ['clem-fixtures/digest.md'] } };
    assert.ok(verifyStepOutput(contract, { path: 'clem-fixtures/digest.md' }, (p) => p === path.join(dir, 'clem-fixtures/digest.md')).ok, 'a literal relative path that exists');
    const missing = verifyStepOutput(contract, { path: 'x' }, () => false);
    assert.equal(missing.ok, false);
    assert.match(missing.problems.join(' '), /does not exist/);
    // A field holding a relative path is resolved the same way.
    assert.ok(verifyStepOutput({ verify: { path_exists: ['path'] } }, { path: 'clem-fixtures/digest.md' }, (p) => p === path.join(dir, 'clem-fixtures/digest.md')).ok);
    // A field name that is not a path and is absent still reads as a missing field.
    const absent = verifyStepOutput({ verify: { path_exists: ['file'] } }, { other: 1 }, () => true);
    assert.equal(absent.ok, false);
    assert.match(absent.problems.join(' '), /not a file path string/);
  } finally {
    setStepOutputLiteralPathResolver(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an array contract on a tool that answers in an envelope takes the list it carries', () => {
  const contract = { type: 'array' as const };
  const envelope = { data: { value: [{ subject: 'One' }, { subject: 'Two' }] }, error: null, successful: true, logId: 'log_x' };
  assert.deepEqual(coerceOutputForContract(envelope, contract), [{ subject: 'One' }, { subject: 'Two' }]);
  assert.deepEqual(coerceOutputForContract({ data: { value: [] }, successful: true }, contract), [], 'an empty day is an empty list');
  const failed = { data: { value: [] }, error: 'denied', successful: false };
  assert.deepEqual(coerceOutputForContract(failed, contract), failed, 'a failure envelope is left for the failure checks');
  assert.deepEqual(coerceOutputForContract(envelope, { type: 'object' as const }), envelope, 'an object contract keeps the envelope');
});

test('required keys the envelope lacks but its payload has every one of read the payload', () => {
  const envelope = { data: { value: [{ subject: 'One' }], '@odata.context': 'x' }, error: null, successful: true, logId: 'log_x' };
  assert.deepEqual(coerceOutputForContract(envelope, { type: 'object', required_keys: ['value'] }), envelope.data);
  assert.deepEqual(coerceOutputForContract(envelope, { type: 'object', non_empty: ['value'] }), envelope.data);
  assert.deepEqual(coerceOutputForContract(envelope, { type: 'object', required_keys: ['data'] }), envelope, 'a key the envelope has keeps it');
  const failed = { data: { value: [] }, error: 'denied', successful: false };
  assert.deepEqual(coerceOutputForContract(failed, { type: 'object', required_keys: ['value'] }), failed);
});
