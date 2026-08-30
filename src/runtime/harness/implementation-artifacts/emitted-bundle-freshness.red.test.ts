/**
 * Run: node scripts/run-tests-isolated.mjs \
 *   src/runtime/harness/implementation-artifacts/emitted-bundle-freshness.red.test.ts
 *
 * OPEN-THE-GATES 5.4. Tag blocker: transport-entry.ts gained the reviewed_cli
 * branch after the last emit. The shipped transport-*.cjs contained
 * executeReviewedCliRead ZERO times, so a live daemon could never run a
 * reviewed CLI read through the attested transport.
 *
 * Re-break two ways:
 *   (i)  ship a transport bundle that omits executeReviewedCliRead
 *   (ii) ship a stamp whose transport digest is not the file on disk
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const EMITTED = path.join(DIR, 'emitted');
const ENTRY = path.join(DIR, 'transport-entry.ts');

test('NEGATIVE: the shipped transport bundle contains executeReviewedCliRead', () => {
  const source = readFileSync(ENTRY, 'utf8');
  assert.match(source, /executeReviewedCliRead/, 'source still declares the reviewed CLI read branch');
  const manifest = JSON.parse(readFileSync(path.join(EMITTED, 'manifest.json'), 'utf8')) as {
    artifacts: { transport: { file: string; sha256: string } };
  };
  const shipped = path.join(EMITTED, manifest.artifacts.transport.file);
  assert.equal(existsSync(shipped), true, shipped);
  const bundle = readFileSync(shipped, 'utf8');
  assert.match(
    bundle,
    /executeReviewedCliRead/,
    'stale emit: live daemon transport has no reviewed CLI read',
  );
});

test('re-break (i): the digest-addressed transport file matches the stamp', () => {
  const stamp = JSON.parse(readFileSync(path.join(EMITTED, 'build-stamp.json'), 'utf8')) as {
    artifacts: { transport: string };
  };
  const named = readdirSync(EMITTED).find((name) => name.startsWith('transport-') && name.endsWith('.cjs'));
  assert.ok(named, 'emitted transport-*.cjs is missing');
  const digest = named!.slice('transport-'.length, -'.cjs'.length);
  assert.equal(digest, stamp.artifacts.transport);
  const bytes = readFileSync(path.join(EMITTED, named!));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), digest);
});

test('re-break (ii): source reviewed_cli branch is not an unshipped comment', () => {
  const source = readFileSync(ENTRY, 'utf8');
  assert.match(source, /return executeReviewedCliRead\(call\)/);
});
