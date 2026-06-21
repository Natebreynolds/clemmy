/**
 * Run: npx tsx --test src/runtime/harness/published-destinations.test.ts
 *
 * Part 2 (2026-06-21): the durable project→destination binding that lets the
 * destination gate confer PROVENANCE on a site this project has published to
 * before — turning a one-time success into learned, reusable, cross-session
 * knowledge, while keeping the cross-project clobber guard intact.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-pubdest-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-A\n');

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resetMachineIdCacheForTests } = await import('../machine-id.js');
resetMachineIdCacheForTests?.();
const {
  recordPublishedDestination,
  establishedTargetsFor,
  isEstablishedDestination,
  normalizeProjectKey,
  renderEstablishedDestinationsForContext,
} = await import('./published-destinations.js');

const PROJECT = '/Users/nate/clementine-next/clementine-onepager';

test('a project with no recorded publish has no established destinations', () => {
  assert.equal(establishedTargetsFor('/some/never/published').size, 0);
  assert.equal(isEstablishedDestination('/some/never/published', 'whatever.netlify.app'), false);
});

test('recording a successful publish establishes the destination (identity-aware, cross-session)', () => {
  recordPublishedDestination(PROJECT, ['clementine-onepager.netlify.app']);
  // A later redeploy — by subdomain OR by bare slug — is now established.
  assert.equal(isEstablishedDestination(PROJECT, 'clementine-onepager.netlify.app'), true);
  assert.equal(isEstablishedDestination(PROJECT, 'clementine-onepager'), true);
  assert.equal(isEstablishedDestination(PROJECT, 'https://clementine-onepager.netlify.app/'), true);
});

test('established destinations are PROJECT-scoped — no cross-project clobber', () => {
  // The coffee project establishes its own site…
  recordPublishedDestination('/Users/nate/coffee', ['my-coffee.netlify.app']);
  // …which must NOT confer provenance on an unrelated project's deploy.
  assert.equal(isEstablishedDestination(PROJECT, 'my-coffee.netlify.app'), false);
  assert.equal(isEstablishedDestination('/Users/nate/coffee', 'my-coffee.netlify.app'), true);
});

test('project key normalization is trailing-slash + case insensitive', () => {
  assert.equal(normalizeProjectKey('/Foo/Bar/'), '/foo/bar');
  recordPublishedDestination('/proj/x/', ['site-a']);
  assert.equal(isEstablishedDestination('/proj/x', 'site-a'), true); // no trailing slash still matches
});

test('recording is idempotent + accumulates multiple destinations', () => {
  recordPublishedDestination('/proj/multi', ['site-1.netlify.app']);
  recordPublishedDestination('/proj/multi', ['site-1.netlify.app']); // dup — no growth of distinct forms
  recordPublishedDestination('/proj/multi', ['site-2.vercel.app']);
  const forms = establishedTargetsFor('/proj/multi');
  assert.ok(forms.has('site-1.netlify.app') && forms.has('site-1'));
  assert.ok(forms.has('site-2.vercel.app') && forms.has('site-2'));
});

test('empty/garbage inputs are ignored (never crash, never poison)', () => {
  recordPublishedDestination('', ['x.netlify.app']);
  recordPublishedDestination(undefined, ['x.netlify.app']);
  recordPublishedDestination('/proj/ok', []);
  assert.equal(establishedTargetsFor('/proj/ok').size, 0);
});

// ─── Agent side: surface the resolved binding so the agent updates the SAME site ───

test('renderEstablishedDestinationsForContext: surfaces the actionable host + "update, do not recreate"', () => {
  const project = '/Users/nate/agent-side-render';
  // A fresh project surfaces nothing.
  assert.equal(renderEstablishedDestinationsForContext(project), '');
  // After a recorded success, the agent gets a one-line hint naming the host.
  recordPublishedDestination(project, ['my-onepager.netlify.app']);
  const hint = renderEstablishedDestinationsForContext(project);
  assert.match(hint, /my-onepager\.netlify\.app/, 'names the actionable full host, not just the bare slug');
  assert.match(hint, /update|same/i);
  assert.match(hint, /do not create a new site/i);
});

test('full loop: record-on-success → established → identity-matched provenance → agent hint', () => {
  const project = '/Users/nate/clementine-onepager';
  recordPublishedDestination(project, ['clementine-onepager.netlify.app']); // a successful deploy
  // gate side: a later redeploy by subdomain OR bare slug is provenanced (cross-session)
  assert.equal(isEstablishedDestination(project, 'clementine-onepager.netlify.app'), true);
  assert.equal(isEstablishedDestination(project, 'clementine-onepager'), true);
  // agent side: the binding is surfaced so it deploys explicitly first-try
  assert.match(renderEstablishedDestinationsForContext(project), /clementine-onepager\.netlify\.app/);
});

test('agent hint resolves a URL/host focus ref (fixes the cwd-vs-resource_ref key mismatch)', () => {
  // Recorded keyed by the deploy cwd (a filesystem path) …
  recordPublishedDestination('/Users/nate/onepager-proj', ['onepager-proj.netlify.app']);
  // … but the agent reads by focus.resource_ref, which is usually the deployed
  // URL/host, NOT the cwd. That lookup must still resolve (was dead before).
  assert.match(renderEstablishedDestinationsForContext('https://onepager-proj.netlify.app/'), /onepager-proj\.netlify\.app/);
  assert.match(renderEstablishedDestinationsForContext('onepager-proj.netlify.app'), /onepager-proj\.netlify\.app/);
  // and the cwd lookup (the gate's path) still works
  assert.match(renderEstablishedDestinationsForContext('/Users/nate/onepager-proj'), /onepager-proj\.netlify\.app/);
});
