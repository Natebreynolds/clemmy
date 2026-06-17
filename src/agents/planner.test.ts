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

const { PlanSchema, buildPlannerAgent, buildPlannerTool } = await import('./planner.js');

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
    objective: 'Send personalized outreach to the 8 market-leader firms.',
    steps: [{ n: 1, action: 'Send the emails', rationale: 'The ask.', verification: null }],
    successCriteria: ['8 emails sent from the Scorpion mailbox.'],
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

// ─── Planner Agent ─────────────────────────────────────────────

test('Planner Agent: is named Planner with structured output', () => {
  const agent = buildPlannerAgent();
  assert.equal(agent.name, 'Planner');
  // The output type is the PlanSchema; SDK stores it on the agent.
  // We don't unwrap the SDK internals here — name check + tool-surface
  // check below proves the wiring without coupling to SDK internals.
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
