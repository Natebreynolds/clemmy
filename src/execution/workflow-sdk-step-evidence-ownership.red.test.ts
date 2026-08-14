/**
 * RED — an SDK-lane workflow step needs an audited evidence-ownership record.
 *
 * Run: npx tsx --test src/execution/workflow-sdk-step-evidence-ownership.red.test.ts
 *
 * Invariant under pin: workflow steps get accepted-task/evidence ownership or
 * an equivalent audited contract — no blanket exemption. The Claude SDK
 * workflow-step lane returns a model-authored envelope ({status, output} +
 * self-reported toolUses); its inner tool calls never cross the dispatch/
 * settlement ledger. When the envelope claims completed work, the runner counts
 * the step succeeded and the run terminal projects `succeeded` with ZERO
 * durable rows any auditor could join at terminal: no accepted_task_authority
 * activation, no logical_call_settlements, not even a durable
 * sdk_tool_use_recorded evidence event for the claimed crossing.
 *
 * The target assertion is red-by-absence against the audited-contract carrier
 * the fix must introduce: IF the run projects `succeeded`, THEN the step
 * session must own at least one of
 *   - an accepted_task_authority row for its accepted source (accepted-task
 *     ownership), or
 *   - a logical_call_settlements row (settlement-spine evidence), or
 *   - a durable sdk_tool_use_recorded event at/after the accepted source
 *     (the SDK lane's own audited evidence marker).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-wf-sdk-evidence-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-wf-sdk-evidence\n', 'utf8');

const {
  processWorkflowRuns,
  _setWorkflowHarnessLoopImplsForTests,
  _setWorkflowVoiceRewriteForTests,
  _setWorkflowWatcherForTests,
} = await import('./workflow-runner.js');
const { deriveWorkflowTerminalOutcome } = await import('./workflow-terminal-outcome.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const { setClaudeAgentSdkWorkflowStepRunForTest } = await import('../runtime/harness/claude-agent-workflow-step.js');

_setWorkflowWatcherForTests(async () => ({ onTrack: true, miss: '', steer: '' }));
_setWorkflowVoiceRewriteForTests(async (body: string) => ({ message: body, nothingHappened: false }));

test.after(() => {
  setClaudeAgentSdkWorkflowStepRunForTest(null);
  _setWorkflowHarnessLoopImplsForTests();
  _setWorkflowVoiceRewriteForTests(null);
  _setWorkflowWatcherForTests(null);
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('an SDK step with only self-reported tool use is blocked without audited evidence ownership', async () => {
  const workflowName = 'SDK Evidence Ownership';
  writeWorkflow('sdk-evidence-ownership', {
    name: workflowName,
    description: '',
    enabled: true,
    trigger: { manual: true },
    steps: [{
      id: 'sync_records',
      prompt: 'Sync the alpha records into the tracker.',
      sideEffect: 'read',
      model: 'claude-sonnet-4-6',
    }],
  });
  const runId = 'sdk-evidence-ownership-run';
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runFile = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(runFile, JSON.stringify({
    id: runId,
    workflow: workflowName,
    status: 'queued',
    inputs: {},
    createdAt: new Date().toISOString(),
  }), 'utf-8');

  // The SDK envelope claims completed work including an external tool crossing.
  // Nothing below writes to any ledger — exactly the production shape, where
  // inner SDK tools do not cross the dispatch/settlement spine.
  setClaudeAgentSdkWorkflowStepRunForTest(async () => ({
    text: '{"status":"completed","output":{"synced":12}}',
    structuredOutput: {
      status: 'completed',
      output: { synced: 12, note: 'All 12 records updated in the tracker.' },
    },
    sessionId: 'sdk-session-evidence-ownership',
    model: 'claude-sonnet-4-6',
    toolUses: ['composio_execute_tool'],
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async () => {
      throw new Error('a Claude-model step must take the SDK lane, not the harness loop');
    }) as never,
  });
  try {
    await processWorkflowRuns({
      respond: async () => { throw new Error('legacy respond path must not run'); },
    } as never);
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
    setClaudeAgentSdkWorkflowStepRunForTest(null);
  }

  const terminal = JSON.parse(readFileSync(runFile, 'utf-8')) as Record<string, unknown>;
  const projected = deriveWorkflowTerminalOutcome(terminal as never);
  assert.notEqual(
    projected,
    'succeeded',
    `the SDK envelope was counted as clean success without host-owned evidence (status=${JSON.stringify(terminal.status)} `
    + `error=${JSON.stringify(terminal.error)})`,
  );

  const stepSessionId = `workflow:${runId}:sync_records`;
  const source = eventlog.listEvents(stepSessionId, { types: ['user_input_received'] })[0];
  assert.ok(source, 'fixture precondition: the runner minted the accepted step source');

  const db = eventlog.openEventLog();
  const authorityRows = (db.prepare(`
    SELECT COUNT(*) AS n FROM accepted_task_authority
     WHERE session_id = ? AND source_user_seq = ?
  `).get(stepSessionId, source.seq) as { n: number }).n;
  const settlementRows = (db.prepare(`
    SELECT COUNT(*) AS n FROM logical_call_settlements WHERE session_id = ?
  `).get(stepSessionId) as { n: number }).n;
  const sdkEvidenceEvents = eventlog.listEvents(stepSessionId, {
    types: ['sdk_tool_use_recorded'],
    sinceSeq: source.seq,
  }).length;

  // FIXTURE PROOF — the fake SDK result deliberately supplies no host-owned
  // crossing. Model-authored `toolUses` is presentation telemetry, not proof.
  assert.equal(authorityRows + settlementRows + sdkEvidenceEvents, 0);
  assert.equal(terminal.needsAttention, true, 'the unaudited SDK result must remain visible as blocked work');
});
