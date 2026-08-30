/**
 * A retired connection id must not keep steering live calls.
 *
 * Live 2026-08-28: four active facts named an Outlook connection the provider
 * had re-issued. The model restated it, the host had bound a different
 * account, and an admitted plan for a correctly resolved capability died one
 * call short. Hand-editing the row is not a general answer — every user of
 * every provider reaches this state eventually and almost none can edit a
 * database — so the harness corrects it where it observes the supersession.
 */
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.CLEMENTINE_HOME = '/tmp/clemmy-test-superseded-account';

const {
  rememberFact,
  getFact,
  correctFactsNamingSupersededAccount,
} = await import('./facts.js');
const { openMemoryDb } = await import('./db.js');

const DEAD = 'ca_DeadConnection01';
const LIVE = 'ca_LiveConnection02';

beforeEach(() => {
  openMemoryDb().prepare('DELETE FROM consolidated_facts').run();
});

after(() => {
  rmSync('/tmp/clemmy-test-superseded-account', { recursive: true, force: true });
});

test('a fact naming a retired connection is corrected, not left to misdirect', () => {
  const fact = rememberFact({
    kind: 'reference',
    content: `Calendar lookups should use Outlook connection ${DEAD}.`,
  });
  const corrected = correctFactsNamingSupersededAccount({
    supersededAccountId: DEAD,
    currentAccountId: LIVE,
  });
  assert.equal(corrected, 1);
  const old = getFact(fact.id);
  assert.equal(old?.active, false, 'the fact asserting the dead id must stop being active');
  const rows = openMemoryDb()
    .prepare('SELECT content FROM consolidated_facts WHERE active = 1')
    .all() as { content: string }[];
  assert.equal(rows.length, 1);
  assert.match(rows[0].content, new RegExp(LIVE), 'the replacement must name the live connection');
  assert.doesNotMatch(rows[0].content, new RegExp(DEAD));
  // The INTENT survives: only the machine spelling changed.
  assert.match(rows[0].content, /Calendar lookups should use Outlook connection/);
});

test('a pinned preference survives the correction', () => {
  // The user pinned this deliberately. Correcting a stale id must not quietly
  // discard a preference they set.
  const fact = rememberFact({
    kind: 'constraint',
    content: `For calendar lookups, use Outlook connection ${DEAD}.`,
  });
  openMemoryDb().prepare('UPDATE consolidated_facts SET pinned = 1 WHERE id = ?').run(fact.id);
  assert.equal(correctFactsNamingSupersededAccount({
    supersededAccountId: DEAD, currentAccountId: LIVE,
  }), 1);
  const row = openMemoryDb()
    .prepare('SELECT content, pinned FROM consolidated_facts WHERE active = 1')
    .get() as { content: string; pinned: number };
  assert.equal(row.pinned, 1, 'the pin must carry across to the corrected fact');
  assert.match(row.content, new RegExp(LIVE));
});

test('facts that never named the retired id are untouched', () => {
  rememberFact({ kind: 'reference', content: 'Unrelated durable preference about scheduling.' });
  assert.equal(correctFactsNamingSupersededAccount({
    supersededAccountId: DEAD, currentAccountId: LIVE,
  }), 0);
});

test('a degenerate or self-identical id rewrites nothing', () => {
  rememberFact({ kind: 'reference', content: `Use connection ${DEAD}.` });
  // A blank/short token would substring-match unrelated text; an identical id
  // would rewrite every fact to itself and churn the whole store.
  assert.equal(correctFactsNamingSupersededAccount({ supersededAccountId: '', currentAccountId: LIVE }), 0);
  assert.equal(correctFactsNamingSupersededAccount({ supersededAccountId: 'ca_', currentAccountId: LIVE }), 0);
  assert.equal(correctFactsNamingSupersededAccount({ supersededAccountId: DEAD, currentAccountId: DEAD }), 0);
});
