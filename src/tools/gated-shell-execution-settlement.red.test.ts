/**
 * RED pins — the typed shell execution truth reaches the durable settlement
 * through the gated local MCP lane (registerGatedMutatingTools + the REAL
 * run_shell_command through wrapToolForHarness).
 *
 * Invariant under pin (live class 2026-08-11): the host classifies its OWN
 * executions. An exit-zero command settles 'succeeded'; a nonzero exit and a
 * command timeout settle as typed failure/timeout outcomes — never 'unknown',
 * never 'succeeded'. Today the typed ShellExecutionOutcome is recorded per
 * call and then dropped before classification, so all three settle 'unknown'.
 *
 * Run: npx tsx --test src/tools/gated-shell-execution-settlement.red.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'gated-shell-exec-settlement-'));
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

const { appendEvent, createSession, openEventLog, closeEventLog } =
  await import('../runtime/harness/eventlog.js');
const { registerGatedMutatingTools } = await import('./gated-mutating-tools.js');
const { recordTurnGraphShadow } = await import('../runtime/graph/turn-graph-shadow.js');
const { getComputerTools } = await import('./computer-tools.js');

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
    data: { text: 'run the build check' },
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

function onlySettlement(fixture: Fixture) {
  const rows = openEventLog().prepare(`
    SELECT outcome_kind, outcome_evidence, outcome_detail,
           recovery_action, execution_kind, physical_crossing_count
      FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ?
  `).all(fixture.sessionId, fixture.sourceUserSeq) as Array<{
    outcome_kind: string;
    outcome_evidence: string;
    outcome_detail: string | null;
    recovery_action: string;
    execution_kind: string;
    physical_crossing_count: number;
  }>;
  assert.equal(rows.length, 1, `exactly one settlement for one call: ${JSON.stringify(rows)}`);
  return rows[0]!;
}

test("an exit-zero shell command settles 'succeeded' — the host knows its own execution finished", async () => {
  const fixture = register();
  await fixture.shell({ command: 'echo ok' });
  const row = onlySettlement(fixture);
  assert.equal(
    row.outcome_kind,
    'succeeded',
    `exit_code 0 is a typed success the settlement must carry, got: ${JSON.stringify(row)}`,
  );
});

test("a generic nonzero exit settles as nominal inert failure — never 'succeeded'", async () => {
  const fixture = register();
  await fixture.shell({ command: 'exit 3' });
  const row = onlySettlement(fixture);
  // The finite recovery taxonomy intentionally has no catch-all
  // `execution_failed` candidate class: a generic exit must not eliminate a
  // tool, reopen discovery, or claim it is transient. Nominal evidence + the
  // execution_failed detail preserves what the host knows without guessing.
  assert.equal(row.outcome_kind, 'unknown');
  assert.equal(row.outcome_evidence, 'nominal');
  assert.equal(row.outcome_detail, 'execution_failed');
  assert.equal(row.recovery_action, 'stop_and_explain');
  assert.notEqual(row.outcome_kind, 'succeeded', 'a nonzero exit is never a success');
});

test("a command timeout settles as a typed timeout outcome — never 'unknown', never 'succeeded'", async () => {
  const fixture = register();
  await fixture.shell({
    command: "node -e 'setTimeout(function(){},60000)'",
    // The schema floor (min 1000ms) keeps this deterministic and still fast.
    timeout_ms: 1000,
  });
  const row = onlySettlement(fixture);
  assert.notEqual(
    row.outcome_kind,
    'unknown',
    `the host killed this command itself and knows it timed out: ${JSON.stringify(row)}`,
  );
  assert.notEqual(row.outcome_kind, 'succeeded', 'a timed-out command is never a success');
});

test.after(() => {
  closeEventLog();
  rmSync(TMP, { recursive: true, force: true });
});
