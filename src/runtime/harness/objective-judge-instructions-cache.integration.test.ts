import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, mock, test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelRequest } from '@openai/agents-core';
import type { SkillExecutionContext } from './objective-judge.js';
import type { ReviewInputComposition, ReviewInputObservation } from './review-input-observation.js';

const priorHome = process.env.CLEMENTINE_HOME;
const testHome = mkdtempSync(path.join(os.tmpdir(), 'clem-judge-instructions-cache-'));
process.env.CLEMENTINE_HOME = testHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
mkdirSync(path.join(testHome, 'state'), { recursive: true });
const { JUDGE_SYSTEM_PROMPT, HOST_COMPLETION_EVIDENCE_GUIDANCE, buildCompletionJudgeInstructions,
  COMPLETION_DECISION_AUDIT_GUIDANCE, buildObjectiveJudgePrompt, parseCompletionVerdict, runRoutedJudgeAttempt,
  runHedgedJudge, judgeObjectiveComplete, _setCompletionJudgeForTests,
  completionJudgeComparisonDiagnostic, completionJudgeComparisonForRoute } = await import('./objective-judge.js');
const { MEMORY_REQUIREMENT_REVIEW_INSTRUCTIONS } = await import('./memory-completion-obligation.js');
const { INSTRUCTION_CACHE_DELIM, CACHE_BREAK_SENTINEL } = await import('./model-wire-registry.js');
const { applyClaudeEnvelope } = await import('./claude-model.js');
const { closeEventLog } = await import('./eventlog.js');
const { createAnthropic } = await import('@ai-sdk/anthropic');
const { aisdk } = await import('@openai/agents-extensions/ai-sdk');
// Pure wire fixtures use the existing injection; they do not start the installed client.
const FIXTURE_CLAUDE_CLIENT_VERSION = '0.0.0';

after(() => {
  closeEventLog();
  rmSync(testHome, { recursive: true, force: true });
  if (priorHome === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = priorHome;
});

const evidence = {
  refKind: 'call ids',
  refs: () => ['call_1'],
  resolve: (ref: string) => (ref === 'call_1' ? { text: '{"runs":[]}' } : undefined),
} as never;
const prompt = buildObjectiveJudgePrompt('Which enabled workflow ran most recently?', 'end-of-day, 7h ago, succeeded.', {
  fullSourceEvidence: true, skills: [], toolCallSummary: 'Retained READ results: end-of-day succeeded 7h ago.',
});

function capturingModel(responseText = 'DONE: supported.') {
  const requests: ModelRequest[] = [];
  return {
    requests,
    model: {
      async getResponse(request: ModelRequest) {
        requests.push(request);
        return { responseId: 'r', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1, inputTokensDetails: [], outputTokensDetails: [] },
          output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: responseText }] }] };
      },
      async *getStreamedResponse() { throw new Error('the judge uses the response path'); },
    },
  };
}
const route = (family: 'claude' | 'byo' | 'codex', model: unknown) => ({
  model: model as never, modelId: family === 'claude' ? 'claude-sonnet-5' : 'judge-model', judgeFamily: family,
  brainFamily: 'byo' as const, transport: 'test', selfJudge: false,
});

test('family comparison diagnostics distinguish route basis without asserting a served author or invoking metadata hooks', () => {
  const unavailable = { selfJudgeBasis: 'unavailable', servedAuthorQualification: 'unknown' };
  const implicit = { selfJudgeBasis: 'implicit_brain_route_unknown', servedAuthorQualification: 'unknown' };
  const provided = { selfJudgeBasis: 'provided_author_route', servedAuthorQualification: 'unknown' };
  const sameFamily = { brainFamily: 'claude', judgeFamily: 'claude', selfJudge: true };
  assert.deepEqual(completionJudgeComparisonForRoute(sameFamily), implicit);
  assert.equal(sameFamily.selfJudge, true, 'the new diagnostic does not revise the legacy comparison');
  assert.deepEqual(completionJudgeComparisonForRoute({ ...sameFamily, authorFamily: 'codex', selfJudge: false }), provided);
  assert.deepEqual(completionJudgeComparisonForRoute({ brainFamily: 'codex', judgeFamily: 'claude', selfJudge: false }), implicit);
  for (const unsupported of [undefined, null, [], {}, { ...sameFamily, authorFamily: undefined },
    { ...sameFamily, authorFamily: ['codex'] }, { ...sameFamily, judgeFamily: 'other' },
    { ...sameFamily, selfJudge: 'true' }]) assert.deepEqual(completionJudgeComparisonForRoute(unsupported), unavailable);
  let hooks = 0;
  for (const key of ['brainFamily', 'judgeFamily', 'selfJudge', 'authorFamily']) {
    const accessor = Object.defineProperty({ ...sameFamily }, key, { get() { hooks += 1; throw new Error('must not run'); } });
    assert.deepEqual(completionJudgeComparisonForRoute(accessor), unavailable);
  }
  const proxy = new Proxy(sameFamily, { getOwnPropertyDescriptor() { hooks += 1; throw new Error('must not run'); } });
  assert.deepEqual(completionJudgeComparisonForRoute(proxy), unavailable);
  assert.equal(hooks, 0);
  for (const unsupported of [undefined, {}, { selfJudgeBasis: ['provided_author_route'], servedAuthorQualification: 'unknown' },
    { selfJudgeBasis: 'provided_author_route', servedAuthorQualification: 'verified' },
    Object.create(provided), new Proxy(provided, { getOwnPropertyDescriptor() { hooks += 1; throw new Error('must not run'); } }),
    Object.defineProperty({}, 'selfJudgeBasis', { get() { hooks += 1; throw new Error('must not run'); } })]) {
    assert.deepEqual(completionJudgeComparisonDiagnostic(unsupported), unavailable);
  }
  assert.deepEqual(completionJudgeComparisonDiagnostic({ ...provided, unrelated: 'not retained' }), provided);
  assert.equal(hooks, 0);
});

async function withComparisonJudgeFixture(run: () => Promise<void>) {
  const env = { AUTH_MODE: 'claude_oauth', MODEL_ROUTING_MODE: 'off', CLAUDE_MODEL: 'claude-opus-5-5',
    OPENAI_MODEL_PRIMARY: 'gpt-6.1-sol', CLEMMY_JUDGE_CROSS_FAMILY: 'on', CLEMMY_JUDGE_HEDGE: 'off',
    CLEMMY_COMPLETION_REVIEW: 'on', CLEMMY_CLAUDE_OVERLOAD_FALLBACK: 'off', CLEMMY_CLAUDE_TRANSPORT: 'raw_messages',
    CLEMMY_MODEL_ROLES: JSON.stringify([{ role: 'judge', modelId: 'claude-sonnet-5', scope: 'durable', source: 'settings' }]),
    CLEMMY_DEBATE_JUDGE: '', BYO_MODEL_BASE_URL: '', BYO_MODEL_API_KEY: '', BYO_MODEL_ID: '', BYO_PROVIDERS: '',
    CLEMMY_BOUNDARY_JUDGE_CLAUDE_MODEL: '', CLEMMY_BOUNDARY_JUDGE_CODEX_MODEL: '', JEV_API_KEY: '', JEV_ENABLED: 'off' };
  const prior = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const authPath = path.join(testHome, 'state', 'claude-auth.json');
  let auth: Buffer | undefined;
  try { auth = readFileSync(authPath); } catch { /* first fixture */ }
  Object.assign(process.env, env);
  writeFileSync(authPath, JSON.stringify({ accessToken: 'sk-ant-oat01-fixture', expiresAt: Date.now() + 3_600_000 }));
  try { await run(); } finally {
    mock.restoreAll();
    _setCompletionJudgeForTests(null);
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (auth) writeFileSync(authPath, auth); else rmSync(authPath, { force: true });
  }
}

test('the actual deciding route carries a comparison basis while the existing request and legacy selfJudge stay unchanged', async () => {
  await withComparisonJudgeFixture(async () => {
    const { ClaudeModelProvider } = await import('./claude-model.js');
    const { captureBoundaryJudgeSelection } = await import('./debate-model.js');
    const { model, requests } = capturingModel();
    mock.method(ClaudeModelProvider.prototype, 'getModel', () => model);
    const selection = captureBoundaryJudgeSelection();
    assert.equal(selection.status, 'captured');
    const instructions = 'Review this controlled result. Return DONE or CORRECT.';
    const body = 'Objective: report the controlled value. Candidate: value present. Source: exact value present.';
    const implicit = await runHedgedJudge(instructions, body, parseCompletionVerdict, value => value.done, 'completion',
      { timeoutMs: 30_000, effort: 'medium', boundaryJudgeSelection: selection, requireCompletePrompt: true });
    const provided = await runHedgedJudge(instructions, body, parseCompletionVerdict, value => value.done, 'completion',
      { timeoutMs: 30_000, effort: 'medium', boundaryJudgeSelection: selection, requireCompletePrompt: true,
        reviewedAuthor: { provider: 'codex', modelId: 'gpt-6.1-sol', source: 'settings' } });
    assert.equal(requests.length, 2, 'one existing request per invocation; no diagnostic request');
    assert.deepEqual(requests[0], requests[1], 'diagnostic metadata never enters model input, tools, cache or effort');
    assert.equal(requests[0]!.systemInstructions, instructions);
    assert.equal(requests[0]!.modelSettings.reasoning?.effort, 'medium');
    assert.deepEqual(implicit.value, { done: true, reason: 'supported.' });
    assert.deepEqual(provided.value, implicit.value);
    assert.equal(implicit.routing?.selfJudge, true, 'the configured Claude brain remains the legacy comparison');
    assert.equal(provided.routing?.selfJudge, false, 'the already provided Codex writer remains the legacy comparison');
    assert.deepEqual(implicit.comparisonDiagnostic, { selfJudgeBasis: 'implicit_brain_route_unknown', servedAuthorQualification: 'unknown' });
    assert.deepEqual(provided.comparisonDiagnostic, { selfJudgeBasis: 'provided_author_route', servedAuthorQualification: 'unknown' });
    const verdict = await judgeObjectiveComplete('Report the controlled value.', 'The controlled value is present.', {
      skills: [], fullSourceEvidence: true, reviewStakes: 'read', toolCallSummary: 'The controlled value is present.',
      boundaryJudgeSelection: selection,
    });
    assert.equal(requests.length, 3);
    assert.equal(verdict.done, true);
    assert.equal(verdict.selfJudge, true);
    assert.equal(verdict.selfJudgeBasis, 'implicit_brain_route_unknown');
    assert.equal(verdict.servedAuthorQualification, 'unknown');
  });
});

test('missing, failed and mocked deciding routes keep author comparison unavailable without new I/O or hooks', async () => {
  await withComparisonJudgeFixture(async () => {
    const empty = await judgeObjectiveComplete('', 'nothing to judge');
    assert.equal(empty.selfJudgeBasis, 'unavailable');
    assert.equal(empty.servedAuthorQualification, 'unknown');
    let calls = 0;
    let hooks = 0;
    const mocked = Object.defineProperty({ verdict: { done: true, reason: 'fixture verdict' }, failure: null }, 'comparisonDiagnostic',
      { get() { hooks += 1; throw new Error('must not run'); } });
    _setCompletionJudgeForTests(async () => { calls += 1; return mocked; });
    const result = await judgeObjectiveComplete('Report the controlled value.', 'The controlled value is present.', { skills: [] });
    assert.equal(calls, 1);
    assert.equal(hooks, 0);
    assert.equal(result.selfJudgeBasis, 'unavailable');
    assert.equal(result.servedAuthorQualification, 'unknown');
    _setCompletionJudgeForTests(async () => { calls += 1; return { verdict: null, failure: 'error',
      comparisonDiagnostic: { selfJudgeBasis: 'provided_author_route', servedAuthorQualification: 'unknown' } }; });
    const failed = await judgeObjectiveComplete('Report the controlled value.', 'The controlled value is present.', { skills: [] });
    assert.equal(calls, 2);
    assert.equal(failed.failedOpen, true);
    assert.equal(failed.selfJudgeBasis, 'unavailable', 'a failed route cannot claim a deciding author comparison');
    assert.equal(failed.servedAuthorQualification, 'unknown');
  });
});

test('the actual recommendation review requests a same-call rationale while preserving its objective and contrary evidence', async () => {
  const objective = 'Compare A and B, recommend an option meeting capacity 12, and explain the cheaper alternative.';
  const candidate = 'A holds 8 and B holds 16. Recommend B because it meets capacity 12; A costs less but cannot meet the capacity constraint.';
  const standing = 'Capacity must be met before price decides the recommendation.';
  const source = 'Verified table: A capacity=8 price=20; B capacity=16 price=30. Contrary evidence: A has the lower price.';
  const context: SkillExecutionContext = {
    skills: [], fullSourceEvidence: true, toolCallSummary: source, agentInstructions: standing,
    completionEvidenceGuidance: HOST_COMPLETION_EVIDENCE_GUIDANCE,
  };
  const scopedPrompt = buildObjectiveJudgePrompt(objective, candidate, context);
  for (const answer of [
    'DONE: Capacity 12 excludes A=8 and permits B=16; lower A price does not overcome the capacity rule, so B is supported.',
    'CORRECT: (1) "A meets capacity 12" — the verified table gives A capacity 8, so the capacity rule excludes A.',
  ]) {
    const { model, requests } = capturingModel(answer);
    const verdict = await runRoutedJudgeAttempt({ ...route('claude', model), ownerSelectedJudge: true } as never,
      buildCompletionJudgeInstructions(context), scopedPrompt, parseCompletionVerdict, true, evidence, undefined, 'medium');
    assert.equal(requests.length, 1, 'the rationale belongs to the existing review, without a restatement or added review');
    assert.equal(requests[0]!.modelSettings.reasoning?.effort, 'medium');
    const instructions = String(requests[0]!.systemInstructions);
    assert.match(instructions, /DONE: <concise rationale[\s\S]*every materially requested explanation or recommendation decision[\s\S]*condition → applicable rule or exact evidence → consequence/);
    assert.match(instructions, /resolve contrary evidence/);
    assert.ok(instructions.endsWith(INSTRUCTION_CACHE_DELIM));
    assert.equal(instructions.split(HOST_COMPLETION_EVIDENCE_GUIDANCE).length - 1, 1,
      'the existing full host guide is neither duplicated nor replaced');
    const input = requests[0]!.input as Array<{ role: string; content: unknown }>;
    assert.equal(input.length, 1);
    const sentPrompt = String(input[0]!.content);
    assert.ok(sentPrompt.startsWith(scopedPrompt));
    for (const retained of [objective, candidate, standing, source]) assert.ok(sentPrompt.includes(retained));
    assert.equal(verdict.done, answer.startsWith('DONE:'));
    assert.equal(verdict.reason, answer.slice(answer.indexOf(':') + 1).trim(), 'the existing parser preserves the model rationale');
  }
});

test('artifact-only review keeps its deliverable contract and a short DONE remains model attestation rather than semantic proof', async () => {
  const objective = 'Save the supplied rows as /tmp/rationale-fixture.json and return its path.';
  const candidate = 'Saved the supplied rows at /tmp/rationale-fixture.json.';
  const source = 'The save succeeded and its exact readback contains the supplied rows.';
  const context: SkillExecutionContext = { skills: [], fullSourceEvidence: true, toolCallSummary: source };
  const scopedPrompt = buildObjectiveJudgePrompt(objective, candidate, context);
  const { model, requests } = capturingModel('DONE: /tmp/rationale-fixture.json contains the supplied rows.');
  const verdict = await runRoutedJudgeAttempt({ ...route('claude', model), ownerSelectedJudge: true } as never,
    buildCompletionJudgeInstructions(context), scopedPrompt, parseCompletionVerdict, true, evidence, undefined, 'medium');
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.modelSettings.reasoning?.effort, 'medium');
  const sentPrompt = JSON.stringify(requests[0]!.input);
  for (const retained of [objective, candidate, source]) assert.ok(sentPrompt.includes(retained));
  assert.equal(verdict.done, true);
  assert.equal(verdict.reason, '/tmp/rationale-fixture.json contains the supplied rows.');
  assert.deepEqual(parseCompletionVerdict('DONE: present.'), { done: true, reason: 'present.' },
    'the prompt asks for semantic reasoning; no lexical rationale gate is introduced');
  assert.equal(parseCompletionVerdict('The answer is complete.'), null, 'the existing verdict grammar remains strict');
});

test('the actual review checks decision sufficiency after all evidence without changing the verdict grammar or adding calls', async () => {
  const controls = [
    {
      objective: 'Explain when retrying a hypothetical delivery would be authorized. Reply as one JSON object.',
      candidate: '```json\n{"action":"retry if no reply was recorded"}\n```',
      source: 'A missing reply does not settle whether the prior delivery reached the recipient. Contrary evidence: the sender may have completed before its response was lost.',
      standing: 'Reconcile the exact prior delivery before authorizing another send; analysis does not authorize sending.',
      answer: 'CORRECT: (1) "retry if no reply was recorded" — an absent reply is consistent with completed delivery; the premise does not establish safe retry. Remove the outside fence too.',
    },
    {
      objective: 'Explain which hypothetical facility can hold 12 people. Reply as one JSON object.',
      candidate: '```json\n{"choice":"B","reason":"A holds 8; B holds 16"}\n```',
      source: 'Verified limits: A=8, B=16. Contrary evidence: A is cheaper.',
      standing: 'The capacity requirement takes precedence over price.',
      answer: 'REVISE_REPLY: Remove only the outside fence; B meets capacity 12 while A does not, so the recommendation is verified.',
    },
    {
      objective: 'Save the supplied rows and return the path.',
      candidate: 'Saved at /tmp/decision-audit-control.json.',
      source: 'The exact save succeeded; readback matches the supplied rows.',
      standing: 'Do not add an unrequested analysis or audit artifact.',
      answer: 'DONE: /tmp/decision-audit-control.json contains the supplied rows.',
    },
  ];
  for (const control of controls) {
    const context: SkillExecutionContext = { skills: [], fullSourceEvidence: true,
      toolCallSummary: control.source, agentInstructions: control.standing,
      completionEvidenceGuidance: HOST_COMPLETION_EVIDENCE_GUIDANCE };
    const scopedPrompt = buildObjectiveJudgePrompt(control.objective, control.candidate, context);
    const { model, requests } = capturingModel(control.answer);
    const verdict = await runRoutedJudgeAttempt({ ...route('claude', model), ownerSelectedJudge: true } as never,
      buildCompletionJudgeInstructions(context), scopedPrompt, parseCompletionVerdict, true, evidence, undefined, 'medium');
    assert.equal(requests.length, 1, 'the existing request owns the sufficiency check and final verdict');
    assert.equal(requests[0]!.modelSettings.reasoning?.effort, 'medium');
    const sent = String((requests[0]!.input as Array<{ content: unknown }>)[0]!.content);
    const semanticAudit=COMPLETION_DECISION_AUDIT_GUIDANCE.slice(0,COMPLETION_DECISION_AUDIT_GUIDANCE.lastIndexOf('\n'));
    assert.ok(scopedPrompt.endsWith('then only the independently requested coverage or memory lines.'));
    assert.equal(sent.split(semanticAudit).length - 1, 1);
    const auditAt = sent.indexOf(semanticAudit);
    for (const retained of [control.objective, control.candidate, control.source, control.standing]) {
      assert.ok(sent.includes(retained));
      assert.ok(sent.indexOf(retained) < auditAt, 'the audit follows the unchanged complete request and contrary evidence');
    }
    const system = String(requests[0]!.systemInstructions);
    assert.equal(system.split(HOST_COMPLETION_EVIDENCE_GUIDANCE).length - 1, 1);
    assert.equal(system.split(COMPLETION_DECISION_AUDIT_GUIDANCE).length - 1, 0,
      'the current-source tail does not duplicate the stable instruction prefix');
    assert.deepEqual(verdict, parseCompletionVerdict(control.answer),
      'these synthetic answers verify request plumbing and existing parser behavior, not model semantic judgment');
  }
});

test('optional host completion guidance preserves legacy instructions and refuses dynamic substitutions', () => {
  assert.equal(buildCompletionJudgeInstructions(), JUDGE_SYSTEM_PROMPT);
  assert.equal(buildCompletionJudgeInstructions({}), JUDGE_SYSTEM_PROMPT);
  assert.equal(buildCompletionJudgeInstructions({ memoryRequirementContext: 'source-bound memory evidence' }),
    `${JUDGE_SYSTEM_PROMPT}\n\n${MEMORY_REQUIREMENT_REVIEW_INSTRUCTIONS}`);
  const originalHostParagraph = HOST_COMPLETION_EVIDENCE_GUIDANCE.split('\nSTOP / CONTINUE REASONING:')[0]!;
  assert.equal(originalHostParagraph.length, 1130, 'the original evidence rules retain their exact bytes');
  assert.equal(createHash('sha256').update(originalHostParagraph).digest('hex'),
    '53270f13455d791552f4968d66131e857cc1e8725d426c81a6c30e45817ccf64',
    'the paragraph matches the approved original host guidance, including punctuation and whitespace');
  assert.throws(() => buildCompletionJudgeInstructions({
    completionEvidenceGuidance: 'source-specific instructions cannot be made a shared cache prefix' as never,
  }), /must match the retained host rules exactly/);
});

test('host guidance appears once in the stable prefix while changing objective and evidence stay outside', async () => {
  const systems: string[] = [];
  for (const suffix of ['one', 'two']) {
    const source = {
      refKind: 'call ids', refs: () => [`source_${suffix}_call`],
      resolve: () => ({ text: `source_${suffix}_result` }),
    };
    const context: SkillExecutionContext = {
      skills: [], fullSourceEvidence: true, toolCallSummary: `source_${suffix}_result`,
      completionEvidenceGuidance: HOST_COMPLETION_EVIDENCE_GUIDANCE,
    };
    const scopedPrompt = buildObjectiveJudgePrompt(`source_${suffix}_objective`, `source_${suffix}_reply`, context);
    const { model, requests } = capturingModel();
    await runRoutedJudgeAttempt(route('claude', model) as never, buildCompletionJudgeInstructions(context),
      scopedPrompt, parseCompletionVerdict, true, source);
    const request = requests[0]!;
    const system = String(request.systemInstructions);
    systems.push(system);
    assert.equal(system.split(HOST_COMPLETION_EVIDENCE_GUIDANCE).length - 1, 1);
    assert.equal(system.match(/STOP \/ CONTINUE REASONING:/g)?.length, 1,
      'execution and analysis receive the same replay rules once, before the cache boundary');
    assert.ok(system.endsWith(INSTRUCTION_CACHE_DELIM));
    assert.doesNotMatch(system, new RegExp(`source_${suffix}_`), 'no current-source facts or refs enter the stable prefix');
    const input = JSON.stringify(request.input);
    assert.doesNotMatch(input, /Judge only the effective accepted objective/);
    assert.doesNotMatch(input, /STOP \/ CONTINUE REASONING:/);
    for (const kind of ['objective', 'reply', 'result', 'call']) assert.ok(input.includes(`source_${suffix}_${kind}`));
  }
  assert.equal(systems[0], systems[1], 'new source identities do not rewrite the fixed reviewer prefix');
});

test('a Claude review with evidence tools marks its instructions as the stable prefix; the prompt is unchanged', async () => {
  const { model, requests } = capturingModel();
  await runRoutedJudgeAttempt(route('claude', model) as never, JUDGE_SYSTEM_PROMPT, prompt, parseCompletionVerdict, true, evidence);
  const request = requests[0]!;
  const system = String(request.systemInstructions);
  assert.ok(system.endsWith(INSTRUCTION_CACHE_DELIM));
  assert.ok(system.startsWith(JUDGE_SYSTEM_PROMPT), 'the same instructions, in the same order');
  const input = request.input as Array<{ role: string; content: unknown }>;
  assert.equal(input.length, 1);
  assert.equal(typeof input[0]!.content, 'string', 'one plain message, as before');
  assert.ok(String(input[0]!.content).startsWith(prompt));
});

for (const family of ['byo', 'codex'] as const) {
  test(`a ${family} review carries no cache marker`, async () => {
    const { model, requests } = capturingModel();
    await runRoutedJudgeAttempt(route(family, model) as never, JUDGE_SYSTEM_PROMPT, prompt, parseCompletionVerdict, true, evidence);
    assert.doesNotMatch(String(requests[0]!.systemInstructions), new RegExp(CACHE_BREAK_SENTINEL));
  });
}

test('a Claude review without evidence tools is unchanged', async () => {
  const { model, requests } = capturingModel();
  await runRoutedJudgeAttempt(route('claude', model) as never, JUDGE_SYSTEM_PROMPT, prompt, parseCompletionVerdict, true);
  assert.equal(requests[0]!.systemInstructions, JUDGE_SYSTEM_PROMPT);
});

test('requested review effort reaches every reviewer; omitted effort preserves the provider default', async () => {
  // Depth is a harness decision; only the transport adapter decides how an
  // explicitly requested effort maps onto the model's declared wire support.
  for (const family of ['claude', 'codex', 'byo'] as const) {
    for (const evidenceSource of [evidence, undefined]) {
      const requested = capturingModel();
      await runRoutedJudgeAttempt(route(family, requested.model) as never, JUDGE_SYSTEM_PROMPT, prompt,
        parseCompletionVerdict, true, evidenceSource, undefined, 'medium');
      assert.equal(requested.requests[0]!.modelSettings?.reasoning?.effort, 'medium',
        `${family} receives the requested review depth with or without evidence tools`);
      const unset = capturingModel();
      await runRoutedJudgeAttempt(route(family, unset.model) as never, JUDGE_SYSTEM_PROMPT, prompt,
        parseCompletionVerdict, true, evidenceSource);
      assert.equal(unset.requests[0]!.modelSettings?.reasoning?.effort, undefined,
        `${family}: no effort asked, none sent`);
    }
  }
});

test('on the Anthropic wire the instructions are a cache point and no marker text is sent', async () => {
  const bodies: Record<string, unknown>[] = [];
  const provider = createAnthropic({
    apiKey: 'test-key',
    fetch: (async (_url: unknown, init?: { body?: unknown }) => {
      const wire = applyClaudeEnvelope({ body: String(init?.body) }, 'sk-ant-oat01-x', FIXTURE_CLAUDE_CLIENT_VERSION);
      bodies.push(JSON.parse(String(wire.body)));
      return new Response(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
        content: [{ type: 'text', text: 'DONE: the evidence supports the answer.' }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  const verdict = await runRoutedJudgeAttempt(route('claude', aisdk(provider('claude-sonnet-5'))) as never,
    JUDGE_SYSTEM_PROMPT, prompt, parseCompletionVerdict, true, evidence);
  assert.equal(verdict.done, true);
  const body = bodies[0]!;
  assert.doesNotMatch(JSON.stringify(body), /<<<CLEM_/);
  const system = body.system as Array<{ text: string; cache_control?: unknown }>;
  const cached = system.filter((block) => block.cache_control);
  assert.equal(cached.length, 1, 'one cache point on the instructions');
  assert.ok(cached[0]!.text.startsWith(JUDGE_SYSTEM_PROMPT.trim().slice(0, 200)));
  const messages = body.messages as Array<{ content: Array<{ type: string; text?: string }> }>;
  const text = messages[0]!.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
  assert.ok(text.startsWith(prompt), 'the reviewer reads the same prompt');
});

test('host guidance reaches the Anthropic cache block exactly once', async () => {
  const bodies: Record<string, unknown>[] = [];
  const provider = createAnthropic({
    apiKey: 'test-key',
    fetch: (async (_url: unknown, init?: { body?: unknown }) => {
      const wire = applyClaudeEnvelope({ body: String(init?.body) }, 'sk-ant-oat01-x', FIXTURE_CLAUDE_CLIENT_VERSION);
      bodies.push(JSON.parse(String(wire.body)));
      return new Response(JSON.stringify({
        id: 'msg_guidance', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
        content: [{ type: 'text', text: 'DONE: the current retained evidence supports the result.' }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  const instructions = buildCompletionJudgeInstructions({ completionEvidenceGuidance: HOST_COMPLETION_EVIDENCE_GUIDANCE });
  const verdict = await runRoutedJudgeAttempt(route('claude', aisdk(provider('claude-sonnet-5'))) as never,
    instructions, prompt, parseCompletionVerdict, true, evidence);
  assert.equal(verdict.done, true);
  const body = bodies[0]!;
  assert.doesNotMatch(JSON.stringify(body), /<<<CLEM_/);
  const blocks = body.system as Array<{ text: string; cache_control?: unknown }>;
  const cached = blocks.filter(block => block.cache_control);
  assert.equal(cached.length, 1);
  assert.ok(cached[0]!.text.includes(HOST_COMPLETION_EVIDENCE_GUIDANCE));
  assert.equal(blocks.reduce((count, block) => count + block.text.split(HOST_COMPLETION_EVIDENCE_GUIDANCE).length - 1, 0), 1);
  const messages = body.messages as Array<{ content: Array<{ type: string; text?: string }> }>;
  const sentPrompt = messages[0]!.content.filter(block => block.type === 'text').map(block => block.text).join('');
  assert.ok(sentPrompt.startsWith(prompt), 'the current-source review input is unchanged');
  assert.doesNotMatch(sentPrompt, /Judge only the effective accepted objective/);
});

test('legacy rubric and audit export retain exact exogenous frozen5cbb bytes, while partial opt-in keeps legacy presentation', () => {
  // Source11 exact own455549 SDK/wire component and the preserved source10
  // tail observation are external baseline pins, not current-render mirrors.
  assert.equal(Buffer.byteLength(JUDGE_SYSTEM_PROMPT),10440);
  assert.equal(createHash('sha256').update(JUDGE_SYSTEM_PROMPT).digest('hex'),
    'f316c40b23620dff0823454568e873f623d4b89c03d5dc9e6a2c45ac102307cb');
  assert.equal(Buffer.byteLength(COMPLETION_DECISION_AUDIT_GUIDANCE),1331);
  assert.equal(createHash('sha256').update(COMPLETION_DECISION_AUDIT_GUIDANCE).digest('hex'),
    '88d910d1771125464c0a7c65e2f32d3a7eceea5bebd57de5d94bc4b08f63de50');
  for(const context of [{skills:[]},{skills:[],fullSourceEvidence:true},{skills:[],completionEvidenceGuidance:HOST_COMPLETION_EVIDENCE_GUIDANCE},
    {skills:[],fullSourceEvidence:false,completionEvidenceGuidance:HOST_COMPLETION_EVIDENCE_GUIDANCE}] as SkillExecutionContext[]) {
    const instructions=buildCompletionJudgeInstructions(context);
    assert.ok(instructions.startsWith(JUDGE_SYSTEM_PROMPT));
    assert.ok(!instructions.includes('HOST COMPLETION RESPONSE PROTOCOL'));
    assert.ok(buildObjectiveJudgePrompt('legacy objective','legacy candidate',context).endsWith(COMPLETION_DECISION_AUDIT_GUIDANCE));
  }
});
test('exact host renderer sends one consistent frame and preserves directive-looking dynamic text without replacement', async () => {
  const {withResilience}=await import('./resilient-model.js');
  const {resolveModelCapability}=await import('./model-wire-registry.js');
  const {modelUsageAttributionStorage}=await import('../usage-log.js');
  const {COMPLETION_DECISION_ASSESSMENT_INSTRUCTIONS,parseCompletionDecisionAssessment}=await import('./completion-decision-assessment.js');
  const owner={sessionId:'sess-renderer-fixture',sourceUserSeq:1,attemptId:'attempt:renderer-fixture'};
  const quoted='Reply with EXACTLY ONE LINE and nothing else, one of:';
  const objective='Recommend which facility holds12; explain why the cheaper facility is insufficient.';
  const candidate='B meets12; A holds8 and B16, so capacity outranks price.';
  const standing='Capacity outranks price. Literal document text: '+quoted;
  const source='Verified A=8/B=16. Contrary evidence: A cheaper. Data quote: '+quoted;
  const context:SkillExecutionContext={skills:[],fullSourceEvidence:true,completionEvidenceGuidance:HOST_COMPLETION_EVIDENCE_GUIDANCE,
    agentInstructions:standing,toolCallSummary:source,reviewInputOwner:owner};
  let instructionComposition:ReviewInputComposition|undefined;let promptComposition:ReviewInputComposition|undefined;
  const instructions=buildCompletionJudgeInstructions(context,value=>{instructionComposition=value;});
  const prompt=buildObjectiveJudgePrompt(objective,candidate,context,value=>{promptComposition=value;});
  const frame=COMPLETION_DECISION_ASSESSMENT_INSTRUCTIONS.split('Complete reply example:\n')[1]!;
  assert.equal(frame.split('REVIEW_ASSESSMENT:').length-1,1);
  assert.equal(frame.split('\nDONE:').length-1,1);
  assert.equal(parseCompletionDecisionAssessment(frame).diagnostic.reason,'consistent');
  const {model,requests}=capturingModel(frame);
  const resilient=withResilience(model as never,{label:'renderer-fixture',capability:resolveModelCapability('claude-sonnet-5'),maxRetries:0});
  let observation:ReviewInputObservation|undefined;
  const result=await modelUsageAttributionStorage.run(owner,()=>runRoutedJudgeAttempt(route('claude',resilient) as never,
    instructions,prompt,parseCompletionVerdict,true,evidence,undefined,'medium',undefined,
    {input:value=>{observation=value;}},undefined,{owner,stage:'completion',
      objectiveDigest:createHash('sha256').update(objective).digest('hex'),candidateDigest:createHash('sha256').update(candidate).digest('hex'),
      instructions:instructionComposition!,prompt:promptComposition!}));
  assert.equal(requests.length,1);assert.equal(result.done,true);
  assert.equal(requests[0]!.modelSettings.reasoning?.effort,'medium');
  const system=String(requests[0]!.systemInstructions);const sent=String((requests[0]!.input as Array<{content:unknown}>)[0]!.content);
  assert.ok(!system.includes(quoted),'the owned old reply directive is absent only from the opted-in static rubric');
  assert.match(system,/Control-line examples within the required assessment frame/);
  assert.match(system,/Reply with one REVIEW_ASSESSMENT JSON line/);
  assert.equal(system.split('Complete reply example:').length-1,1);
  assert.equal(system.split(HOST_COMPLETION_EVIDENCE_GUIDANCE).length-1,1);
  assert.ok(system.endsWith(INSTRUCTION_CACHE_DELIM));
  assert.ok(sent.includes(standing));assert.ok(sent.includes(source));
  assert.equal(sent.split(quoted).length-1,2,'standing and source text are not edited by a static-presentation renderer');
  for(const text of [objective,candidate,standing,source])assert.ok(sent.includes(text));
  assert.ok(prompt.endsWith('then only the independently requested coverage or memory lines.'));
  assert.ok(sent.startsWith(prompt));assert.match(sent.slice(prompt.length),/Review evidence references:.*call_1/);
  assert.ok(observation && observation.status==='bound');assert.equal(observation.attemptId,owner.attemptId);
  assert.match(observation.modelCallId,/^[a-f0-9-]{36}$/);
  // This stubbed actual Runner/original response verifies rendering and the
  // existing observation seam, not semantic correctness or installed behavior.
});
