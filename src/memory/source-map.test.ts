/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-sourcemap npx tsx --test src/memory/source-map.test.ts
 *
 * Source-map / landscape memory: pointer-first resource catalog + injection.
 */
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-sourcemap';
process.env.CLEMENTINE_HOME = TEST_HOME;

const { resetMemoryDb, openMemoryDb } = await import('./db.js');
const {
  upsertResourcePointer,
  listResourcePointers,
  countResourcePointers,
  renderSourceMapForContext,
  isSourceMapEnabled,
  canonicalRef,
} = await import('./source-map.js');

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
});

beforeEach(() => {
  resetMemoryDb();
  openMemoryDb();
});

afterEach(() => { delete process.env.CLEMMY_SOURCE_MAP; });

test('isSourceMapEnabled defaults off and reads CLEMMY_SOURCE_MAP', () => {
  delete process.env.CLEMMY_SOURCE_MAP;
  assert.equal(isSourceMapEnabled(), false);
  process.env.CLEMMY_SOURCE_MAP = 'on';
  assert.equal(isSourceMapEnabled(), true);
});

test('upsertResourcePointer inserts once and dedupes on (app, ref), bumping mention_count', () => {
  const a = upsertResourcePointer({ app: 'Google Drive', kind: 'folder', name: 'Q3 Planning', whatsHere: 'board decks' });
  assert.equal(a.mentionCount, 1);
  const b = upsertResourcePointer({ app: 'Google Drive', kind: 'folder', name: 'Q3 Planning' });
  assert.equal(b.id, a.id, 'same (app, synthesized-ref) → same row');
  assert.equal(b.mentionCount, 2, 'a repeat sighting bumps mention_count');
  assert.equal(countResourcePointers(), 1, 'no duplicate row');
});

test('upsert COALESCE fills a missing description but never clobbers an existing one', () => {
  const first = upsertResourcePointer({ app: 'Airtable', kind: 'base', name: 'Prospects', whatsHere: 'prospect records' });
  // A later sighting with no description must not wipe the known one.
  const second = upsertResourcePointer({ app: 'Airtable', kind: 'base', name: 'Prospects' });
  assert.equal(second.whatsHere, 'prospect records', 'existing description preserved');
  // A previously-null field gets filled when later learned.
  const third = upsertResourcePointer({ app: 'Airtable', kind: 'base', name: 'Prospects', whenToUse: 'prospecting + outreach' });
  assert.equal(third.whenToUse, 'prospecting + outreach');
  assert.equal(first.id, third.id);
});

test('canonicalRef prefers the provider id, falls back to the name slug', () => {
  assert.equal(canonicalRef('Google Drive', 'folder', 'abc123'), 'google-drive:folder:abc123');
  assert.equal(canonicalRef('Google Drive', 'folder', undefined, 'Q3 Planning'), 'google-drive:folder:q3-planning');
  assert.equal(canonicalRef('Google Drive', 'folder', '', 'Q3 Planning'), 'google-drive:folder:q3-planning');
});

test('reactive and ingest CONVERGE on one row when they share a provider id', () => {
  // ingest writes with the real Drive folder id...
  const ingest = upsertResourcePointer({ app: 'Google Drive', kind: 'folder', name: 'Q3 Planning', providerId: 'fld_abc', source: 'ingest' });
  // ...and a later reactive sighting carries the same id (via the extractor's ref).
  const reactive = upsertResourcePointer({ app: 'Google Drive', kind: 'folder', name: 'Q3 Planning Folder', providerId: 'fld_abc', source: 'reactive', whatsHere: 'board decks' });
  assert.equal(reactive.id, ingest.id, 'same provider id → one converged row');
  assert.equal(reactive.mentionCount, 2);
  assert.equal(reactive.name, 'Q3 Planning Folder', 'name updates to latest');
  assert.equal(reactive.whatsHere, 'board decks', 'reactive enriches the ingested row');
  assert.equal(countResourcePointers(), 1);
});

test('explicit ref dedupes regardless of name drift', () => {
  const a = upsertResourcePointer({ app: 'Salesforce', kind: 'object', name: 'Account', ref: 'sf:object:Account' });
  const b = upsertResourcePointer({ app: 'Salesforce', kind: 'object', name: 'Accounts (renamed)', ref: 'sf:object:Account' });
  assert.equal(b.id, a.id, 'same explicit ref → same row even when the name changes');
  assert.equal(b.name, 'Accounts (renamed)', 'name updates to the latest');
});

test('listResourcePointers filters by app', () => {
  upsertResourcePointer({ app: 'Google Drive', kind: 'folder', name: 'Decks' });
  upsertResourcePointer({ app: 'Airtable', kind: 'base', name: 'CRM' });
  assert.equal(listResourcePointers({ app: 'Airtable' }).length, 1);
  assert.equal(listResourcePointers().length, 2);
});

test('renderSourceMapForContext returns empty when the flag is off', () => {
  delete process.env.CLEMMY_SOURCE_MAP;
  upsertResourcePointer({ app: 'Google Drive', kind: 'folder', name: 'Q3 Planning', whatsHere: 'board decks' });
  assert.equal(renderSourceMapForContext(), '');
});

test('renderSourceMapForContext renders a grouped, pointer-only block when on', () => {
  process.env.CLEMMY_SOURCE_MAP = 'on';
  upsertResourcePointer({ app: 'Google Drive', kind: 'folder', name: 'Q3 Planning', whatsHere: 'board decks and OKRs' });
  upsertResourcePointer({ app: 'Airtable', kind: 'base', name: 'Prospects', whatsHere: 'prospect records' });
  const block = renderSourceMapForContext();
  assert.match(block, /Data landscape/);
  assert.match(block, /Google Drive:/);
  assert.match(block, /Q3 Planning/);
  assert.match(block, /board decks and OKRs/);
  assert.match(block, /Airtable:/);
});

test('renderSourceMapForContext promotes resources relevant to the objective', () => {
  process.env.CLEMMY_SOURCE_MAP = 'on';
  upsertResourcePointer({ app: 'Google Drive', kind: 'folder', name: 'Recipes', whatsHere: 'personal cooking notes' });
  upsertResourcePointer({ app: 'Google Drive', kind: 'folder', name: 'Renewals', whatsHere: 'contract renewal models and targets' });
  const block = renderSourceMapForContext(24, undefined, 'prepare the contract renewal targets');
  assert.ok(block.indexOf('Renewals') < block.indexOf('Recipes'), 'objective-relevant resource ranks first');
});

test('renderSourceMapForContext respects the char budget', () => {
  process.env.CLEMMY_SOURCE_MAP = 'on';
  for (let i = 0; i < 50; i++) {
    upsertResourcePointer({ app: 'Airtable', kind: 'table', name: `Table ${i}`, whatsHere: 'a fairly wordy description that takes up some space in the block budget' });
  }
  const block = renderSourceMapForContext(24, 400);
  assert.ok(block.length <= 420, `block stays within budget (got ${block.length})`);
});
