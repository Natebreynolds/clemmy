/**
 * RED: no fabricated compute obligation for a read-shaped ask.
 *
 * "What's on my plate today?" needs tools only to READ; the model-composed
 * summary IS the response. When the graph for such an ask lands on the action
 * route, the contract freezer refuses every all-read proposal ("an action
 * graph cannot be weakened to read-only work"), forcing the model to invent a
 * non-read (typically compute) operation nobody asked for — a fabricated
 * obligation that may not even have a terminal evidence issuer
 * (live 2026-08-11).
 *
 * Invariant: a read-shaped ask must own a typed read-work path that requires
 * no non-read operation — either its graph is read/retrieve (deterministic
 * read contract), or an all-read expected-work proposal is admissible.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-read-only-work-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-read-only-work\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const authority = await import('./accepted-task-authority.js');
const contracts = await import('./expected-work-contract.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

function accept(text: string) {
  const session = eventlog.createSession({ id: `read-only-work-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  const graphEvent = shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  });
  assert.ok(graphEvent, 'fixture has one exact persisted graph');
  assert.equal(authority.armAcceptedTaskAuthority({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  }).status, 'armed');
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    graph: graphEvent.data.graph as import('../graph/turn-graph-ir.js').TurnGraphIR,
  };
}

function allReadProposal(): contracts.ExpectedWorkProposalV1 {
  return {
    version: 1,
    operations: [{
      id: 'read_current_state',
      effect: 'read',
      coverage: 'complete_set',
      dependsOn: [],
      dataFrom: [],
      cardinality: { kind: 'once' },
    }],
    universes: [],
  };
}

function assertReadWorkPathExists(task: ReturnType<typeof accept>): void {
  if (task.graph.classification.route !== 'act') {
    // Unified typed decision routes the read ask as retrieve: the
    // deterministic read contract is the read-work path.
    const fixed = contracts.freezeDeterministicExpectedWorkContract(task);
    assert.ok(
      fixed.status === 'fixed' || fixed.status === 'replayed',
      `a read-routed ask freezes its deterministic read work: ${JSON.stringify(fixed)}`,
    );
    if (fixed.status !== 'fixed' && fixed.status !== 'replayed') return;
    assert.ok(
      fixed.contract.operations.every((operation) => operation.effect === 'read'),
      'read work never carries a non-read operation',
    );
    return;
  }
  // The graph still says act: then the read work itself must be admissible
  // without a manufactured non-read operation.
  const frozen = contracts.freezeActionExpectedWorkContract({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    proposal: allReadProposal(),
  });
  assert.ok(
    frozen.status === 'fixed' || frozen.status === 'replayed',
    'a read-shaped ask must be satisfiable as read-only expected work — '
    + 'refusing it fabricates a compute obligation nobody asked for: '
    + JSON.stringify(frozen),
  );
}

test("\"what's on my plate today?\" is satisfiable as read work without a fabricated non-read operation", () => {
  assertReadWorkPathExists(accept("What's on my plate today?"));
});

test('"anything new in my inbox today?" is satisfiable as read work without a fabricated non-read operation', () => {
  assertReadWorkPathExists(accept('anything new in my inbox today?'));
});
