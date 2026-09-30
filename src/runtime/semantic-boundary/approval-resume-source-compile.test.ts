/**
 * An owner's approval of a card is not a message to interpret. The resume
 * mints a hidden control source ("Approve apr-…") for the one stored action
 * it runs; a semantic model reading that source as small talk refused the
 * resume as "not an action turn" and the approved command never ran (live
 * 2026-09-30). That source compiles as the action it is, whatever a model
 * would say, and only that exact source shape is exempt.
 *
 * Run: node scripts/run-tests-isolated.mjs src/runtime/semantic-boundary/approval-resume-source-compile.test.ts
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-approval-resume-compile-'));
Object.assign(process.env, {
  CLEMENTINE_HOME: HOME,
  CLEMMY_TEST_ISOLATED_HOME: '1',
  EMBEDDINGS_DISABLED: 'true',
  MCP_AUTO_IMPORT_ENABLED: 'false',
});
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-approval-resume-compile\n');

const eventlog = await import('../harness/eventlog.js');
const { recordAcceptedSourceGraph } = await import('../harness/record-accepted-source-graph.js');
const { turnGraphFromShadowEvent } = await import('../graph/turn-graph-shadow.js');
const semanticPorts = await import('./turn-semantic-port-registry.js');
const { activateActionExpectedWork } = await import('../harness/expected-work-admission.js');

after(() => {
  semanticPorts.installTurnSemanticModelPort(null);
  eventlog.closeEventLog();
  rmSync(HOME, { recursive: true, force: true });
});

function acceptedSource(data: Record<string, unknown>) {
  const session = eventlog.createSession({ kind: 'chat', channel: 'desktop' });
  const attempt = eventlog.beginRunAttempt(session.id, { runId: `compile:${session.id}` });
  const source = eventlog.recordRunAttemptUserInput(attempt, { turn: 0, role: 'user', data }, { armRunInFlight: true });
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

test('a synthetic approval-resume source compiles as an action turn even when the semantic model would call it conversation', async () => {
  let asked = 0;
  semanticPorts.installTurnSemanticModelPort({
    async interpret() { asked += 1; throw new Error('the model must not be asked to read an approval'); },
  } as never);
  const { sessionId, sourceUserSeq } = acceptedSource({
    text: 'Approve apr-test1.', displayText: 'Approve apr-test1', synthetic: true,
    source: 'approval_resume', approvalId: 'apr-test1', decision: 'approve',
  });
  const event = await recordAcceptedSourceGraph({
    identity: { sessionId, turn: 0, sourceUserSeq }, surface: 'approval_resume', acceptedText: 'Approve apr-test1.',
  });
  assert.ok(event, 'the source was admitted');
  assert.equal(asked, 0, 'no semantic model call');
  const graph = turnGraphFromShadowEvent(event);
  assert.equal(graph?.classification.route, 'act');
  const activation = activateActionExpectedWork({ sessionId, sourceUserSeq });
  assert.ok(activation.status === 'activated' || activation.status === 'replayed', JSON.stringify(activation));
});

test('an ordinary source on the same surface still goes to the semantic port', async () => {
  let asked = 0;
  semanticPorts.installTurnSemanticModelPort({
    async interpret() { asked += 1; throw new Error('port consulted'); },
  } as never);
  const { sessionId, sourceUserSeq } = acceptedSource({ text: 'yes, send it' });
  await recordAcceptedSourceGraph({
    identity: { sessionId, turn: 0, sourceUserSeq }, surface: 'approval_resume', acceptedText: 'yes, send it',
  });
  assert.equal(asked, 1, 'a real reply is interpreted as before');
});
