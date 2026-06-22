/**
 * Run: npx tsx --test src/tools/code-mode-gate-parity.test.ts
 *
 * Code Mode Phase 2 GATE-PARITY (Lane C). The safety claim: a WRITE inside a
 * code-mode program passes the SAME write-boundary gates, at the SAME thresholds,
 * as a discrete tool call — because clem.<tool> dispatches through the same
 * wrapToolForHarness chain. Driven through the dispatcher (the sandbox is just
 * transport, proven in Phase 1) with fake gated tools, against the REAL bracket
 * chain. Mirrors the harness-gate-benchmark traps.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-codemode-parity-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

const { resetEventLog, createSession, listEvents } = await import('../runtime/harness/eventlog.js');
const { dispatchCodeModeTool, _setCodeModeToolsForTests } = await import('./code-mode-tool.js');

function setBaselineEnv(): void {
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  process.env.CLEMMY_TOOL_GUARDRAIL = 'off';
  process.env.CLEMMY_EXECUTION_GATE = 'off';
  process.env.CLEMMY_GROUNDING_GATE = 'off';
  process.env.CLEMMY_GOAL_FIDELITY_GATE = 'off';
  process.env.CLEMMY_DESTINATION_GATE = 'off';
  process.env.CLEMMY_CONFIRM_FIRST = 'off';
  process.env.CLEMMY_GUARDRAIL_PERSIST = 'off';
  process.env.CLEMMY_CODE_MODE_WRITES = 'on';
}

// Fake gated tools (return without sending); the REAL gates run in
// wrapToolForHarness around them.
function injectFakes(): void {
  _setCodeModeToolsForTests(new Map<string, { name: string; invoke: (c: unknown, i: string, d: unknown) => Promise<unknown> }>([
    ['composio_execute_tool', { name: 'composio_execute_tool', invoke: async () => 'sent' }],
    ['run_shell_command', { name: 'run_shell_command', invoke: async () => 'deployed' }],
  ]));
}

function blockKindsFor(sessionId: string): string[] {
  return listEvents(sessionId, { types: ['guardrail_tripped'] })
    .map((e) => (e.data as { kind?: string }).kind)
    .filter((k): k is string => typeof k === 'string' && k !== 'fanout_nudge');
}

const send = (to: string) => ({ tool_slug: 'GMAIL_SEND_EMAIL', arguments: JSON.stringify({ recipient_email: to, subject: 's', body: 'b' }) });

test('GATE-PARITY: a program looping batch sends trips confirm-first (same as a discrete loop)', async () => {
  setBaselineEnv();
  process.env.CLEMMY_CONFIRM_FIRST = 'on';
  resetEventLog();
  injectFakes();
  const sess = createSession({ kind: 'chat' });
  const counter = (await import('../runtime/harness/brackets.js')).ToolCallsCounter;
  const shared = new counter(1000);
  // 8 distinct-recipient sends in a loop (the confirm-first-batch shape).
  for (let i = 1; i <= 8; i += 1) {
    try { await dispatchCodeModeTool('composio_execute_tool', send(`r${i}@b.com`), sess.id, shared); } catch { /* gate block surfaces as throw — expected */ }
  }
  assert.ok(blockKindsFor(sess.id).includes('confirm_first_required'), 'confirm-first must fire for an in-program batch, same as discrete calls');
  _setCodeModeToolsForTests(null);
});

test('GATE-PARITY: a wrong/implicit-destination publish inside a program hard-blocks', async () => {
  setBaselineEnv();
  process.env.CLEMMY_DESTINATION_GATE = 'on';
  resetEventLog();
  const destination = await import('../runtime/harness/destination-gate.js');
  destination._resetDestinationStateForTests();
  injectFakes();
  const sess = createSession({ kind: 'chat' });
  try {
    await dispatchCodeModeTool('run_shell_command', { command: 'netlify deploy --dir "/x/site" --prod --json' }, sess.id);
  } catch { /* destination gate blocks → throw, expected */ }
  assert.ok(blockKindsFor(sess.id).includes('implicit_destination'), 'an implicit-destination publish must trip the destination gate inside a program');
  _setCodeModeToolsForTests(null);
});

test('SAFETY: with writes OFF, a program cannot reach a mutating tool at all (refused pre-gate)', async () => {
  setBaselineEnv();
  process.env.CLEMMY_CODE_MODE_WRITES = 'off';
  injectFakes();
  await assert.rejects(
    () => dispatchCodeModeTool('composio_execute_tool', send('a@b.com'), 'sess-x'),
    /writes are disabled|not available/,
  );
  _setCodeModeToolsForTests(null);
});
