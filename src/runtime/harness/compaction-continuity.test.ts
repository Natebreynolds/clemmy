/**
 * Continuity after history reduction: an approved plan decision, a user
 * correction, a pending approval and a completed-write receipt survive a
 * forced Layer 1 + Layer 2 compaction and a reopen of storage, and the
 * completed write stays visible as already done so it is never re-issued.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentInputItem } from '@openai/agents';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-compaction-continuity-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_AUTO_COMPACT = 'on';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-compaction-continuity\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const dispatch = await import('./dispatch-ledger.js');
const identities = await import('./attempt-identity.js');
const outcomes = await import('./attempt-outcome.js');
const store = await import('./logical-call-settlement-store.js');
const { compactSessionIfNeeded, _setCompactionSummarizerForTests } = await import('./compaction.js');
const { HarnessSession } = await import('./session.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const user = (text: string) => ({ role: 'user', content: text }) as unknown as AgentInputItem;
const assistant = (text: string) => ({ role: 'assistant', content: text }) as unknown as AgentInputItem;
const system = (text: string) => ({ role: 'system', content: text }) as unknown as AgentInputItem;
const call = (callId: string, name: string, args: unknown) => ({
  type: 'function_call', id: `fc-${callId}`, callId, name, arguments: JSON.stringify(args), status: 'completed',
}) as unknown as AgentInputItem;
const result = (callId: string, output: string) => ({
  type: 'function_call_result', name: 'x', callId, status: 'completed', output: { type: 'text', text: output },
}) as unknown as AgentInputItem;

test('an approved plan, a user correction, a pending approval and a completed-write receipt survive forced compaction and a reopen', async (t) => {
  t.after(() => _setCompactionSummarizerForTests(null));
  const session = HarnessSession.create({ kind: 'chat', title: 'continuity' });
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Draft the Q3 inventory memo from the notes file and save it.' } });
  assert.ok(shadow.recordTurnGraphShadow({ identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 } }));
  const task = { sessionId: session.id, sourceUserSeq: source.seq, acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq) };

  // The completed write: a real settled mutating logical call, retained output.
  const writeArgs = { path: 'memos/q3-inventory.md', content: 'Q3 inventory memo', mode: 'create' };
  const started = dispatch.beginPhysicalDispatch({
    identity: { ...task, logicalToolCallId: 'write-q3', physicalDispatchId: 'write-q3:1', ordinal: 0 },
    tool: 'write_file', args: writeArgs,
  });
  assert.equal(started.status, 'inserted');
  if (started.status !== 'inserted') return;
  assert.equal(dispatch.settlePhysicalDispatch({ identity: started.identity, tool: 'write_file', outcome: 'returned' }).status, 'inserted');
  const receipt = JSON.stringify({ ok: true, committed: true, path: 'memos/q3-inventory.md', receipt: 'file-revision:q3:1' });
  const committed = store.commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId: 'write-q3' },
    contract: { toolName: 'write_file', args: writeArgs },
    execution: { kind: 'provider_execution' },
    result: { payload: receipt },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: true },
    observer: { lane: 'composio', callId: 'write-q3', turn: 1 },
  });
  assert.equal(committed.status, 'committed', JSON.stringify(committed));
  eventlog.writeToolOutput({ sessionId: session.id, callId: 'write-q3', tool: 'write_file', output: receipt });

  const items: AgentInputItem[] = [
    user('Draft the Q3 inventory memo from the notes file and save it.'),
    assistant('Plan: read notes, draft memo, save to memos/q3-inventory.md. Approve?'),
    user('Approve the plan.'),
    system('[plan approved] read notes → draft memo → save memos/q3-inventory.md'),
  ];
  // Enough older reads to force Layer 1 to collapse and Layer 2 to summarize.
  for (let i = 0; i < 14; i += 1) {
    const callId = `read-${i}`;
    const body = `notes section ${i} ${'n'.repeat(1200)}`;
    items.push(call(callId, 'read_file', { path: `notes/${i}.md` }), result(callId, body));
    eventlog.writeToolOutput({ sessionId: session.id, callId, tool: 'read_file', output: body });
    items.push(assistant(`Read section ${i}; continuing.`));
  }
  items.push(call('write-q3', 'write_file', writeArgs), result('write-q3', receipt));
  items.push(user('Correction: the memo must cite the Q3 file, not the Q2 one.'));
  items.push(assistant('Understood. Sending the memo to finance needs your approval: send memos/q3-inventory.md to finance@example.test?'));
  items.push(system('[approval pending: apr-send-q3] send memos/q3-inventory.md to finance@example.test'));
  session.updateConversationSnapshot(items);

  _setCompactionSummarizerForTests(async () => ({ summary: '- Earlier: read fourteen note sections [read-0]…[read-13]; drafted memo.', modelUsed: 'fixture-summarizer' }));
  const { result: outcome, nextItems, forkRequest } = await compactSessionIfNeeded(session, items, {
    inputBudgetTokens: 200_000, layer1ItemThreshold: 10, layer1RetainToolPairs: 2, layer2RetainMessages: 4, forceLayer2: true,
  });
  assert.equal(outcome.layer1.applied, true, JSON.stringify(outcome));
  assert.equal(outcome.layer2.applied, true, JSON.stringify(outcome));
  assert.equal(forkRequest, undefined);
  assert.ok(outcome.afterTokens < outcome.beforeTokens, 'history actually shrank');

  const text = JSON.stringify(nextItems);
  const userTexts = nextItems.filter((item) => (item as { role?: string }).role === 'user').map((item) => String((item as { content?: unknown }).content));
  assert.deepEqual(userTexts, [
    'Draft the Q3 inventory memo from the notes file and save it.',
    'Approve the plan.',
    'Correction: the memo must cite the Q3 file, not the Q2 one.',
  ], 'every user message, including the approval decision and the correction, stays verbatim and in order');
  assert.match(text, /approval pending: apr-send-q3/, 'the pending approval stays in the retained tail');
  const writeVisible = nextItems.some((item) => (item as { callId?: string }).callId === 'write-q3' && (item as { type?: string }).type === 'function_call_result')
    || /Durable completed writes — already done[\s\S]*write-q3/.test(text);
  assert.ok(writeVisible, `the completed write stays visible either verbatim or as an already-done ledger entry: ${text.slice(0, 2000)}`);
  assert.doesNotMatch(text, /notes section 3 nnnn/, 'older read bodies were actually reduced');

  // Reopen storage: the reduced history is what the next turn and a restart see.
  session.updateConversationSnapshot(nextItems);
  eventlog.closeEventLog();
  const reopened = HarnessSession.load(session.id)?.toInputItems() ?? [];
  assert.equal(JSON.stringify(reopened), JSON.stringify(nextItems), 'the reduced history survives reopening storage byte for byte');

  // The completed write is settled durably: the same logical call cannot be committed twice.
  const again = store.commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId: 'write-q3' },
    contract: { toolName: 'write_file', args: writeArgs },
    execution: { kind: 'provider_execution' },
    result: { payload: receipt },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: true },
    observer: { lane: 'composio', callId: 'write-q3', turn: 1 },
  });
  assert.notEqual(again.status, 'committed', `a settled write is not committed a second time: ${JSON.stringify(again)}`);
});
