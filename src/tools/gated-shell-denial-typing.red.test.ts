/**
 * RED pins — a shell policy denial keeps its type end to end on the gated
 * local MCP lane (registerGatedMutatingTools + the REAL run_shell_command).
 *
 * Invariant under pin (live class 2026-08-11):
 *   - A pre-dispatch policy denial settles ONCE as a typed
 *     policy_denial / refused_pre_dispatch settlement — never 'unknown',
 *     never success-shaped.
 *   - The MCP wire result carries isError:true for every denial shape,
 *     including throws the SDK launders into prose and the in-execute
 *     'Refused:' early returns.
 *   - The transport_mirror tool_returned row and the wire result tell the
 *     SAME truth (ok:false <=> isError:true) — one call, one verdict.
 *   - A denial that never dispatched records zero physical crossings.
 *
 * Run: npx tsx --test src/tools/gated-shell-denial-typing.red.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'gated-shell-denial-typing-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.CLEMMY_TOOL_GUARDRAIL = 'off';
process.env.CLEMMY_EXECUTION_GATE = 'off';
process.env.CLEMMY_GROUNDING_GATE = 'off';
process.env.CLEMMY_GOAL_FIDELITY_GATE = 'off';
process.env.CLEMMY_CONFIRM_FIRST = 'off';
process.env.CLEMENTINE_MCP_GATED_MUTATIONS = 'on';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { appendEvent, createSession, listEvents, openEventLog, closeEventLog } =
  await import('../runtime/harness/eventlog.js');
const { registerGatedMutatingTools } = await import('./gated-mutating-tools.js');
const { recordTurnGraphShadow } = await import('../runtime/graph/turn-graph-shadow.js');
const { getComputerTools } = await import('./computer-tools.js');
const { BASE_DIR } = await import('../config.js');

type Handler = (input: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

interface Fixture {
  sessionId: string;
  sourceUserSeq: number;
  shell: Handler;
}

function register(): Fixture {
  const session = createSession({ kind: 'chat' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'tidy up the machine' },
  });
  const shadow = recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn },
  });
  if (!shadow) throw new Error('fixture could not persist a turn graph');
  const handlers = new Map<string, Handler>();
  const server = {
    tool: (...args: unknown[]) => {
      const name = typeof args[0] === 'string' ? (args[0] as string) : '';
      const handler = args.find((a) => typeof a === 'function') as Handler | undefined;
      if (name && handler) handlers.set(name, handler);
    },
  };
  registerGatedMutatingTools(server as never, {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    runScopeId: `${session.id}::brain:test`,
    directOrchestrator: true,
    runtimeToolsForTest: getComputerTools() as never,
  });
  const shell = handlers.get('run_shell_command');
  if (!shell) throw new Error('run_shell_command did not register on the gated surface');
  return { sessionId: session.id, sourceUserSeq: source.seq, shell };
}

function settlements(fixture: Fixture) {
  return openEventLog().prepare(`
    SELECT outcome_kind, execution_kind, physical_crossing_count, host_crossing_count
      FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ?
  `).all(fixture.sessionId, fixture.sourceUserSeq) as Array<{
    outcome_kind: string;
    execution_kind: string;
    physical_crossing_count: number;
    host_crossing_count: number | null;
  }>;
}

function physicalDispatchCount(fixture: Fixture): number {
  return (openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ? AND source_user_seq = ?
  `).get(fixture.sessionId, fixture.sourceUserSeq) as { n: number }).n;
}

function mirrorRows(fixture: Fixture) {
  return listEvents(fixture.sessionId).filter((event) =>
    event.type === 'tool_returned'
    && event.data.accounting === 'transport_mirror'
    && event.data.tool === 'run_shell_command');
}

test('a policy-denied shell command returns MCP isError:true on the wire (laundered throw shape)', async () => {
  const fixture = register();
  const result = await fixture.shell({ command: 'sudo shutdown -r now' });
  assert.equal(
    result.isError,
    true,
    `a policy denial reached the model success-shaped: ${JSON.stringify(result).slice(0, 300)}`,
  );
});

test("a policy-denied shell command settles durably as policy_denial / refused_pre_dispatch, not 'unknown'", async () => {
  const fixture = register();
  await fixture.shell({ command: 'sudo shutdown -r now' });
  const rows = settlements(fixture);
  assert.equal(rows.length, 1, `exactly one settlement for one call, got ${JSON.stringify(rows)}`);
  assert.equal(
    rows[0]!.outcome_kind,
    'policy_denial',
    `a nominal policy refusal must settle typed, got: ${JSON.stringify(rows[0])}`,
  );
  assert.equal(
    rows[0]!.execution_kind,
    'refused_pre_dispatch',
    'nothing was dispatched, and the execution kind must say so',
  );
});

test('mirror row and wire result agree on a denial — one call cannot carry two truths', async () => {
  const fixture = register();
  const result = await fixture.shell({ command: 'sudo shutdown -r now' });
  const mirror = mirrorRows(fixture);
  assert.ok(mirror.length >= 1, 'mirror row exists');
  for (const row of mirror) {
    assert.equal(
      row.data.ok === false,
      result.isError === true,
      `mirror ok:${String(row.data.ok)} disagrees with wire isError:${String(result.isError)}`,
    );
  }
  // And the shared verdict is FAILURE: neither surface may call a denial ok.
  assert.equal(result.isError, true, 'the agreed verdict for a denial is error, not success');
});

test("an in-execute 'Refused:' early return is typed on the wire and on the mirror (not success-shaped text)", async () => {
  const fixture = register();
  const result = await fixture.shell({
    command: 'sqlite3 memory.db "UPDATE consolidated_facts SET pinned=0 WHERE id=1"',
  });
  assert.equal(
    result.isError,
    true,
    `a refusal returned as plain text reached the model success-shaped: ${
      JSON.stringify(result.content[0]?.text ?? '').slice(0, 200)}`,
  );
  const mirror = mirrorRows(fixture);
  assert.ok(mirror.length >= 1, 'mirror row exists');
  for (const row of mirror) {
    assert.equal(row.data.ok, false, `mirror stamped a refusal ok:${String(row.data.ok)}`);
  }
});

test('an own-stores authorization denial (harness.db mutation) is typed on the wire and settles policy_denial', async () => {
  const fixture = register();
  const result = await fixture.shell({
    command: `sqlite3 ${JSON.stringify(path.join(BASE_DIR, 'state', 'harness.db'))} "UPDATE pending_approvals SET status='resolved'"`,
  });
  assert.equal(
    result.isError,
    true,
    `an authorization-state denial reached the model success-shaped: ${JSON.stringify(result).slice(0, 300)}`,
  );
  const rows = settlements(fixture);
  assert.equal(rows.length, 1, `exactly one settlement for one call, got ${JSON.stringify(rows)}`);
  assert.equal(
    rows[0]!.outcome_kind,
    'policy_denial',
    `the own-stores gate is a nominal policy refusal, got: ${JSON.stringify(rows[0])}`,
  );
});

// GUARD (must pass today and stay green after the fix): a pre-dispatch denial
// settles exactly once and records zero physical crossings — the transport
// mirror is event accounting, never a second settlement.
test('GUARD: a pre-dispatch denial settles exactly once with zero physical dispatches', async () => {
  const fixture = register();
  await fixture.shell({ command: 'sudo shutdown -r now' });
  const rows = settlements(fixture);
  assert.equal(rows.length, 1, `one denial, one settlement row: ${JSON.stringify(rows)}`);
  assert.equal(rows[0]!.physical_crossing_count, 0, 'a refused call never crossed to a provider');
  assert.equal(physicalDispatchCount(fixture), 0, 'no physical dispatch row may exist for a refused call');
});

test.after(() => {
  closeEventLog();
  rmSync(TMP, { recursive: true, force: true });
});
