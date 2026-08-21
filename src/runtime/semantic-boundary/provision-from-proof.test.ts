/** Run: node scripts/run-tests-isolated.mjs src/runtime/semantic-boundary/provision-from-proof.test.ts
 *
 * Live 2026-08-18 sess-msywj8qp: semantic admission recorded "No host
 * capabilities were supplied, so no operations could be bound" while the same
 * turn's capability_resolution event held PROVEN FIRECRAWL_SEARCH /
 * GOOGLEDRIVE_LIST_FILES entries with live prepared commands. The typed
 * catalog was unprovisioned (production packs refuse on this home), so the
 * graph compiled 12 unbound nodes and the brain rediscovered everything
 * through tool_search. Proof the host already produced for this exact
 * accepted source is capability supply.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-provision-proof-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-provision-proof\n', 'utf8');

const eventlog = await import('../harness/eventlog.js');
const resolution = await import('../harness/capability-resolution.js');
const admit = await import('./admit-and-compile-accepted-source.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function turnWithResolution(id: string, entries: unknown[]): { sessionId: string; sourceUserSeq: number } {
  const session = eventlog.createSession({ id, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'user',
    type: 'user_input_received',
    data: { text: 'Find me 25 personal injury lawyers and put it all in a google sheet' },
  });
  eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'system',
    type: 'capability_resolution',
    data: { sourceUserSeq: source.seq, authoritativeForTask: true, entries },
  });
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

const LIVE_ENTRIES = [
  { intent: 'web search for firms', kind: 'composio', identifier: 'FIRECRAWL_SEARCH', status: 'proven', connection: 'unknown', effectClass: 'read' },
  { intent: 'list drive files', kind: 'composio', identifier: 'GOOGLEDRIVE_LIST_FILES', status: 'proven', connection: 'unknown', effectClass: 'read' },
  { intent: 'create the results sheet', kind: 'composio', identifier: 'GOOGLESHEETS_CREATE_GOOGLE_SHEET1', status: 'proven', connection: 'unknown', effectClass: 'write' },
  { intent: 'scrape sites', kind: 'composio', identifier: 'FIRECRAWL_SCRAPE', status: 'previously_failed', connection: 'unknown', effectClass: 'read' },
  { intent: 'dead connection', kind: 'composio', identifier: 'OUTLOOK_SEARCH_EMAILS', status: 'proven', connection: 'missing', effectClass: 'read' },
];

test('proven resolution entries become citable capability descriptors when the catalog is empty', () => {
  const turn = turnWithResolution('provision-proof-1', LIVE_ENTRIES);
  const descriptors = admit.hostDescriptorsFromResolutionProof(turn.sessionId, turn.sourceUserSeq);
  const ids = descriptors.map((d) => d.id).sort();
  assert.deepEqual(ids, [
    'cap:resolved:firecrawl_search',
    'cap:resolved:googledrive_list_files',
    'cap:resolved:googlesheets_create_google_sheet1',
  ], JSON.stringify(ids));
  const write = descriptors.find((d) => d.id.includes('googlesheets'));
  assert.equal(write?.effect, 'external_write');
  assert.equal(write?.readbackRequired, true);
  const read = descriptors.find((d) => d.id.includes('firecrawl'));
  assert.equal(read?.effect, 'read');
  assert.ok(descriptors.every((d) => d.manifestDigest.length === 64), 'descriptors carry a content digest');
});

test('previously_failed and missing-connection entries are never supplied as authority', () => {
  const turn = turnWithResolution('provision-proof-2', LIVE_ENTRIES);
  const descriptors = admit.hostDescriptorsFromResolutionProof(turn.sessionId, turn.sourceUserSeq);
  assert.ok(!descriptors.some((d) => d.id.includes('firecrawl_scrape')), 'previously_failed is not proof');
  assert.ok(!descriptors.some((d) => d.id.includes('outlook')), 'a missing connection is not proof');
});

test('supply falls back to the latest prior authoritative proof; authority stays per-source', () => {
  // Ordering truth (live 2026-08-18 second breaker): admission runs before
  // this turn's resolver, so exact-source-only supply always came up empty
  // (ops=0). Descriptor SUPPLY may use the latest prior authoritative
  // resolution — citation candidates only. Call AUTHORITY
  // (provenComposioSlugForTurn) remains strictly per accepted source.
  const turn = turnWithResolution('provision-proof-3', LIVE_ENTRIES);
  const later = eventlog.appendEvent({
    sessionId: turn.sessionId, turn: 2, role: 'user',
    type: 'user_input_received', data: { text: 'and now something else' },
  });
  const supplied = admit.hostDescriptorsFromResolutionProof(turn.sessionId, later.seq);
  assert.equal(supplied.length, 3, 'prior proof is citable supply');
  // Same-session prior proof IS remap-eligible (live 2026-08-18 seqs
  // 58306/58040: a PROVEN slug bounced not_reachable on the continuation
  // turn because the remap demanded exact-source proof). Cross-session
  // remains forbidden.
  assert.deepEqual(
    resolution.provenComposioSlugForTurn({
      sessionId: turn.sessionId,
      sourceUserSeq: later.seq,
      requestedTarget: 'FIRECRAWL_SEARCH',
    }),
    { slug: 'FIRECRAWL_SEARCH' },
    'same-session prior proof carries the remap',
  );
  const other = eventlog.createSession({ id: 'provision-proof-other-session', kind: 'chat' });
  const otherSource = eventlog.appendEvent({
    sessionId: other.id, turn: 1, role: 'user',
    type: 'user_input_received', data: { text: 'unrelated' },
  });
  assert.equal(
    resolution.provenComposioSlugForTurn({
      sessionId: other.id,
      sourceUserSeq: otherSource.seq,
      requestedTarget: 'FIRECRAWL_SEARCH',
    }),
    null,
    'cross-session proof never remaps the carrier',
  );
});

test('the reader never supplies FUTURE proof, and a later source gets the fallback', () => {
  const session = eventlog.createSession({ id: 'provision-proof-4', kind: 'chat' });
  const early = eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'user',
    type: 'user_input_received', data: { text: 'first ask, before any resolution exists' },
  });
  assert.deepEqual(
    resolution.provenCapabilityEntriesForTurn({ sessionId: session.id, sourceUserSeq: early.seq }),
    [],
    'proof recorded after this source is not yet supply for it',
  );
  eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'system',
    type: 'capability_resolution',
    data: { sourceUserSeq: early.seq, authoritativeForTask: true, entries: LIVE_ENTRIES },
  });
  const entries = resolution.provenCapabilityEntriesForTurn({ sessionId: session.id, sourceUserSeq: early.seq });
  assert.equal(entries.length, 3, 'same-source proof is supply');
  const later = eventlog.appendEvent({
    sessionId: session.id, turn: 2, role: 'user',
    type: 'user_input_received', data: { text: 'second ask' },
  });
  assert.equal(
    resolution.provenCapabilityEntriesForTurn({ sessionId: session.id, sourceUserSeq: later.seq }).length,
    3,
    'the latest prior authoritative proof is supply for the next source',
  );
});

test('a fresh session follows its cross_session_prefix trail for supply', () => {
  // Live 2026-08-18 breaker 3: every Discord prompt opens a new session, so
  // within-session supply starved on turn one while the prior session held
  // proven entries the context builder was already carrying forward.
  const prior = turnWithResolution('provision-proof-prior', LIVE_ENTRIES);
  const fresh = eventlog.createSession({ id: 'provision-proof-fresh', kind: 'chat' });
  eventlog.appendEvent({
    sessionId: fresh.id, turn: 1, role: 'system',
    type: 'cross_session_prefix',
    data: { priorSessionIds: [prior.sessionId], sessionsIncluded: 1 },
  });
  const source = eventlog.appendEvent({
    sessionId: fresh.id, turn: 1, role: 'user',
    type: 'user_input_received', data: { text: 'next breaker ask' },
  });
  const supplied = resolution.provenCapabilityEntriesForTurn({
    sessionId: fresh.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(supplied.length, 3, 'linked prior-session proof is supply');
  // An unlinked fresh session still gets nothing — the host trail is the scope.
  const orphan = eventlog.createSession({ id: 'provision-proof-orphan', kind: 'chat' });
  const orphanSource = eventlog.appendEvent({
    sessionId: orphan.id, turn: 1, role: 'user',
    type: 'user_input_received', data: { text: 'unlinked ask' },
  });
  assert.deepEqual(resolution.provenCapabilityEntriesForTurn({
    sessionId: orphan.id,
    sourceUserSeq: orphanSource.seq,
  }), []);
});
