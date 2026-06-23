/**
 * Run: npx tsx --test src/memory/tool-choice-audit.test.ts
 *
 * Procedural-memory self-heal (Wave 2). The periodic audit re-applies the
 * cross-service / async-task-post guard across the tool-choice store and
 * invalidates (recoverable) any mis-bound active choice — healing pollution that
 * predates the write-time guard. Validates: detection precision, end-to-end heal
 * (polluted invalidated, clean survives), the no-known-toolkit safety no-op, and
 * the kill-switch.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-tc-audit-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { rememberToolChoice, peekToolChoice } = await import('./tool-choice-store.js');
const { detectToolChoicePollution, auditAndHealToolChoices } = await import('./tool-choice-audit.js');

test.after(() => { try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

const rec = (intent: string, identifier: string, kind: 'composio' | 'cli' = 'composio') => ({
  intent,
  choice: { kind, identifier, testedAt: '2026-06-23T00:00:00Z' } as const,
  filePath: '', fallbacks: [], body: '',
});

// ─── detectToolChoicePollution (pure) ─────────────────────────────

test('detect: cross-service mismatch (intent names X, slug is from Y)', () => {
  const hit = detectToolChoicePollution(rec('pull dataforseo ranked keywords', 'AIRTABLE_LIST_RECORDS'), ['dataforseo', 'airtable']);
  assert.equal(hit?.reason, 'cross_service_mismatch');
});

test('detect: async TASK_POST bound to a LIVE intent', () => {
  const hit = detectToolChoicePollution(rec('dataforseo live serp results', 'DATAFORSEO_CREATE_SERP_GOOGLE_ORGANIC_TASK_POST'), ['dataforseo']);
  assert.equal(hit?.reason, 'async_taskpost_for_live_intent');
});

test('detect: a consistent live-data binding is clean', () => {
  assert.equal(detectToolChoicePollution(rec('dataforseo traffic estimate', 'DATAFORSEO_GET_GOOGLE_HIST_BULK_TRAFFIC_EST_LIVE'), ['dataforseo']), null);
});

test('detect: non-composio and invalidated records are skipped', () => {
  assert.equal(detectToolChoicePollution(rec('deploy the site', 'netlify', 'cli'), ['dataforseo', 'airtable']), null);
  assert.equal(detectToolChoicePollution({ intent: 'x', choice: null, fallbacks: [], body: '', filePath: '' }, ['dataforseo']), null);
});

test('detect: empty known-toolkit list never triggers the cross-service rule', () => {
  // cross-service needs a baseline; with none, only the async-taskpost rule can fire
  assert.equal(detectToolChoicePollution(rec('pull dataforseo ranked keywords', 'AIRTABLE_LIST_RECORDS'), []), null);
});

// ─── auditAndHealToolChoices (end-to-end over the real store) ──────

test('audit: invalidates the polluted binding, keeps the clean one', async () => {
  rememberToolChoice({ intent: 'pull dataforseo ranked keywords', choice: { kind: 'composio', identifier: 'AIRTABLE_LIST_RECORDS' } });
  rememberToolChoice({ intent: 'dataforseo traffic estimate', choice: { kind: 'composio', identifier: 'DATAFORSEO_GET_GOOGLE_HIST_BULK_TRAFFIC_EST_LIVE' } });

  const hits = await auditAndHealToolChoices({ knownToolkits: ['dataforseo', 'airtable'] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].reason, 'cross_service_mismatch');

  assert.equal(peekToolChoice('pull dataforseo ranked keywords')?.choice, null, 'polluted choice invalidated (recoverable)');
  assert.ok(peekToolChoice('dataforseo traffic estimate')?.choice, 'clean choice survives');
  // The invalidated record keeps a fallback breadcrumb (recoverable).
  assert.ok((peekToolChoice('pull dataforseo ranked keywords')?.fallbacks.length ?? 0) >= 1);
});

test('audit: no known toolkits → no-op (a Composio outage cannot quarantine the store)', async () => {
  rememberToolChoice({ intent: 'pull dataforseo ranked keywords 2', choice: { kind: 'composio', identifier: 'AIRTABLE_LIST_RECORDS' } });
  const hits = await auditAndHealToolChoices({ knownToolkits: [] });
  assert.equal(hits.length, 0);
  assert.ok(peekToolChoice('pull dataforseo ranked keywords 2')?.choice, 'untouched without a baseline');
});

test('audit: dryRun reports without invalidating', async () => {
  rememberToolChoice({ intent: 'pull dataforseo ranked keywords 3', choice: { kind: 'composio', identifier: 'AIRTABLE_LIST_RECORDS' } });
  const hits = await auditAndHealToolChoices({ knownToolkits: ['dataforseo', 'airtable'], dryRun: true });
  assert.ok(hits.some((h) => h.intent === 'pull dataforseo ranked keywords 3'));
  assert.ok(peekToolChoice('pull dataforseo ranked keywords 3')?.choice, 'dryRun leaves the choice intact');
});

test('audit: kill-switch CLEMMY_TOOLCHOICE_AUDIT=off → no-op', async () => {
  rememberToolChoice({ intent: 'pull dataforseo ranked keywords 4', choice: { kind: 'composio', identifier: 'AIRTABLE_LIST_RECORDS' } });
  process.env.CLEMMY_TOOLCHOICE_AUDIT = 'off';
  try {
    const hits = await auditAndHealToolChoices({ knownToolkits: ['dataforseo', 'airtable'] });
    assert.equal(hits.length, 0);
    assert.ok(peekToolChoice('pull dataforseo ranked keywords 4')?.choice, 'flag off → untouched');
  } finally {
    delete process.env.CLEMMY_TOOLCHOICE_AUDIT;
  }
});
