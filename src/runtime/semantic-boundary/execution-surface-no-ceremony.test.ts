/** Run: node scripts/run-tests-isolated.mjs src/runtime/semantic-boundary/execution-surface-no-ceremony.test.ts
 *
 * Execution surfaces may skip the pre-model semantic ceremony, but that does
 * not let a deterministic work graph shed its obligations. A workflow-kind
 * source that has no expected-work binding writer remains unparticipated and
 * must refuse before accepted-task authority, logical calls, or physical I/O.
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

const { appendEvent, createSession, openEventLog } = await import('../harness/eventlog.js');
const { admitAndCompileAcceptedSource } = await import('./admit-and-compile-accepted-source.js');
const { readSemanticDisposition } = await import('./semantic-disposition.js');
const { installTurnSemanticModelPort } = await import('./turn-semantic-port-registry.js');
const { requireAcceptedTaskAuthority } = await import('../harness/accepted-task-authority.js');

test('a workflow-kind non-conversational source without a binder refuses authority before execution', async () => {
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
  assert.throws(
    () => requireAcceptedTaskAuthority({ sessionId: session.id, sourceUserSeq: source.seq }),
    /non-conversational graph has no expected-work binding writer/,
  );
  const counts = openEventLog().prepare(`
    SELECT
      (SELECT COUNT(*) FROM accepted_task_authority
        WHERE session_id = ? AND source_user_seq = ?) AS authority_count,
      (SELECT COUNT(*) FROM logical_tool_calls
        WHERE session_id = ? AND source_user_seq = ?) AS logical_count,
      (SELECT COUNT(*) FROM physical_dispatches
        WHERE session_id = ? AND source_user_seq = ?) AS physical_count
  `).get(
    session.id, source.seq,
    session.id, source.seq,
    session.id, source.seq,
  ) as { authority_count: number; logical_count: number; physical_count: number };
  assert.deepEqual(counts, {
    authority_count: 0,
    logical_count: 0,
    physical_count: 0,
  });
  installTurnSemanticModelPort(null);
});
