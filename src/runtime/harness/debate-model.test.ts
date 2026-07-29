import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';
import { StreamEventResponseCompleted } from '@openai/agents-core/types';
import type { DebateBrains } from './debate-model.js';

// Isolate from the host's ~/.clementine-next/.env: getRuntimeEnv() falls back to
// BASE_DIR/.env, so debateMode()/shouldDebate() default assertions must not see a
// CLEMMY_DEBATE_MODE the operator set live. Point BASE_DIR at an empty temp dir
// BEFORE the module (and config.ts) load — hence the dynamic import.
process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-debate-test-'));
const {
  DebateModel,
  debateMode,
  shouldDebate,
  buildJudgeRequest,
  buildVerifyRequest,
  summarizeOutput,
  heartbeatsUntil,
  streamResponseAsEvents,
  setJudgeOrderCoinForTest,
  resolveDebateBrains,
  verifyJudgeAvailable,
  resolveBoundaryJudge,
  resolveBoundaryJudgeHedge,
  readRecentDebateTraces,
} = await import('./debate-model.js');
const { withModelFallback } = await import('./fallback-model.js');
const { getDebateCheckerModel } = await import('../../config.js');

// Codex logged in, Claude NOT (a non-oat01 token blocks the host-keychain fallback
// so claudeAvailable() can't see the operator's real Claude login). Verify-judge tests.
function writeCodexAuth(): void {
  const state = path.join(process.env.CLEMENTINE_HOME as string, 'state');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'auth.json'), JSON.stringify({ codexOauth: { accessToken: 'codex-access', refreshToken: 'codex-refresh' } }), 'utf-8');
  writeFileSync(path.join(state, 'claude-auth.json'), JSON.stringify({ accessToken: 'sk-ant-api03-not-a-subscription-token' }), 'utf-8');
}
const fakeProvider = (m: Model): import('@openai/agents-core').ModelProvider => ({ getModel: () => m }) as import('@openai/agents-core').ModelProvider;

// --- fixtures ---------------------------------------------------------------

function req(extra: Record<string, unknown> = {}): ModelRequest {
  return { input: 'hi', systemInstructions: 'BASE', modelSettings: {}, tools: [], handoffs: [], ...extra } as unknown as ModelRequest;
}
function msg(text: string): ModelResponse {
  return { output: [{ type: 'message', content: text }], usage: {} } as unknown as ModelResponse;
}
function extractTextForTest(response: ModelResponse): string {
  const item = response.output.find((candidate) => (candidate as { type?: unknown }).type === 'message') as { content?: unknown } | undefined;
  if (typeof item?.content === 'string') return item.content;
  if (!Array.isArray(item?.content)) return '';
  return item.content
    .map((part) => (typeof (part as { text?: unknown }).text === 'string' ? String((part as { text?: unknown }).text) : ''))
    .join('');
}
function model(impl: Partial<Model>): Model {
  return {
    getResponse: impl.getResponse ?? (async () => msg('ok')),
    getStreamedResponse:
      impl.getStreamedResponse ??
      (async function* () {
        yield { type: 'response_started' } as any;
        yield { type: 'response_done', response: { output: [{ type: 'message', content: 'ok' }] } } as any;
      }),
  } as Model;
}
function brains(over: Partial<DebateBrains>): DebateBrains {
  return {
    passthrough: over.passthrough ?? model({}),
    draftA: over.draftA ?? model({ getResponse: async () => msg('A') }),
    draftB: over.draftB ?? model({ getResponse: async () => msg('B') }),
    judge: over.judge ?? model({ getResponse: async () => msg('JUDGED') }),
  };
}
async function collect(it: AsyncIterable<unknown>): Promise<any[]> {
  const o: any[] = [];
  for await (const e of it) o.push(e);
  return o;
}
// Tests exercise the fusion logic through getResponse, which in production is
// reserved for internal sub-calls (no fusion). fuseNonStreamed enables it here.
function dm(b: DebateBrains, opts: Record<string, unknown> = {}) {
  return new DebateModel(b, { fuseNonStreamed: true, ...opts } as any);
}
const noSleep = () => Promise.resolve();
function assertSdkDone(done: unknown) {
  assert.doesNotThrow(() => StreamEventResponseCompleted.parse(done));
}

function withEnv(env: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  const restore = () => {
    for (const k of Object.keys(env)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  };
  const r = fn();
  return r instanceof Promise ? r.finally(restore) : (restore(), r);
}

test('boundary judge with CLEMMY_JUDGE_CROSS_FAMILY=off binds a concrete same-family wire and disables the cross-family hedge', () => {
  // 2026-07-12: cross-family judging is now DEFAULT ON, so this pins the
  // kill-switch (=off) path — the operator's opt-back-out to a single-provider
  // failure domain: same-family judge, no hedge.
  const isolated = {
    CLEMMY_JUDGE_CROSS_FAMILY: 'off',
    BYO_PROVIDERS: '',
    BYO_MODEL_BASE_URL: '',
    BYO_MODEL_API_KEY: '',
    BYO_MODEL_ID: '',
  };
  withEnv({ ...isolated, AUTH_MODE: 'codex_oauth', MODEL_ROUTING_MODE: 'off', OPENAI_MODEL_PRIMARY: 'gpt-5.4' }, () => {
    const route = resolveBoundaryJudge();
    assert.equal(route.judgeFamily, 'codex');
    assert.equal(route.brainFamily, 'codex');
    assert.equal(route.transport, 'codex_responses');
    assert.ok(route.model, 'the Codex provider model is bound directly');
    assert.equal(resolveBoundaryJudgeHedge(route), null);
  });
  withEnv({ ...isolated, AUTH_MODE: 'claude_oauth', MODEL_ROUTING_MODE: 'off', CLAUDE_MODEL: 'claude-opus-4-8' }, () => {
    const route = resolveBoundaryJudge();
    assert.equal(route.judgeFamily, 'claude');
    assert.equal(route.brainFamily, 'claude');
    assert.equal(route.transport, 'claude_subscription');
    assert.ok(route.model, 'the Claude subscription model is bound directly');
    assert.equal(resolveBoundaryJudgeHedge(route), null);
  });
  withEnv({
    ...isolated,
    AUTH_MODE: 'api_key',
    MODEL_ROUTING_MODE: 'all_in',
    BYO_MODEL_BASE_URL: 'https://api.z.ai/v1',
    BYO_MODEL_API_KEY: 'zai-key',
    BYO_MODEL_ID: 'gpt-4o',
    BYO_MODEL_JUDGE_ID: 'gpt-4o-mini',
  }, () => {
    const route = resolveBoundaryJudge();
    assert.equal(route.judgeFamily, 'byo');
    assert.equal(route.brainFamily, 'byo');
    assert.equal(route.modelId, 'gpt-4o-mini');
    assert.equal(route.transport, 'byo_openai_compatible');
    assert.ok(route.model, 'the configured BYO model is bound directly');
    assert.equal(resolveBoundaryJudgeHedge(route), null);
  });
});

// --- mode + trigger ---------------------------------------------------------

test('debateMode: defaults OFF; on/all/high parse', () => {
  withEnv({ CLEMMY_DEBATE_MODE: undefined }, () => assert.equal(debateMode(), 'off'));
  withEnv({ CLEMMY_DEBATE_MODE: 'all' }, () => assert.equal(debateMode(), 'all'));
  withEnv({ CLEMMY_DEBATE_MODE: 'high' }, () => assert.equal(debateMode(), 'high'));
  withEnv({ CLEMMY_DEBATE_MODE: 'off' }, () => assert.equal(debateMode(), 'off'));
});

// Production request shape: the role:'user' item sits BEFORE the harness's
// appended role:'system' items (context packet, goal block) — the layout that
// made the v1 byte-length proxy fire on the packet, not the request.
const PACKET = { role: 'system', content: '[AGENT CONTEXT PACKET] ' + 'x'.repeat(1200) };
function goalItem(objective: string) {
  return { role: 'system', content: `[ACTIVE GOAL — parked outside this conversation.]\nObjective: ${objective}\nProgress so far:\n- earlier we already sent a draft to review` };
}
function userTurn(userText: string, ...sys: unknown[]) {
  return req({ input: [{ role: 'user', content: userText }, PACKET, ...sys], tools: [{}] });
}

test('shouldDebate: off never, all always; high (v2) reads the USER message + goal, not the context packet', () => {
  withEnv({ CLEMMY_DEBATE_MODE: 'off' }, () => assert.equal(shouldDebate(req()), false));
  withEnv({ CLEMMY_DEBATE_MODE: 'all' }, () => assert.equal(shouldDebate(req()), true));
  withEnv({ CLEMMY_DEBATE_MODE: 'all' }, () => {
    assert.equal(shouldDebate(req({ outputType: { type: 'object' } })), false, 'structured-output contracts never fuse');
  });
  withEnv({ CLEMMY_DEBATE_MODE: 'high', CLEMMY_DEBATE_STAKES_V2: 'on' }, () => {
    // REGRESSION for the over-fire bug: a packet-sized role:system context ALONE
    // (terse user, no action verb, no goal) must NOT fire — even though the
    // packet is 1200 chars and the user item is buried before it.
    assert.equal(shouldDebate(userTurn('what did we do yesterday?')), false, 'packet length alone no longer fires');
    // A terse user send-ask fires on the keyword (the FATAL case: the user item
    // is NOT last — system packet is appended after it — so a tail-walk would miss it).
    assert.equal(shouldDebate(userTurn('send the proposal to the client')), true, 'user keyword (user item is mid-array)');
    // Length is complexity, not risk. Long research belongs to the durable graph,
    // not an automatic second author.
    assert.equal(shouldDebate(userTurn('x'.repeat(850))), false, 'long user message alone does not fire');
    assert.equal(shouldDebate(userTurn('double-check this answer against the sources')), true, 'explicit verification request fires');
    // Harness continuations and proactive outcome relays project durable graph
    // state and must never be re-authored by Fusion — even for an action goal.
    assert.equal(shouldDebate(userTurn('Continue with the next step of your plan.', goalItem('Send the 8 priority-account outreach emails'))), false, 'continuation bypasses Fusion');
    assert.equal(shouldDebate(userTurn('Continue with the next step of your plan.', goalItem('Research and summarize the market'))), false, 'continuation + non-send goal (ledger "sent" excluded)');
    assert.equal(
      shouldDebate(userTurn('A background task you started from this conversation NEEDS ATTENTION (see the latest note).')),
      false,
      'durable outcome relay bypasses Fusion',
    );
  });
  // Kill-switch reverts to the legacy proxy, which over-fires on packet length.
  withEnv({ CLEMMY_DEBATE_MODE: 'high', CLEMMY_DEBATE_STAKES_V2: 'off' }, () => {
    assert.equal(shouldDebate(userTurn('what did we do yesterday?')), true, 'legacy: packet length over-fires (reverted)');
  });
});

test('shouldDebate: even mode=all cannot re-author durable outcome relays or continuation edges', () => {
  withEnv({ CLEMMY_DEBATE_MODE: 'all' }, () => {
    assert.equal(
      shouldDebate(userTurn('A background task you started from this conversation just finished (see the latest note).')),
      false,
    );
    assert.equal(
      shouldDebate(userTurn('Continue with the next step of your plan.', goalItem('Deploy the production app'))),
      false,
    );
  });
});

// --- getResponse paths ------------------------------------------------------

test('getResponse: NOT a debate turn → passthrough only; drafts/judge untouched', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'off' }, async () => {
    let drafted = 0;
    const b = brains({
      passthrough: model({ getResponse: async () => msg('PASS') }),
      draftA: model({ getResponse: async () => { drafted++; return msg('A'); } }),
      draftB: model({ getResponse: async () => { drafted++; return msg('B'); } }),
    });
    const res = await dm(b).getResponse(req());
    assert.equal((res.output[0] as any).content, 'PASS');
    assert.equal(drafted, 0, 'no drafting on a non-debate turn');
  });
});

test('getResponse: debate turn → both brains draft, judge sees both drafts and answers', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all' }, async () => {
    let judgeSystem = '';
    const b = brains({
      draftA: model({ getResponse: async () => msg('CLAUDE-DRAFT') }),
      draftB: model({ getResponse: async () => msg('CODEX-DRAFT') }),
      judge: model({ getResponse: async (r: any) => { judgeSystem = r.systemInstructions; return msg('FINAL'); } }),
    });
    const res = await dm(b).getResponse(req());
    assert.equal((res.output[0] as any).content, 'FINAL');
    assert.match(judgeSystem, /CLAUDE-DRAFT/);
    assert.match(judgeSystem, /CODEX-DRAFT/);
    assert.match(judgeSystem, /RECONCILE/);
  });
});

test('getResponse: slow debate judge hits deadline and falls back to the stronger draft', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all' }, async () => {
    let aborted = false;
    const b = brains({
      draftA: model({ getResponse: async () => msg('short') }),
      draftB: model({ getResponse: async () => msg('LONGER-CODEX-DRAFT') }),
      judge: model({ getResponse: async (r: any) => {
        const sig = r.signal as AbortSignal | undefined;
        sig?.addEventListener('abort', () => { aborted = true; }, { once: true });
        return new Promise<ModelResponse>(() => {});
      } }),
    });
    const t0 = Date.now();
    const res = await dm(b, { checkerDeadlineMs: 10 }).getResponse(req());
    assert.equal((res.output[0] as any).content, 'LONGER-CODEX-DRAFT');
    assert.ok(Date.now() - t0 < 2000, 'deadline fallback returned promptly');
    assert.equal(aborted, true, 'deadline aborts the late judge request');
  });
});

test('getResponse: one draft fails → fail open to the survivor (no judge)', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all' }, async () => {
    let judged = 0;
    const b = brains({
      draftA: model({ getResponse: async () => { throw new Error('claude down'); } }),
      draftB: model({ getResponse: async () => msg('CODEX-SURVIVES') }),
      judge: model({ getResponse: async () => { judged++; return msg('FINAL'); } }),
    });
    const res = await dm(b).getResponse(req());
    assert.equal((res.output[0] as any).content, 'CODEX-SURVIVES');
    assert.equal(judged, 0, 'judge skipped — only one draft survived');
  });
});

test('getResponse: a HUNG draft does not hold the turn hostage — grace elapses, survivor answers', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all' }, async () => {
    let judged = 0;
    const b = brains({
      draftA: model({ getResponse: () => new Promise<ModelResponse>(() => {}) }), // never resolves
      draftB: model({ getResponse: async () => msg('CODEX-FAST') }),
      judge: model({ getResponse: async () => { judged++; return msg('FINAL'); } }),
    });
    const t0 = Date.now();
    const res = await dm(b, { draftGraceMs: 30 }).getResponse(req());
    const elapsed = Date.now() - t0;
    assert.equal((res.output[0] as any).content, 'CODEX-FAST', 'fell open to the fast survivor');
    assert.equal(judged, 0, 'no judge — only one draft made the grace window');
    assert.ok(elapsed < 2000, `returned promptly (~grace), not hostage to the hung draft (took ${elapsed}ms)`);
  });
});

test('getResponse: BOTH drafts fail → passthrough last resort', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all' }, async () => {
    const b = brains({
      draftA: model({ getResponse: async () => { throw new Error('down'); } }),
      draftB: model({ getResponse: async () => { throw new Error('down'); } }),
      passthrough: model({ getResponse: async () => msg('LASTRESORT') }),
    });
    const res = await dm(b).getResponse(req());
    assert.equal((res.output[0] as any).content, 'LASTRESORT');
  });
});

// --- getStreamedResponse paths ---------------------------------------------

test('getStreamedResponse: non-debate turn forwards passthrough verbatim', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'off' }, async () => {
    const b = brains({
      passthrough: model({ getStreamedResponse: async function* () {
        yield { type: 'response_started' } as any;
        yield { type: 'output_text_delta', delta: 'PASSTHRU' } as any;
        yield { type: 'response_done', response: { output: [{ type: 'message' }] } } as any;
      } }),
    });
    const evs = await collect(dm(b).getStreamedResponse(req()));
    assert.ok(evs.some((e) => e.type === 'output_text_delta' && e.delta === 'PASSTHRU'));
    assert.equal(evs.filter((e) => e.type === 'response_started').length, 1);
  });
});

test('getStreamedResponse: structured-output requests skip fusion even when enabled', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all', CLEMMY_FUSION_STRATEGY: 'verify' }, async () => {
    let judged = 0;
    const b = brains({
      passthrough: model({ getStreamedResponse: async function* () {
        yield { type: 'response_started', providerData: { passthrough: true } } as any;
        yield { type: 'output_text_delta', delta: '{"reply":"ok"}' } as any;
        yield { type: 'response_done', response: { id: 'pass', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '{"reply":"ok"}' }] }], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } } as any;
      } }),
      judge: model({ getStreamedResponse: async function* () { judged++; yield { type: 'response_done', response: { output: [] } } as any; } }),
    });
    const evs = await collect(dm(b).getStreamedResponse(req({ outputType: { type: 'object' } })));
    assert.equal(judged, 0, 'checker/judge was not called');
    assert.equal(evs.filter((e) => e.type === 'response_started').length, 1);
    assert.ok(evs.some((e) => e.type === 'response_started' && e.providerData?.passthrough === true), 'passthrough stream was forwarded verbatim');
  });
});

test('getStreamedResponse: debate streams the JUDGE; exactly one response_started; no content before judge', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all' }, async () => {
    const b = brains({
      judge: model({ getStreamedResponse: async function* () {
        yield { type: 'response_started' } as any; // must be dropped (we emit our own)
        yield { type: 'output_text_delta', delta: 'RECONCILED' } as any;
        yield { type: 'response_done', response: { output: [{ type: 'message', content: 'RECONCILED' }] } } as any;
      } }),
    });
    const evs = await collect(dm(b, { heartbeatMs: 0 }).getStreamedResponse(req()));
    assert.equal(evs.filter((e) => e.type === 'response_started').length, 1, 'one response_started total');
    const firstContentIdx = evs.findIndex((e) => e.type === 'output_text_delta');
    const startIdx = evs.findIndex((e) => e.type === 'response_started');
    assert.ok(startIdx >= 0 && startIdx < firstContentIdx, 'response_started precedes any content');
    assert.ok(evs.some((e) => e.type === 'output_text_delta' && e.delta === 'RECONCILED'));
    assert.equal(evs.filter((e) => e.type === 'response_done').length, 1);
  });
});

test('getStreamedResponse: debate judge can start then hang; deadline aborts and streams fallback draft', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all' }, async () => {
    let aborted = false;
    const b = brains({
      draftA: model({ getResponse: async () => msg('short') }),
      draftB: model({ getResponse: async () => msg('LONGER-STREAM-DRAFT') }),
      judge: model({ getStreamedResponse: async function* (r: any) {
        const sig = r.signal as AbortSignal | undefined;
        sig?.addEventListener('abort', () => { aborted = true; }, { once: true });
        yield { type: 'response_started' } as any;
        await new Promise<void>((resolve) => sig?.addEventListener('abort', () => resolve(), { once: true }));
      } }),
    });
    const evs = await collect(dm(b, { heartbeatMs: 0, checkerDeadlineMs: 10 }).getStreamedResponse(req()));
    assert.ok(evs.some((e) => e.type === 'output_text_delta' && e.delta === 'LONGER-STREAM-DRAFT'), 'streamed the fallback draft');
    assert.equal(evs.filter((e) => e.type === 'response_done').length, 1);
    assert.equal(aborted, true, 'deadline aborts the late debate judge');
  });
});

test('getStreamedResponse: slow drafting emits keep-alive frames (no committed content)', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all' }, async () => {
    // A draft that resolves only after a couple of heartbeat ticks.
    let resolveA: (v: ModelResponse) => void;
    const slowA = new Promise<ModelResponse>((r) => { resolveA = r; });
    const b = brains({
      draftA: model({ getResponse: () => slowA }),
      draftB: model({ getResponse: async () => msg('B') }),
      judge: model({ getStreamedResponse: async function* () {
        yield { type: 'output_text_delta', delta: 'FINAL' } as any;
        yield { type: 'response_done', response: { output: [{ type: 'message' }] } } as any;
      } }),
    });
    // Heartbeat every tick; sleep is immediate so ticks fire until the draft resolves.
    let ticks = 0;
    const sleep = async () => { ticks++; if (ticks === 3) resolveA(msg('A')); };
    const evs = await collect(dm(b, { heartbeatMs: 1, sleep }).getStreamedResponse(req()));
    const keepalives = evs.filter((e) => e.type === 'model' && e.event?.type === 'debate.keepalive');
    assert.ok(keepalives.length >= 1, 'at least one keep-alive while drafting');
    // Keep-alives never carry committed content.
    const kaIdx = evs.findIndex((e) => e.type === 'model');
    const contentIdx = evs.findIndex((e) => e.type === 'output_text_delta');
    assert.ok(kaIdx < contentIdx, 'keep-alives precede the judge content');
  });
});

// --- helpers ----------------------------------------------------------------

test('buildJudgeRequest: isolates a redacted synthesis packet from the executor transport', () => {
  const signal = new AbortController().signal;
  const r = req({
    input: [
      {
        role: 'user',
        content: 'Reconcile deployment resource deploy-ordinary-42. OPENAI_API_KEY=sk-judge-user-secret-123456',
      },
      {
        type: 'function_call_result',
        name: 'railway',
        output: {
          resource_id: 'deploy-ordinary-42',
          OPENAI_API_KEY: 'sk-judge-tool-secret-123456',
        },
      },
      { role: 'system', content: 'Goal deploy-ordinary-42. Authorization: Bearer judge-system-secret-123456' },
    ],
    systemInstructions: 'FULL EXECUTOR HARNESS COMPOSIO_API_KEY=sk-judge-harness-secret-123456',
    tools: [{ name: 't', description: 'secret sk-judge-tool-schema-123456' }],
    handoffs: [{ name: 'h' }],
    previousResponseId: 'executor-response-secret',
    conversationId: 'executor-conversation-secret',
    prompt: { id: 'executor-prompt-secret' },
    signal,
    modelSettings: {
      temperature: 0.3,
      providerData: {
        headers: { Authorization: 'Bearer judge-provider-secret-123456' },
        apiKey: 'sk-judge-provider-key-123456',
      },
    },
  });
  const jr = buildJudgeRequest(
    r,
    msg('DRAFT-A deploy-ordinary-42. Bearer judge-draft-a-secret-123456'),
    msg('DRAFT-B deploy-ordinary-42. COMPOSIO_API_KEY=sk-judge-draft-b-secret-123456'),
  ) as any;
  const serialized = JSON.stringify(jr);
  assert.deepEqual(jr.tools, [], 'executor tool schemas never cross into the judge lane');
  assert.deepEqual(jr.handoffs, [], 'executor handoffs never cross into the judge lane');
  assert.equal(jr.modelSettings.temperature, 0.3, 'safe generic model settings survive');
  assert.equal(jr.signal, signal, 'caller cancellation remains authoritative');
  assert.equal(jr.previousResponseId, undefined, 'executor response identity is not inherited');
  assert.equal(jr.conversationId, undefined, 'executor conversation identity is not inherited');
  assert.equal(jr.prompt, undefined, 'executor prompt-template identity is not inherited');
  assert.doesNotMatch(serialized, /judge-(?:user|tool|system|harness|provider|draft)[-a-z0-9]*/i);
  assert.doesNotMatch(serialized, /FULL EXECUTOR HARNESS/);
  assert.match(serialized, /\[REDACTED\]/, 'known credentials are replaced before crossing providers');
  assert.match(serialized, /deploy-ordinary-42/, 'ordinary evidence and resource ids survive');
  assert.match(jr.systemInstructions, /DRAFT-A/);
  assert.match(jr.systemInstructions, /DRAFT-B/);
});

test('buildJudgeRequest randomizes draft order to cancel position bias (content preserved)', () => {
  const r = req();
  try {
    // No swap: Claude (a) renders under "DRAFT A", Codex (b) under "DRAFT B".
    setJudgeOrderCoinForTest(() => false);
    const noSwap = (buildJudgeRequest(r, msg('CLAUDE_DRAFT'), msg('CODEX_DRAFT')) as any).systemInstructions as string;
    assert.ok(
      noSwap.indexOf('CLAUDE_DRAFT') > noSwap.indexOf('--- DRAFT A ---') &&
        noSwap.indexOf('CLAUDE_DRAFT') < noSwap.indexOf('--- DRAFT B ---'),
      'no-swap: Claude draft sits under DRAFT A',
    );
    assert.ok(noSwap.indexOf('CODEX_DRAFT') > noSwap.indexOf('--- DRAFT B ---'), 'no-swap: Codex draft under DRAFT B');

    // Swap: the order flips so neither provider is structurally first.
    setJudgeOrderCoinForTest(() => true);
    const swapped = (buildJudgeRequest(r, msg('CLAUDE_DRAFT'), msg('CODEX_DRAFT')) as any).systemInstructions as string;
    assert.ok(
      swapped.indexOf('CODEX_DRAFT') > swapped.indexOf('--- DRAFT A ---') &&
        swapped.indexOf('CODEX_DRAFT') < swapped.indexOf('--- DRAFT B ---'),
      'swap: Codex draft sits under DRAFT A',
    );
    assert.ok(swapped.indexOf('CLAUDE_DRAFT') > swapped.indexOf('--- DRAFT B ---'), 'swap: Claude draft under DRAFT B');

    // Both drafts are always present regardless of order.
    for (const s of [noSwap, swapped]) {
      assert.match(s, /CLAUDE_DRAFT/);
      assert.match(s, /CODEX_DRAFT/);
    }
  } finally {
    setJudgeOrderCoinForTest(null);
  }
});

test('buildVerifyRequest / buildJudgeRequest DISABLE extended thinking (effort=none + strips a pre-set anthropic.effort)', () => {
  // The checker inheriting the turn effort turned on Claude extended thinking,
  // which corrupted its structured output (thinking bled into the reply). Both
  // builders must force no-thinking.
  const r = req({
    modelSettings: {
      temperature: 0.3,
      reasoning: { effort: 'high' },
      providerData: { providerOptions: { anthropic: { effort: 'high' } } },
    },
  });
  for (const built of [buildVerifyRequest(r, msg('D')) as any, buildJudgeRequest(r, msg('A'), msg('B')) as any]) {
    assert.equal(built.modelSettings.reasoning.effort, 'none', 'reasoning effort forced to none');
    assert.equal(built.modelSettings.providerData.providerOptions.anthropic.effort, undefined, 'pre-translated anthropic effort stripped');
    assert.equal(built.modelSettings.temperature, 0.3, 'other modelSettings preserved');
  }
});

test('buildVerifyRequest: isolates a bounded evidence packet and strips the executor graph', () => {
  const r = req({
    input: [
      { role: 'user', content: 'Deploy the app.' },
      { type: 'function_call_result', name: 'railway', output: { ok: true, url: 'https://example.test' } },
      { role: 'system', content: `[ACTIVE GOAL]\n${'x'.repeat(30_000)}` },
    ],
    systemInstructions: `FULL EXECUTOR HARNESS ${'y'.repeat(20_000)}`,
    tools: [{ name: 't' }],
    handoffs: [{ name: 'h' }],
    modelSettings: { temperature: 0.3, toolChoice: 'required', maxTokens: 9_000 },
  });
  const vr = buildVerifyRequest(r, msg('DRAFT')) as any;
  assert.deepEqual(vr.tools, [], 'tools stripped');
  assert.deepEqual(vr.handoffs, [], 'handoffs stripped');
  assert.equal(vr.outputType.type, 'json_schema', 'verdict has a provider-visible JSON contract');
  assert.equal(vr.outputType.name, 'fusion_verdict');
  assert.equal(vr.outputType.strict, true);
  assert.deepEqual(vr.outputType.schema.required, ['verdict', 'issues', 'corrected']);
  assert.equal(vr.outputType.schema.additionalProperties, false);
  assert.equal(vr.modelSettings.temperature, 0.3, 'other modelSettings preserved');
  assert.equal(vr.modelSettings.toolChoice, undefined, 'executor tool choice stripped');
  assert.ok(vr.modelSettings.maxTokens <= 1_800, 'checker output is capped');
  assert.doesNotMatch(vr.systemInstructions, /FULL EXECUTOR HARNESS/, 'full harness prompt is not inherited');
  assert.match(vr.systemInstructions, /narrow cross-model VERIFIER/, 'checker gets only its narrow contract');
  assert.match(vr.input, /DRAFT/, 'the draft is included in the verifier packet');
  assert.match(vr.input, /https:\/\/example\.test/, 'recent tool evidence is included');
  assert.ok(vr.input.length < 20_000, 'huge runtime context is bounded');
});

test('buildVerifyRequest: redacts credentials and drops executor conversation/provider identity', () => {
  const signal = new AbortController().signal;
  const r = req({
    input: [
      {
        role: 'user',
        content: 'Check resource sheet-ordinary-91 with OPENAI_API_KEY=sk-verify-user-secret-123456.',
      },
      {
        type: 'function_call_result',
        name: 'sheets',
        output: {
          resource_id: 'sheet-ordinary-91',
          refresh_token: 'verify-refresh-secret-123456',
          detail: 'Authorization: Bearer verify-tool-bearer-123456',
        },
      },
      { role: 'system', content: 'Goal sheet-ordinary-91. DISCORD_BOT_TOKEN=verify-system-secret-123456' },
    ],
    systemInstructions: 'FULL EXECUTOR HARNESS sk-verify-harness-secret-123456',
    tools: [{ name: 't', description: 'sk-verify-tool-schema-123456' }],
    handoffs: [{ name: 'h' }],
    previousResponseId: 'verify-response-secret',
    conversationId: 'verify-conversation-secret',
    prompt: { id: 'verify-prompt-secret' },
    signal,
    modelSettings: {
      temperature: 0.2,
      providerData: {
        headers: { Authorization: 'Bearer verify-provider-secret-123456' },
        apiKey: 'sk-verify-provider-key-123456',
      },
    },
  });
  const vr = buildVerifyRequest(
    r,
    msg('Resource sheet-ordinary-91 is ready. Bearer verify-draft-secret-123456'),
  ) as any;
  const serialized = JSON.stringify(vr);

  assert.equal(vr.signal, signal, 'caller cancellation remains authoritative');
  assert.equal(vr.previousResponseId, undefined);
  assert.equal(vr.conversationId, undefined);
  assert.equal(vr.prompt, undefined);
  assert.deepEqual(vr.tools, []);
  assert.deepEqual(vr.handoffs, []);
  assert.equal(vr.modelSettings.temperature, 0.2, 'safe generic model settings survive');
  assert.doesNotMatch(serialized, /verify-(?:user|refresh|tool|system|harness|provider|draft|response|conversation|prompt)[-a-z0-9]*/i);
  assert.doesNotMatch(serialized, /FULL EXECUTOR HARNESS/);
  assert.match(serialized, /\[REDACTED\]/);
  assert.match(serialized, /sheet-ordinary-91/, 'ordinary evidence and ids remain available to the checker');
});

test('fusion trace excerpts redact credentials for VERIFY and legacy DEBATE', async () => {
  const tracePath = path.join(process.env.CLEMENTINE_HOME as string, 'state', 'debate-traces.jsonl');
  await withEnv(
    { NODE_ENV: undefined, CLEMMY_DEBATE_MODE: 'all', CLEMMY_FUSION_STRATEGY: 'verify' },
    async () => {
      const b = brains({
        passthrough: model({
          getResponse: async () => msg(
            'VERIFY-TRACE-ID-91 resource-id-91 OPENAI_API_KEY=sk-verify-trace-secret-123456',
          ),
        }),
        judge: model({
          getResponse: async () => msg('{"verdict":"accept","issues":[],"corrected":null}'),
        }),
      });
      await dm(b).getResponse(req());
    },
  );
  const persistedAfterVerify = readFileSync(tracePath, 'utf8')
    .split('\n')
    .find((line) => line.includes('VERIFY-TRACE-ID-91'));
  assert.ok(persistedAfterVerify, 'VERIFY trace row was persisted');
  const verifySerialized = persistedAfterVerify;
  assert.doesNotMatch(verifySerialized, /sk-verify-trace-secret-123456/);
  assert.match(verifySerialized, /\[REDACTED\]/);
  assert.match(verifySerialized, /resource-id-91/);

  await withEnv(
    { NODE_ENV: undefined, CLEMMY_DEBATE_MODE: 'all', CLEMMY_FUSION_STRATEGY: 'debate' },
    async () => {
      const b = brains({
        draftA: model({
          getResponse: async () => msg(
            'DEBATE-TRACE-ID-92 resource-id-92 OPENAI_API_KEY=sk-debate-trace-a-123456',
          ),
        }),
        draftB: model({
          getResponse: async () => msg(
            'DEBATE-TRACE-ID-92 resource-id-92 Bearer debate-trace-b-secret-123456',
          ),
        }),
        judge: model({
          getResponse: async () => msg(
            'DEBATE-TRACE-ID-92 resource-id-92 COMPOSIO_API_KEY=sk-debate-trace-final-123456',
          ),
        }),
      });
      await dm(b).getResponse(req());
    },
  );
  const persistedAfterDebate = readFileSync(tracePath, 'utf8')
    .split('\n')
    .find((line) => line.includes('DEBATE-TRACE-ID-92'));
  assert.ok(persistedAfterDebate, 'legacy DEBATE trace row was persisted');
  const debateSerialized = persistedAfterDebate;
  assert.doesNotMatch(debateSerialized, /sk-debate-trace-(?:a|final)-123456|debate-trace-b-secret-123456/);
  assert.match(debateSerialized, /\[REDACTED\]/);
  assert.match(debateSerialized, /resource-id-92/);

  const consoleRows = readRecentDebateTraces(20);
  assert.ok(consoleRows.some((row) => JSON.stringify(row).includes('VERIFY-TRACE-ID-91')));
  assert.ok(consoleRows.some((row) => JSON.stringify(row).includes('DEBATE-TRACE-ID-92')));
});

test('getDebateCheckerModel: defaults to Sonnet (fast, low-contention checker); env overrides', () => {
  const prev = process.env.CLEMMY_DEBATE_CHECKER_MODEL;
  try {
    delete process.env.CLEMMY_DEBATE_CHECKER_MODEL;
    assert.equal(getDebateCheckerModel(), 'claude-sonnet-4-6', 'default checker is Sonnet, not the Opus brain');
    process.env.CLEMMY_DEBATE_CHECKER_MODEL = 'claude-opus-4-8';
    assert.equal(getDebateCheckerModel(), 'claude-opus-4-8', 'override honored');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_DEBATE_CHECKER_MODEL;
    else process.env.CLEMMY_DEBATE_CHECKER_MODEL = prev;
  }
});

test('summarizeOutput: renders message text and proposed tool calls', () => {
  const out = [
    { type: 'message', content: 'hello world' },
    { type: 'function_call', name: 'send_email', arguments: { to: 'x@y.z' } },
  ];
  const s = summarizeOutput(out);
  assert.match(s, /hello world/);
  assert.match(s, /proposes tool call: send_email/);
});

test('streamResponseAsEvents: text delta then a response_done carrying the output', async () => {
  const evs = await collect((async function* () { yield* streamResponseAsEvents(msg('SOLO')); })());
  assert.ok(evs.some((e) => e.type === 'output_text_delta' && e.delta === 'SOLO'));
  const done = evs.find((e) => e.type === 'response_done');
  assert.ok(done, 'response_done present');
  assert.equal((done.response.output[0] as any).content[0].text, 'SOLO');
  assertSdkDone(done);
});

// --- P0 regression: SDK-conformant response_done on the fail-open paths -------
// (audit found a CRITICAL crash: a survivor/judge-fallback response_done with no
//  id + empty usage throws a ZodError in the SDK and crashes the turn — the exact
//  path the grace/fail-open feature exists for.)

test('streamResponseAsEvents: response_done is SDK-conformant (non-empty id + numeric usage)', async () => {
  const evs = await collect((async function* () { yield* streamResponseAsEvents(msg('SOLO')); })());
  const done: any = evs.find((e) => e.type === 'response_done');
  assert.equal(typeof done.response.id, 'string');
  assert.ok(done.response.id.length > 0, 'non-empty id (else the SDK Zod parse crashes the turn)');
  assert.equal(typeof done.response.usage.inputTokens, 'number');
  assert.equal(typeof done.response.usage.outputTokens, 'number');
  assert.equal(typeof done.response.usage.totalTokens, 'number');
  assertSdkDone(done);
});

test('streamResponseAsEvents: normalizes legacy model output into SDK response_done content parts', async () => {
  const resp = {
    output: [
      { type: 'message', content: 'LEGACY-STRING' },
      { type: 'message', role: 'user', status: 'completed', content: [{ type: 'output_text', text: 'WRONG-ROLE-PART' }] },
      { type: 'reasoning', content: [{ type: 'output_text', text: 'REASONING' }] },
    ],
    usage: {},
  } as any;
  const evs = await collect((async function* () { yield* streamResponseAsEvents(resp); })());
  const done: any = evs.find((e) => e.type === 'response_done');
  assertSdkDone(done);
  assert.equal(done.response.output[0].role, 'assistant');
  assert.equal(done.response.output[0].content[0].type, 'output_text');
  assert.equal(done.response.output[1].role, 'assistant');
  assert.equal(done.response.output[1].content[0].type, 'output_text');
  assert.equal(done.response.output[2].content[0].type, 'input_text');
});

test('streamResponseAsEvents: preserves a real responseId + sums usage when present', async () => {
  const resp = { output: [{ type: 'message', content: 'X' }], responseId: 'resp_123', usage: { inputTokens: 10, outputTokens: 5 } } as any;
  const evs = await collect((async function* () { yield* streamResponseAsEvents(resp); })());
  const done: any = evs.find((e) => e.type === 'response_done');
  assert.equal(done.response.id, 'resp_123');
  assert.equal(done.response.usage.inputTokens, 10);
  assert.equal(done.response.usage.totalTokens, 15);
});

test('getStreamedResponse survivor (fail-open) path emits a conformant response_done', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all' }, async () => {
    const b = brains({
      draftA: model({ getResponse: async () => { throw new Error('down'); } }),
      draftB: model({ getResponse: async () => ({ output: [{ type: 'message', content: 'SURV' }], responseId: 'r1', usage: { inputTokens: 3, outputTokens: 2 } } as any) }),
    });
    const evs = await collect(dm(b, { heartbeatMs: 0 }).getStreamedResponse(req()));
    const done: any = evs.find((e) => e.type === 'response_done');
    assert.ok(done && typeof done.response.id === 'string' && done.response.id.length > 0);
    assert.equal(typeof done.response.usage.totalTokens, 'number');
    assert.equal(evs.filter((e) => e.type === 'response_started').length, 1, 'one response_started total');
  });
});

// --- P0: judge failure must NOT fail the turn when two drafts exist -----------

test('getResponse: judge failure falls back to the longer surviving draft', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all' }, async () => {
    const b = brains({
      draftA: model({ getResponse: async () => msg('SHORT') }),
      draftB: model({ getResponse: async () => msg('A MUCH LONGER DRAFT ANSWER') }),
      judge: model({ getResponse: async () => { throw new Error('judge down'); } }),
    });
    const res = await dm(b).getResponse(req());
    assert.equal((res.output[0] as any).content, 'A MUCH LONGER DRAFT ANSWER', 'fell back to the longer draft');
  });
});

test('getStreamedResponse: judge failure PRE-content replays a surviving draft (conformant, no crash)', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all' }, async () => {
    const b = brains({
      draftA: model({ getResponse: async () => msg('DRAFT-A-LONGER-ANSWER') }),
      draftB: model({ getResponse: async () => msg('B') }),
      judge: model({ getStreamedResponse: async function* () { throw new Error('judge stream down'); } }),
    });
    const evs = await collect(dm(b, { heartbeatMs: 0 }).getStreamedResponse(req()));
    assert.ok(evs.some((e) => e.type === 'output_text_delta' && e.delta === 'DRAFT-A-LONGER-ANSWER'));
    const done: any = evs.find((e) => e.type === 'response_done');
    assert.ok(done && done.response.id && typeof done.response.usage.totalTokens === 'number');
    assert.equal(evs.filter((e) => e.type === 'response_started').length, 1);
  });
});

test('fan-out worker scope is NOT fused — runs single-brain (no checker/judge, no budget burn)', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all', CLEMMY_FUSION_STRATEGY: 'verify' }, async () => {
    let judged = 0;
    const b = brains({
      passthrough: model({ getResponse: async () => msg('WORKER-OUTPUT'), getStreamedResponse: async function* () {
        yield { type: 'output_text_delta', delta: 'WORKER-OUTPUT' } as any;
        yield { type: 'response_done', response: { output: [{ type: 'message', content: 'WORKER-OUTPUT' }] } } as any;
      } }),
      judge: model({ getResponse: async () => { judged++; return msg('X'); }, getStreamedResponse: async function* () { judged++; yield { type: 'response_done', response: { output: [] } } as any; } }),
    });
    const { harnessRunContextStorage } = await import('./brackets.js');
    const evs = await harnessRunContextStorage.run(
      { sessionId: 's', counter: {} as any, guardrailScopeId: 'worker-1' } as any,
      () => collect(dm(b, { heartbeatMs: 0 }).getStreamedResponse(req())),
    );
    assert.equal(judged, 0, 'no checker/judge inside a worker scope');
    assert.ok(evs.some((e) => e.type === 'output_text_delta' && e.delta === 'WORKER-OUTPUT'), 'worker ran single-brain');
  });
});

test('debate: judge streams text but NO terminal response_done → one is synthesized (no SDK crash)', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all' }, async () => {
    const b = brains({
      judge: model({ getStreamedResponse: async function* () {
        yield { type: 'output_text_delta', delta: 'ANSWER' } as any; // no response_done!
      } }),
    });
    const evs = await collect(dm(b, { heartbeatMs: 0 }).getStreamedResponse(req()));
    const dones: any[] = evs.filter((e) => e.type === 'response_done');
    assert.equal(dones.length, 1, 'exactly one synthesized terminal response_done');
    assert.ok(dones[0].response.id && typeof dones[0].response.usage.totalTokens === 'number', 'conformant');
  });
});

test('verify: malformed checker verdict is buffered and Clementine draft ships exactly once', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all', CLEMMY_FUSION_STRATEGY: 'verify' }, async () => {
    const b = brains({
      passthrough: model({ getResponse: async () => msg('DRAFT-PROSE') }),
      judge: model({ getResponse: async () => msg('I would rewrite this completely.') }),
    });
    const evs = await collect(dm(b, { heartbeatMs: 0 }).getStreamedResponse(req()));
    assert.equal(evs.filter((e) => e.type === 'response_started').length, 1);
    assert.equal(evs.filter((e) => e.type === 'response_done').length, 1);
    assert.ok(evs.some((e) => e.type === 'output_text_delta' && e.delta === 'DRAFT-PROSE'));
    assert.doesNotMatch(JSON.stringify(evs), /rewrite this completely/);
  });
});

test('verify: a valid bounded correction is applied to the draft and replayed as one conformant response', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all', CLEMMY_FUSION_STRATEGY: 'verify' }, async () => {
    const b = brains({
      passthrough: model({ getResponse: async () => ({
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The deploy is at example.test.' }] }],
        responseId: 'draft-id',
        usage: {},
      } as any) }),
      judge: model({ getResponse: async () => msg(JSON.stringify({
        verdict: 'correct',
        issues: ['The supplied tool receipt contains the HTTPS URL.'],
        corrected: 'The deploy is live at https://example.test.',
      })) }),
    });
    const evs = await collect(dm(b, { heartbeatMs: 0 }).getStreamedResponse(req()));
    const done: any = evs.find((e) => e.type === 'response_done');
    assertSdkDone(done);
    assert.equal(done.response.id, 'draft-id', 'the executor response identity is preserved');
    assert.equal(done.response.output[0].role, 'assistant');
    assert.equal(done.response.output[0].content[0].text, 'The deploy is live at https://example.test.');
    assert.equal(evs.filter((e) => e.type === 'response_done').length, 1);
  });
});

test('verify: a HUNG checker ships the executor draft past the deadline — no failure, no hang', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all', CLEMMY_FUSION_STRATEGY: 'verify' }, async () => {
    let aborted = false;
    const b = brains({
      passthrough: model({ getResponse: async () => msg('DRAFT-PROSE') }),
      judge: model({ getResponse: async (r: any) => {
        const sig = r.signal as AbortSignal | undefined;
        sig?.addEventListener('abort', () => { aborted = true; }, { once: true });
        return new Promise<ModelResponse>(() => {});
      } }),
    });
    const evs = await collect(dm(b, { heartbeatMs: 0, checkerDeadlineMs: 10 }).getStreamedResponse(req()));
    const dones: any[] = evs.filter((e) => e.type === 'response_done');
    assert.equal(dones.length, 1, 'exactly one response_done — the shipped draft (no crash, no duplicate)');
    assert.match(JSON.stringify(evs), /DRAFT-PROSE/, 'shipped the executor draft instead of failing on the hung checker');
    assert.equal(aborted, true, 'deadline aborts the late checker');
  });
});

test('getStreamedResponse: judge failure AFTER content rethrows (cannot duplicate a partial stream)', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all' }, async () => {
    const b = brains({
      judge: model({ getStreamedResponse: async function* () {
        yield { type: 'output_text_delta', delta: 'partial' } as any;
        throw new Error('judge died mid-stream');
      } }),
    });
    const got: any[] = [];
    await assert.rejects(async () => { for await (const e of dm(b, { heartbeatMs: 0 }).getStreamedResponse(req())) got.push(e); });
    assert.ok(got.some((e) => e.type === 'output_text_delta' && e.delta === 'partial'));
  });
});

test('legacy DEBATE routes tool-bearing turns executor-first and preserves the executable edge unchanged', async () => {
  await withEnv(
    { CLEMMY_DEBATE_MODE: 'all', CLEMMY_FUSION_STRATEGY: 'debate' },
    async () => {
      const executableDraft = {
        output: [{
          type: 'function_call',
          name: 'send_email',
          callId: 'call-preserve-1',
          arguments: '{"to":"user@example.test"}',
        }],
        usage: {},
      } as unknown as ModelResponse;
      let executorCalls = 0;
      let draftCalls = 0;
      let judgeCalls = 0;
      const b = brains({
        passthrough: model({
          getResponse: async () => {
            executorCalls += 1;
            return executableDraft;
          },
        }),
        draftA: model({
          getResponse: async () => {
            draftCalls += 1;
            return msg('should not draft A');
          },
        }),
        draftB: model({
          getResponse: async () => {
            draftCalls += 1;
            return msg('should not draft B');
          },
        }),
        judge: model({
          getResponse: async () => {
            judgeCalls += 1;
            return msg('should not reconcile');
          },
        }),
      });

      const response = await dm(b).getResponse(req({ tools: [{ name: 'send_email' }] }));

      assert.equal(response, executableDraft, 'the active executor tool call survives byte-for-byte');
      assert.equal(executorCalls, 1);
      assert.equal(draftCalls, 0, 'parallel authoring is skipped on an executable graph edge');
      assert.equal(judgeCalls, 0, 'a tool-less judge is never asked to recreate the executable edge');
    },
  );
});

// --- 'verify' strategy: Codex drives (executor=passthrough), Claude checks (judge) ---

test('verify strategy: executor authors once, checker returns a typed correction', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all', CLEMMY_FUSION_STRATEGY: 'verify' }, async () => {
    let executorCalls = 0;
    let checkerSawDraft = '';
    const b = brains({
      passthrough: model({ getResponse: async () => { executorCalls += 1; return msg('CODEX-DRAFT'); } }),
      judge: model({ getResponse: async (r: any) => {
        checkerSawDraft = r.input;
        return msg(JSON.stringify({
          verdict: 'correct',
          issues: ['A concrete evidence-backed correction is required.'],
          corrected: 'CLAUDE-CORRECTION',
        }));
      } }),
    });
    const res = await dm(b).getResponse(req());
    assert.equal((res.output[0] as any).content, 'CLAUDE-CORRECTION');
    assert.equal(executorCalls, 1, 'executor drafted exactly once (2 calls total, not 3)');
    assert.match(checkerSawDraft, /CODEX-DRAFT/, 'checker received the executor draft');
    assert.match(checkerSawDraft, /Return only the JSON verdict object/);
  });
});

test('verify strategy: a delayed healthy executor is not mistaken for first-byte silence', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all', CLEMMY_FUSION_STRATEGY: 'verify' }, async () => {
    let primaryCalls = 0;
    let rescueCalls = 0;
    const primary = model({
      getResponse: async () => {
        primaryCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 40));
        return msg('HEALTHY-PRIMARY-DRAFT');
      },
    });
    const rescue = model({
      getResponse: async () => {
        rescueCalls += 1;
        return msg('UNEXPECTED-RESCUE-DRAFT');
      },
    });
    const routedExecutor = withModelFallback(
      [
        { label: 'healthy-primary', getModel: () => primary },
        { label: 'rescue', getModel: () => rescue },
      ],
      { firstByteTimeoutMs: 10 },
    );
    const b = brains({
      passthrough: routedExecutor,
      judge: model({ getResponse: async () => msg('{"verdict":"accept","issues":[],"corrected":null}') }),
    });

    const evs = await collect(dm(b, { heartbeatMs: 0 }).getStreamedResponse(req()));

    assert.equal(primaryCalls, 1);
    assert.equal(rescueCalls, 0, 'first-byte timing applies to streams, not total getResponse latency');
    assert.ok(evs.some((event) => event.type === 'output_text_delta' && event.delta === 'HEALTHY-PRIMARY-DRAFT'));
  });
});

test('verify strategy: accept verdict preserves Clementine response byte-for-byte', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all', CLEMMY_FUSION_STRATEGY: 'verify' }, async () => {
    const draft = {
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Exact Clementine answer.' }] }],
      responseId: 'exact-draft',
      usage: { inputTokens: 3, outputTokens: 4 },
    } as unknown as ModelResponse;
    const b = brains({
      passthrough: model({ getResponse: async () => draft }),
      judge: model({ getResponse: async () => msg('{"verdict":"accept","issues":[]}') }),
    });
    const res = await dm(b).getResponse(req());
    assert.equal(res, draft, 'accept returns the original response object with no rewrite');
    assert.equal(extractTextForTest(res), 'Exact Clementine answer.');
  });
});

test('verify strategy: runaway correction is rejected before any checker text reaches the user', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all', CLEMMY_FUSION_STRATEGY: 'verify' }, async () => {
    const runaway = 'x'.repeat(29_169);
    const b = brains({
      passthrough: model({ getResponse: async () => msg('Short factual draft.') }),
      judge: model({ getResponse: async () => msg(JSON.stringify({
        verdict: 'correct',
        issues: ['Claims a correction is needed.'],
        corrected: runaway,
      })) }),
    });
    const evs = await collect(dm(b, { heartbeatMs: 0 }).getStreamedResponse(req()));
    assert.ok(evs.some((e) => e.type === 'output_text_delta' && e.delta === 'Short factual draft.'));
    assert.ok(!evs.some((e) => e.type === 'output_text_delta' && e.delta === runaway));
  });
});

test('verify strategy: a correction cannot erase durable URLs, ids, or coverage receipts', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all', CLEMMY_FUSION_STRATEGY: 'verify' }, async () => {
    const exact = 'Built 8/8 items locally for bg-proof-123. Artifact: https://example.test/report.';
    const b = brains({
      passthrough: model({ getResponse: async () => msg(exact) }),
      judge: model({ getResponse: async () => msg(JSON.stringify({
        verdict: 'correct',
        issues: ['Replace the concrete report with a generic status.'],
        corrected: 'The background task was not completed. Try again later.',
      })) }),
    });
    const res = await dm(b).getResponse(req());
    assert.equal(extractTextForTest(res), exact);
  });
});

test('verify strategy: a response containing a tool call bypasses the checker and preserves the executable edge', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all', CLEMMY_FUSION_STRATEGY: 'verify' }, async () => {
    let checkerCalls = 0;
    const draft = {
      output: [
        { type: 'message', content: 'I am applying the verified change now.' },
        { type: 'function_call', name: 'run_shell_command', arguments: '{"cmd":"true"}' },
      ],
      usage: {},
    } as unknown as ModelResponse;
    const b = brains({
      passthrough: model({ getResponse: async () => draft }),
      judge: model({ getResponse: async () => { checkerCalls += 1; return msg('{"verdict":"accept","issues":[]}'); } }),
    });
    const res = await dm(b).getResponse(req());
    assert.equal(res, draft);
    assert.equal(checkerCalls, 0);
    assert.equal((res.output[1] as any).type, 'function_call');
  });
});

test('verify strategy: ASK/CONTINUE graph edges do not consume the one final-answer verification slot', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all', CLEMMY_FUSION_STRATEGY: 'verify' }, async () => {
    let executorCalls = 0;
    let checkerCalls = 0;
    const b = brains({
      passthrough: model({ getResponse: async () => (
        executorCalls++ === 0 ? msg('ASK: Which Railway project should I use?') : msg('Final answer.')
      ) }),
      judge: model({ getResponse: async () => {
        checkerCalls += 1;
        return msg('{"verdict":"accept","issues":[]}');
      } }),
    });
    const m = dm(b, { maxPerTurn: 1 });
    assert.equal(extractTextForTest(await m.getResponse(req())), 'ASK: Which Railway project should I use?');
    assert.equal(extractTextForTest(await m.getResponse(req())), 'Final answer.');
    assert.equal(checkerCalls, 1, 'only the terminal final answer was checked');
  });
});

test('verify strategy: exhausted executor failure is not retried by promoting the checker into the hero role', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all', CLEMMY_FUSION_STRATEGY: 'verify' }, async () => {
    let checkerCalls = 0;
    const b = brains({
      passthrough: model({ getResponse: async () => { throw new Error('executor chain exhausted'); } }),
      judge: model({ getResponse: async () => { checkerCalls += 1; return msg('generic checker answer'); } }),
    });
    await assert.rejects(() => dm(b).getResponse(req()), /executor chain exhausted/);
    assert.equal(checkerCalls, 0);
  });
});

test('verify strategy: non-streamed hung checker hits deadline, aborts, and ships executor draft', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all', CLEMMY_FUSION_STRATEGY: 'verify' }, async () => {
    let aborted = false;
    const b = brains({
      passthrough: model({ getResponse: async () => msg('EXECUTOR-DRAFT') }),
      judge: model({ getResponse: async (r: any) => {
        const sig = r.signal as AbortSignal | undefined;
        sig?.addEventListener('abort', () => { aborted = true; }, { once: true });
        return new Promise<ModelResponse>(() => {});
      } }),
    });
    const t0 = Date.now();
    const res = await dm(b, { checkerDeadlineMs: 10 }).getResponse(req());
    assert.equal((res.output[0] as any).content, 'EXECUTOR-DRAFT');
    assert.ok(Date.now() - t0 < 2000, 'deadline fallback returned promptly');
    assert.equal(aborted, true, 'deadline aborts the late checker request');
  });
});

test('verify strategy (streamed): checker verdict is buffered before one corrected response streams', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all', CLEMMY_FUSION_STRATEGY: 'verify' }, async () => {
    const b = brains({
      passthrough: model({ getResponse: async () => msg('CODEX-DRAFT') }),
      judge: model({ getResponse: async () => msg(JSON.stringify({
        verdict: 'correct',
        issues: ['Corrected a specific fact.'],
        corrected: 'REFINED',
      })) }),
    });
    const evs = await collect(dm(b, { heartbeatMs: 0 }).getStreamedResponse(req()));
    assert.equal(evs.filter((e) => e.type === 'response_started').length, 1);
    assert.ok(evs.some((e) => e.type === 'output_text_delta' && e.delta === 'REFINED'));
  });
});

test('verify strategy: tool-routing drafts ship as-is (no slot spent); the answer still gets checked', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all', CLEMMY_FUSION_STRATEGY: 'verify' }, async () => {
    let executorCall = 0;
    let checkerCalls = 0;
    const drafts: any[] = [
      { output: [{ type: 'function_call', name: 'focus_get', arguments: {} }], responseId: 'r1', usage: {} }, // tool-routing (no answer text)
      { output: [{ type: 'message', content: 'THE ANSWER' }], responseId: 'r2', usage: {} },                  // user-facing answer
    ];
    const b = brains({
      passthrough: model({ getResponse: async () => drafts[executorCall++] }),
      judge: model({ getResponse: async () => {
        checkerCalls += 1;
        return msg(JSON.stringify({
          verdict: 'correct',
          issues: ['Concrete correction.'],
          corrected: 'CHECKED',
        }));
      } }),
    });
    const m = dm(b, { maxPerTurn: 1 }); // cap of ONE
    const r1 = await m.getResponse(req()); // tool-routing → ship as-is, no checker, no slot
    const r2 = await m.getResponse(req()); // answer → checked (the slot was preserved)
    assert.equal((r1.output[0] as any).type, 'function_call', 'tool-routing draft shipped as-is');
    assert.equal((r2.output[0] as any).content, 'CHECKED', 'the answer got checked');
    assert.equal(checkerCalls, 1, 'checker ran exactly once — only on the user-facing answer');
  });
});

test('verify strategy: a structured draft with empty reply (workflow step) ships as-is — no checker, no slot', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all', CLEMMY_FUSION_STRATEGY: 'verify' }, async () => {
    let checkerCalls = 0;
    const stepDraft: any = { output: [{ type: 'message', content: JSON.stringify({ reply: '', summary: 'step done', done: true }) }], responseId: 'rw', usage: {} };
    const answerDraft: any = { output: [{ type: 'message', content: JSON.stringify({ reply: 'Here is your answer.', summary: 's', done: true }) }], responseId: 'ra', usage: {} };
    let call = 0;
    const b = brains({
      passthrough: model({ getResponse: async () => (call++ === 0 ? stepDraft : answerDraft) }),
      judge: model({ getResponse: async () => {
        checkerCalls += 1;
        return msg(JSON.stringify({
          verdict: 'correct',
          issues: ['Concrete correction.'],
          corrected: 'CHECKED',
        }));
      } }),
    });
    const m = dm(b, { maxPerTurn: 1 });
    const r1 = await m.getResponse(req()); // empty reply → ship as-is, no checker, no slot
    const r2 = await m.getResponse(req()); // real reply → checked (slot preserved)
    assert.equal(JSON.parse((r1.output[0] as any).content).reply, '', 'empty-reply step shipped as-is');
    const correctedEnvelope = JSON.parse((r2.output[0] as any).content);
    assert.equal(correctedEnvelope.reply, 'CHECKED', 'only the user-facing reply was corrected');
    assert.equal(correctedEnvelope.summary, 's', 'internal decision fields were preserved');
    assert.equal(correctedEnvelope.done, true, 'completion state was preserved');
    assert.equal(checkerCalls, 1, 'checker ran only on the turn with a non-empty reply');
  });
});

test('verify strategy: checker failure ships the executor draft (conformant, no crash)', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all', CLEMMY_FUSION_STRATEGY: 'verify' }, async () => {
    const b = brains({
      passthrough: model({ getResponse: async () => ({ output: [{ type: 'message', content: 'CODEX-SOLO' }], responseId: 'r9', usage: { inputTokens: 1, outputTokens: 1 } } as any) }),
      judge: model({ getResponse: async () => { throw new Error('checker down'); } }),
    });
    const evs = await collect(dm(b, { heartbeatMs: 0 }).getStreamedResponse(req()));
    assert.ok(evs.some((e) => e.type === 'output_text_delta' && e.delta === 'CODEX-SOLO'), 'shipped the executor draft');
    const done: any = evs.find((e) => e.type === 'response_done');
    assert.ok(done && done.response.id && typeof done.response.usage.totalTokens === 'number');
  });
});

test('verify strategy: an EMPTY checker response_done ships the executor draft, not an empty turn', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all', CLEMMY_FUSION_STRATEGY: 'verify' }, async () => {
    const b = brains({
      passthrough: model({ getResponse: async () => ({ output: [{ type: 'message', content: 'CODEX-SOLO' }], responseId: 'r11', usage: { inputTokens: 1, outputTokens: 1 } } as any) }),
      judge: model({ getResponse: async () => ({ output: [], usage: {} } as any) }),
    });
    const evs = await collect(dm(b, { heartbeatMs: 0 }).getStreamedResponse(req()));
    assert.ok(evs.some((e) => e.type === 'output_text_delta' && e.delta === 'CODEX-SOLO'), 'shipped the executor draft on an empty checker done');
    const dones = evs.filter((e) => e.type === 'response_done');
    assert.equal(dones.length, 1, 'exactly one terminal response_done (no empty duplicate)');
    assert.ok((dones[0] as any).response.output.length > 0, 'final done carries the non-empty executor draft');
  });
});

test('per-message cap: debate runs at most maxPerTurn times across iterations, then passes through', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all' }, async () => {
    let drafts = 0;
    let passthrough = 0;
    const b = brains({
      draftA: model({ getResponse: async () => { drafts += 1; return msg('A'); } }),
      draftB: model({ getResponse: async () => msg('B') }),
      judge: model({ getResponse: async () => msg('JUDGED') }),
      passthrough: model({ getResponse: async () => { passthrough += 1; return msg('PASS'); } }),
    });
    // One DebateModel instance = one message (model resolved once per run).
    const m = dm(b, { maxPerTurn: 2 });
    const r1 = await m.getResponse(req()); // debate 1
    const r2 = await m.getResponse(req()); // debate 2
    const r3 = await m.getResponse(req()); // cap hit → passthrough
    const r4 = await m.getResponse(req()); // passthrough
    assert.equal((r1.output[0] as any).content, 'JUDGED');
    assert.equal((r2.output[0] as any).content, 'JUDGED');
    assert.equal((r3.output[0] as any).content, 'PASS', 'cap reached → single-brain');
    assert.equal((r4.output[0] as any).content, 'PASS');
    assert.equal(drafts, 2, 'drafted only for the 2 capped debates');
    assert.equal(passthrough, 2, 'remaining iterations ran single-brain');
  });
});

test('per-message cap: maxPerTurn=0 means unlimited (legacy)', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all' }, async () => {
    let drafts = 0;
    const b = brains({ draftA: model({ getResponse: async () => { drafts += 1; return msg('A'); } }) });
    const m = dm(b, { maxPerTurn: 0 });
    await m.getResponse(req()); await m.getResponse(req()); await m.getResponse(req());
    assert.equal(drafts, 3, 'no cap → every iteration debates');
  });
});

test('draftBoth: the grace-losing (hung) draft is ABORTED, not left billing', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all' }, async () => {
    let hungSignal: AbortSignal | undefined;
    const b = brains({
      draftA: model({ getResponse: (r: any) => { hungSignal = r.signal; return new Promise<ModelResponse>(() => {}); } }),
      draftB: model({ getResponse: async () => msg('FAST') }),
    });
    const res = await dm(b, { draftGraceMs: 20 }).getResponse(req());
    assert.equal((res.output[0] as any).content, 'FAST', 'answered from the fast survivor');
    assert.ok(hungSignal, 'the hung draft received an abort signal');
    assert.equal(hungSignal!.aborted, true, 'the hung loser draft was aborted on grace timeout');
  });
});

test('heartbeatsUntil: yields nothing once the promise has already settled', async () => {
  const evs = await collect(heartbeatsUntil(Promise.resolve('done'), 1, noSleep));
  assert.equal(evs.length, 0);
});

test('heartbeatsUntil: intervalMs<=0 disables heartbeats entirely', async () => {
  let resolve: (v: unknown) => void;
  const p = new Promise((r) => { resolve = r; });
  const gen = heartbeatsUntil(p, 0, noSleep);
  const first = await gen.next();
  assert.equal(first.done, true);
  resolve!(null);
});

// --- verify-strategy brain assembly: GLM brain + Codex judge -----------------

const GLM_BRAIN_ENV = {
  MODEL_ROUTING_MODE: 'all_in',
  BYO_MODEL_BASE_URL: 'https://api.z.ai/api/paas/v4',
  BYO_MODEL_ID: 'glm-5.2',
  BYO_MODEL_API_KEY: 'zai-key',
  BYO_MODEL_PROVIDER: 'GLM (Z.ai)',
  BYO_PROVIDERS: '',
  CLEMMY_MODEL_ROLES: '',
};

test('resolveDebateBrains (verify): GLM brain + Codex judge engages without two flagships', async () => {
  writeCodexAuth(); // Codex available; Claude NOT
  await withEnv({ ...GLM_BRAIN_ENV, CLEMMY_FUSION_STRATEGY: 'verify', CLEMMY_DEBATE_JUDGE: 'codex' }, () => {
    const pass = model({});
    const b = resolveDebateBrains(fakeProvider(pass));
    assert.notEqual(b, null, 'verify fusion engages with a BYO brain + Codex judge');
    // verify signature: the executor IS the passthrough (no second flagship draft)
    assert.equal(b!.draftA, b!.passthrough);
    assert.equal(b!.draftB, b!.passthrough);
    assert.notEqual(b!.judge, b!.passthrough, 'the judge is a distinct (Codex) model');
  });
});

test('resolveDebateBrains (verify): no DIFFERENT judge available → null (no self-check)', async () => {
  writeCodexAuth();
  // judge control points at Claude, which is NOT logged in → cannot field a judge
  await withEnv({ ...GLM_BRAIN_ENV, CLEMMY_FUSION_STRATEGY: 'verify', CLEMMY_DEBATE_JUDGE: 'claude' }, () => {
    const b = resolveDebateBrains(fakeProvider(model({})));
    assert.equal(b, null);
  });
});

test('verifyJudgeAvailable reflects the GLM-brain + Codex-judge pairing', async () => {
  writeCodexAuth();
  await withEnv({ ...GLM_BRAIN_ENV, CLEMMY_FUSION_STRATEGY: 'verify', CLEMMY_DEBATE_JUDGE: 'codex' }, () => {
    assert.equal(verifyJudgeAvailable(), true);
  });
  // debate strategy uses the two-flagship path, not this helper
  await withEnv({ ...GLM_BRAIN_ENV, CLEMMY_FUSION_STRATEGY: 'debate', CLEMMY_DEBATE_JUDGE: 'codex' }, () => {
    assert.equal(verifyJudgeAvailable(), false);
  });
  // verify + judge=claude but Claude not logged in → not available
  await withEnv({ ...GLM_BRAIN_ENV, CLEMMY_FUSION_STRATEGY: 'verify', CLEMMY_DEBATE_JUDGE: 'claude' }, () => {
    assert.equal(verifyJudgeAvailable(), false);
  });
});


// Tool-bearing turns have one author (the active executor). This also subsumes
// the live 2026-07-24 text-only-Claude transport failure: DEBATE never fans an
// executable edge out to independent drafters, while tool-less prose still can.
test('debate uses executor-first verify for tool-bearing turns and full debate for tool-less prose', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all' }, async () => {
    let draftACalls = 0;
    let judgeSystem = '';
    const b = brains({
      passthrough: model({ getResponse: async () => msg('EXECUTOR-DRAFT with plenty of substantive user-facing content here') }),
      draftA: model({ getResponse: async () => { draftACalls += 1; return msg('CLAUDE-DRAFT'); } }),
      judge: model({ getResponse: async (r: any) => { judgeSystem = r.systemInstructions; return msg('REFINED FINAL with plenty of substantive user-facing content here'); } }),
    });
    const res = await dm(b).getResponse(req({ tools: [{ name: 'run_shell_command' }] }));
    assert.equal(draftACalls, 0, 'parallel drafters are never dispatched with tools');
    assert.match(judgeSystem, /VERIFY|DRAFT/i, 'the checker ran the verify shape');
    assert.match((res.output[0] as any).content, /REFINED FINAL|EXECUTOR-DRAFT/);

    // Tool-less turn: full debate still engages the claude draft.
    const b2 = brains({
      draftA: model({ getResponse: async () => { draftACalls += 1; return msg('CLAUDE-DRAFT'); } }),
    });
    await dm(b2).getResponse(req());
    assert.equal(draftACalls, 1, 'tool-less turns still full-debate');
  });
});
