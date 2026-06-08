/**
 * Run: npx tsx --test src/spaces/space-enforce.test.ts
 *
 * The Space authoring-reliability gate (mirror of workflow-enforce tests):
 * auto-repair preserves intent, validation blocks real runtime failures, and a
 * clean thin Space passes untouched. Temp CLEMENTINE_HOME so runner-file checks
 * resolve against a scratch dir.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-space-enforce-test-'));

const enforce = await import('./space-enforce.js');
const store = await import('./store.js');

function writeRunner(slug: string, file: string) {
  const dir = store.resolveInSpace(slug, 'data');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), 'process.stdout.write("{}")', 'utf-8');
}

test('clean thin space passes untouched (no repairs, no errors)', () => {
  writeRunner('clean', 'r.mjs');
  const prep = enforce.prepareSpaceForWrite({
    slug: 'clean',
    dataSources: [{ id: 'pull', runner: 'r.mjs' }],
    actions: [],
  });
  assert.equal(prep.ok, true);
  assert.equal(prep.repairs.length, 0);
  assert.equal(prep.errors.length, 0);
});

test('auto-repair coerces confirm:true on a send-like action', () => {
  const prep = enforce.prepareSpaceForWrite({
    slug: 'sendy',
    dataSources: [],
    actions: [{ id: 'send_email', label: 'Send email', composioSlug: 'OUTLOOK_OUTLOOK_SEND_EMAIL' }],
  });
  assert.equal(prep.ok, true);
  assert.equal(prep.actions[0].confirm, true);
  assert.match(prep.repairs.join(' '), /confirm:true/);
});

test('auto-repair drops a bad timezone (keeps the source)', () => {
  writeRunner('tz', 'r.mjs');
  const prep = enforce.prepareSpaceForWrite({
    slug: 'tz',
    dataSources: [{ id: 'pull', runner: 'r.mjs', schedule: '0 7 * * *', timezone: 'Mars/Phobos' }],
    actions: [],
  });
  assert.equal(prep.ok, true);
  assert.equal(prep.dataSources[0].timezone, undefined);
  assert.match(prep.repairs.join(' '), /invalid timezone/i);
});

test('auto-repair drops a redundant runner when both backends are declared', () => {
  writeRunner('both', 'r.mjs');
  const prep = enforce.prepareSpaceForWrite({
    slug: 'both',
    dataSources: [],
    actions: [{ id: 'act', composioSlug: 'SOME_TOOL', runner: 'r.mjs' }],
  });
  assert.equal(prep.actions[0].runner, undefined);
  assert.equal(prep.actions[0].composioSlug, 'SOME_TOOL');
});

test('ERROR: source with no backend blocks the save', () => {
  const prep = enforce.prepareSpaceForWrite({
    slug: 'nob', dataSources: [{ id: 'pull' }], actions: [],
  });
  assert.equal(prep.ok, false);
  assert.match(prep.errors.join(' '), /neither a runner nor a composio_slug/);
});

test('ERROR: runner file that is not on disk blocks the save', () => {
  const prep = enforce.prepareSpaceForWrite({
    slug: 'missing', dataSources: [{ id: 'pull', runner: 'nope.mjs' }], actions: [],
  });
  assert.equal(prep.ok, false);
  assert.match(prep.errors.join(' '), /doesn.t exist/);
});

test('ERROR: invalid cron on a scheduled source blocks the save', () => {
  writeRunner('badcron', 'r.mjs');
  const prep = enforce.prepareSpaceForWrite({
    slug: 'badcron', dataSources: [{ id: 'pull', runner: 'r.mjs', schedule: 'every morning' }], actions: [],
  });
  assert.equal(prep.ok, false);
  assert.match(prep.errors.join(' '), /invalid schedule/);
});

test('ERROR: action with no backend blocks the save', () => {
  const prep = enforce.prepareSpaceForWrite({
    slug: 'noact', dataSources: [], actions: [{ id: 'x', label: 'Do thing' }],
  });
  assert.equal(prep.ok, false);
  assert.match(prep.errors.join(' '), /neither a composio_slug nor a runner/);
});
