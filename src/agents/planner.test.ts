/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-planner npx tsx --test src/agents/planner.test.ts
 *
 * The planner is an LLM agent — we don't try to validate its
 * judgement here. We DO validate:
 *   - The PlanSchema accepts realistic plans and rejects malformed ones.
 *   - The Planner Agent itself is read-only (tool surface narrow).
 *   - The asTool wrapper exposes the expected name/description.
 *   - The customOutputExtractor serializes a plan to JSON.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-planner';
process.env.CLEMENTINE_HOME = TEST_HOME;

const { PlanSchema, buildPlannerAgent, buildPlannerTool, _testOnly_sanitizePlanOutput } = await import('./planner.js');

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME + '/state', { recursive: true });
});

// ─── PlanSchema ────────────────────────────────────────────────

test('PlanSchema: accepts a minimal valid plan', () => {
  const plan = PlanSchema.parse({
    objective: 'Add a refresh token handler to the Composio client.',
    steps: [
      { n: 1, action: 'Read src/integrations/composio/client.ts', rationale: 'Confirm current auth path.', verification: null },
    ],
    successCriteria: ['The refresh handler retries on 401 once with a fresh token.'],
    stages: null,
    risks: [],
    estimatedComplexity: 'moderate',
    recommendsTrackedExecution: false,
    needsUserInput: [],
    appliedInstructions: [],
    externalSends: null,
  });
  assert.equal(plan.objective.startsWith('Add a refresh'), true);
  assert.equal(plan.steps[0].n, 1);
});

test('PlanSchema: accepts authored stages partitioning the criteria', () => {
  const plan = PlanSchema.parse({
    objective: 'Build the Q2 outreach list and draft the emails.',
    steps: [{ n: 1, action: 'Pull accounts', rationale: 'Source of truth.', verification: null }],
    successCriteria: ['A brief exists.', 'Drafts exist for the top 3 accounts.'],
    stages: [
      { title: 'Research', criteria: ['A brief exists.'] },
      { title: 'Draft', criteria: ['Drafts exist for the top 3 accounts.'] },
    ],
    risks: [],
    estimatedComplexity: 'large',
    recommendsTrackedExecution: true,
    needsUserInput: [],
    appliedInstructions: [],
    externalSends: null,
  });
  assert.equal(plan.stages!.length, 2);
  assert.equal(plan.stages![0].title, 'Research');
});

test('PlanSchema: accepts enumerated externalSends (what the user blesses on approval)', () => {
  const plan = PlanSchema.parse({
    objective: 'Send personalized outreach to the 8 priority-account firms.',
    steps: [{ n: 1, action: 'Send the emails', rationale: 'The ask.', verification: null }],
    successCriteria: ['8 emails sent from the Acme mailbox.'],
    stages: null,
    risks: ['Irreversible: emails cannot be unsent.'],
    estimatedComplexity: 'moderate',
    recommendsTrackedExecution: false,
    needsUserInput: [],
    appliedInstructions: [],
    externalSends: [
      { slug: 'OUTLOOK_SEND_EMAIL', summary: 'personalized outreach to 8 firms', count: 8 },
    ],
  });
  assert.equal(plan.externalSends!.length, 1);
  assert.equal(plan.externalSends![0].slug, 'OUTLOOK_SEND_EMAIL');
  assert.equal(plan.externalSends![0].count, 8);
});

test('PlanSchema: rejects empty objective', () => {
  assert.throws(() => PlanSchema.parse({
    objective: '',
    steps: [{ n: 1, action: 'do thing', rationale: 'why', verification: null }],
    successCriteria: ['it works'],
    risks: [],
    estimatedComplexity: 'trivial',
    recommendsTrackedExecution: false,
    needsUserInput: [],
  }));
});

test('PlanSchema: rejects zero steps', () => {
  assert.throws(() => PlanSchema.parse({
    objective: 'A real objective.',
    steps: [],
    successCriteria: ['done'],
    risks: [],
    estimatedComplexity: 'trivial',
    recommendsTrackedExecution: false,
    needsUserInput: [],
  }));
});

test('PlanSchema: rejects bad complexity enum', () => {
  assert.throws(() => PlanSchema.parse({
    objective: 'A real objective.',
    steps: [{ n: 1, action: 'do thing', rationale: 'why', verification: null }],
    successCriteria: ['it works'],
    risks: [],
    estimatedComplexity: 'small',
    recommendsTrackedExecution: false,
    needsUserInput: [],
  }));
});

test('PlanSchema: caps steps and successCriteria', () => {
  const tooMany = Array.from({ length: 21 }, (_, i) => ({ n: i + 1, action: 'a', rationale: 'b' }));
  assert.throws(() => PlanSchema.parse({
    objective: 'Some objective',
    steps: tooMany,
    successCriteria: ['ok'],
    risks: [],
    estimatedComplexity: 'large',
    recommendsTrackedExecution: true,
    needsUserInput: [],
  }));
});

test('sanitizePlanOutput accepts fenced schema-drifted JSON', () => {
  const plan = _testOnly_sanitizePlanOutput('```json\n' + JSON.stringify({
    goal: 'Draft approved outreach emails for the top accounts.',
    actions: [
      { step: 'Review standing outbound instructions.', why: 'Respect user preferences.', check: 'Instructions are reflected in the drafts.' },
      'Create the draft emails for review.',
    ],
    criteria: ['Drafts exist for the selected accounts.'],
    milestones: [{ name: 'Draft', successCriteria: ['Drafts exist for the selected accounts.'] }],
    risks: 'Irreversible if emails are sent instead of drafted.',
    complexity: 'small',
    trackedExecution: 'false',
    questions: 'Which accounts should be included?',
    applied_instructions: 'Do not send without approval.',
    external_sends: [{ tool: 'OUTLOOK_SEND_EMAIL', target: 'approved account outreach', count: '3' }],
  }) + '\n```');

  assert.ok(plan);
  assert.equal(plan.objective, 'Draft approved outreach emails for the top accounts.');
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[1].n, 2);
  assert.equal(plan.estimatedComplexity, 'moderate');
  assert.equal(plan.recommendsTrackedExecution, false);
  assert.deepEqual(plan.needsUserInput, ['Which accounts should be included?']);
  assert.deepEqual(plan.appliedInstructions, ['Do not send without approval.']);
  assert.deepEqual(plan.externalSends, [
    { slug: 'OUTLOOK_SEND_EMAIL', summary: 'approved account outreach', count: 3 },
  ]);
});

// ─── Planner Agent ─────────────────────────────────────────────

test('Planner Agent: is named Planner', () => {
  const agent = buildPlannerAgent();
  assert.equal(agent.name, 'Planner');
});

test('Planner Agent: tool surface is read-only', () => {
  const agent = buildPlannerAgent();
  const tools = agent.tools ?? [];
  // No mutation tools — none of the executor / writer write tools
  // should be present. We check by name.
  const forbidden = new Set([
    'task_add', 'task_update', 'goal_create', 'goal_update', 'goal_delete',
    'write_file', 'run_shell_command',
    'notify_user', 'ask_user_question', 'answer_check_in',
    'execution_update_step', 'execution_complete', 'execution_mark_blocked',
    'create_plan', 'update_plan_step',
    'team_message', 'team_request', 'team_reply',
    'memory_remember', 'memory_forget',
    'workspace_config',
  ]);
  for (const tool of tools) {
    const name = (tool as { name?: string }).name;
    if (!name) continue;
    assert.equal(forbidden.has(name), false, `Planner has forbidden mutation tool: ${name}`);
  }
});

test('Planner Agent: has at least the basic read tools', () => {
  const agent = buildPlannerAgent();
  const names = new Set((agent.tools ?? []).map((t) => (t as { name?: string }).name).filter(Boolean) as string[]);
  for (const required of ['memory_recall', 'read_file', 'list_files', 'session_history', 'goal_list']) {
    assert.equal(names.has(required), true, `Planner is missing required read tool: ${required}`);
  }
});

// ─── asTool wrapper ────────────────────────────────────────────

test('buildPlannerTool: exposes the expected name + description', () => {
  const t = buildPlannerTool() as { name?: string; description?: string };
  assert.equal(t.name, 'draft_plan');
  assert.ok(t.description && t.description.length > 50, 'description should be informative');
  // The orchestrator must know it is read-only — that phrase or
  // equivalent should be present so the model trusts it.
  assert.match(t.description ?? '', /read[- ]?only|does not mutate/i);
});
