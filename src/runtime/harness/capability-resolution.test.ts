/**
 * Run: npx tsx --test src/runtime/harness/capability-resolution.test.ts
 *
 * Typed capability resolution — the runtime resolves what a turn's ask can
 * rely on from structural sources (proven memos, invalidated memos, the
 * connection registry) with no provider names in the control flow.
 *
 * Pinned from the live 2026-08-05 session: a proven calendar memo must
 * resolve `proven` with its account, and the apify firm-research memo —
 * auto-invalidated in July — must resolve `previously_failed` instead of
 * silently vanishing while the model asks the user to approve a plan that
 * assumes it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-cap-resolution-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const {
  resolveTurnCapabilities,
  renderCapabilityResolutionForContext,
  recordCapabilityResolution,
} = await import('./capability-resolution.js');
const { rememberToolChoice, invalidateToolChoice } = await import('../../memory/tool-choice-store.js');
const { __test__: composioTest, listConnectedToolkits } = await import('../../integrations/composio/client.js');
const { createSession, listEvents, resetEventLog } = await import('./eventlog.js');

// Teach one proven memo and one that then fails out — the live pair.
rememberToolChoice({
  intent: 'outlook.calendar.view_day',
  description: 'List Outlook calendar events for a date range (calendar view)',
  choice: {
    kind: 'composio',
    identifier: 'OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW',
    accountIdentity: 'user@example.com',
  },
});
rememberToolChoice({
  intent: 'apify.google_search_scrape_public_firm_research',
  description: 'Run Google Search via Apify and return organic results for public-source firm research',
  choice: {
    kind: 'composio',
    identifier: 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS',
  },
});
invalidateToolChoice('apify.google_search_scrape_public_firm_research', 'auto-invalidated after 3 failures with no later success');

test('a proven memo resolves proven; an invalidated memo resolves previously_failed', () => {
  const calendar = resolveTurnCapabilities('whats on my outlook calendar view for tomorrow');
  const proven = calendar.entries.find((e) => e.identifier === 'OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW');
  assert.ok(proven, 'the proven calendar memo must surface');
  assert.equal(proven.status, 'proven');
  assert.equal(proven.accountIdentity, 'user@example.com');

  const firms = resolveTurnCapabilities('scrape law firms with apify google search for public firm research');
  const failed = firms.entries.find((e) => e.identifier === 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS');
  assert.ok(failed, 'the invalidated apify memo must surface instead of vanishing');
  assert.equal(failed.status, 'previously_failed');
  assert.ok(failed.failureReason && /auto-invalidated/.test(failed.failureReason));
});

test('no registry snapshot → connection is unknown, never disconnected', () => {
  const r = resolveTurnCapabilities('whats on my outlook calendar view for tomorrow');
  assert.equal(r.registryAvailable, false);
  for (const e of r.entries) {
    assert.notEqual(e.connection, 'missing', 'absence of the registry must not read as a missing connection');
  }
});

test('an unrelated ask resolves nothing — zero prompt tax without history', () => {
  const r = resolveTurnCapabilities('tell me a story about clementines');
  assert.deepEqual(r.entries, []);
  assert.equal(renderCapabilityResolutionForContext(r), '');
});

test('the rendered block is data + floor, and names both statuses', () => {
  const r = resolveTurnCapabilities('scrape firms with apify google search research, then check my outlook calendar view');
  const block = renderCapabilityResolutionForContext(r);
  assert.match(block, /\[capability resolution/);
  assert.match(block, /✕ previously failed: apify\.google_search_scrape_public_firm_research/);
  assert.match(block, /Floor: a previously-failed path must be re-verified/);
});

test('with a registry snapshot, connections join: active toolkit → active; absent toolkit → missing', async () => {
  composioTest.setConnectedAccountsLoader(async () => [
    { id: 'ca_1', status: 'ACTIVE', toolkit: { slug: 'outlook' } },
  ]);
  try {
    await listConnectedToolkits({ requireFresh: true }); // seed the sync peek
    const r = resolveTurnCapabilities(
      'scrape firms with apify google search research, then check my outlook calendar view',
    );
    assert.equal(r.registryAvailable, true);
    const outlook = r.entries.find((e) => e.identifier.startsWith('OUTLOOK_'));
    const apify = r.entries.find((e) => e.identifier.startsWith('APIFY_'));
    assert.equal(outlook?.connection, 'active');
    assert.equal(apify?.connection, 'missing', 'a registry without the toolkit is a real missing connection');
  } finally {
    composioTest.setConnectedAccountsLoader(null);
  }
});

test('recordCapabilityResolution persists a typed event; empty resolutions persist nothing', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  recordCapabilityResolution(sess.id, resolveTurnCapabilities('scrape firms with apify google search research'), 7);
  const rows = listEvents(sess.id, { types: ['capability_resolution'] });
  assert.equal(rows.length, 1);
  const data = rows[0].data as { entries: Array<{ status: string }>; sourceUserSeq?: number };
  assert.ok(data.entries.some((e) => e.status === 'previously_failed'));
  assert.equal(data.sourceUserSeq, 7);

  recordCapabilityResolution(sess.id, { entries: [], registryAvailable: false });
  assert.equal(listEvents(sess.id, { types: ['capability_resolution'] }).length, 1, 'empty resolution stays silent');
});
