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
  const prep = enforce.prepareSpaceForWrite({
    slug: 'clean',
    dataSources: [{ id: 'pull', composioSlug: 'SALESFORCE_GET_CONTACTS' }],
    actions: [],
  });
  assert.equal(prep.ok, true);
  assert.equal(prep.repairs.length, 0);
  assert.equal(prep.errors.length, 0);
});

test('prepare rejects ambiguous identities before a caller can smoke, refresh, or dispatch', () => {
  const prep = enforce.prepareSpaceForWrite({
    slug: 'identity-gate',
    dataSources: [
      { id: '   ', composioSlug: 'SALESFORCE_GET_CONTACTS' },
      { id: ' pull', composioSlug: 'SALESFORCE_GET_CONTACTS' },
      { id: 'pull', composioSlug: 'SALESFORCE_GET_CONTACTS' },
      { id: 'pull', composioSlug: 'SALESFORCE_GET_CONTACTS' },
      { id: '_meta', composioSlug: 'SALESFORCE_GET_CONTACTS' },
      { id: 'x'.repeat(121), composioSlug: 'SALESFORCE_GET_CONTACTS' },
      { id: 'control\u0001source', composioSlug: 'SALESFORCE_GET_CONTACTS' },
    ],
    actions: [
      { id: '', composioSlug: 'OUTLOOK_SEND_EMAIL' },
      { id: 'send ', composioSlug: 'OUTLOOK_SEND_EMAIL' },
      { id: 'send', composioSlug: 'OUTLOOK_SEND_EMAIL' },
      { id: 'send', composioSlug: 'OUTLOOK_SEND_EMAIL' },
      { id: 'y'.repeat(121), composioSlug: 'OUTLOOK_SEND_EMAIL' },
      { id: 'control\u0001action', composioSlug: 'OUTLOOK_SEND_EMAIL' },
    ],
  });
  assert.equal(prep.ok, false);
  const errors = prep.errors.join('\n');
  assert.match(errors, /Data source .*non-whitespace/i);
  assert.match(errors, /Data source .*leading or trailing whitespace/i);
  assert.match(errors, /Duplicate data source id "pull"/i);
  assert.match(errors, /reserved id "_meta"/i);
  assert.match(errors, /Data source .*120 character/i);
  assert.match(errors, /Data source .*control character/i);
  assert.match(errors, /Action .*non-whitespace/i);
  assert.match(errors, /Action .*leading or trailing whitespace/i);
  assert.match(errors, /Duplicate action id "send"/i);
  assert.match(errors, /Action .*120 character/i);
  assert.match(errors, /Action .*control character/i);
});

test('prepare preserves valid prototype-shaped source and action identities', () => {
  const prep = enforce.prepareSpaceForWrite({
    slug: 'identity-prototype',
    dataSources: [
      { id: '__proto__', composioSlug: 'SALESFORCE_GET_CONTACTS' },
      { id: 'constructor', composioSlug: 'SALESFORCE_GET_CONTACTS' },
      { id: 'prototype', composioSlug: 'SALESFORCE_GET_CONTACTS' },
    ],
    actions: [
      { id: '__proto__', composioSlug: 'OUTLOOK_SEND_EMAIL' },
      { id: 'constructor', composioSlug: 'OUTLOOK_SEND_EMAIL' },
      { id: 'prototype', composioSlug: 'OUTLOOK_SEND_EMAIL' },
    ],
  });
  assert.equal(prep.ok, true, prep.errors.join('\n'));
  assert.deepEqual(
    prep.dataSources.map((source) => source.id),
    ['__proto__', 'constructor', 'prototype'],
  );
  assert.deepEqual(
    prep.actions.map((action) => action.id),
    ['__proto__', 'constructor', 'prototype'],
  );
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

test('auto-repair marks every opaque runner action as approval-required', () => {
  writeRunner('local-approval', 'approve-post.mjs');
  const prep = enforce.prepareSpaceForWrite({
    slug: 'local-approval',
    dataSources: [],
    actions: [{
      id: 'approve_post',
      label: 'Approve locally',
      runner: 'approve-post.mjs',
      argsTemplate: { external: false },
      confirm: false,
    }],
  });
  assert.equal(prep.ok, true);
  assert.equal(prep.actions[0].confirm, true);
  assert.equal(prep.repairs.some((repair) => /confirm:true/.test(repair)), true);
});

test('auto-repair drops a bad timezone (keeps the source)', () => {
  const prep = enforce.prepareSpaceForWrite({
    slug: 'tz',
    dataSources: [{ id: 'pull', composioSlug: 'SALESFORCE_GET_CONTACTS', schedule: '0 7 * * *', timezone: 'Mars/Phobos' }],
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

test('auto-repair drops a redundant data-source runner when both backends are declared', () => {
  writeRunner('both-source', 'r.mjs');
  const prep = enforce.prepareSpaceForWrite({
    slug: 'both-source',
    dataSources: [{ id: 'pull', composioSlug: 'SOME_READ_TOOL', runner: 'r.mjs' }],
    actions: [],
  });
  assert.equal(prep.ok, true);
  assert.equal(prep.dataSources[0].runner, undefined);
  assert.equal(prep.dataSources[0].composioSlug, 'SOME_READ_TOOL');
  assert.match(prep.repairs.join(' '), /Data source "pull".*dropped the runner/);
});

test('Composio data sources must be provably read-only at authoring time', () => {
  const read = enforce.prepareSpaceForWrite({
    slug: 'read-source',
    dataSources: [{ id: 'events', composioSlug: 'GOOGLECALENDAR_LIST_EVENTS' }],
    actions: [],
  });
  assert.equal(read.ok, true, read.errors.join('\n'));

  for (const composioSlug of [
    'GOOGLESHEETS_UPDATE_SPREADSHEET',
    'GMAIL_MARK_AS_READ',
    'ACME_DO_THING',
  ]) {
    const unsafe = enforce.prepareSpaceForWrite({
      slug: 'unsafe-source',
      dataSources: [{ id: 'pull', composioSlug }],
      actions: [],
    });
    assert.equal(unsafe.ok, false, `${composioSlug} must not become an automatic refresh`);
    assert.match(
      unsafe.errors.join(' '),
      /Data source "pull".*provably read-only.*action/i,
    );
  }
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

test('an opaque data-source runner is rejected even when its staged file exists', () => {
  const prep = enforce.prepareSpaceForWrite({
    slug: 'staged',
    dataSources: [{ id: 'pull', runner: 'new.mjs' }],
    actions: [],
    availableRunnerFiles: new Set(['new.mjs']),
  });
  assert.equal(prep.ok, false);
  assert.match(prep.errors.join(' '), /opaque runner|read-only Composio/i);
});

test('an installed runner declaration survives metadata/view saves but remains approval-gated at runtime', () => {
  writeRunner('legacy-preserved', 'pull.mjs');
  const existingDataSources = [{
    id: 'pull',
    runner: 'pull.mjs',
    schedule: '0 7 * * *',
    timezone: 'America/Los_Angeles',
  }];
  const prep = enforce.prepareSpaceForWrite({
    slug: 'legacy-preserved',
    dataSources: existingDataSources,
    existingDataSources,
    actions: [],
  });

  assert.equal(prep.ok, true, prep.errors.join('\n'));
  assert.deepEqual(prep.dataSources, existingDataSources);
  assert.match(
    prep.warnings.join(' '),
    /legacy runner.*preserved.*entrypoint hash.*approval.*helpers.*outside the digest/i,
  );
});

test('legacy compatibility cannot introduce a new runner source or swap its runner filename', () => {
  writeRunner('legacy-narrow', 'old.mjs');
  writeRunner('legacy-narrow', 'new.mjs');
  const existingDataSources = [{ id: 'pull', runner: 'old.mjs' }];

  const added = enforce.prepareSpaceForWrite({
    slug: 'legacy-narrow',
    dataSources: [
      ...existingDataSources,
      { id: 'new-source', runner: 'new.mjs' },
    ],
    existingDataSources,
    actions: [],
  });
  assert.equal(added.ok, false);
  assert.match(added.errors.join(' '), /new-source.*opaque runner|new-source.*read-only Composio/i);

  const swapped = enforce.prepareSpaceForWrite({
    slug: 'legacy-narrow',
    dataSources: [{ id: 'pull', runner: 'new.mjs' }],
    existingDataSources,
    actions: [],
  });
  assert.equal(swapped.ok, false);
  assert.match(swapped.errors.join(' '), /pull.*opaque runner|pull.*read-only Composio/i);
});

test('ERROR: runner declarations must be filenames under data/, not paths', () => {
  const viewDir = store.resolveInSpace('runner-paths', 'view');
  mkdirSync(viewDir, { recursive: true });
  writeFileSync(path.join(viewDir, 'evil.mjs'), 'process.stdout.write("{}")', 'utf-8');

  const prep = enforce.prepareSpaceForWrite({
    slug: 'runner-paths',
    dataSources: [{ id: 'pull', runner: '../view/evil.mjs' }],
    actions: [{ id: 'act', runner: '../view/evil.mjs' }],
  });

  assert.equal(prep.ok, false);
  assert.match(prep.errors.join(' '), /Data source "pull".*not a path/);
  assert.match(prep.errors.join(' '), /Action "act".*not a path/);
});

test('ERROR: invalid cron on a scheduled source blocks the save', () => {
  const prep = enforce.prepareSpaceForWrite({
    slug: 'badcron', dataSources: [{ id: 'pull', composioSlug: 'SALESFORCE_GET_CONTACTS', schedule: 'every morning' }], actions: [],
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
