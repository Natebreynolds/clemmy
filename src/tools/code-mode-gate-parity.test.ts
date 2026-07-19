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

test('GATE-SUPERSEDED (2026-07-08): an in-program send is REFUSED before any gate — a program can never loop sends at all', async () => {
  // This test used to assert confirm-first parity for an 8-send in-program
  // loop. The code-mode send guard (606a2245) made that scenario impossible
  // BY DESIGN: an irreversible send inside run_tool_program is refused before
  // it fires (code programs die at the 60s cap mid-batch and lose sends), with
  // a redirect to run_batch — a strictly stronger guarantee than confirm-first
  // catching the batch at send #N.
  setBaselineEnv();
  process.env.CLEMMY_CONFIRM_FIRST = 'on';
  resetEventLog();
  injectFakes();
  const sess = createSession({ kind: 'chat' });
  const counter = (await import('../runtime/harness/brackets.js')).ToolCallsCounter;
  const shared = new counter(1000);
  let refusals = 0;
  for (let i = 1; i <= 8; i += 1) {
    try {
      await dispatchCodeModeTool('composio_execute_tool', send(`r${i}@beta.example`), sess.id, shared);
    } catch (err) {
      if (err instanceof Error && /run_batch/.test(err.message) && /irreversible external send/.test(err.message)) refusals += 1;
    }
  }
  assert.equal(refusals, 8, 'every in-program send is refused with the run_batch redirect — none reach the gates');
  const writes = listEvents(sess.id, { types: ['external_write'] });
  assert.equal(writes.length, 0, 'no send ever fired, so no external_write was recorded');
  _setCodeModeToolsForTests(null);
});

test('GATE-PARITY: an in-program reversible-write loop is refused at the 3rd mutation (run_batch redirect)', async () => {
  // Reversible writes may run singly in a program (gated normally), but a
  // LOOP of them dies at the 60s cap just like sends — the escalation guard
  // refuses the 3rd mutating call in one program run.
  setBaselineEnv();
  resetEventLog();
  injectFakes();
  const sess = createSession({ kind: 'chat' });
  const counter = (await import('../runtime/harness/brackets.js')).ToolCallsCounter;
  const shared = new counter(1000);
  const update = (n: number) => ({ tool_slug: 'AIRTABLE_UPDATE_RECORD', arguments: JSON.stringify({ record: n }) });
  await dispatchCodeModeTool('composio_execute_tool', update(1), sess.id, shared);
  await dispatchCodeModeTool('composio_execute_tool', update(2), sess.id, shared);
  await assert.rejects(
    () => dispatchCodeModeTool('composio_execute_tool', update(3), sess.id, shared),
    /run_batch/,
    'the 3rd mutating call in one program run must be refused toward run_batch',
  );
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

test('TELEMETRY: each in-program call emits codeMode-tagged tool_called/tool_returned (trace visibility)', async () => {
  setBaselineEnv(); // gates off + writes on → a reversible write executes cleanly
  resetEventLog();
  injectFakes();
  const sess = createSession({ kind: 'chat' });
  // A reversible UPDATE, not a send — sends are refused in code mode by design
  // (606a2245), so telemetry visibility is proven on a call that executes.
  await dispatchCodeModeTool('composio_execute_tool', { tool_slug: 'AIRTABLE_UPDATE_RECORD', arguments: JSON.stringify({ record: 1 }) }, sess.id);
  const called = listEvents(sess.id, { types: ['tool_called'] }).filter((e) => (e.data as { codeMode?: boolean }).codeMode);
  const returned = listEvents(sess.id, { types: ['tool_returned'] }).filter((e) => (e.data as { codeMode?: boolean }).codeMode);
  assert.ok(called.length >= 1, 'an in-program clem call emits a codeMode-tagged tool_called');
  assert.ok(returned.length >= 1, 'and a codeMode-tagged tool_returned');
  assert.equal((returned[0].data as { tool?: string }).tool, 'composio_execute_tool');
  _setCodeModeToolsForTests(null);
});

test('SAFETY: with writes OFF, a program cannot reach a mutating tool at all (refused pre-gate)', async () => {
  setBaselineEnv();
  process.env.CLEMMY_CODE_MODE_WRITES = 'off';
  injectFakes();
  await assert.rejects(
    () => dispatchCodeModeTool('composio_execute_tool', send('a@beta.example'), 'sess-x'),
    /writes are disabled|not available/,
  );
  _setCodeModeToolsForTests(null);
});
