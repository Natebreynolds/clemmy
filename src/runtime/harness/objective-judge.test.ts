/**
 * Run: npx tsx --test src/runtime/harness/objective-judge.test.ts
 *
 * Pure + fail-open behavior of the objective judge. The live model call is
 * NOT unit-tested (covered via the loop's injected judgeFn tests).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildObjectiveJudgePrompt, judgeObjectiveComplete, shouldRunObjectiveJudge, isPromiseShapedReply, clipForJudge, JUDGE_RESPONSE_MAX_CHARS, parseCompletionVerdict } = await import('./objective-judge.js');

const baseGate = {
  optIn: true,
  actionIntent: false,
  totalToolCalls: 0,
  workThreshold: 3,
  continuationsUsed: 0,
  maxContinuations: 3,
  nextAction: 'completed',
};

test('gate: fires for an explicit ACTION intent even with few tool calls', () => {
  assert.equal(shouldRunObjectiveJudge({ ...baseGate, actionIntent: true, totalToolCalls: 0 }), true);
});

test('gate: fires for a LOOKUP-classified turn that did real work (≥ threshold tool calls)', () => {
  // "find me the accounts and drop them in a sheet" classifies as lookup but is
  // multi-step action — many tool calls. This is the bug the run exposed.
  assert.equal(shouldRunObjectiveJudge({ ...baseGate, actionIntent: false, totalToolCalls: 7 }), true);
});

test('gate: does NOT fire for a trivial lookup (few tool calls, non-action)', () => {
  assert.equal(shouldRunObjectiveJudge({ ...baseGate, actionIntent: false, totalToolCalls: 2 }), false);
});

test('gate: does NOT fire when the caller did not opt in', () => {
  assert.equal(shouldRunObjectiveJudge({ ...baseGate, optIn: false, actionIntent: true, totalToolCalls: 9 }), false);
});

test('gate: does NOT fire once the continuation budget is exhausted', () => {
  assert.equal(shouldRunObjectiveJudge({ ...baseGate, actionIntent: true, continuationsUsed: 3 }), false);
});

test('gate: does NOT fire when nextAction is not completed (e.g. awaiting approval)', () => {
  assert.equal(shouldRunObjectiveJudge({ ...baseGate, actionIntent: true, nextAction: 'awaiting_approval' }), false);
});

// ── Promise-shaped completion (the "I'll do that next" chatbot turn) ──────────

test('gate: FIRES for a promise-shaped reply even when it looks low-effort (the incident)', () => {
  // The exact shape that slipped through: non-action intent, 1 tool call, done.
  assert.equal(
    shouldRunObjectiveJudge({ ...baseGate, actionIntent: false, totalToolCalls: 1, promiseShaped: true }),
    true,
  );
  // Without the promise signal, the same low-effort turn is NOT judged (unchanged).
  assert.equal(
    shouldRunObjectiveJudge({ ...baseGate, actionIntent: false, totalToolCalls: 1, promiseShaped: false }),
    false,
  );
});

test('isPromiseShapedReply: future-tense promise with no artifact → true', () => {
  for (const p of [
    "Got it. I'll prep them as review-ready drafts, not send them yet.",
    'Going to put that report together for you.',
    "Let me go pull all the data and build the file.",
  ]) {
    assert.equal(isPromiseShapedReply(p), true, `promise: ${p}`);
  }
});

test('isPromiseShapedReply: a real artifact/result suppresses the promise signal → false', () => {
  for (const r of [
    "Done — created the sheet: https://example.com/s/123",
    "Here's the summary of all 44 records.",
    "I've drafted the report and saved it to /tmp/out.html",
    'Found 5 accounts matching your filter.',
    "You're right — going forward I'll treat SEO data as raw metrics first.",
    "From now on I'll use the source column for those rows.",
    '', // empty
  ]) {
    assert.equal(isPromiseShapedReply(r), false, `not a bare promise: ${r}`);
  }
});

test('buildObjectiveJudgePrompt includes the objective and the assistant response', () => {
  const prompt = buildObjectiveJudgePrompt('build a report on X', 'Done — saved to /tmp/report.md');
  assert.match(prompt, /build a report on X/);
  assert.match(prompt, /\/tmp\/report\.md/);
});

test('clipForJudge passes a sub-cap body through untouched', () => {
  const r = clipForJudge('a short response');
  assert.equal(r.truncated, false);
  assert.equal(r.text, 'a short response');
});

test('clipForJudge windows head+tail and self-describes the elision', () => {
  const head = 'HEAD_MARKER ' + 'a'.repeat(JUDGE_RESPONSE_MAX_CHARS);
  const tailEvidence = ' saved to https://example.com/sheet TAIL_MARKER';
  const full = head + 'z'.repeat(2000) + tailEvidence;
  const r = clipForJudge(full);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length < full.length, 'output is shorter than the full input');
  assert.ok(r.text.length <= JUDGE_RESPONSE_MAX_CHARS + 200, 'output stays near the cap (plus the small marker)');
  assert.match(r.text, /HEAD_MARKER/, 'keeps the head');
  assert.match(r.text, /TAIL_MARKER/, 'keeps the tail where artifact evidence clusters');
  assert.match(r.text, /elided from the MIDDLE for length/, 'tells the judge the middle was cut for length');
});

test('buildObjectiveJudgePrompt directs the judge not to penalize a windowed reply', () => {
  const prompt = buildObjectiveJudgePrompt('build a big report', 'B'.repeat(JUDGE_RESPONSE_MAX_CHARS + 5000));
  assert.match(prompt, /do not mark the objective incomplete merely because/i);
});

test('judgeObjectiveComplete fails OPEN (done:true) when there is no response text to judge', async () => {
  const v = await judgeObjectiveComplete('build a report', '');
  assert.equal(v.done, true);
});

test('judgeObjectiveComplete fails OPEN when the objective is empty', async () => {
  const v = await judgeObjectiveComplete('', 'some response');
  assert.equal(v.done, true);
});

test('buildObjectiveJudgePrompt injects the skill-execution rubric when skills were loaded', async () => {
  const { buildObjectiveJudgePrompt } = await import('./objective-judge.js');
  const p = buildObjectiveJudgePrompt('clone and improve the site', 'I built and deployed it.', {
    skills: [{ name: 'redesign-skill', body: 'Step 1: generate hero imagery. Step 2: build. Step 3: deploy.' }],
    toolCallSummary: 'run_shell_command×13, skill_read×4',
  });
  assert.match(p, /verify they were EXECUTED/i);
  assert.match(p, /redesign-skill/);
  assert.match(p, /generate hero imagery/);
  assert.match(p, /run_shell_command×13/);
});

test('buildObjectiveJudgePrompt without skill context is unchanged (no rubric injected)', async () => {
  const { buildObjectiveJudgePrompt } = await import('./objective-judge.js');
  const p = buildObjectiveJudgePrompt('do a thing', 'done');
  assert.doesNotMatch(p, /SKILLS LOADED THIS SESSION/);
  assert.match(p, /exactly one verdict line/);
  assert.doesNotMatch(p, /structured verdict/);
});

// Regression (2026-06-14): a build/deploy run that loads NO skill still did real
// work; the judge was previously starved of the tool-call evidence (it only
// rendered inside the skills block), so it false-rejected genuinely-finished
// action turns and stranded ~10% of completions into a false stuck loop.
test('buildObjectiveJudgePrompt surfaces tool-call evidence even with NO skill loaded', () => {
  const p = buildObjectiveJudgePrompt(
    'build and deploy the Test Bakehouse site',
    'Done — Test Bakehouse is live: https://test-bakehouse.netlify.app',
    { skills: [], toolCallSummary: 'run_shell_command×5, write_file×1' },
  );
  assert.match(p, /Tool calls made this session/);
  assert.match(p, /run_shell_command×5/);
  // No skill rubric should be injected for an empty skills list.
  assert.doesNotMatch(p, /SKILLS LOADED THIS SESSION/);
});

test('buildObjectiveJudgePrompt suppresses the evidence line for a zero-tool turn', () => {
  // A bare promise with no tools must NOT get a corroborating evidence line —
  // the judge should still see only prose and demand the artifact.
  const p = buildObjectiveJudgePrompt('build a thing', "I'll get right on that.", {
    skills: [],
    toolCallSummary: '(no tool calls made)',
  });
  assert.doesNotMatch(p, /Tool calls made this session/);
});

// ─── composeJudgedObjective — continuity-aware judged objective ────

test('composeJudgedObjective: bare follow-up gets prior REAL user messages as context', async () => {
  const { composeJudgedObjective } = await import('./objective-judge.js');
  const composed = composeJudgedObjective('just mine please', [
    'I need to pull 25 market leader accounts new from Salesforce that have not had contact in 15 days, de-dupe against Airtable, then SEO enrichment.',
    'Continue with the next step of your plan. If you have nothing left to do, set done=true and nextAction=completed.',
    'You hit a step / time budget on the previous turn and the user has now replied `continue`.\n\nPick up where you left off; do not restart the workflow from scratch.',
  ]);
  assert.match(composed, /25 market leader accounts/);
  assert.match(composed, /Current user message .*: just mine please/);
  assert.doesNotMatch(composed, /Continue with the next step/, 'harness drip injections must be filtered');
  assert.doesNotMatch(composed, /step \/ time budget/, 'synthetic continue inputs must be filtered');
});

test('composeJudgedObjective: long objective passes through unchanged', async () => {
  const { composeJudgedObjective } = await import('./objective-judge.js');
  const long = 'Research the top 25 personal injury firms in New York by SERP visibility, then write each one an outreach note referencing their weakest keyword cluster.';
  assert.equal(composeJudgedObjective(long, ['earlier message']), long);
});

test('composeJudgedObjective: no real priors → raw input unchanged', async () => {
  const { composeJudgedObjective } = await import('./objective-judge.js');
  assert.equal(composeJudgedObjective('lets do it', []), 'lets do it');
  assert.equal(
    composeJudgedObjective('lets do it', [
      'You marked this objective complete, but an independent verification check found it is NOT finished: x.',
    ]),
    'lets do it',
    'injected-only history must not be treated as context',
  );
});

test('composeJudgedObjective: keeps only the last 2 priors and truncates very long ones', async () => {
  const { composeJudgedObjective } = await import('./objective-judge.js');
  const composed = composeJudgedObjective('go', ['first', 'second', `third ${'x'.repeat(700)}`]);
  assert.doesNotMatch(composed, /\bfirst\b/, 'only the last 2 priors are kept');
  assert.match(composed, /second/);
  assert.match(composed, /…/, 'long prior is truncated');
});

test('JUDGE_SYSTEM_PROMPT: rubric audits only NAMED deliverables and yields on ambiguity', async () => {
  const { JUDGE_SYSTEM_PROMPT } = await import('./objective-judge.js');
  assert.match(JUDGE_SYSTEM_PROMPT, /Do NOT invent extra deliverables/);
  assert.match(JUDGE_SYSTEM_PROMPT, /bare conversational follow-up/);
  assert.doesNotMatch(JUDGE_SYSTEM_PROMPT, /lean toward not-done/, 'the loop-forever-on-ambiguity rule is gone');
});

// ─── Plain-text verdict parser (schema-free; feed fake finalOutput strings) ───

test('parseCompletionVerdict: DONE marker → done:true + reason', () => {
  const v = parseCompletionVerdict('DONE: Spreadsheet created at /Users/me/Q3.xlsx with URL returned');
  assert.equal(v?.done, true);
  assert.match(v!.reason, /Q3\.xlsx/);
});

test('parseCompletionVerdict: INCOMPLETE marker → done:false + missing evidence', () => {
  const v = parseCompletionVerdict('INCOMPLETE: Assistant proposed steps but no artifact or URL was produced');
  assert.equal(v?.done, false);
  assert.match(v!.reason, /no artifact/);
});

test('parseCompletionVerdict: tolerant of NOT-DONE alias, no colon, lowercase, whitespace', () => {
  assert.equal(parseCompletionVerdict('  done  everything shipped')?.done, true);
  assert.equal(parseCompletionVerdict('DONE')?.done, true);
  assert.equal(parseCompletionVerdict('DONE - everything shipped')?.done, true);
  assert.equal(parseCompletionVerdict('NOT-DONE: still missing the send confirmation')?.done, false);
  assert.equal(parseCompletionVerdict('not done: nothing produced')?.done, false);
});

test('parseCompletionVerdict: legacy structured object/JSON verdicts are accepted', () => {
  const done = parseCompletionVerdict({ done: true, reason: 'file written at /tmp/report.md' });
  assert.deepEqual(done, { done: true, reason: 'file written at /tmp/report.md' });

  const incomplete = parseCompletionVerdict('```json\n{"done":"false","reason":"missing the spreadsheet URL"}\n```');
  assert.equal(incomplete?.done, false);
  assert.equal(incomplete?.reason, 'missing the spreadsheet URL');

  const status = parseCompletionVerdict('{"status":"completed","summary":"artifact path returned"}');
  assert.equal(status?.done, true);
  assert.equal(status?.reason, 'artifact path returned');
});

test('parseCompletionVerdict: no marker → null (caller applies its own fail semantics)', () => {
  assert.equal(parseCompletionVerdict('It seems like the work is finished'), null);
  assert.equal(parseCompletionVerdict(''), null);
  assert.equal(parseCompletionVerdict(undefined), null);
});

test('parseCompletionVerdict: reason clamped in code, never validated', () => {
  const v = parseCompletionVerdict(`DONE: ${'z'.repeat(900)}`);
  assert.equal(v?.done, true);
  assert.equal(v!.reason.length, 400);
});

// ─── Per-criterion checklist verdict parsing (goal-contract granularity) ───

test('parseCriteriaVerdicts: one line per criterion, mixed MET/UNMET, notes preserved', async () => {
  const { parseCriteriaVerdicts } = await import('./objective-judge.js');
  const raw = ['1: MET: sheet URL present', '2: UNMET: no send confirmation', '3: MET: file path quoted'].join('\n');
  const v = parseCriteriaVerdicts(raw, 3);
  assert.equal(v?.length, 3);
  assert.deepEqual(v?.map((x) => x.pass), [true, false, true]);
  assert.match(v?.[1].note ?? '', /send confirmation/);
});

test('parseCriteriaVerdicts: tolerant of synonyms (PASS/FAIL), separators, and order', async () => {
  const { parseCriteriaVerdicts } = await import('./objective-judge.js');
  const raw = ['2) FAIL — missing artifact', '1. PASS: done well'].join('\n');
  const v = parseCriteriaVerdicts(raw, 2);
  assert.deepEqual(v?.map((x) => x.pass), [true, false]);
});

test('parseCriteriaVerdicts: ALL-OR-NOTHING — a partial listing returns null (never silently partial)', async () => {
  const { parseCriteriaVerdicts } = await import('./objective-judge.js');
  assert.equal(parseCriteriaVerdicts('1: MET: ok', 2), null);
  assert.equal(parseCriteriaVerdicts('here is my analysis of the criteria...', 2), null);
  assert.equal(parseCriteriaVerdicts('', 1), null);
});

test('parseCriteriaVerdicts: out-of-range and duplicate indices ignored, prose around lines tolerated', async () => {
  const { parseCriteriaVerdicts } = await import('./objective-judge.js');
  const raw = ['Verdicts:', '1: MET: ok', '1: UNMET: dup ignored', '5: MET: out of range', '2: UNMET: real'].join('\n');
  const v = parseCriteriaVerdicts(raw, 2);
  assert.deepEqual(v?.map((x) => x.pass), [true, false]);
});
