/**
 * Run: node scripts/run-tests-isolated.mjs src/agents/watches.integration.test.ts
 *
 * The connection, end to end through the workflow runner: a watch workflow's
 * run finishes, its report becomes retained watch history, a From Clem item
 * titled by its source, and a memory fact tagged with the watch.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-watch-integration-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMENTINE_WORKFLOW_HARNESS_POLL_MS = '20';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-watch-integration\n', 'utf8');

const {
  processWorkflowRuns,
  _setWorkflowDiagnosisForTests,
  _setWorkflowHarnessLoopImplsForTests,
  _setWorkflowVoiceRewriteForTests,
  _setWorkflowWatcherForTests,
} = await import('../execution/workflow-runner.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { recordStepResult } = await import('../tools/step-result-tool.js');
const { loadNotifications } = await import('../runtime/notifications.js');
const { searchFactsByText } = await import('../memory/facts.js');
const { loadWatchState } = await import('./watches.js');
const eventlog = await import('../runtime/harness/eventlog.js');

_setWorkflowWatcherForTests(async () => ({ onTrack: true, miss: '', steer: '' }));
_setWorkflowVoiceRewriteForTests(async (body: string) => ({ message: body, nothingHappened: false }));
_setWorkflowDiagnosisForTests(async () => null);

test.after(() => {
  _setWorkflowHarnessLoopImplsForTests();
  _setWorkflowVoiceRewriteForTests(null);
  _setWorkflowWatcherForTests(null);
  _setWorkflowDiagnosisForTests(null);
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

async function until<T>(read: () => T, done: (value: T) => boolean, ms = 4_000): Promise<T> {
  const deadline = Date.now() + ms;
  let value = read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    value = read();
  }
  return value;
}

test("a watch run's findings reach From Clem by their source, and what it learned is remembered", async () => {
  const workflowName = 'FRAMEWORK-TEST Fixture Inbox Watch';
  const slug = 'framework-test-fixture-inbox-watch';
  writeWorkflow(slug, {
    name: workflowName,
    description: 'Fixture: watch a folder of client notes for unhappy clients.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'judge', prompt: 'Read the new client notes and report unhappy clients.', sideEffect: 'read' }],
    watch: { source: 'fixture client notes', lookFor: 'a client who sounds unhappy', purpose: 'tell_me' },
  } as Parameters<typeof writeWorkflow>[1]);
  const runId = 'framework-test-fixture-inbox-watch-run';
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId, workflow: workflowName, status: 'queued', inputs: {}, createdAt: new Date().toISOString(),
  }), 'utf-8');
  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async (options: { sessionId: string }) => {
      recordStepResult(options.sessionId, {
        findings: [{ key: 'note-7', title: 'Acme sounds frustrated about the rollout date', detail: 'Two notes today asking for a date.' }],
        learned: ['Dana Ortiz is the Acme champion.'],
      });
      return {
        sessionId: options.sessionId, status: 'completed', steps: 1, lastTurn: 1,
        lastDecision: { summary: 'done', reply: 'done', done: true, nextAction: 'completed' },
      };
    }) as never,
  });
  try {
    await processWorkflowRuns({ respond: async () => { throw new Error('legacy respond path must not run'); } } as never);
    const state = await until(() => loadWatchState(slug), (value) => value.runs.length > 0);
    assert.equal(state.runs.length, 1, 'the run was recorded on its watch');
    assert.equal(state.runs[0]?.report, 'ok');
    const item = loadNotifications().find((row) => row.metadata?.watch === `watch:${slug}`);
    assert.ok(item, 'the finding was raised');
    assert.equal(item.title, 'Acme sounds frustrated about the rollout date');
    assert.equal(item.metadata?.itemKey, 'note-7');
    assert.equal(item.metadata?.sourceTitle, 'Your fixture client notes watch');
    assert.equal(item.silent, true, 'quiet by default: Home and From Clem, never a push');
    const facts = searchFactsByText('Acme champion', 5);
    assert.ok(facts.some((fact) => /From the fixture client notes watch: Dana Ortiz is the Acme champion\./.test(fact.content)),
      'what the watch learned is remembered, tagged with the watch');
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
  }
});
