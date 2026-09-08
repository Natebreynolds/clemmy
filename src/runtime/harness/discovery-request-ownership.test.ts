import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-discovery-request-'));
process.env.CLEMENTINE_HOME = home;
const log = await import('./eventlog.js');
const { discoveryGovernor } = await import('./discovery-governor.js');
const { admitDiscoveryBoundary, settleDiscoveryBoundary, exactDiscoveryRequestDigest } = await import('./discovery-boundary.js');

test.after(() => { log.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

function accepted(label: string, legacy = false) {
  const session = log.createSession({ id: `request-ownership-${label}`, kind: 'chat' });
  const source = log.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: label } });
  const key = { sessionId: session.id, sourceUserSeq: source.seq };
  discoveryGovernor.initializeTask({ ...key, knownCapability: false, ...(!legacy ? { claimKeyVersion: 'exact_request_v1' as const } : {}) });
  return key;
}

function input(key: ReturnType<typeof accepted>, callId: string, query: string, extra: Record<string, unknown> = {}) {
  return { ...key, callId, toolName: 'tool_search', input: { query, ...extra } };
}

test('independent plain queries have concurrent exact owners without English role membership', () => {
  const key = accepted('parallel');
  const a = admitDiscoveryBoundary(input(key, 'a', 'create a static workspace'));
  const b = admitDiscoveryBoundary(input(key, 'b', 'inspect an unrelated document format'));
  assert.ok(a && b);
  assert.notEqual(a.subject, b.subject);
  assert.match(a.subject, /^request:[a-f0-9]{64}$/);
  assert.equal('advisory' in a, false);
  assert.equal(discoveryGovernor.getTaskState(key)?.roles.length, 0);
  assert.throws(() => admitDiscoveryBoundary(input(key, 'duplicate-a', 'create a static workspace')), /new_call_requires_retry_epoch/);
  assert.throws(() => admitDiscoveryBoundary(input(key, 'a', 'different text cannot reuse this call')), /same_call_replay/);
  assert.equal(discoveryGovernor.getTaskState(key)?.allClaims.filter((claim) => claim.outcome === 'pending').length, 2);
});

test('role annotations cannot change exact request identity or create another in-flight call', () => {
  const key = accepted('annotations');
  const plain = input(key, 'first', 'create a static workspace', { account_selection: null });
  assert.ok(admitDiscoveryBoundary(plain));
  const polluted = input(key, 'second', '[role:clause-0:write] create a static workspace', { account_selection: null, role_key: 'made-up-role' });
  assert.equal(exactDiscoveryRequestDigest(plain.toolName, plain.input), exactDiscoveryRequestDigest(polluted.toolName, polluted.input));
  assert.equal(exactDiscoveryRequestDigest('ToolSearch', polluted.input), exactDiscoveryRequestDigest(plain.toolName, plain.input));
  assert.throws(() => admitDiscoveryBoundary(polluted), /new_call_requires_retry_epoch/);
});

test('settled continuation and restart retain every prior call identity and reject changed-byte replay', () => {
  const key = accepted('reopen');
  const first = admitDiscoveryBoundary(input(key, 'first', 'create workspace'))!;
  settleDiscoveryBoundary(first, 'succeeded');
  const next = admitDiscoveryBoundary(input(key, 'next', 'create workspace'))!;
  assert.ok(next);
  settleDiscoveryBoundary(next, 'succeeded');
  log.closeEventLog();
  assert.throws(() => admitDiscoveryBoundary(input(key, 'first', 'create workspace')), /same_call_replay/);
  assert.throws(() => admitDiscoveryBoundary(input(key, 'first', 'completely different operation')), /same_call_replay/);
  assert.ok(admitDiscoveryBoundary(input(key, 'third', 'create workspace')));
});

test('same call text and call ID remain isolated by exact accepted source and account request', () => {
  const a = accepted('source-a');
  const b = accepted('source-b');
  assert.ok(admitDiscoveryBoundary(input(a, 'same', 'search records', { account_selection: { identity: 'account-a' } })));
  assert.ok(admitDiscoveryBoundary(input(b, 'same', 'search records', { account_selection: { identity: 'account-a' } })));
  assert.ok(admitDiscoveryBoundary(input(a, 'account-b', 'search records', { account_selection: { identity: 'account-b' } })));
  assert.throws(() => discoveryGovernor.initializeTask({ ...a, sourceUserSeq: b.sourceUserSeq, knownCapability: false }), /not an accepted user task/);
});

test('new strategy refuses missing exact identity and never freezes advisory clause requirements', () => {
  const key = accepted('no-grammar');
  const initialized = discoveryGovernor.initializeRoles({ ...key, brokerCoverage: 'authorized_external_v1', requirements: [
    { roleKey: 'clause-2:read', clauseIndex: 2, text: 'Include the same content in its mobile view', resolved: false },
  ] });
  assert.deepEqual(initialized.roles, []);
  assert.equal(initialized.policy.roleScoped, false);
  assert.equal(discoveryGovernor.admit({ ...key, callId: 'missing', category: 'broad_discovery' }).reason, 'request_identity_required');
});

test('a new evidence epoch cannot steal a still-pending exact request owner', () => {
  const key = accepted('pending-across-epochs');
  assert.ok(admitDiscoveryBoundary(input(key, 'old-owner', 'inspect the selected schema')));
  discoveryGovernor.recordEvidence({ ...key, kind: 'catalog_revision_changed', detail: 'host_observed_new_catalog' });
  assert.ok((discoveryGovernor.getTaskState(key)?.policy.epoch ?? 0) > 0);
  assert.throws(() => admitDiscoveryBoundary(input(key, 'new-owner', 'inspect the selected schema')), /new_call_requires_retry_epoch/);
});

test('actual reworded searches and role changes cannot replenish no-progress after the same public result', async () => {
  const { projectHostNoProgressAuthority } = await import('./host-no-progress-projection.js');
  const { initializeNoProgressGovernor, observeNoProgress, NO_PROGRESS_RETRY_BUDGET } = await import('./no-progress-governor.js');
  const key = accepted('mobile-plan-rewording');
  const baseline = projectHostNoProgressAuthority(key);
  assert.equal(baseline.status, 'ok');
  if (baseline.status !== 'ok') return;
  let state = initializeNoProgressGovernor({ taskKey: `${key.sessionId}#${key.sourceUserSeq}`, authority: baseline.authority });
  const queries = [
    'create a simple static Space with slug and display content',
    'Space mobile view rendering',
    'create new Workspace Space with slug and static view',
    'create Space workspace slug title static view content no data sources',
    'create a native static workspace with the same mobile display',
  ];
  let priorAuthority: unknown;
  for (let index = 0; index <= NO_PROGRESS_RETRY_BUDGET + 1; index += 1) {
    const callId = `mobile-query-${index}`;
    const lease = admitDiscoveryBoundary(input(key, callId, queries[index]!, { role_key: `clause-${index}:read` }));
    assert.ok(lease);
    const capabilityRef = 'cap:exact:unchanged-candidate';
    log.appendEvent({ sessionId: key.sessionId, turn: 1, role: 'system', type: 'capability_discovered', data: {
      sourceUserSeq: key.sourceUserSeq, capabilities: [{ capabilityRef, descriptor: { id: capabilityRef, effect: 'read' } }],
    } });
    log.writeToolOutput({ sessionId: key.sessionId, callId, tool: 'tool_search', output: JSON.stringify({ query: queries[index], results: [{ capabilityRef }] }) });
    settleDiscoveryBoundary(lease, 'succeeded');
    const projected = projectHostNoProgressAuthority(key);
    assert.equal(projected.status, 'ok');
    if (projected.status !== 'ok') return;
    const decision = observeNoProgress(state, { taskKey: state.taskKey, attemptClass: 'authority_acquisition', authority: projected.authority });
    if (index === 0) assert.equal(decision.reason, 'authority_progress');
    else {
      assert.deepEqual(projected.authority, priorAuthority, 'neither changed query nor changed role is new capability evidence');
      assert.notEqual(decision.reason, 'authority_progress');
    }
    priorAuthority = projected.authority;
    state = decision.state;
    if (index === NO_PROGRESS_RETRY_BUDGET + 1) assert.equal(decision.action, 'terminalize');
  }
});

test('already-started sources preserve the old role policy, pending owner and settlement across reopen', () => {
  const key = accepted('legacy', true);
  discoveryGovernor.initializeRoles({ ...key, brokerCoverage: 'authorized_external_v1', requirements: [
    { roleKey: 'clause-0:write', clauseIndex: 0, text: 'create workspace', resolved: false },
  ] });
  const first = admitDiscoveryBoundary(input(key, 'legacy-first', 'create workspace', { role_key: 'clause-0:write' }))!;
  assert.equal(first.subject, 'clause-0:write');
  log.closeEventLog();
  const reopened = discoveryGovernor.initializeTask({ ...key, knownCapability: false, claimKeyVersion: 'exact_request_v1' });
  assert.equal(reopened.policy.claimKeyVersion, 'legacy');
  assert.throws(() => admitDiscoveryBoundary(input(key, 'legacy-second', 'reworded', { role_key: 'clause-0:write' })), /new_call_requires_retry_epoch/);
  settleDiscoveryBoundary(first, 'succeeded');
  assert.ok(admitDiscoveryBoundary(input(key, 'legacy-third', 'reworded', { role_key: 'clause-0:write' })));
});

test('canonical request encoding preserves account/source quote bytes and rejects accessor/non-JSON data', () => {
  assert.equal(exactDiscoveryRequestDigest('tool_search', { query: 'a', limit: 8 }), exactDiscoveryRequestDigest('tool_search', { limit: 8, query: 'a' }));
  assert.notEqual(exactDiscoveryRequestDigest('tool_search', { query: 'a', account_selection: { source_quote: ' A' } }), exactDiscoveryRequestDigest('tool_search', { query: 'a', account_selection: { source_quote: 'A' } }));
  const getter = Object.defineProperty({}, 'query', { enumerable: true, get() { throw new Error('must not run'); } });
  assert.throws(() => exactDiscoveryRequestDigest('tool_search', getter), /accessor/i);
  assert.throws(() => exactDiscoveryRequestDigest('tool_search', { query: 'a', limit: NaN }), /finite/i);
});

test('v80 migration leaves historical task and pending claim ownership byte-identical', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { applyHarnessMigrationsThroughVersionForTests, applyHarnessMigrations } = await import('./eventlog-schema.js');
  const db = new Database(':memory:');
  try {
    applyHarnessMigrationsThroughVersionForTests(db, 79);
    db.pragma('foreign_keys = OFF');
    db.prepare(`INSERT INTO discovery_governor_tasks
      (session_id, source_user_seq, known_capability, initialized_at, updated_at)
      VALUES ('historical', 7, 0, 'before', 'before')`).run();
    db.prepare(`INSERT INTO discovery_governor_claims
      (session_id, source_user_seq, category, call_id, outcome, admitted_at)
      VALUES ('historical', 7, 'broad_discovery', 'pending-owner', 'pending', 'before')`).run();
    const before = db.prepare('SELECT * FROM discovery_governor_claims').all();
    applyHarnessMigrations(db);
    assert.deepEqual(db.prepare('SELECT * FROM discovery_governor_claims').all(), before);
    assert.equal((db.prepare('SELECT claim_key_version FROM discovery_governor_tasks').get() as { claim_key_version: number }).claim_key_version, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM discovery_governor_request_calls').get() as { n: number }).n, 0);
  } finally { db.close(); }
});
