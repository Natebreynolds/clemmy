/**
 * The goal reviewer reads the owner's standing instructions exactly as the
 * run's workers had them — pinned through the real workflow runner.
 *
 * Regression (10-02): a weekly report left one person out under the owner's
 * standing rule for weekly reports; the reviewer, which never saw that rule,
 * scored the omission unsubstantiated against the saved workflow's wording.
 *
 * Run: node scripts/run-tests-isolated.mjs src/execution/workflow-goal-standing-instructions.integration.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-goal-standing-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const runner = await import('./workflow-runner.js');
const workflowStore = await import('../memory/workflow-store.js');
const workflowQueue = await import('../tools/workflow-run-queue.js');
const carrier = await import('../runtime/harness/reviewed-local-tool-carrier.js');
const adapters = await import('../runtime/harness/production-capability-adapters.js');
const manifests = await import('../runtime/harness/capability-manifest-store.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const observations = await import('../runtime/harness/independent-capability-observation.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const spaces = await import('../spaces/store.js');
const workspaceDb = await import('../spaces/workspace-db.js');
const { workerStandingInstructions } = await import('./workflow-worker-standing-instructions.js');
const { OWNER_STANDING_INSTRUCTIONS_HEADING, OWNER_STANDING_INSTRUCTIONS_RUBRIC, JUDGE_SYSTEM_PROMPT, CRITERIA_JUDGE_SYSTEM_PROMPT } = await import('../runtime/harness/objective-judge.js');

import type { WorkflowDefinition } from '../memory/workflow-store.js';

test.after(() => {
  runner._setWorkflowRunGoalJudgeForTests(null);
  runner._setWorkflowVoiceRewriteForTests(null);
  runner._setWorkflowWatcherForTests(null);
  workspaceDb.closeWorkspaceDb();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const RULE = '- Going forward, leave the fixture rep off weekly team reports. This applies only to weekly reports.';

/** A worker's retained memory context, as the host records it. */
function memoryContext(sessionId: string, policies: string): void {
  if (!eventlog.getSession(sessionId)) {
    eventlog.createSession({ id: sessionId, kind: 'workflow', channel: 'workflow', metadata: { source: 'workflow' } });
  }
  eventlog.appendEvent({ sessionId, turn: 0, role: 'system', type: 'guardrail_tripped',
    data: { kind: 'model_memory_context', version: 2, sourceUserSeq: 1, digest: `d-${sessionId}`,
      fragments: [[
        '# Persistent Context',
        '## Autonomy',
        '- Proceed on ordinary work.',
        '## User Preferences',
        '- Professional, direct.',
        '## Standing Policies',
        '**Prompt-only instructions (context, not deterministic enforcement)**',
        policies,
        '## Core Personality',
        '- Warm.',
      ].join('\n')], manifest: [], totals: { tokens: 1, bytes: 1, coreTokens: 1, relevantTokens: 0, nowTokens: 0 } } });
}

test('the standing instructions are read from every step of the run and of that run only, once each', () => {
  memoryContext('workflow:run-a:collect', RULE);
  memoryContext('workflow:run-a:compile', RULE);
  memoryContext('workflow:run-a:compile', '- Round figures to whole dollars.');
  memoryContext('workflow:run-b:collect', '- A rule from another run.');
  const text = workerStandingInstructions('run-a') ?? '';
  assert.match(text, /## User Preferences\n- Professional, direct\./);
  assert.equal(text.split('leave the fixture rep off').length - 1, 1, 'the same section is kept once');
  assert.match(text, /Round figures to whole dollars/);
  assert.doesNotMatch(text, /another run/);
  assert.doesNotMatch(text, /Core Personality|Autonomy/, 'only the owner\'s preferences and policies');
  assert.equal(workerStandingInstructions('run-none'), null, 'nothing is reconstructed when no step recorded its context');
  assert.equal(workerStandingInstructions('run-*'), null, 'a run id is matched exactly, never as a pattern');
  assert.ok((workerStandingInstructions('run-a', 120) ?? '').length <= 120, 'bounded');
});

test('both goal reviewers carry one precedence rule for the owner\'s standing instructions', () => {
  assert.ok(JUDGE_SYSTEM_PROMPT.includes(OWNER_STANDING_INSTRUCTIONS_RUBRIC));
  assert.ok(CRITERIA_JUDGE_SYSTEM_PROMPT.includes(OWNER_STANDING_INSTRUCTIONS_RUBRIC));
  assert.ok(OWNER_STANDING_INSTRUCTIONS_RUBRIC.includes(OWNER_STANDING_INSTRUCTIONS_HEADING));
  assert.match(OWNER_STANDING_INSTRUCTIONS_RUBRIC, /never adds a deliverable/);
  assert.match(OWNER_STANDING_INSTRUCTIONS_RUBRIC, /never relaxes a USER CONSTRAINT/);
});

test('FRAMEWORK-TEST-standing-instructions: the run\'s goal review is given the rule its worker had', async () => {
  manifests.installCapabilityManifestStore(manifests.createCapabilityManifestStore());
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  ports.clearProductionCapabilityPorts();
  observations.clearIndependentCapabilityObservations();
  const observed = carrier.observeReviewedLocalTool('space_set_data');
  assert.ok(observed);
  const manifest = carrier.reviewedLocalCapabilityManifest(observed);
  assert.ok(manifest);
  assert.equal(ports.registerFixtureCapabilityPort(ports.productionPortIdentityFromManifest(manifest), {
    invoke: adapters.invokeForSealedManifest(manifest),
    reconcile: adapters.reconcileForSealedManifest(manifest),
  }).ok, true);
  runner._setWorkflowVoiceRewriteForTests((async (message: string) => ({ message, nothingHappened: false })) as never);
  runner._setWorkflowWatcherForTests((async () => ({ onTrack: true })) as never);

  const slug = 'framework-test-standing-instructions';
  spaces.spaceStore.save({ id: slug, title: 'FRAMEWORK-TEST standing instructions', status: 'active',
    viewEntry: 'view/index.html', viewContent: '<!doctype html><title>FRAMEWORK-TEST</title>', dataSources: [], actions: [] });
  const workflow: WorkflowDefinition = {
    name: 'FRAMEWORK-TEST-standing-instructions',
    description: 'Commit one fictional weekly team snapshot into a test Space.',
    enabled: true,
    trigger: { schedule: '0 7 * * 5', timezone: 'UTC' },
    inputs: {},
    steps: [{ id: 'save_snapshot', prompt: '', sideEffect: 'write', call: { tool: 'space_set_data',
      args: { slug, source_id: 'weekly', data_json: JSON.stringify({ reps: ['fixture-rep-1', 'fixture-rep-2'] }) } } }],
    goal: { objective: 'Save this week\'s snapshot for the whole team roster.', successCriteria: ['The snapshot is saved'], maxAttempts: 1 },
  };
  const persisted = workflowStore.writeWorkflow(workflow.name, workflow);
  const reviewed: string[] = [];
  runner._setWorkflowRunGoalJudgeForTests({
    judge: async (_objective: string, evidenceText: string) => { reviewed.push(evidenceText); return { done: true, reason: 'saved' }; },
    judgeCriteria: async (_objective: string, criteria: string[], evidenceText: string) => {
      reviewed.push(evidenceText);
      return criteria.map(() => ({ pass: true, note: 'saved' }));
    },
  } as never);

  const queued = workflowQueue.queueWorkflowRun(persisted.data.name, {}, {
    source: 'schedule', workflowSlug: persisted.name,
    triggerReceiptId: `workflow-schedule:v1:${persisted.name}:1790000000000`, dedupe: false,
  });
  assert.equal(queued.status, 'queued', queued.message);
  memoryContext(`workflow:${queued.id!}:save_snapshot`, RULE);

  await runner.processWorkflowRuns({} as never);

  assert.ok(reviewed.length > 0, 'the goal reviewer ran');
  const evidence = reviewed.join('\n');
  assert.ok(evidence.includes(OWNER_STANDING_INSTRUCTIONS_HEADING), 'under the heading the shared rule names');
  assert.ok(evidence.includes(RULE.slice(2)), 'the owner\'s rule exactly as the worker had it');
});
