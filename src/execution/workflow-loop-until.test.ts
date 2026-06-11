/**
 * Run: npx tsx --test src/execution/workflow-loop-until.test.ts
 *
 * Workflow loopUntil (GOAL-CONTRACT-PLAN.md Phase 2):
 *   - stepLoopUntilEnabled: side-effect law (read loops; write needs
 *     loopSafe; send never; forEach/deterministic excluded; contract required)
 *   - loopUntilMaxAttempts: default 3, clamped 1–5
 *   - runWithContractLoop: success passthrough, retry-with-evidence on a
 *     contract violation, exhaustion rethrows, non-contract errors propagate
 *   - checkLoopUntilAuthoring: refuses misconfigured ENABLED workflows,
 *     never blocks disabled drafts
 *   - workflow-store: loop_until / loop_safe round-trip SKILL.md
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-loop-until';
process.env.CLEMENTINE_HOME = TEST_HOME;

const {
  stepLoopUntilEnabled,
  loopUntilMaxAttempts,
  runWithContractLoop,
  renderLoopRetryEvidence,
  WorkflowContractViolationError,
} = await import('./workflow-runner.js');
const { checkLoopUntilAuthoring } = await import('./workflow-enforce.js');
const { writeWorkflow, readWorkflow } = await import('../memory/workflow-store.js');
import type { WorkflowStepInput, WorkflowDefinition } from '../memory/workflow-store.js';

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
});

const CONTRACT = { type: 'array' as const, min_items: { '': 10 } };

function step(overrides: Partial<WorkflowStepInput> = {}): WorkflowStepInput {
  return {
    id: 'scrape',
    prompt: 'Scrape the directory listing and return the rows as a JSON array.',
    sideEffect: 'read',
    output: CONTRACT,
    loopUntil: {},
    ...overrides,
  };
}

function violation(problems: string[] = ['min_items: output "(root)" has 2 item(s), needs at least 10']) {
  return new WorkflowContractViolationError('contract failed', 'scrape', problems, 'output_contract');
}

// ─── eligibility (the side-effect law) ───────────────────────────────────────

test('stepLoopUntilEnabled: read step with contract + loopUntil loops', () => {
  assert.equal(stepLoopUntilEnabled(step()), true);
});

test('stepLoopUntilEnabled: send steps NEVER loop (declared or heuristic)', () => {
  assert.equal(stepLoopUntilEnabled(step({ sideEffect: 'send' })), false);
  assert.equal(
    stepLoopUntilEnabled(step({ sideEffect: undefined, prompt: 'send the emails to the prospect list, then return the count' })),
    false,
    'prose heuristic classifies a send even without the declared field',
  );
});

test('stepLoopUntilEnabled: write steps require the explicit loopSafe assertion', () => {
  assert.equal(stepLoopUntilEnabled(step({ sideEffect: 'write' })), false);
  assert.equal(stepLoopUntilEnabled(step({ sideEffect: 'write', loopSafe: true })), true);
});

test('stepLoopUntilEnabled: requires loopUntil + an output contract; plain steps only', () => {
  assert.equal(stepLoopUntilEnabled(step({ loopUntil: undefined })), false);
  assert.equal(stepLoopUntilEnabled(step({ output: undefined })), false);
  assert.equal(stepLoopUntilEnabled(step({ forEach: 'items' })), false);
  assert.equal(stepLoopUntilEnabled(step({ deterministic: { runner: 'export.ts' } })), false);
});

test('loopUntilMaxAttempts: default 3, clamped to 1–5', () => {
  assert.equal(loopUntilMaxAttempts(step()), 3);
  assert.equal(loopUntilMaxAttempts(step({ loopUntil: { maxAttempts: 5 } })), 5);
  assert.equal(loopUntilMaxAttempts(step({ loopUntil: { maxAttempts: 99 } })), 5);
  assert.equal(loopUntilMaxAttempts(step({ loopUntil: { maxAttempts: 0 } })), 1);
});

// ─── the loop harness ────────────────────────────────────────────────────────

test('runWithContractLoop: a passing first attempt runs once, untouched prompt', async () => {
  const prompts: string[] = [];
  const out = await runWithContractLoop(async (s) => { prompts.push(s.prompt); return 'ok'; }, step(), { maxAttempts: 3 });
  assert.equal(out, 'ok');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0], step().prompt, 'first attempt prompt is unamended');
});

test('runWithContractLoop: contract failure re-runs with the evidence injected; success returns', async () => {
  const prompts: string[] = [];
  const retries: { attempt: number; problems: string[] }[] = [];
  let calls = 0;
  const out = await runWithContractLoop(
    async (s) => {
      prompts.push(s.prompt);
      calls += 1;
      if (calls < 3) throw violation([`min_items: got ${calls * 2}, needs 10`]);
      return 'rows';
    },
    step(),
    { maxAttempts: 3, onLoopRetry: ({ attempt, problems }) => retries.push({ attempt, problems }) },
  );
  assert.equal(out, 'rows');
  assert.equal(calls, 3);
  assert.equal(retries.length, 2);
  assert.match(prompts[1], /CONTRACT RETRY \(attempt 2\)/);
  assert.match(prompts[1], /min_items: got 2/);
  assert.match(prompts[2], /CONTRACT RETRY \(attempt 3\)/, 'each retry is amended from the ORIGINAL prompt');
  assert.match(prompts[2], /min_items: got 4/);
  assert.doesNotMatch(prompts[2], /got 2, needs 10/, 'evidence does not stack across attempts');
});

test('runWithContractLoop: exhausting attempts rethrows the LAST violation', async () => {
  let calls = 0;
  await assert.rejects(
    runWithContractLoop(async () => { calls += 1; throw violation([`attempt ${calls} failed`]); }, step(), { maxAttempts: 3 }),
    (err: unknown) => err instanceof WorkflowContractViolationError && /attempt 3 failed/.test(err.problems[0]),
  );
  assert.equal(calls, 3);
});

test('runWithContractLoop: a NON-contract error propagates immediately (no loop)', async () => {
  let calls = 0;
  await assert.rejects(
    runWithContractLoop(async () => { calls += 1; throw new Error('network down'); }, step(), { maxAttempts: 3 }),
    /network down/,
  );
  assert.equal(calls, 1);
});

test('runWithContractLoop: beforeRetry fires between attempts (cancel-check seam)', async () => {
  let beforeRetryCalls = 0;
  let calls = 0;
  await runWithContractLoop(
    async () => { calls += 1; if (calls === 1) throw violation(); return 'ok'; },
    step(),
    { maxAttempts: 2, beforeRetry: () => { beforeRetryCalls += 1; } },
  );
  assert.equal(beforeRetryCalls, 1);
});

test('renderLoopRetryEvidence caps the problem list and tells the step how to bail honestly', () => {
  const text = renderLoopRetryEvidence(1, Array.from({ length: 10 }, (_, i) => `problem ${i}`));
  assert.equal((text.match(/^- /gm) ?? []).length, 6, 'at most 6 problems listed');
  assert.match(text, /blocked/, 'offers the honest-blocker escape hatch');
});

// ─── authoring law ───────────────────────────────────────────────────────────

function wf(steps: WorkflowStepInput[], enabled = true): WorkflowDefinition {
  return { name: 'loop-test', description: 'loop test', enabled, trigger: { manual: true }, steps };
}

test('checkLoopUntilAuthoring: read step with contract is clean', () => {
  assert.deepEqual(checkLoopUntilAuthoring(wf([step()])), []);
});

test('checkLoopUntilAuthoring: refuses loop_until without an output contract', () => {
  const errors = checkLoopUntilAuthoring(wf([step({ output: undefined })]));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no output contract/);
});

test('checkLoopUntilAuthoring: refuses loop_until on send and unsafe write; loop_safe clears the write', () => {
  assert.match(checkLoopUntilAuthoring(wf([step({ sideEffect: 'send' })]))[0], /never loop/);
  assert.match(checkLoopUntilAuthoring(wf([step({ sideEffect: 'write' })]))[0], /loop_safe/);
  assert.deepEqual(checkLoopUntilAuthoring(wf([step({ sideEffect: 'write', loopSafe: true })])), []);
});

test('checkLoopUntilAuthoring: refuses forEach/deterministic; never blocks a disabled draft', () => {
  assert.match(checkLoopUntilAuthoring(wf([step({ forEach: 'items' })]))[0], /plain LLM steps only/);
  assert.match(checkLoopUntilAuthoring(wf([step({ deterministic: { runner: 'x.ts' } })]))[0], /plain LLM steps only/);
  assert.deepEqual(checkLoopUntilAuthoring(wf([step({ sideEffect: 'send' })], false)), [], 'disabled draft saves');
});

// ─── store round-trip ────────────────────────────────────────────────────────

test('workflow-store: loop_until + loop_safe round-trip SKILL.md', () => {
  writeWorkflow('loop-rt', wf([
    step({ id: 'a', loopUntil: { maxAttempts: 4 } }),
    step({ id: 'b', sideEffect: 'write', loopSafe: true, loopUntil: {} }),
    step({ id: 'c', loopUntil: undefined }),
  ]));
  const back = readWorkflow('loop-rt')!.data;
  assert.deepEqual(back.steps[0].loopUntil, { maxAttempts: 4 });
  assert.equal(back.steps[0].loopSafe, undefined);
  assert.deepEqual(back.steps[1].loopUntil, {});
  assert.equal(back.steps[1].loopSafe, true);
  assert.equal(back.steps[2].loopUntil, undefined, 'absent stays absent');
});

test('workflow-store: parse clamps a malformed max_attempts', () => {
  writeWorkflow('loop-clamp', wf([step({ id: 'a', loopUntil: { maxAttempts: 99 } })]));
  const back = readWorkflow('loop-clamp')!.data;
  assert.deepEqual(back.steps[0].loopUntil, { maxAttempts: 5 });
});
