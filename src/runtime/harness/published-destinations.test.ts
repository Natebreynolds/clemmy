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

const PROJECT = '/Users/example/projects/fixture-onepager';

test('a project with no recorded publish has no established destinations', () => {
  assert.equal(establishedTargetsFor('/some/never/published').size, 0);
  assert.equal(isEstablishedDestination('/some/never/published', 'fixture-unpublished.netlify.app'), false);
});

test('recording a successful publish establishes the destination (identity-aware, cross-session)', () => {
  recordPublishedDestination(PROJECT, ['fixture-onepager.netlify.app']);
  // A later redeploy — by subdomain OR by bare slug — is now established.
  assert.equal(isEstablishedDestination(PROJECT, 'fixture-onepager.netlify.app'), true);
  assert.equal(isEstablishedDestination(PROJECT, 'fixture-onepager'), true);
  assert.equal(isEstablishedDestination(PROJECT, 'https://fixture-onepager.netlify.app/'), true);
});

test('established destinations are PROJECT-scoped — no cross-project clobber', () => {
  // The coffee project establishes its own site…
  recordPublishedDestination('/Users/example/projects/fixture-coffee', ['fixture-coffee.netlify.app']);
  // …which must NOT confer provenance on an unrelated project's deploy.
  assert.equal(isEstablishedDestination(PROJECT, 'fixture-coffee.netlify.app'), false);
  assert.equal(isEstablishedDestination('/Users/example/projects/fixture-coffee', 'fixture-coffee.netlify.app'), true);
});

test('project key normalization is trailing-slash + case insensitive', () => {
  assert.equal(normalizeProjectKey('/Foo/Bar/'), '/foo/bar');
  recordPublishedDestination('/proj/x/', ['site-a']);
  assert.equal(isEstablishedDestination('/proj/x', 'site-a'), true); // no trailing slash still matches
});

test('recording is idempotent + accumulates multiple destinations', () => {
  recordPublishedDestination('/proj/multi', ['fixture-site-one.netlify.app']);
  recordPublishedDestination('/proj/multi', ['fixture-site-one.netlify.app']); // dup — no growth of distinct forms
  recordPublishedDestination('/proj/multi', ['site-2.vercel.app']);
  const forms = establishedTargetsFor('/proj/multi');
  assert.ok(forms.has('fixture-site-one.netlify.app') && forms.has('fixture-site-one'));
  assert.ok(forms.has('site-2.vercel.app') && forms.has('site-2'));
});

test('empty/garbage inputs are ignored (never crash, never poison)', () => {
  recordPublishedDestination('', ['fixture-ignored.netlify.app']);
  recordPublishedDestination(undefined, ['fixture-ignored.netlify.app']);
  recordPublishedDestination('/proj/ok', []);
  assert.equal(establishedTargetsFor('/proj/ok').size, 0);
});

// ─── Agent side: surface the resolved binding so the agent updates the SAME site ───

test('renderEstablishedDestinationsForContext: surfaces the actionable host + "update, do not recreate"', () => {
  const project = '/Users/example/agent-side-render';
  // A fresh project surfaces nothing.
  assert.equal(renderEstablishedDestinationsForContext(project), '');
  // After a recorded success, the agent gets a one-line hint naming the host.
  recordPublishedDestination(project, ['fixture-agent-hint.netlify.app']);
  const hint = renderEstablishedDestinationsForContext(project);
  assert.match(hint, /fixture-agent-hint\.netlify\.app/, 'names the actionable full host, not just the bare slug');
  assert.match(hint, /update|same/i);
  assert.match(hint, /do not create a new site/i);
});

test('full loop: record-on-success → established → identity-matched provenance → agent hint', () => {
  const project = '/Users/example/projects/fixture-onepager';
  recordPublishedDestination(project, ['fixture-onepager.netlify.app']); // a successful deploy
  // gate side: a later redeploy by subdomain OR bare slug is provenanced (cross-session)
  assert.equal(isEstablishedDestination(project, 'fixture-onepager.netlify.app'), true);
  assert.equal(isEstablishedDestination(project, 'fixture-onepager'), true);
  // agent side: the binding is surfaced so it deploys explicitly first-try
  assert.match(renderEstablishedDestinationsForContext(project), /fixture-onepager\.netlify\.app/);
});

test('agent hint resolves a URL/host focus ref (fixes the cwd-vs-resource_ref key mismatch)', () => {
  // Recorded keyed by the deploy cwd (a filesystem path) …
  recordPublishedDestination('/Users/example/projects/fixture-focus-site', ['fixture-focus-site.netlify.app']);
  // … but the agent reads by focus.resource_ref, which is usually the deployed
  // URL/host, NOT the cwd. That lookup must still resolve (was dead before).
  assert.match(renderEstablishedDestinationsForContext('https://fixture-focus-site.netlify.app/'), /fixture-focus-site\.netlify\.app/);
  assert.match(renderEstablishedDestinationsForContext('fixture-focus-site.netlify.app'), /fixture-focus-site\.netlify\.app/);
  // and the cwd lookup (the gate's path) still works
  assert.match(renderEstablishedDestinationsForContext('/Users/example/projects/fixture-focus-site'), /fixture-focus-site\.netlify\.app/);
});
