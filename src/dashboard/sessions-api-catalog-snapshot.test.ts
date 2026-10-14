/** Controlled catalog fixtures: presentation caching is request-local and
 * does not substitute a stale lineage for exact continuation/control reads. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-catalog-snapshot-'));
process.env.CLEMENTINE_HOME = fixtureHome;
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });
const log = await import('../runtime/harness/eventlog.js');
const { claimSessionForAcceptedSource, readAcceptedSourceConversationProjection } =
  await import('../runtime/harness/accepted-source-session-branch.js');
const { buildUnifiedSessionList, getUnifiedSessionDetail } = await import('./sessions-api.js');
test.after(() => { log.closeEventLog(); rmSync(fixtureHome, { recursive: true, force: true }); });

const continuity = { provider: 'desktop', scopeId: null, conversationId: 'catalog-stop-lineage', audienceId: 'catalog-owner' };
let serial = 0;
function accept(entrySessionId: string, identity = continuity) {
  const index = ++serial;
  return claimSessionForAcceptedSource({ kind: 'ordinary', entrySessionId, durableSourceId: `catalog-run-${index}`, continuity: identity,
    receipt: { requestId: `catalog-request-${index}`, runId: `catalog-run-${index}`, inputHash: String(index).padStart(64, '0') } }).selection;
}
function exchange(sessionId: string, request: string, reply: string, stop = false) {
  const source = log.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: request } });
  log.appendEvent({ sessionId, turn: 0, role: 'system', type: 'turn_model_routed', data: { sourceUserSeq: source.seq, agentName: 'Catalog Agent' } });
  log.appendEvent({ sessionId, turn: 0, role: 'system', type: 'deliverable_saved', data: { sourceUserSeq: source.seq, name: 'catalog.txt', dir: 'out' } });
  log.appendEvent({ sessionId, turn: 1, role: 'Clem', type: 'conversation_completed', data: { sourceUserSeq: source.seq, reply } });
  if (stop) log.updateSession(sessionId, { status: 'cancelled' });
}

test('search and preview validate a stopped lineage once and avoid decoration/full-state reads', () => {
  const root = log.createSession({ id: 'catalog-shared-root', kind: 'chat', channel: 'desktop', userId: continuity.audienceId,
    title: 'Shared stopped conversation', metadata: { source: 'desktop', channelId: continuity.conversationId,
      userId: continuity.audienceId, pinned: true, tags: ['catalog-lineage'], __conversation: { privateState: 'x'.repeat(100_000) } } });
  const ids: string[] = [];
  for (let index = 0; index < 3; index++) {
    const selected = accept(root.id);
    ids.push(selected.sessionId);
    exchange(selected.sessionId, `Catalog needle ${index}.`, `Catalog answer ${index}.`, index < 2);
  }
  const beforeBindings = log.openEventLog().prepare('SELECT * FROM accepted_source_session_bindings ORDER BY durable_source_digest').all();
  log.closeEventLog();
  const db = log.openEventLog();
  const prepare = db.prepare.bind(db);
  const identityReads: string[] = [];
  const fullStateReads: string[] = [];
  const eventReads: unknown[][] = [];
  const eventReadTypes: string[] = [];
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (sql.includes("json_object('ingressProvider'")) {
      const get = statement.get.bind(statement);
      statement.get = ((...args: unknown[]) => {
        if (ids.includes(String(args[0]))) identityReads.push(String(args[0]));
        return get(...args);
      }) as typeof statement.get;
    }
    if (/SELECT\s+\*\s+FROM\s+sessions\s+WHERE\s+id/i.test(sql)) fullStateReads.push(sql);
    const exactKeyRead = /SELECT \* FROM events NOT INDEXED\s+WHERE seq IN/.test(sql);
    if (/SELECT \* FROM events WHERE session_id/.test(sql) || exactKeyRead) {
      const all = statement.all.bind(statement);
      statement.all = ((...args: unknown[]) => {
        const rows = all(...args) as Array<{ type: string }>;
        if (ids.includes(String(exactKeyRead ? args[args.length - 1] : args[0]))) {
          eventReads.push(args);
          eventReadTypes.push(...rows.map(row => row.type));
        }
        return rows;
      }) as typeof statement.all;
    }
    return statement;
  }) as typeof db.prepare;
  try {
    const phases: string[] = [];
    const listed = buildUnifiedSessionList({ q: 'catalog needle', tag: 'catalog-lineage', source: 'desktop', limit: 100 },
      { observer: (phase) => { phases.push(phase); } });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.id, `harness:${root.id}`);
    assert.equal(listed[0]!.executionSessionId, ids[2]);
    assert.equal(listed[0]!.turnCount, 6);
    assert.equal(listed[0]!.preview, 'Catalog answer 2.');
    assert.equal(listed[0]!.pinned, true);
    assert.equal(identityReads.length, 0, 'identity comes from the list rows already held, without point reads');
    assert.equal(phases.filter(phase => phase === 'catalog_lineage').length, 1,
      'summary, search and preview reuse one principal-checked lineage projection');
    assert.equal(phases.filter(phase => phase === 'catalog_lineage_rows').length, 0);
    assert.equal(phases.filter(phase => phase === 'catalog_lineage_proofs').length, ids.length,
      'the pointer and each branched member still redeem their exact persisted selector proofs');
    assert.equal(fullStateReads.length, 0, 'list must not deserialize recovery/provider state per member');
    assert.equal(eventReads.length, 6, 'one public row query per member for search and preview, not three decoration queries');
    assert.ok(!eventReads.some(args => args.includes('turn_model_routed') || args.includes('deliverable_saved')));
    assert.ok(!eventReadTypes.some(type => type === 'turn_model_routed' || type === 'deliverable_saved'),
      'exact-key redemption does not load decoration payloads either');
    assert.deepEqual(db.prepare('SELECT * FROM accepted_source_session_bindings ORDER BY durable_source_digest').all(), beforeBindings);
  } finally { db.prepare = prepare; log.closeEventLog(); }

  const expectedProjection = { rootSessionId: root.id, headSessionId: ids[2]!, sessionIds: ids };
  const displayRows = log.listSessionRowsForDisplay();
  assert.ok(displayRows);
  const held = new Map(displayRows.map(row => [row.id, row]));
  assert.deepEqual(readAcceptedSourceConversationProjection(root.id, { rows: id => held.get(id) }), expectedProjection,
    'the held-row path validates every member of the same complete lineage');
  assert.deepEqual(readAcceptedSourceConversationProjection(root.id), expectedProjection,
    'detail/control readers without held rows still reopen the same persisted lineage');
  const detail = getUnifiedSessionDetail(`harness:${root.id}`)!;
  assert.equal(detail.turns.length, 6);
  assert.ok(detail.turns.some(turn => turn.agentName === 'Catalog Agent' && turn.files?.length), 'full history still has decoration');
  log.updateSession(ids[2]!, { status: 'cancelled' });
  const next = accept(root.id);
  exchange(next.sessionId, 'Catalog needle next.', 'New current head answer.');
  const fresh = buildUnifiedSessionList({ tag: 'catalog-lineage' });
  assert.equal(fresh[0]!.executionSessionId, next.sessionId, 'a new request observes the durable successor');
  assert.equal(fresh[0]!.turnCount, 8);
  assert.equal(fresh[0]!.preview, 'New current head answer.');
  assert.equal(getUnifiedSessionDetail(`harness:${root.id}`)!.continueHint?.streamUrl, `/api/sessions/${next.sessionId}/events`);
});

test('a later forged pointer invalidates presentation reuse; principal splits never join history', () => {
  const root = log.createSession({ id: 'catalog-corrupt-root', kind: 'chat', channel: 'desktop', userId: continuity.audienceId,
    title: 'Catalog isolated owner', metadata: { source: 'desktop', channelId: continuity.conversationId, userId: continuity.audienceId,
      tags: ['catalog-corrupt'] } });
  accept(root.id);
  exchange(root.id, 'Private owner catalog needle.', 'Private owner answer.', true);
  const split = accept(root.id, { ...continuity, audienceId: 'foreign-catalog-owner' });
  exchange(split.sessionId, 'Foreign catalog fixture.', 'Foreign catalog answer.');
  const child = accept(root.id);
  exchange(child.sessionId, 'Continue owner catalog needle.', 'Owner continuation answer.');
  assert.equal(buildUnifiedSessionList({ tag: 'catalog-corrupt', q: 'owner catalog needle' }).length, 1);
  const db = log.openEventLog();
  db.prepare('UPDATE sessions SET user_id = ? WHERE id = ?').run('foreign-catalog-owner', child.sessionId);
  const changedPrincipal = buildUnifiedSessionList({ tag: 'catalog-corrupt', includeArchived: true, limit: 500 })
    .find(row => row.id === `harness:${root.id}`)!;
  assert.equal(changedPrincipal.executionSessionId, undefined, 'a warmed row cache cannot retain the old principal');
  assert.equal(changedPrincipal.turnCount, 2);
  assert.equal(changedPrincipal.preview, 'Private owner answer.');
  db.prepare('UPDATE sessions SET user_id = ? WHERE id = ?').run(continuity.audienceId, child.sessionId);
  const restored = buildUnifiedSessionList({ tag: 'catalog-corrupt', includeArchived: true, limit: 500 })
    .find(row => row.id === `harness:${root.id}`)!;
  assert.equal(restored.executionSessionId, child.sessionId);
  assert.equal(restored.turnCount, 4, 'restoring the exact principal restores only that owner lineage');
  const forged = log.createSession({ id: 'catalog-forged-child', kind: 'chat', channel: 'desktop', userId: continuity.audienceId,
    metadata: { ...log.getSession(child.sessionId)!.metadata } });
  exchange(forged.id, 'Forged catalog fixture.', 'Forged catalog answer.');
  db.prepare('UPDATE accepted_source_session_pointers SET head_session_id = ? WHERE root_session_id = ?').run(forged.id, root.id);
  const listed = buildUnifiedSessionList({ includeArchived: true, limit: 500 });
  const owner = listed.find(row => row.id === `harness:${root.id}`)!;
  assert.equal(owner.executionSessionId, undefined, 'new request fails closed on the copied session-bound binding');
  assert.equal(owner.turnCount, 2);
  assert.equal(owner.preview, 'Private owner answer.');
  assert.equal(listed.find(row => row.id === `harness:${split.sessionId}`)?.preview, 'Foreign catalog answer.');
  assert.doesNotMatch(JSON.stringify(getUnifiedSessionDetail(`harness:${root.id}`)!.turns), /Foreign catalog|Forged catalog/);
});

test('indexed workflow grouping preserves principal boundaries, filters, pinned order and detail counts', () => {
  for (let run = 0; run < 8; run++) {
    for (const owner of ['a', 'b']) {
      for (let step = 0; step < 3; step++) {
        const row = log.createSession({ id: `catalog-flow-${run}-${owner}-${step}`, kind: 'workflow', channel: 'workflow', userId: owner,
          title: `Flow ${run} ${owner}::${step}`, metadata: { source: 'workflow', workflowName: `Flow ${run} ${owner}`,
            workflowRunId: `catalog-flow-run-${run}`, stepId: String(step),
            tags: [owner, `step-${step}`], pinned: run === 0 && owner === 'a' && step === 0,
            archived: run === 7, __conversation: { privateState: 'x'.repeat(1000) } } });
        exchange(row.id, `Workflow needle ${run} ${owner} ${step}.`, `Workflow answer ${run} ${owner} ${step}.`);
      }
    }
  }
  const listed = buildUnifiedSessionList({ source: 'workflow', q: 'workflow needle', limit: 500 });
  assert.equal(listed.length, 14, 'two archived principal groups are filtered out');
  assert.equal(listed[0]!.title, 'Flow 0 a');
  assert.equal(listed[0]!.pinned, true);
  for (const row of listed) {
    assert.equal(row.turnCount, 6);
    assert.equal(row.runSteps?.length, 3);
    const detail = getUnifiedSessionDetail(row.id)!;
    assert.equal(row.turnCount, detail.turns.length);
    assert.equal(row.preview, detail.session.preview);
    const owner = row.title.endsWith(' a') ? 'a' : 'b';
    assert.ok(detail.turns.every(turn => turn.text.includes(` ${owner} `)), 'same run id cannot borrow the other principal');
  }
  assert.equal(buildUnifiedSessionList({ source: 'workflow', tag: 'a', q: 'workflow needle', includeArchived: true }).length, 8);
  assert.equal(buildUnifiedSessionList({ source: 'workflow', q: 'workflow needle', includeArchived: true, limit: 2 }).length, 2);
});
