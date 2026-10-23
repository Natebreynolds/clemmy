/** Production pre-turn refusal: truthful delivery without constructing an agent. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-planning-refusal-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT = 'off';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
mkdirSync(path.join(HOME, 'state'), { recursive: true });

const eventlog = await import('./eventlog.js');
const continuity = await import('../../memory/task-continuity.js');
const { commitTurnOutcome } = await import('./delivery-committer.js');
const { turnOutcomeId } = await import('./turn-outcome.js');
const { runConversation } = await import('./loop.js');
const memory = await import('../../memory/db.js');

test.after(() => {
  eventlog.closeEventLog();
  memory.closeMemoryDb();
  rmSync(HOME, { recursive: true, force: true });
});

test('an unverified earlier-question connection blocks truthfully before any agent work', async () => {
  const session = eventlog.createSession({ id: 'plan-continuity-refusal', kind: 'chat', channel: 'desktop' });
  const parentAttempt = eventlog.beginRunAttempt(session.id, { runId: 'fixture-question' });
  const parent = eventlog.recordRunAttemptUserInput(parentAttempt, {
    turn: 1, role: 'user', data: { text: 'Prepare the controlled fixture report.', userId: 'fixture-owner' },
  });
  const question = 'PRIVATE-FIXTURE-CONTEXT: which controlled report should be planned?';
  eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'Clem', type: 'awaiting_user_input',
    data: { question, options: ['Amber', 'Violet'], purpose: 'clarification', sourceUserSeq: parent.seq } });
  const identity = { sessionId: session.id, turn: 1, sourceUserSeq: parent.seq };
  commitTurnOutcome({ version: 2, id: turnOutcomeId(identity), identity, status: 'needs_input',
    resumable: true, needs: { kind: 'input' }, presentation: { kind: 'question', text: question } });
  eventlog.finishRunAttempt(parentAttempt, 'completed');
  const pendingBefore = continuity.peekTaskContinuityPacket({ sessionId: session.id });
  assert.equal(pendingBefore.status, 'available');

  // The observed ingress defect omitted userId on the next Plan source. This
  // test preserves that refusal; ingress identity is fixed independently.
  const attempt = eventlog.beginRunAttempt(session.id, { runId: 'fixture-plan-followup' });
  const source = eventlog.recordRunAttemptUserInput(attempt, { turn: 2, role: 'user', data: {
    text: 'Prepare a plan for the Amber fixture report.', taskMode: { version: 1, kind: 'plan' },
  } });
  let agentBuilds = 0;
  let runnerBuilds = 0;
  const result = await runConversation({
    sessionId: session.id, sourceUserSeq: source.seq, reuseRecordedUserInput: true,
    input: String(source.data.text), turnEngine: 'host_v1',
    buildAgent: async () => { agentBuilds += 1; throw new Error('An unresolved source must not construct an agent'); },
    makeRunner: () => { runnerBuilds += 1; throw new Error('An unresolved source must not construct a runner'); },
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.steps, 0);
  assert.equal(agentBuilds, 0);
  assert.equal(runnerBuilds, 0);
  const events = eventlog.listEvents(session.id).filter(e => e.data.sourceUserSeq === source.seq);
  assert.equal(events.filter(e => e.type === 'tool_called' || e.type === 'model_request_started').length, 0);
  const refused = events.filter(e => e.type === 'primary_model_planning_prime_refused');
  assert.equal(refused.length, 1);
  assert.equal(refused[0]?.data.stage, 'accepted_source_continuation');
  assert.equal(refused[0]?.data.reason, 'durable accepted-source continuation is unresolved');
  const terminals = events.filter(e => e.type === 'conversation_completed');
  assert.equal(terminals.length, 1, 'the blocked turn still delivers exactly one terminal');
  const terminal = terminals[0]!;
  assert.equal(terminal.data.reason, 'accepted_source_continuation_unavailable');
  assert.equal((terminal.data.turnOutcome as { status?: string }).status, 'blocked');
  assert.equal(terminal.data.reply, result.error);
  assert.match(result.error ?? '', /verify.*earlier question/i);
  assert.match(result.error ?? '', /Nothing was started in this turn/);
  assert.match(result.error ?? '', /restate your request in a new chat/i);
  assert.doesNotMatch(result.error ?? '', /capability catalog|retry|PRIVATE-FIXTURE-CONTEXT|fixture-owner|durable accepted-source/i);
  assert.deepEqual(continuity.peekTaskContinuityPacket({ sessionId: session.id }), pendingBefore,
    'truthful presentation must neither consume nor relax the unresolved continuation');
});
