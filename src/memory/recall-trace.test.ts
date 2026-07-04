/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-recall-trace npx tsx --test src/memory/recall-trace.test.ts
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-recall-trace';
process.env.CLEMENTINE_HOME = TEST_HOME;

// eslint-disable-next-line import/first
const { resetMemoryDb, openMemoryDb } = await import('./db.js');
// eslint-disable-next-line import/first
const { rememberFact, renderFactsForInstructions, setFactPinned } = await import('./facts.js');
// eslint-disable-next-line import/first
const { appendFactRecallTrace, readFactRecallTrace } = await import('./recall-trace.js');

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
});

beforeEach(() => {
  resetMemoryDb();
  rmSync(`${TEST_HOME}/state/memory-recall-trace.jsonl`, { force: true });
  openMemoryDb();
});

test('appendFactRecallTrace records bounded fact metadata for later review', () => {
  const fact = rememberFact({ kind: 'project', content: 'Market_Leader__c marks market leader accounts.', importance: 8 });
  appendFactRecallTrace({
    surface: 'memory_search_facts',
    query: 'market leader',
    facts: [{ fact, reason: 'agent-tool-semantic-search' }],
    nowIso: '2026-07-04T12:00:00.000Z',
  });

  const [entry] = readFactRecallTrace(5);
  assert.equal(entry.surface, 'memory_search_facts');
  assert.equal(entry.query, 'market leader');
  assert.equal(entry.facts.length, 1);
  assert.equal(entry.facts[0].id, fact.id);
  assert.equal(entry.facts[0].reason, 'agent-tool-semantic-search');
  assert.equal(entry.facts[0].importance, 8);
});

test('renderFactsForInstructions traces pinned and scored facts with their reasons', () => {
  const pinned = rememberFact({ kind: 'feedback', content: 'Always preserve client source links.', importance: 9 });
  setFactPinned(pinned.id, true);
  const scored = rememberFact({ kind: 'project', content: 'Market_Leader__c marks market leader accounts.', importance: 8 });

  const rendered = renderFactsForInstructions(10, 2600, 'market leader accounts');

  assert.match(rendered, /Always preserve client source links/);
  assert.match(rendered, /Market_Leader__c/);
  const [entry] = readFactRecallTrace(5);
  assert.equal(entry.surface, 'facts_for_instructions');
  assert.equal(entry.objective, 'market leader accounts');
  assert.equal(entry.mode, 'all');
  assert.ok(entry.facts.some((f) => f.id === pinned.id && f.reason === 'pinned-standing-instruction'));
  assert.ok(entry.facts.some((f) => f.id === scored.id && f.reason === 'scored-stanford-objective'));
});

test('renderFactsForInstructions traces only scored facts that survive clipping', () => {
  const visible = rememberFact({ kind: 'project', content: 'Short visible market leader fact.', importance: 9 });
  rememberFact({ kind: 'project', content: `Very long market leader detail ${'x'.repeat(1000)}`, importance: 8 });

  const rendered = renderFactsForInstructions(10, 120, 'market leader');
  const [entry] = readFactRecallTrace(5);

  assert.match(rendered, /Short visible market leader fact/);
  assert.ok(entry.facts.some((f) => f.id === visible.id));
  assert.ok(entry.facts.length < 2, 'clipped-away fact is not recorded as exposed');
});
