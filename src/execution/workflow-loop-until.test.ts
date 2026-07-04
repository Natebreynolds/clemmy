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
  stepHasLoopProbe,
  loopUntilMaxAttempts,
  runWithContractLoop,
  renderLoopRetryEvidence,
  summarizeAttemptChange,
  attemptRecordsEnabled,
  WorkflowContractViolationError,
} = await import('./workflow-runner.js');
const { checkLoopUntilAuthoring } = await import('./workflow-enforce.js');
const { appendWorkflowEvent, listAttemptRecords } = await import('./workflow-events.js');
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

// ─── T2.3: external exit probe ───────────────────────────────────────────────

const PROBE_LOOP = { probe: { runner: 'check-export-status.ts' }, until: { required_keys: ['done'], non_empty: ['done'] } };

test('stepHasLoopProbe: complete probe+until only', () => {
  assert.equal(stepHasLoopProbe(step({ loopUntil: PROBE_LOOP })), true);
  assert.equal(stepHasLoopProbe(step({ loopUntil: { probe: { runner: 'x.ts' } } })), false);
  assert.equal(stepHasLoopProbe(step({ loopUntil: { until: { required_keys: ['done'] } } })), false);
  assert.equal(stepHasLoopProbe(step()), false);
});

test('stepLoopUntilEnabled: a probe exit qualifies WITHOUT an own-output contract; side-effect law still applies', () => {
  assert.equal(stepLoopUntilEnabled(step({ output: undefined, loopUntil: PROBE_LOOP })), true);
  assert.equal(stepLoopUntilEnabled(step({ output: undefined, loopUntil: PROBE_LOOP, sideEffect: 'send' })), false);
  assert.equal(stepLoopUntilEnabled(step({ output: undefined, loopUntil: PROBE_LOOP, sideEffect: 'write' })), false);
  assert.equal(stepLoopUntilEnabled(step({ output: undefined, loopUntil: PROBE_LOOP, sideEffect: 'write', loopSafe: true })), true);
  assert.equal(stepLoopUntilEnabled(step({ output: undefined, loopUntil: PROBE_LOOP, forEach: 'items' })), false);
});

test('loopUntilMaxAttempts: probe loops clamp to 1–10 (polling needs more passes)', () => {
  assert.equal(loopUntilMaxAttempts(step({ loopUntil: { ...PROBE_LOOP, maxAttempts: 8 } })), 8);
  assert.equal(loopUntilMaxAttempts(step({ loopUntil: { ...PROBE_LOOP, maxAttempts: 99 } })), 10);
  assert.equal(loopUntilMaxAttempts(step({ loopUntil: PROBE_LOOP })), 3);
});

test('checkLoopUntilAuthoring: probe+until is a valid exit; half-declared probe is refused', () => {
  const base: WorkflowDefinition = {
    name: 'poll-export', description: 'x', enabled: true, trigger: { manual: true },
    steps: [step({ output: undefined, loopUntil: PROBE_LOOP })],
  };
  assert.deepEqual(checkLoopUntilAuthoring(base), []);

  const half: WorkflowDefinition = {
    ...base,
    steps: [step({ output: undefined, loopUntil: { probe: { runner: 'x.ts' } } })],
  };
  const errors = checkLoopUntilAuthoring(half);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /incomplete loop_until probe/);
});

test('loopUntil probe/until round-trips through the SKILL.md store', () => {
  const def: WorkflowDefinition = {
    name: 'poll-rt', description: 'probe round trip', enabled: false, trigger: { manual: true },
    steps: [step({ output: undefined, loopUntil: { maxAttempts: 8, ...PROBE_LOOP } })],
  };
  writeWorkflow('poll-rt', def);
  const read = readWorkflow('poll-rt');
  assert.ok(read);
  const lu = read!.data.steps[0].loopUntil!;
  assert.equal(lu.maxAttempts, 8);
  assert.deepEqual(lu.probe, { runner: 'check-export-status.ts' });
  assert.deepEqual(lu.until, { required_keys: ['done'], non_empty: ['done'] });
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

// ─── STATE pillar: comparable per-attempt records (S1) ───────────────────────

test('summarizeAttemptChange: first attempt reports the raw problem count', () => {
  assert.equal(summarizeAttemptChange(1, ['a', 'b'], undefined), 'attempt 1: 2 contract problems');
  assert.equal(summarizeAttemptChange(1, ['a'], undefined), 'attempt 1: 1 contract problem');
});

test('summarizeAttemptChange: later attempts diff fixed / new / still-failing vs the prior set', () => {
  // prior = [a,b,c]; now = [b,c,d] → fixed a (1), new d (1), persisting b,c (2)
  assert.equal(
    summarizeAttemptChange(2, ['b', 'c', 'd'], ['a', 'b', 'c']),
    'attempt 2: fixed 1, 1 new, 2 still failing',
  );
});

test('runWithContractLoop: sampleMetrics snapshot-diff attributes per-attempt cost to onLoopRetry', async () => {
  // Cumulative session counters the loop snapshots before/after each attempt.
  let tokens = 0;
  let toolCalls = 0;
  const seen: Array<{ attempt: number; metrics: { durationMs: number; tokens?: number; toolCalls?: number } }> = [];
  let calls = 0;
  const out = await runWithContractLoop(
    async () => {
      calls += 1;
      // each attempt "spends" 100 tokens + 2 tool calls cumulatively
      tokens += 100;
      toolCalls += 2;
      if (calls < 3) throw violation([`fail ${calls}`]);
      return 'done';
    },
    step(),
    {
      maxAttempts: 3,
      sampleMetrics: () => ({ tokens, toolCalls }),
      onLoopRetry: ({ attempt, metrics }) => seen.push({ attempt, metrics }),
    },
  );
  assert.equal(out, 'done');
  assert.equal(seen.length, 2, 'two failed-then-retried attempts recorded');
  // each retried attempt is attributed exactly its own 100 tokens / 2 tool calls (the DIFF, not cumulative)
  assert.equal(seen[0].metrics.tokens, 100);
  assert.equal(seen[0].metrics.toolCalls, 2);
  assert.equal(seen[1].metrics.tokens, 100);
  assert.equal(seen[1].metrics.toolCalls, 2);
  assert.ok(typeof seen[0].metrics.durationMs === 'number');
});

test('runWithContractLoop: without sampleMetrics, tokens/toolCalls are absent (durationMs still present)', async () => {
  const seen: Array<{ metrics: { durationMs: number; tokens?: number; toolCalls?: number } }> = [];
  let calls = 0;
  await runWithContractLoop(
    async () => { calls += 1; if (calls === 1) throw violation(); return 'ok'; },
    step(),
    { maxAttempts: 2, onLoopRetry: ({ metrics }) => seen.push({ metrics }) },
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].metrics.tokens, undefined);
  assert.equal(seen[0].metrics.toolCalls, undefined);
  assert.ok(typeof seen[0].metrics.durationMs === 'number');
});

test('attemptRecordsEnabled: always on (graduated — CLEMMY_ATTEMPT_RECORDS removed)', () => {
  process.env.CLEMMY_ATTEMPT_RECORDS = 'off';
  assert.equal(attemptRecordsEnabled(), true, 'always on — the removed flag no longer disables it');
  delete process.env.CLEMMY_ATTEMPT_RECORDS;
});

test('listAttemptRecords: attempt_record events round-trip through the run log, scoped by step', () => {
  appendWorkflowEvent('attempt-rt', 'run-1', {
    kind: 'attempt_record',
    stepId: 'scrape',
    attempt: { attemptIndex: 1, maxAttempts: 3, failedProblems: ['min_items'], changeSummary: 'attempt 1: 1 contract problem', metrics: { durationMs: 12, tokens: 100, toolCalls: 2 } },
  });
  appendWorkflowEvent('attempt-rt', 'run-1', { kind: 'step_loop_retry', stepId: 'scrape', meta: { attempt: 1 } });
  appendWorkflowEvent('attempt-rt', 'run-1', {
    kind: 'attempt_record',
    stepId: 'other',
    attempt: { attemptIndex: 1, maxAttempts: 3, failedProblems: ['x'], changeSummary: 'attempt 1: 1 contract problem', metrics: { durationMs: 5 } },
  });
  const all = listAttemptRecords('attempt-rt', 'run-1');
  assert.equal(all.length, 2, 'only attempt_record events, not the step_loop_retry');
  const scoped = listAttemptRecords('attempt-rt', 'run-1', 'scrape');
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].record.metrics.tokens, 100);
  assert.equal(scoped[0].stepId, 'scrape');
  assert.ok(scoped[0].at, 'carries the event timestamp');
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
