/**
 * Run: npx tsx --test src/runtime/harness/destination-gate.test.ts
 *
 * The destination gate flags an irreversible publish (deploy/publish/
 * release/promote/ship or --prod) whose target is AMBIENT — not named in
 * the command — so it can't silently clobber an unrelated linked site.
 * Born from the 2026-06-13 wrong-site incident (`netlify deploy --prod`
 * followed a stale `.netlify` link to a different live site).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyShellCommand,
  evaluateShellDestination,
  destinationCardSuffix,
  isDestinationGateEnabled,
  wasDestinationNudged,
  markDestinationNudged,
  ImplicitDestinationError,
  _resetDestinationStateForTests,
} from './destination-gate.js';

test('the INCIDENT command flags: netlify deploy --prod (no explicit site)', () => {
  const r = evaluateShellDestination('netlify deploy --dir "/x/site" --prod --json --message "Deploy"');
  assert.equal(r.action, 'flag');
  assert.equal(r.verb, 'deploy');
  assert.equal(r.shapeKey, 'netlify:deploy');
});

test('an EXPLICIT --site makes it allow (the recovery the model eventually did)', () => {
  const r = evaluateShellDestination('netlify deploy --dir "/x/site" --prod --site 6c97fed4-6043-4841 --json');
  assert.equal(r.action, 'allow');
});

test('--prod with no project flags even without a verb (vercel --prod)', () => {
  const r = evaluateShellDestination('vercel --prod');
  assert.equal(r.action, 'flag');
  assert.equal(r.verb, '--prod');
});

test('vercel deploy --scope <team> is explicit → allow', () => {
  assert.equal(evaluateShellDestination('vercel deploy --prod --scope my-team').action, 'allow');
});

test('npm publish (ambient registry) flags; with --registry URL it allows', () => {
  assert.equal(evaluateShellDestination('npm publish').action, 'flag');
  assert.equal(evaluateShellDestination('npm publish --registry https://r.example.com').action, 'allow');
});

test('gcloud app deploy (verb is the 3rd token) still flags', () => {
  const r = evaluateShellDestination('gcloud app deploy');
  assert.equal(r.action, 'flag');
  assert.equal(r.verb, 'deploy');
  assert.equal(r.shapeKey, 'gcloud:deploy');
});

test('compound command: cd x && netlify deploy --prod flags on the publish segment', () => {
  const r = evaluateShellDestination('cd /tmp/site && netlify deploy --prod');
  assert.equal(r.action, 'flag');
  assert.equal(r.shapeKey, 'netlify:deploy');
});

// ---- false-positive guards (precision matters: this nudges on every shell publish) ----

test('NO false positive: a verb inside a quoted commit message', () => {
  assert.equal(evaluateShellDestination('git commit -m "deploy the new release"').action, 'allow');
});

test('NO false positive: echo with a quoted publish word', () => {
  assert.equal(evaluateShellDestination('echo "ready to publish"').action, 'allow');
});

test('NO false positive: git push (push is not a tracked publish verb)', () => {
  assert.equal(evaluateShellDestination('git push origin main').action, 'allow');
});

test('NO false positive: a plain read command', () => {
  assert.equal(evaluateShellDestination('ls -la /tmp/site').action, 'allow');
  assert.equal(evaluateShellDestination('netlify status --json').action, 'allow');
});

test('a publish verb only after a FLAG does not count (not a sub-command)', () => {
  // "deploy" appears, but after a flag — not the leading sub-command run.
  assert.equal(classifyShellCommand('mytool --note deploy').isPublish, false);
});

test('classify: an explicit https remote URI pins the destination', () => {
  assert.equal(evaluateShellDestination('wrangler publish https://my.workers.dev/app').action, 'allow');
});

test('destinationCardSuffix: present only for an ambient publish', () => {
  assert.match(destinationCardSuffix('netlify deploy --prod'), /implicit target/);
  assert.equal(destinationCardSuffix('netlify deploy --prod --site abc'), '');
  assert.equal(destinationCardSuffix('ls -la'), '');
});

test('the gate is enabled by default', () => {
  assert.equal(isDestinationGateEnabled(), true);
});

test('one-shot ledger: nudged once per (session, shape), then remembered', () => {
  _resetDestinationStateForTests();
  const sid = 'sess-x';
  assert.equal(wasDestinationNudged(sid, 'netlify:deploy'), false);
  markDestinationNudged(sid, 'netlify:deploy');
  assert.equal(wasDestinationNudged(sid, 'netlify:deploy'), true);
  // distinct shape / session is independent
  assert.equal(wasDestinationNudged(sid, 'npm:publish'), false);
  assert.equal(wasDestinationNudged('sess-y', 'netlify:deploy'), false);
});

test('ImplicitDestinationError carries a recoverable, explicit message', () => {
  const e = new ImplicitDestinationError({ command: 'netlify deploy --prod', verb: 'deploy', shapeKey: 'netlify:deploy' });
  assert.match(e.message, /IMPLICIT_DESTINATION/);
  assert.match(e.message, /--site/);          // tells the model how to make it explicit
  assert.match(e.message, /netlify status/);  // or how to confirm the current link
  assert.match(e.message, /conscious second attempt/i); // one-shot: a retry passes
  assert.equal(e.verb, 'deploy');
});
