/** Catalog search retains the original public window/election. Fixtures are
 * process-private; no provider, installed server or live-home mutation. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-catalog-search-window-'));
process.env.CLEMENTINE_HOME = fixtureHome;
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });
const log = await import('../runtime/harness/eventlog.js');
const { SessionStore } = await import('../memory/session-store.js');
const { buildUnifiedSessionList, getUnifiedSessionDetail } = await import('./sessions-api.js');
const { reconstructHarnessTranscriptText, humanHarnessText } = await import('../runtime/harness/transcript.js');
const { publicUserInputText, PUBLIC_RUN_FAILURE_TEXT } = await import('../runtime/harness/public-presentation.js');
const { claimSessionForAcceptedSource, readAcceptedSourceConversationProjection } = await import('../runtime/harness/accepted-source-session-branch.js');
test.after(() => { log.closeEventLog(); rmSync(fixtureHome, { recursive: true, force: true }); });

type Summary = ReturnType<typeof buildUnifiedSessionList>[number];
const store = new SessionStore();
let serial = 0;
function accept(entrySessionId: string, conversationId: string, audienceId = 'search-owner') {
  const number = ++serial;
  return claimSessionForAcceptedSource({ kind: 'ordinary', entrySessionId, durableSourceId: `search-source-${number}`,
    continuity: { provider: 'desktop', scopeId: null, conversationId, audienceId },
    receipt: { requestId: `search-request-${number}`, runId: `search-source-${number}`, inputHash: String(number).padStart(64, '0') } }).selection;
}
function chat(id: string, tag = 'search-matrix', metadata: Record<string, unknown> = {}) {
  return log.createSession({ id, kind: 'chat', channel: 'desktop', userId: 'search-owner', title: `Controlled ${id}`,
    metadata: { source: 'desktop', channelId: id, userId: 'search-owner', tags: [tag], ...metadata } });
}
function emit(sessionId: string, type: Parameters<typeof log.appendEvent>[0]['type'], data: Record<string, unknown>,
  role: Parameters<typeof log.appendEvent>[0]['role'] = 'system', turn = 1) {
  return log.appendEvent({ sessionId, type, data, role, turn });
}
function exchange(sessionId: string, text: string, reply: string, turn = 1) {
  const source = emit(sessionId, 'user_input_received', { text }, 'user', turn);
  emit(sessionId, 'conversation_completed', { sourceUserSeq: source.seq, reply }, 'Clem', turn);
  return source;
}
function terminal(sessionId: string, sourceUserSeq: number, text: string, status: 'done' | 'cancelled' | 'needs_input' = 'done', approvalId?: string) {
  const outcomeId = `turn:${sourceUserSeq}`;
  const needs = status === 'needs_input' ? { kind: 'approval' } : undefined;
  return { terminalKey: outcomeId, sourceUserSeq, logicalTerminalVersion: 1,
    presentation: { version: 1, id: `${outcomeId}:presentation`, outcomeId, audience: 'user', phase: 'final',
      identity: { sessionId, turn: 1, sourceUserSeq }, status,
      kind: status === 'cancelled' ? 'stopped' : status === 'needs_input' ? 'approval' : 'answer', text,
      resumable: Boolean(needs), ...(needs ? { needs } : {}), ...(approvalId ? { approvalId } : {}) },
    turnOutcome: { version: 2, id: outcomeId, status, resumable: Boolean(needs), ...(needs ? { needs } : {}) }, reply: text };
}

// Reference uses the unchanged default projector/reader and the previous
// workflow election, not the new prefix/exact-row algorithm.
function originalSearchText(summary: Summary): string {
  let turns: Array<{ text: string; createdAt: string; seq?: number }>;
  const rawId = summary.id.slice(8);
  if (summary.store === 'desktop') {
    const record = store.get(rawId);
    turns = record.turns.map(turn => ({ ...turn, text: turn.role === 'assistant' ? humanHarnessText(turn.text, '') : turn.text.trim() }))
      .filter(turn => turn.text).slice(-20);
    return `${record.title ?? ''} ${turns.map(turn => turn.text).join(' ')}`.toLowerCase();
  }
  const row = log.getSession(rawId)!;
  if (summary.runSteps) {
    const members = log.listSessions({ status: 'any', limit: 500 })
      .filter(member => member.kind === 'workflow' && member.metadata.workflowRunId === row.metadata.workflowRunId && member.userId === row.userId);
    turns = members.flatMap(member => log.listEvents(member.id, { types: ['user_input_received', 'conversation_completed'], limit: 40 }))
      .flatMap(event => {
        const text = event.type === 'user_input_received'
          ? event.data.synthetic === true ? '' : publicUserInputText(event.data)
          : humanHarnessText(event.data, '');
        return text ? [{ text, createdAt: event.createdAt, seq: event.seq }] : [];
      }).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.seq! - right.seq!);
  } else {
    const conversation = readAcceptedSourceConversationProjection(row.id);
    turns = (conversation?.sessionIds ?? [row.id]).flatMap(id => reconstructHarnessTranscriptText(id, 40));
  }
  return `${summary.title ?? ''} ${turns.slice(-20).map(turn => turn.text).join(' ')}`.toLowerCase();
}
function authoritativeRows() {
  const db = log.openEventLog();
  return ['sessions', 'events', 'accepted_source_session_bindings', 'accepted_source_session_pointers']
    .map(table => db.prepare(`SELECT * FROM ${table}`).all());
}

const long = chat('search-long', 'search-matrix', { pinned: true });
for (let turn = 1; turn <= 90; turn++) exchange(long.id, `Owner long-window ${turn}.`, `Visible long-window answer ${turn}.`, turn);
const mixed = chat('search-mixed');
accept(mixed.id, mixed.id);
const stopped = emit(mixed.id, 'user_input_received', { text: 'Read mixed needle.' }, 'user');
emit(mixed.id, 'workflow_saved', { sourceUserSeq: stopped.seq, slug: 'mixed-fixture', name: 'Decoration-only secret', op: 'created', steps: [] });
log.appendConversationCheckIn({ source: stopped, text: 'Visible check-in needle.' });
emit(mixed.id, 'conversation_completed', terminal(mixed.id, stopped.seq,
  'Stopped.\n\nRetained work (durable checkpoint):\n- Source/tool read_file: completed result retained as rh_search_private.\nExternal write state: no settled external-write attempt is recorded.', 'cancelled'), 'Clem');
const recovered = emit(mixed.id, 'user_input_received', { text: 'Recover mixed needle.' }, 'user');
emit(mixed.id, 'conversation_completed', { reply: 'Superseded private apology.', reason: 'no_structured_output' }, 'Clem');
emit(mixed.id, 'conversation_superseded', { reason: 'recovered' });
emit(mixed.id, 'conversation_completed', terminal(mixed.id, recovered.seq, 'Recovered mixed needle.'), 'Clem');
const wrongSource = emit(mixed.id, 'user_input_received', { text: 'Preserve source binding.' }, 'user');
const wrong = emit(mixed.id, 'conversation_completed', { reply: 'Temporary corruption fixture.' }, 'Clem');
log.openEventLog().prepare('UPDATE events SET data_json = ? WHERE seq = ?').run(
  JSON.stringify(terminal('foreign-session', wrongSource.seq, 'Foreign typed secret.')), wrong.seq);
const approval = emit(mixed.id, 'user_input_received', { text: 'Ask before fixture action.' }, 'user');
emit(mixed.id, 'approval_requested', { approvalId: 'apr-search-fixture', preview: { ask: 'Can I do the controlled needle action?' } }, 'Clem');
emit(mixed.id, 'conversation_completed', terminal(mixed.id, approval.seq,
  'Approval required for fixture action. Review apr-search-fixture to continue.', 'needs_input', 'apr-search-fixture'), 'Clem');
const plan = emit(mixed.id, 'user_input_received', { text: 'Plan fixture needle.', taskMode: { version: 1, kind: 'plan' } }, 'user');
log.appendEvent({ sessionId: mixed.id, turn: 1, role: 'host', type: 'plan_revision_published', parentEventId: plan.id,
  data: { sourceUserSeq: plan.seq, readiness: 'ready', planArtifactRef: { planId: 'plan-search-fixture', revision: 1, digest: 'a'.repeat(64) } } });
const synthetic = emit(mixed.id, 'user_input_received', { text: 'Synthetic private directive.', synthetic: true }, 'user');
emit(mixed.id, 'conversation_completed', { sourceUserSeq: synthetic.seq, reply: PUBLIC_RUN_FAILURE_TEXT }, 'Clem');
emit(mixed.id, 'clem_message', { text: 'A standalone needle message.' }, 'Clem');
emit(mixed.id, 'deliverable_saved', { sourceUserSeq: stopped.seq, name: 'Secret-decoration-name.txt', dir: 'out' });
const archived = chat('search-archived', 'search-matrix', { archived: true });
exchange(archived.id, 'Archived needle.', 'Archived public answer.');
const empty = chat('search-empty');
for (const owner of ['search-owner', 'foreign-owner']) for (let step = 0; step < 3; step++) {
  const row = log.createSession({ id: `search-flow-${owner}-${step}`, kind: 'workflow', channel: 'workflow', userId: owner,
    title: `Controlled workflow ${owner}::${step}`, metadata: { source: 'workflow', workflowRunId: 'search-flow-shared',
      workflowName: `Controlled workflow ${owner}`, stepId: String(step), tags: ['search-matrix'] } });
  for (let turn = 1; turn <= 35; turn++) exchange(row.id, `Workflow ${owner} needle ${step} ${turn}.`, `Workflow ${owner} answer ${step} ${turn}.`, turn);
}
log.openEventLog().prepare("UPDATE events SET created_at = ? WHERE session_id LIKE 'search-flow-%'").run('2026-10-11T00:00:00Z');
store.appendTurn('search-desktop', { role: 'user', text: 'Controlled desktop fixture', createdAt: '2026-10-11T00:00:00Z' });
for (let turn = 1; turn <= 30; turn++) store.appendTurn('search-desktop', { role: 'assistant', text: `Desktop needle ${turn}.`, createdAt: `2026-10-11T00:00:${String(turn).padStart(2, '0')}Z` });

test('full catalog results/order/limits equal the original public search across chat/workflow/desktop windows', () => {
  const before = authoritativeRows();
  for (const query of [
    { q: ' needle ', includeArchived: true, limit: 500 }, { q: 'LONG-WINDOW ANSWER 15', limit: 1 },
    { q: 'answer 75', includeArchived: true }, { q: 'rh_search_private' }, { q: 'foreign typed secret' },
    { q: 'superseded private apology' }, { q: 'synthetic private directive' }, { q: 'decoration-only secret' },
    { q: 'controlled needle action', tag: 'search-matrix' }, { q: 'plan ready for review', source: 'desktop' },
    { q: 'needle', source: 'workflow', limit: 2 }, { q: 'workflow foreign-owner', source: 'workflow' },
    { q: 'archived needle', includeArchived: false }, { q: 'archived needle', includeArchived: true },
    { q: 'desktop needle 30', source: 'desktop', limit: 0 }, { q: 'controlled', limit: -1 },
  ]) {
    const baseline = buildUnifiedSessionList({ ...query, q: undefined, limit: 500 });
    const needle = query.q.trim().toLowerCase();
    const limit = Math.max(1, Math.min(500, Math.trunc(query.limit ?? 100)));
    const expected = baseline.filter(summary => summary.title.toLowerCase().includes(needle) || originalSearchText(summary).includes(needle)).slice(0, limit);
    assert.deepEqual(buildUnifiedSessionList(query), expected, JSON.stringify(query));
  }
  assert.deepEqual(authoritativeRows(), before, 'search grants no control/effect authority and writes no state');
  assert.equal(buildUnifiedSessionList({ tag: 'search-matrix', q: 'answer 75' }).length, 0, 'oldest40 window cannot silently become newest40');
});

test('selected raw windows are equivalent, with covering prefixes and exact primary-key payload seeks', (t) => {
  log.closeEventLog();
  const db = log.openEventLog();
  const prepare = db.prepare.bind(db);
  let prefixCalls = 0; let finalCalls = 0;
  const selections = new Map<string, { types: string[]; limit: number }>();
  const observedPlans: { prefix: string[]; redemption: string[] } = { prefix: [], redemption: [] };
  const eventSchema = db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string; type: string; pk: number }>;
  assert.ok(eventSchema.some(column => column.name === 'seq' && column.type === 'INTEGER' && column.pk === 1),
    'global integer primary-key ordering has no sequence ties');
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (/SELECT seq FROM events INDEXED BY idx_events_session_type/.test(sql)) {
      const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(long.id, 'user_input_received', 40) as Array<{ detail: string }>;
      observedPlans.prefix = plan.map(row => row.detail);
      assert.ok(plan.some(row => /COVERING INDEX idx_events_session_type/.test(row.detail)), JSON.stringify(plan));
      assert.ok(!plan.some(row => /TEMP B-TREE/.test(row.detail)), 'prefix ordering is served by the existing index');
      const all = statement.all.bind(statement);
      statement.all = ((...args: unknown[]) => {
        prefixCalls++;
        const selection = selections.get(String(args[0])) ?? { types: [], limit: Number(args[2]) };
        selection.types.push(String(args[1])); selections.set(String(args[0]), selection);
        const rows = all(...args) as unknown[]; assert.ok(rows.length <= 40); return rows;
      }) as typeof statement.all;
    }
    if (/SELECT \* FROM events NOT INDEXED\s+WHERE seq IN/.test(sql)) {
      const all = statement.all.bind(statement);
      statement.all = ((...args: unknown[]) => {
        finalCalls++;
        const sessionId = String(args[args.length - 1]);
        const selectedSequences = args.slice(0, -1).map(Number);
        const selection = selections.get(sessionId)!;
        assert.ok(selection, 'every redemption follows sequence discovery for its own session');
        const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>;
        observedPlans.redemption = plan.map(row => row.detail);
        assert.ok(plan.some(row => /SEARCH events USING INTEGER PRIMARY KEY \(rowid=\?\)/.test(row.detail)), JSON.stringify(plan));
        assert.ok(!plan.some(row => /SCAN events|idx_events_session_seq|TEMP B-TREE/.test(row.detail)),
          'selected payloads use exact rowid seeks without a sparse session scan or sort');
        const actual = all(...args) as unknown[];
        const expected = prepare(`SELECT * FROM events WHERE session_id = ? AND type IN (${selection.types.map(() => '?').join(',')})
          ORDER BY seq ASC LIMIT ?`).all(sessionId, ...selection.types, selection.limit) as Array<{ seq: number }>;
        assert.deepEqual(selectedSequences, expected.map(row => row.seq), 'discovery selects exactly the original oldest40 keys');
        assert.deepEqual(actual, expected, 'only the exact original first40 payloads reach JSON decoding');
        assert.ok(actual.length <= 40);
        selections.delete(sessionId);
        return actual;
      }) as typeof statement.all;
    }
    return statement;
  }) as typeof db.prepare;
  try {
    const rows = buildUnifiedSessionList({ tag: 'search-matrix', q: 'needle', includeArchived: true, limit: 500 });
    assert.ok(rows.length >= 4);
    assert.ok(prefixCalls >= 8); assert.ok(finalCalls >= 4);
    t.diagnostic(JSON.stringify({ sourceOnlyQueryPlans: observedPlans }));
  } finally { db.prepare = prepare; log.closeEventLog(); }
});

test('exact row redemption sorts selected keys, excludes foreign sessions, and does not decode unselected payloads', () => {
  const owner = chat('search-exact-owner', 'search-exact');
  const foreign = chat('search-exact-foreign', 'search-exact');
  const first = emit(owner.id, 'clem_message', { text: 'First selected text.' }, 'Clem');
  const unread = emit(owner.id, 'clem_message', { text: 'Unselected corrupt text.' }, 'Clem');
  const foreignEvent = emit(foreign.id, 'clem_message', { text: 'Foreign corrupt text.' }, 'Clem');
  const second = emit(owner.id, 'clem_message', { text: 'Second selected text.' }, 'Clem');
  const db = log.openEventLog();
  db.prepare('UPDATE events SET data_json = ? WHERE seq IN (?, ?)').run('{invalid', unread.seq, foreignEvent.seq);
  assert.deepEqual(log.listEventsAtSequences(owner.id, [second.seq, foreignEvent.seq, first.seq, second.seq]), [first, second]);
  assert.deepEqual(log.listEventsAtSequences(owner.id, []), []);
  assert.deepEqual(log.listEventsAtSequences('absent-session', [first.seq]), []);
  for (const keys of [[0], [-1], [Number.MAX_SAFE_INTEGER + 1], [first.seq + 0.5], Array.from({ length: 41 }, () => first.seq)]) {
    assert.throws(() => log.listEventsAtSequences(owner.id, keys), /at most 40 positive sequence keys/);
  }
  assert.throws(() => log.listEventsAtSequences(owner.id, [unread.seq]), SyntaxError,
    'a selected malformed payload is not hidden by a SQL JSON filter');
  db.prepare('UPDATE events SET data_json = ? WHERE seq = ?').run(JSON.stringify(unread.data), unread.seq);
  db.prepare('UPDATE events SET data_json = ? WHERE seq = ?').run(JSON.stringify(foreignEvent.data), foreignEvent.seq);
});

test('a sparse public window still selects oldest40 without decoding intervening private payloads', () => {
  const row = chat('search-sparse-window', 'search-sparse');
  const db = log.openEventLog();
  const insert = db.prepare(`INSERT INTO events (id, session_id, turn, role, type, parent_event_id, data_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (let turn = 1; turn <= 24; turn++) {
      exchange(row.id, `Sparse public ${turn}.`, `Sparse public answer ${turn}.`, turn);
      for (let noise = 0; noise < 64; noise++) insert.run(`sparse-private-${turn}-${noise}`, row.id, turn,
        'system', 'model_resilience_observed', null, '{invalid-private', '2026-10-11T00:00:00Z');
    }
  })();
  const expected = originalSearchText(buildUnifiedSessionList({ tag: 'search-sparse' })[0]!);
  assert.ok(expected.includes('sparse public answer 20.'));
  assert.ok(!expected.includes('sparse public answer 21.'));
  assert.equal(buildUnifiedSessionList({ tag: 'search-sparse', q: 'sparse public answer 20.' }).length, 1);
  assert.equal(buildUnifiedSessionList({ tag: 'search-sparse', q: 'sparse public answer 21.' }).length, 0);
  assert.equal(buildUnifiedSessionList({ tag: 'search-sparse', q: 'invalid-private' }).length, 0);
});

test('malformed payload outside the old window remains unread; malformed payload inside still throws', () => {
  const row = chat('search-corrupt-window', 'search-corrupt');
  for (let turn = 1; turn <= 20; turn++) exchange(row.id, `Early public ${turn}.`, `Early answer ${turn}.`, turn);
  const late = emit(row.id, 'clem_message', { text: 'Late fixture.' }, 'Clem');
  const db = log.openEventLog();
  db.prepare('UPDATE events SET data_json = ? WHERE seq = ?').run('{invalid', late.seq);
  assert.doesNotThrow(() => reconstructHarnessTranscriptText(row.id, 40));
  assert.deepEqual(buildUnifiedSessionList({ tag: 'search-corrupt', q: 'absent needle' }), []);
  const first = log.listEvents(row.id, { limit: 1 })[0]!;
  db.prepare('UPDATE events SET data_json = ? WHERE seq = ?').run('{invalid', first.seq);
  assert.throws(() => reconstructHarnessTranscriptText(row.id, 40), SyntaxError);
  assert.throws(() => buildUnifiedSessionList({ tag: 'search-corrupt', q: 'absent needle' }), SyntaxError);
  db.prepare('UPDATE events SET data_json = ? WHERE seq = ?').run(JSON.stringify(first.data), first.seq);
  db.prepare('UPDATE events SET data_json = ? WHERE seq = ?').run(JSON.stringify(late.data), late.seq);
});

test('optional index unavailable falls back to the same original search and error behavior', () => {
  const query = { tag: 'search-matrix', q: 'needle', includeArchived: true, limit: 500 };
  const expected = buildUnifiedSessionList(query);
  const malformed = chat('search-fallback-corrupt', 'search-fallback-corrupt');
  const source = exchange(malformed.id, 'Fallback malformed source.', 'Fallback answer.');
  const malformedQuery = { tag: 'search-fallback-corrupt', q: 'absent phrase' };
  const db = log.openEventLog();
  db.prepare('UPDATE events SET data_json = ? WHERE seq = ?').run('{invalid', source.seq);
  db.exec('DROP INDEX idx_events_session_type');
  try {
    assert.deepEqual(buildUnifiedSessionList(query), expected);
    assert.throws(() => buildUnifiedSessionList(malformedQuery), SyntaxError);
  } finally {
    db.exec('CREATE INDEX idx_events_session_type ON events(session_id, type)');
    db.prepare('UPDATE events SET data_json = ? WHERE seq = ?').run(JSON.stringify(source.data), source.seq);
  }
});

test('a concurrent connection cannot change the prefix/payload read snapshot', () => {
  const row = chat('search-snapshot-race', 'search-race');
  const source = exchange(row.id, 'Original race needle.', 'Original race answer.');
  log.closeEventLog();
  const db = log.openEventLog(); const prepare = db.prepare.bind(db);
  const writer = new Database(db.name);
  let injected = false;
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (/SELECT seq FROM events INDEXED BY idx_events_session_type/.test(sql)) {
      const all = statement.all.bind(statement);
      statement.all = ((...args: unknown[]) => {
        const result = all(...args);
        if (!injected && args[0] === row.id) {
          injected = true;
          writer.prepare('UPDATE events SET data_json = ? WHERE seq = ?').run(
            JSON.stringify({ text: 'Concurrent rewritten source.' }), source.seq);
          writer.prepare('DELETE FROM events WHERE session_id = ? AND seq != ?').run(row.id, source.seq);
          writer.prepare(`INSERT INTO events (id, session_id, turn, role, type, parent_event_id, data_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('race-concurrent-event', row.id, 2, 'Clem', 'clem_message', null,
              JSON.stringify({ text: 'Concurrent replacement phrase.' }), '2026-10-11T00:00:00Z');
        }
        return result;
      }) as typeof statement.all;
    }
    if (/SELECT \* FROM events NOT INDEXED\s+WHERE seq IN/.test(sql)) {
      const all = statement.all.bind(statement);
      statement.all = ((...args: unknown[]) => {
        const result = all(...args) as Array<{ data_json: string }>;
        if (args[args.length - 1] === row.id) {
          assert.equal(result.length, 2, 'the deleted completion remains in the original read snapshot');
          assert.ok(result.some(event => event.data_json.includes('Original race needle')));
          assert.ok(result.some(event => event.data_json.includes('Original race answer')));
          assert.ok(!result.some(event => /Concurrent replacement|Concurrent rewritten/.test(event.data_json)));
        }
        return result;
      }) as typeof statement.all;
    }
    return statement;
  }) as typeof db.prepare;
  try {
    assert.equal(buildUnifiedSessionList({ tag: 'search-race', q: 'concurrent replacement phrase' }).length, 0,
      'search uses the single original read snapshot, not a mixed window');
    assert.equal(injected, true);
  } finally { db.prepare = prepare; writer.close(); log.closeEventLog(); }
  assert.equal(buildUnifiedSessionList({ tag: 'search-race', q: 'concurrent replacement phrase' }).length, 1,
    'the next request sees the committed replacement');
  assert.equal(buildUnifiedSessionList({ tag: 'search-race', q: 'concurrent rewritten source' }).length, 1,
    'the next request also observes the repaired existing source payload');
});

test('new requests observe Stop successors and reject forged or foreign lineage instead of caching search', () => {
  const root = chat('search-stop-root', 'search-stop');
  const rootSelection = accept(root.id, root.id);
  exchange(rootSelection.sessionId, 'Root retained needle.', 'Root stopped answer.');
  log.updateSession(rootSelection.sessionId, { status: 'cancelled' });
  const head = accept(root.id, root.id);
  exchange(head.sessionId, 'Current branch needle.', 'Current branch answer.');
  const before = buildUnifiedSessionList({ tag: 'search-stop', q: 'current branch needle' });
  assert.equal(before.length, 1); assert.equal(before[0]!.id, `harness:${root.id}`);
  assert.equal(before[0]!.executionSessionId, head.sessionId);
  log.updateSession(head.sessionId, { status: 'cancelled' });
  const successor = accept(root.id, root.id);
  exchange(successor.sessionId, 'Next branch unique needle.', 'Next branch answer.');
  const next = buildUnifiedSessionList({ tag: 'search-stop', q: 'next branch unique needle' });
  assert.equal(next.length, 1); assert.equal(next[0]!.executionSessionId, successor.sessionId);
  assert.equal(next[0]!.turnCount, 6);
  assert.equal(getUnifiedSessionDetail(`harness:${root.id}`)!.continueHint?.streamUrl, `/api/sessions/${successor.sessionId}/events`);
  const split = accept(root.id, root.id, 'foreign-owner');
  exchange(split.sessionId, 'Foreign private search phrase.', 'Foreign split answer.');
  assert.ok(!originalSearchText(next[0]!).includes('foreign private search phrase'));
  const forged = chat('search-forged-head', 'search-stop', log.getSession(successor.sessionId)!.metadata);
  exchange(forged.id, 'Forged private search phrase.', 'Forged answer.');
  log.openEventLog().prepare('UPDATE accepted_source_session_pointers SET head_session_id = ? WHERE root_session_id = ? AND head_session_id = ?')
    .run(forged.id, root.id, successor.sessionId);
  const isolated = buildUnifiedSessionList({ tag: 'search-stop', q: 'root retained needle', includeArchived: true });
  const owner = isolated.find(summary => summary.id === `harness:${root.id}`)!;
  assert.equal(owner.executionSessionId, undefined); assert.equal(owner.turnCount, 2);
  assert.doesNotMatch(JSON.stringify(getUnifiedSessionDetail(owner.id)!.turns), /Foreign private|Forged private|Current branch|Next branch/);
});

test('default and title-only paths perform no prefix searches; empty catalogs have no fabricated matches', () => {
  log.closeEventLog(); const db = log.openEventLog(); const prepare = db.prepare.bind(db);
  let prefixCalls = 0;
  db.prepare = ((sql: string) => { if (/SELECT seq FROM events INDEXED BY idx_events_session_type/.test(sql)) prefixCalls++; return prepare(sql); }) as typeof db.prepare;
  try {
    assert.equal(buildUnifiedSessionList({ tag: 'missing-controlled-tag' }).length, 0);
    const defaultEmpty = buildUnifiedSessionList({ q: undefined, tag: 'search-matrix' });
    assert.ok(defaultEmpty.length > 0); assert.equal(prefixCalls, 0);
    assert.equal(buildUnifiedSessionList({ q: empty.title!, tag: 'search-matrix' }).filter(summary => summary.id === `harness:${empty.id}`).length, 1);
    // A unique tag isolates the title-fast-path from other candidates.
    log.updateSession(empty.id, { metadata: { ...empty.metadata, tags: ['search-title-only'] } });
    prefixCalls = 0;
    assert.equal(buildUnifiedSessionList({ q: empty.title!, tag: 'search-title-only' }).length, 1);
    assert.equal(prefixCalls, 0);
  } finally { db.prepare = prepare; log.closeEventLog(); }
});
