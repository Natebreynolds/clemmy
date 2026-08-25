/** Run: node scripts/run-tests-isolated.mjs src/runtime/semantic-boundary/execution-surface-no-ceremony.test.ts
 *
 * OWNER DECISION 2026-08-25 ("option B"): execution surfaces do not enter the
 * pre-model semantic ceremony. A full day of live runs showed every workflow
 * failure was a ceremony wall while every success executed in the gated tool
 * loop. A workflow-kind session admits by shadow graph, reads as
 * unparticipated, dispatches to the conversation loop, and arms
 * conversation-shaped authority even when its heuristic prose graph
 * classifies act-shaped with zero work nodes (the exact scorpion-facebook-
 * trends admission failure). Chat keeps the ceremony unchanged; a
 * PARTICIPATED source keeps the unique-work-node demand.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-no-ceremony-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-no-ceremony\n', 'utf8');

const { appendEvent, createSession } = await import('../harness/eventlog.js');
const { admitAndCompileAcceptedSource } = await import('./admit-and-compile-accepted-source.js');
const { dispatchAdmittedSource } = await import('./typed-source-dispatch.js');
const { readSemanticDisposition } = await import('./semantic-disposition.js');
const { installTurnSemanticModelPort } = await import('./turn-semantic-port-registry.js');
const { requireAcceptedTaskAuthority } = await import('../harness/accepted-task-authority.js');

test('a workflow-kind session skips the ceremony, dispatches to the loop, and arms authority', async () => {
  // A port IS installed and must never be consulted for an execution
  // surface — before option B this port would participate and the ceremony
  // would own the turn (this is the red half of the pin).
  installTurnSemanticModelPort({
    async interpret() { throw new Error('the semantic port must not be consulted for an execution surface'); },
    async judgeSourceEffect() { throw new Error('never'); },
    async judgePlanGrounding() { throw new Error('never'); },
  } as never);
  const session = createSession({ id: 'workflow:no-ceremony-1:main', kind: 'workflow', userId: 'user-1' });
  const source = appendEvent({
    sessionId: session.id, turn: 1, role: 'user',
    type: 'user_input_received',
    data: { text: 'Scrape the three trend sources, analyze them, and write the digest.' },
  });
  const identity = { sessionId: session.id, turn: 1, sourceUserSeq: source.seq };
  const admitted = await admitAndCompileAcceptedSource({ identity, surface: 'workflow' });
  assert.equal(admitted.ok, true, JSON.stringify(admitted).slice(0, 200));
  assert.equal(
    readSemanticDisposition(session.id, source.seq)?.participation,
    'unparticipated',
    'the semantic port declines execution surfaces',
  );
  const dispatched = await dispatchAdmittedSource(identity);
  assert.equal(dispatched.kind, 'conversation', 'execution surfaces run the gated model loop');
  // The scorpion-facebook-trends failure point: act-shaped heuristic graph,
  // zero work nodes — arming must succeed conversation-shaped, not refuse.
  const authority = requireAcceptedTaskAuthority({ sessionId: session.id, sourceUserSeq: source.seq });
  assert.ok(authority, 'authority arms for the unparticipated execution source');
  installTurnSemanticModelPort(null);
});
