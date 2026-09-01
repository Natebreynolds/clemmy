/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/workflow-self-improvement.test.ts
 *
 * Live 2026-09-01: a saved workflow whose first step was a retired script
 * runner was refused by readiness at every source, with no way through but a
 * human rewriting YAML. Pinned here: the queue turns that refusal into an
 * improvement request and a `held` answer; the improvement turn runs under a
 * scope, and CODE decides whether the rewrite kept the user's intent — a
 * faithful rewrite is applied and the run re-queued, an unfaithful one is
 * reverted byte-for-byte.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-self-improve-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });

const store = await import('../memory/workflow-store.js');
const write = await import('./workflow-write.js');
const improvement = await import('./workflow-self-improvement.js');
const readiness = await import('./workflow-run-readiness.js');
const queue = await import('../tools/workflow-run-queue.js');
const eventlog = await import('../runtime/harness/eventlog.js');

const SLUG = 'legacy-team-update';
const CHANNEL = 'C0BHT7WHZDL';

function legacyDefinition(): Parameters<typeof write.writeWorkflowAndSyncTriggers>[1] {
  return {
    name: SLUG,
    description: 'Post the deterministic team activity summary.',
    enabled: true,
    trigger: { manual: true, schedule: '0 9 * * 1-5', timezone: 'America/Los_Angeles' },
    goal: { objective: 'Post the exact activity summary to the team channel.' },
    steps: [
      {
        id: 'pull_activity',
        prompt: '',
        deterministic: { runner: 'scripts/pull-activity.mjs' },
        sideEffect: 'write',
        output: { type: 'object', required_keys: ['summary'], non_empty: ['summary'] },
      },
      {
        id: 'post_slack',
        prompt: `Post the summary from step pull_activity to channel ${CHANNEL} with SLACK_SEND_MESSAGE exactly once.`,
        dependsOn: ['pull_activity'],
        sideEffect: 'send',
        allowedTools: ['composio_execute_tool'],
        output: { type: 'object', required_keys: ['messageTs'], non_empty: ['messageTs'] },
      },
    ],
  } as never;
}

function improvedSteps() {
  return [
    {
      id: 'pull_activity_calls',
      prompt: '',
      sideEffect: 'read',
      call: { tool: 'salesforce_sf_soql_query', args: { target_org: 'user@example.com', query: 'SELECT Id FROM Task' } },
      output: { type: 'object', required_keys: ['stdout'], non_empty: ['stdout'] },
    },
    {
      id: 'pull_activity',
      prompt: 'Render the stdout of step pull_activity_calls into the exact deterministic summary text. Return {"summary": "..."}.',
      dependsOn: ['pull_activity_calls'],
      sideEffect: 'read',
      output: { type: 'object', required_keys: ['summary'], non_empty: ['summary'] },
    },
    {
      id: 'post_slack',
      prompt: `Post the summary from step pull_activity to channel ${CHANNEL} with SLACK_SEND_MESSAGE exactly once.`,
      dependsOn: ['pull_activity'],
      sideEffect: 'send',
      allowedTools: ['composio_execute_tool'],
      output: { type: 'object', required_keys: ['messageTs'], non_empty: ['messageTs'] },
    },
  ];
}

function seedLegacyWorkflow() {
  const entry = write.writeWorkflowAndSyncTriggers(SLUG, legacyDefinition());
  mkdirSync(path.join(entry.dir, 'scripts'), { recursive: true });
  writeFileSync(path.join(entry.dir, 'scripts', 'pull-activity.mjs'), '// legacy runner\nconsole.log(JSON.stringify({ summary: "x" }));\n');
  return entry;
}

test.after(() => {
  try { eventlog.closeEventLog(); } catch { /* not opened */ }
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('readiness refuses the legacy runner; the queue answers held and records one improvement request', () => {
  seedLegacyWorkflow();
  const entry = store.readWorkflow(SLUG)!;
  const check = readiness.checkWorkflowRunReadiness(entry.data, SLUG);
  assert.equal(check.ok, false);
  assert.ok(improvement.improvableReadinessBlockers(check).length > 0, JSON.stringify(check.blockers));

  const queued = queue.queueWorkflowRun(SLUG, {}, { source: 'dashboard', dedupe: false });
  assert.equal(queued.status, 'held', JSON.stringify(queued));
  assert.match(queued.message, /rewriting that step/);
  const request = improvement.readWorkflowImprovement(SLUG);
  assert.ok(request);
  assert.equal(request.status, 'pending');
  assert.equal(request.source, 'dashboard');
  assert.deepEqual(request.runners, [{ stepId: 'pull_activity', kind: 'deterministic.runner', runner: 'scripts/pull-activity.mjs' }]);

  // A second ask while pending does not mint a second request.
  const again = queue.queueWorkflowRun(SLUG, {}, { source: 'schedule', dedupe: false });
  assert.equal(again.status, 'held');
  assert.equal(improvement.listPendingWorkflowImprovements().length, 1);

  // A capability/account blocker is not this lane's business.
  assert.equal(improvement.requestWorkflowImprovement({
    slug: 'other',
    definition: { name: 'other', steps: [{ id: 'a', prompt: 'read things' }] } as never,
    readiness: { blockers: [{ kind: 'tool', name: 'x', reason: 'workflow_readiness_blocked: missing tool' } as never] },
    source: 'dashboard',
  }), null);
});

test('the prompt names the script to read and the rules that keep intent', () => {
  const entry = store.readWorkflow(SLUG)!;
  const request = improvement.readWorkflowImprovement(SLUG)!;
  const prompt = improvement.buildWorkflowImprovementPrompt({ request, entry });
  assert.match(prompt, /scripts\/pull-activity\.mjs/);
  assert.match(prompt, /full source included below/);
  assert.match(prompt, /BEGIN current definition/, 'the definition rides in the prompt so the first call can be authoring');
  assert.match(prompt, /name: legacy-team-update/);
  assert.match(prompt, /Do not spend calls on workflow_get/);
  assert.match(prompt, /\/\/ legacy runner/, 'the script bytes ride in the prompt so the turn spends no lookups paging them');
  assert.match(prompt, /workflow_update/);
  assert.match(prompt, /Preserve WHAT the workflow does/);
  assert.match(prompt, /workflow_raw_subprocess_authority_unrepresented/);
});

test('the intent guard accepts a faithful rewrite and names every drift', () => {
  const before = store.readWorkflow(SLUG)!.data;
  const good = { ...before, steps: improvedSteps() } as never;
  const accepted = improvement.guardImprovedWorkflowDefinition({ before, after: good, slug: SLUG });
  assert.deepEqual(accepted, { ok: true, violations: [] });

  const drifted = {
    ...before,
    trigger: { manual: true },
    goal: { objective: 'Something else' },
    steps: [
      ...improvedSteps().slice(0, 2),
      { ...improvedSteps()[2], prompt: 'Post the summary to channel C0OTHER12345.' },
      { id: 'legacy', prompt: '', deterministic: { runner: 'scripts/x.mjs' } },
    ],
  } as never;
  const rejected = improvement.guardImprovedWorkflowDefinition({ before, after: drifted, slug: SLUG });
  assert.equal(rejected.ok, false);
  const text = rejected.violations.join(' | ');
  assert.match(text, /trigger changed/);
  assert.match(text, /goal changed/);
  assert.match(text, new RegExp(`send destination "${CHANNEL}" no longer present`));
  assert.match(text, /legacy runner still declared/);
});

test('a faithful improvement turn is applied, a drifting one is reverted byte-for-byte', async () => {
  const entry = store.readWorkflow(SLUG)!;
  const originalBytes = readFileSync(entry.filePath, 'utf8');
  const scopes: string[] = [];
  const request = improvement.readWorkflowImprovement(SLUG)!;

  const applied = await improvement.runWorkflowImprovement({
    request,
    model: 'fixture-brain',
    executeTurn: async (turn) => {
      assert.match(turn.message, /Workflow self-improvement/);
      assert.equal(turn.model, 'fixture-brain');
      write.writeWorkflowAndSyncTriggers(SLUG, { ...entry.data, steps: improvedSteps() } as never);
      return { text: 'Rewrote pull_activity into one exact SOQL read plus a render step; the Slack post is unchanged.' };
    },
    openScope: (scope) => { scopes.push(`open:${scope.sessionId}`); },
    closeScope: (sessionId, reason) => { scopes.push(`close:${sessionId}:${reason}`); },
  });
  assert.equal(applied.status, 'done', JSON.stringify(applied));
  assert.ok(applied.backupPath && existsSync(applied.backupPath), 'a byte backup exists');
  assert.equal(readFileSync(applied.backupPath!, 'utf8'), originalBytes);
  assert.equal(scopes.length, 2);
  assert.match(scopes[1]!, /workflow-improvement-finished/);
  assert.equal(improvement.readWorkflowImprovement(SLUG)?.status, 'done');
  const after = store.readWorkflow(SLUG)!.data;
  assert.equal(improvement.legacyRunnerDeclarations(after).length, 0);
  assert.equal(readiness.checkWorkflowRunReadiness(after, SLUG).ok, true);

  // Reset to legacy and run a turn that changes the trigger: reverted.
  write.writeWorkflowAndSyncTriggers(SLUG, legacyDefinition());
  const fresh = improvement.requestWorkflowImprovement({
    slug: SLUG,
    definition: store.readWorkflow(SLUG)!.data,
    readiness: readiness.checkWorkflowRunReadiness(store.readWorkflow(SLUG)!.data, SLUG),
    source: 'dashboard',
    now: () => Date.now() + improvement.WORKFLOW_IMPROVEMENT_RETRY_COOLDOWN_MS + 1,
  });
  assert.equal(fresh?.status, 'requested');
  const reverted = await improvement.runWorkflowImprovement({
    request: fresh!.request,
    executeTurn: async () => {
      write.writeWorkflowAndSyncTriggers(SLUG, { ...legacyDefinition(), trigger: { manual: true }, steps: improvedSteps() } as never);
      return { text: 'changed the schedule too' };
    },
    openScope: () => {},
    closeScope: () => {},
  });
  assert.equal(reverted.status, 'failed');
  assert.match(reverted.violations?.join(' ') ?? '', /trigger changed/);
  const restored = store.readWorkflow(SLUG)!;
  assert.equal(improvement.legacyRunnerDeclarations(restored.data).length, 1, 'the original definition is back');
  assert.deepEqual(restored.data.trigger, legacyDefinition().trigger);
  assert.equal(improvement.readWorkflowImprovement(SLUG)?.status, 'failed');
});

test('a request left running by a daemon that stopped mid-turn becomes pending again once its wall clock has elapsed', () => {
  const stateFile = path.join(TEST_HOME, 'state', 'improvements-stale.json');
  const requested = improvement.requestWorkflowImprovement({
    slug: 'stale-runner',
    definition: { name: 'stale-runner', steps: [{ id: 'x', prompt: '', deterministic: { runner: 'scripts/x.mjs' } }] } as never,
    readiness: { blockers: [{ kind: 'script', name: 'x', reason: 'workflow_raw_subprocess_authority_unrepresented: legacy' } as never] },
    source: 'schedule',
    stateFile,
  });
  assert.equal(requested?.status, 'requested');
  const startedAt = Date.now() - improvement.WORKFLOW_IMPROVEMENT_WALL_CLOCK_MS - 120_000;
  writeFileSync(stateFile, JSON.stringify({
    'stale-runner': { ...requested!.request, status: 'running', startedAt: new Date(startedAt).toISOString() },
  }));
  assert.equal(improvement.listPendingWorkflowImprovements(stateFile, () => startedAt + 1_000).length, 0, 'a fresh running turn is left alone');
  assert.equal(improvement.listPendingWorkflowImprovements(stateFile).length, 1, 'a stale running turn is retried');
});
