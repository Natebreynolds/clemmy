/** Catalog previews/search must elect exactly the same public words and turn
 * count as detailed history, without loading unrelated card/agent payloads. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-catalog-transcript-'));
process.env.CLEMENTINE_HOME = fixtureHome;
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });
const log = await import('./eventlog.js');
const { reconstructHarnessTranscript, reconstructHarnessTranscriptText } = await import('./transcript.js');
const { PUBLIC_RUN_FAILURE_TEXT } = await import('./public-presentation.js');
test.after(() => { log.closeEventLog(); rmSync(fixtureHome, { recursive: true, force: true }); });

function terminal(sessionId: string, sourceUserSeq: number, text: string,
  status: 'done' | 'cancelled' | 'needs_input' = 'done', approvalId?: string, attemptId?: string) {
  const outcomeId = attemptId ? `brain:${attemptId}` : `turn:${sourceUserSeq}`;
  const needs = status === 'needs_input' ? { kind: 'approval' } : undefined;
  return { terminalKey: outcomeId, sourceUserSeq, ...(attemptId ? { attemptId } : { logicalTerminalVersion: 1 }),
    presentation: { version: 1, id: `${outcomeId}:presentation`, outcomeId, audience: 'user', phase: 'final',
      identity: { sessionId, turn: 1, sourceUserSeq, ...(attemptId ? { attemptId } : {}) }, status,
      kind: status === 'cancelled' ? 'stopped' : status === 'needs_input' ? 'approval' : 'answer',
      text, resumable: Boolean(needs), ...(needs ? { needs } : {}), ...(approvalId ? { approvalId } : {}) },
    turnOutcome: { version: 2, id: outcomeId, status, resumable: Boolean(needs), ...(needs ? { needs } : {}) }, reply: text };
}

function mixedTranscript() {
  const session = log.createSession({ kind: 'chat', title: 'Catalog projection parity' });
  const sid = session.id;
  const emit = (type: Parameters<typeof log.appendEvent>[0]['type'], data: Record<string, unknown>, role: Parameters<typeof log.appendEvent>[0]['role'] = 'system', parentEventId?: string) =>
    log.appendEvent({ sessionId: sid, turn: 1, role, type, data, ...(parentEventId ? { parentEventId } : {}) });
  const first = emit('user_input_received', { text: 'Read the controlled fixture.' }, 'user');
  // Routing and file decorations must not occupy the main visible row window.
  emit('turn_model_routed', { sourceUserSeq: first.seq, agentName: 'Fixture Agent', projectName: 'Fixture Project' });
  emit('deliverable_saved', { sourceUserSeq: first.seq, name: 'fixture.txt', dir: 'out' });
  emit('workflow_saved', { sourceUserSeq: first.seq, slug: 'catalog-fixture', name: 'Catalog Fixture', op: 'created', steps: [] });
  log.appendConversationCheckIn({ source: first, text: 'I have the fixture read.' });
  const badCheckIn = log.appendConversationCheckIn({ source: first, text: 'Unbound hidden check-in.' }).event!;
  log.openEventLog().prepare('UPDATE events SET data_json = ? WHERE seq = ?').run(
    JSON.stringify({ ...badCheckIn.data, sourceUserSeq: first.seq + 10_000 }), badCheckIn.seq);
  emit('conversation_completed', terminal(sid, first.seq,
    'Stopped.\n\nRetained work (durable checkpoint):\n- Source/tool read_file: completed result retained as rh_private_catalog.\nExternal write state: no settled external-write attempt is recorded.', 'cancelled'), 'Clem');

  const second = emit('user_input_received', { text: 'Recover the fixture answer.' }, 'user');
  // Historical parse-exhaustion rows lacked exact terminal ownership; the
  // current writer correctly refuses a second terminal for an owned source.
  emit('conversation_completed', { reply: 'Temporary apology.', reason: 'no_structured_output' }, 'Clem');
  emit('conversation_superseded', { reason: 'recovered' });
  emit('conversation_completed', terminal(sid, second.seq, 'Recovered fixture answer.', 'done', undefined, 'catalog-first-attempt'), 'Clem');
  const duplicate = emit('conversation_completed', { reply: 'Temporary legacy duplicate.' }, 'Clem');
  log.openEventLog().prepare('UPDATE events SET data_json = ? WHERE seq = ?').run(
    JSON.stringify(terminal(sid, second.seq, 'Late duplicate must stay hidden.', 'done', undefined, 'catalog-late-attempt')), duplicate.seq);

  const third = emit('user_input_received', { text: 'Keep contradictory terminals hidden.' }, 'user');
  const wrong = terminal('wrong-session', third.seq, 'Foreign terminal must stay hidden.');
  for (const corrupt of [wrong, { presentation: null, turnOutcome: null, reply: 'Malformed typed fallback must stay hidden.' }]) {
    const row = emit('conversation_completed', { reply: 'Legacy corruption fixture.' }, 'Clem');
    log.openEventLog().prepare('UPDATE events SET data_json = ? WHERE seq = ?').run(JSON.stringify(corrupt), row.seq);
  }

  const card = emit('user_input_received', { text: 'Ask before the fixture action.' }, 'user');
  emit('approval_requested', { approvalId: 'apr-catalog-parity', subject: 'fixture action',
    preview: { ask: 'Can I perform the controlled fixture action?' } }, 'Clem');
  emit('conversation_completed', terminal(sid, card.seq,
    'Approval required for fixture action. Review apr-catalog-parity to continue.', 'needs_input', 'apr-catalog-parity'), 'Clem');

  const plan = emit('user_input_received', { text: 'Plan the fixture.', taskMode: { version: 1, kind: 'plan' } }, 'user');
  emit('plan_revision_published', { sourceUserSeq: plan.seq, readiness: 'ready',
    planArtifactRef: { planId: 'plan-catalog', revision: 1, digest: 'a'.repeat(64) } }, 'host', plan.id);
  log.appendConversationCheckIn({ source: plan, text: 'The plan is taking shape.' });
  const failed = emit('user_input_received', { text: 'Hidden synthetic failure.', synthetic: true }, 'user');
  emit('conversation_completed', { sourceUserSeq: failed.seq, reply: PUBLIC_RUN_FAILURE_TEXT }, 'Clem');
  const relay = emit('user_input_received', { text: 'Hidden synthetic relay.', synthetic: true }, 'user');
  emit('conversation_completed', { sourceUserSeq: relay.seq, reply: 'The fixture relay succeeded.' }, 'Clem');
  emit('clem_message', { text: 'A standalone fixture message.' }, 'Clem');
  emit('clem_message', { text: 'x'.repeat(2_201) }, 'Clem');
  return sid;
}

const sessionId = mixedTranscript();
const withoutDecoration = (turn: ReturnType<typeof reconstructHarnessTranscript>[number]) => {
  const { agentName: _agent, projectName: _project, files: _files, workflows: _workflows, ...publicTurn } = turn;
  return publicTurn;
};

test('catalog text/count retains full public election, source binding and exact bounded windows', () => {
  for (const limit of [1, 3, 6, 12, 20, 40, 1000]) {
    assert.deepEqual(reconstructHarnessTranscriptText(sessionId, limit),
      reconstructHarnessTranscript(sessionId, limit).map(withoutDecoration), `same public turns at row limit ${limit}`);
  }
  // workflow_saved still occupies the same main window, although its card is
  // absent. Removing its event type would expose the Stop terminal too early.
  assert.deepEqual(reconstructHarnessTranscriptText(sessionId, 3).map(t => t.text), [
    'Read the controlled fixture.', 'I have the fixture read.',
  ]);
  const full = reconstructHarnessTranscript(sessionId);
  assert.ok(full.some(t => t.agentName === 'Fixture Agent' && t.projectName === 'Fixture Project'));
  assert.ok(full.some(t => t.files?.length && t.workflows?.length), 'detail keeps the saved artifacts');
  const texts = reconstructHarnessTranscriptText(sessionId).map(t => t.text);
  assert.ok(texts.includes('Stopped.'), 'a stopped terminal reopens as its authored head alone');
  assert.doesNotMatch(texts.join('\n'), /I kept|for when we continue|No changes to another app/);
  assert.ok(texts.includes('Recovered fixture answer.'));
  assert.ok(texts.includes('Can I perform the controlled fixture action?'));
  assert.ok(texts.includes('Plan ready for review.'));
  assert.ok(texts.includes('The fixture relay succeeded.'));
  assert.doesNotMatch(texts.join('\n'), /rh_private|Foreign terminal|Malformed typed|Late duplicate|Temporary apology|Unbound hidden|Hidden synthetic/);
});

test('catalog reads no agent/file decoration rows; full detail still reads them', () => {
  // Reopen before instrumentation so cached statements do not hide executions.
  log.closeEventLog();
  const db = log.openEventLog();
  const prepare = db.prepare.bind(db);
  const reads: unknown[][] = [];
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (/SELECT \* FROM events WHERE session_id/.test(sql)) {
      const all = statement.all.bind(statement);
      statement.all = ((...args: unknown[]) => { reads.push(args); return all(...args); }) as typeof statement.all;
    }
    return statement;
  }) as typeof db.prepare;
  try {
    reconstructHarnessTranscriptText(sessionId);
    assert.equal(reads.length, 1);
    assert.ok(reads[0]!.includes('workflow_saved'), 'same visible event window');
    assert.ok(!reads.some(args => args.includes('turn_model_routed') || args.includes('deliverable_saved')));
    reads.length = 0;
    reconstructHarnessTranscript(sessionId);
    assert.equal(reads.length, 3);
    assert.ok(reads.some(args => args.includes('turn_model_routed')));
    assert.ok(reads.some(args => args.includes('deliverable_saved')));
  } finally { db.prepare = prepare; log.closeEventLog(); }
});
