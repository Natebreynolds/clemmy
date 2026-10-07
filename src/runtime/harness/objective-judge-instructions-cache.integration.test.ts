import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelRequest } from '@openai/agents-core';
import type { SkillExecutionContext } from './objective-judge.js';

const priorHome = process.env.CLEMENTINE_HOME;
const testHome = mkdtempSync(path.join(os.tmpdir(), 'clem-judge-instructions-cache-'));
process.env.CLEMENTINE_HOME = testHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
mkdirSync(path.join(testHome, 'state'), { recursive: true });
const { JUDGE_SYSTEM_PROMPT, HOST_COMPLETION_EVIDENCE_GUIDANCE, buildCompletionJudgeInstructions,
  buildObjectiveJudgePrompt, parseCompletionVerdict, runRoutedJudgeAttempt } = await import('./objective-judge.js');
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

function capturingModel() {
  const requests: ModelRequest[] = [];
  return {
    requests,
    model: {
      async getResponse(request: ModelRequest) {
        requests.push(request);
        return { responseId: 'r', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1, inputTokensDetails: [], outputTokensDetails: [] },
          output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'DONE: supported.' }] }] };
      },
      async *getStreamedResponse() { throw new Error('the judge uses the response path'); },
    },
  };
}
const route = (family: 'claude' | 'byo' | 'codex', model: unknown) => ({
  model: model as never, modelId: family === 'claude' ? 'claude-sonnet-5' : 'judge-model', judgeFamily: family,
  brainFamily: 'byo' as const, transport: 'test', selfJudge: false,
});

test('optional host completion guidance preserves legacy instructions and refuses dynamic substitutions', () => {
  assert.equal(buildCompletionJudgeInstructions(), JUDGE_SYSTEM_PROMPT);
  assert.equal(buildCompletionJudgeInstructions({}), JUDGE_SYSTEM_PROMPT);
  assert.equal(buildCompletionJudgeInstructions({ memoryRequirementContext: 'source-bound memory evidence' }),
    `${JUDGE_SYSTEM_PROMPT}\n\n${MEMORY_REQUIREMENT_REVIEW_INSTRUCTIONS}`);
  assert.equal(HOST_COMPLETION_EVIDENCE_GUIDANCE.length, 1130, 'the relocated paragraph retains its exact bytes');
  assert.equal(createHash('sha256').update(HOST_COMPLETION_EVIDENCE_GUIDANCE).digest('hex'),
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
    assert.ok(system.endsWith(INSTRUCTION_CACHE_DELIM));
    assert.doesNotMatch(system, new RegExp(`source_${suffix}_`), 'no current-source facts or refs enter the stable prefix');
    const input = JSON.stringify(request.input);
    assert.doesNotMatch(input, /Judge only the effective accepted objective/);
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

test('the unchanged host guidance reaches the Anthropic cache block exactly once', async () => {
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
  assert.equal(JSON.stringify(body).split(HOST_COMPLETION_EVIDENCE_GUIDANCE).length - 1, 1);
  const messages = body.messages as Array<{ content: Array<{ type: string; text?: string }> }>;
  const sentPrompt = messages[0]!.content.filter(block => block.type === 'text').map(block => block.text).join('');
  assert.ok(sentPrompt.startsWith(prompt), 'the current-source review input is unchanged');
  assert.doesNotMatch(sentPrompt, /Judge only the effective accepted objective/);
});
