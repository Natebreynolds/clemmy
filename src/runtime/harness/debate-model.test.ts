import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';
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
  summarizeOutput,
  heartbeatsUntil,
  streamResponseAsEvents,
} = await import('./debate-model.js');

// --- fixtures ---------------------------------------------------------------

function req(extra: Record<string, unknown> = {}): ModelRequest {
  return { input: 'hi', systemInstructions: 'BASE', modelSettings: {}, tools: [], handoffs: [], ...extra } as unknown as ModelRequest;
}
function msg(text: string): ModelResponse {
  return { output: [{ type: 'message', content: text }], usage: {} } as unknown as ModelResponse;
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
const noSleep = () => Promise.resolve();

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

// --- mode + trigger ---------------------------------------------------------

test('debateMode: defaults OFF; on/all/high parse', () => {
  withEnv({ CLEMMY_DEBATE_MODE: undefined }, () => assert.equal(debateMode(), 'off'));
  withEnv({ CLEMMY_DEBATE_MODE: 'all' }, () => assert.equal(debateMode(), 'all'));
  withEnv({ CLEMMY_DEBATE_MODE: 'high' }, () => assert.equal(debateMode(), 'high'));
  withEnv({ CLEMMY_DEBATE_MODE: 'off' }, () => assert.equal(debateMode(), 'off'));
});

test('shouldDebate: off never, all always, high on a long/keyword/agentic turn', () => {
  withEnv({ CLEMMY_DEBATE_MODE: 'off' }, () => assert.equal(shouldDebate(req()), false));
  withEnv({ CLEMMY_DEBATE_MODE: 'all' }, () => assert.equal(shouldDebate(req()), true));
  withEnv({ CLEMMY_DEBATE_MODE: 'high' }, () => {
    assert.equal(shouldDebate(req({ input: 'short' })), false);
    assert.equal(shouldDebate(req({ input: 'please send the proposal to the client' })), true, 'keyword');
    assert.equal(shouldDebate(req({ input: 'x'.repeat(900) })), true, 'long input');
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
    const res = await new DebateModel(b).getResponse(req());
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
    const res = await new DebateModel(b).getResponse(req());
    assert.equal((res.output[0] as any).content, 'FINAL');
    assert.match(judgeSystem, /CLAUDE-DRAFT/);
    assert.match(judgeSystem, /CODEX-DRAFT/);
    assert.match(judgeSystem, /RECONCILE/);
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
    const res = await new DebateModel(b).getResponse(req());
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
    const res = await new DebateModel(b, { draftGraceMs: 30 }).getResponse(req());
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
    const res = await new DebateModel(b).getResponse(req());
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
    const evs = await collect(new DebateModel(b).getStreamedResponse(req()));
    assert.ok(evs.some((e) => e.type === 'output_text_delta' && e.delta === 'PASSTHRU'));
    assert.equal(evs.filter((e) => e.type === 'response_started').length, 1);
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
    const evs = await collect(new DebateModel(b, { heartbeatMs: 0 }).getStreamedResponse(req()));
    assert.equal(evs.filter((e) => e.type === 'response_started').length, 1, 'one response_started total');
    const firstContentIdx = evs.findIndex((e) => e.type === 'output_text_delta');
    const startIdx = evs.findIndex((e) => e.type === 'response_started');
    assert.ok(startIdx >= 0 && startIdx < firstContentIdx, 'response_started precedes any content');
    assert.ok(evs.some((e) => e.type === 'output_text_delta' && e.delta === 'RECONCILED'));
    assert.equal(evs.filter((e) => e.type === 'response_done').length, 1);
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
    const evs = await collect(new DebateModel(b, { heartbeatMs: 1, sleep }).getStreamedResponse(req()));
    const keepalives = evs.filter((e) => e.type === 'model' && e.event?.type === 'debate.keepalive');
    assert.ok(keepalives.length >= 1, 'at least one keep-alive while drafting');
    // Keep-alives never carry committed content.
    const kaIdx = evs.findIndex((e) => e.type === 'model');
    const contentIdx = evs.findIndex((e) => e.type === 'output_text_delta');
    assert.ok(kaIdx < contentIdx, 'keep-alives precede the judge content');
  });
});

// --- helpers ----------------------------------------------------------------

test('buildJudgeRequest: preserves tools/modelSettings, appends both drafts to system', () => {
  const r = req({ tools: [{ name: 't' }], modelSettings: { temperature: 0.3 } });
  const jr = buildJudgeRequest(r, msg('DRAFT-A'), msg('DRAFT-B')) as any;
  assert.deepEqual(jr.tools, [{ name: 't' }], 'tools preserved');
  assert.equal(jr.modelSettings.temperature, 0.3, 'modelSettings preserved');
  assert.match(jr.systemInstructions, /BASE/, 'original system kept');
  assert.match(jr.systemInstructions, /DRAFT-A/);
  assert.match(jr.systemInstructions, /DRAFT-B/);
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
  assert.equal((done.response.output[0] as any).content, 'SOLO');
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
    const evs = await collect(new DebateModel(b, { heartbeatMs: 0 }).getStreamedResponse(req()));
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
    const res = await new DebateModel(b).getResponse(req());
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
    const evs = await collect(new DebateModel(b, { heartbeatMs: 0 }).getStreamedResponse(req()));
    assert.ok(evs.some((e) => e.type === 'output_text_delta' && e.delta === 'DRAFT-A-LONGER-ANSWER'));
    const done: any = evs.find((e) => e.type === 'response_done');
    assert.ok(done && done.response.id && typeof done.response.usage.totalTokens === 'number');
    assert.equal(evs.filter((e) => e.type === 'response_started').length, 1);
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
    await assert.rejects(async () => { for await (const e of new DebateModel(b, { heartbeatMs: 0 }).getStreamedResponse(req())) got.push(e); });
    assert.ok(got.some((e) => e.type === 'output_text_delta' && e.delta === 'partial'));
  });
});

// --- 'verify' strategy: Codex drives (executor=passthrough), Claude checks (judge) ---

test('verify strategy: executor drafts, checker verifies → returns the checker final', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all', CLEMMY_FUSION_STRATEGY: 'verify' }, async () => {
    let executorCalls = 0;
    let checkerSawDraft = '';
    const b = brains({
      passthrough: model({ getResponse: async () => { executorCalls += 1; return msg('CODEX-DRAFT'); } }),
      judge: model({ getResponse: async (r: any) => { checkerSawDraft = r.systemInstructions; return msg('CLAUDE-REFINED'); } }),
    });
    const res = await new DebateModel(b).getResponse(req());
    assert.equal((res.output[0] as any).content, 'CLAUDE-REFINED');
    assert.equal(executorCalls, 1, 'executor drafted exactly once (2 calls total, not 3)');
    assert.match(checkerSawDraft, /CODEX-DRAFT/, 'checker received the executor draft');
    assert.match(checkerSawDraft, /VERIFY & REFINE/);
  });
});

test('verify strategy (streamed): executor draft → checker streams refined; one response_started', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all', CLEMMY_FUSION_STRATEGY: 'verify' }, async () => {
    const b = brains({
      passthrough: model({ getResponse: async () => msg('CODEX-DRAFT') }),
      judge: model({ getStreamedResponse: async function* () {
        yield { type: 'response_started' } as any;
        yield { type: 'output_text_delta', delta: 'REFINED' } as any;
        yield { type: 'response_done', response: { output: [{ type: 'message', content: 'REFINED' }] } } as any;
      } }),
    });
    const evs = await collect(new DebateModel(b, { heartbeatMs: 0 }).getStreamedResponse(req()));
    assert.equal(evs.filter((e) => e.type === 'response_started').length, 1);
    assert.ok(evs.some((e) => e.type === 'output_text_delta' && e.delta === 'REFINED'));
  });
});

test('verify strategy: checker failure pre-content ships the executor draft (conformant, no crash)', async () => {
  await withEnv({ CLEMMY_DEBATE_MODE: 'all', CLEMMY_FUSION_STRATEGY: 'verify' }, async () => {
    const b = brains({
      passthrough: model({ getResponse: async () => ({ output: [{ type: 'message', content: 'CODEX-SOLO' }], responseId: 'r9', usage: { inputTokens: 1, outputTokens: 1 } } as any) }),
      judge: model({ getStreamedResponse: async function* () { throw new Error('checker down'); } }),
    });
    const evs = await collect(new DebateModel(b, { heartbeatMs: 0 }).getStreamedResponse(req()));
    assert.ok(evs.some((e) => e.type === 'output_text_delta' && e.delta === 'CODEX-SOLO'), 'shipped the executor draft');
    const done: any = evs.find((e) => e.type === 'response_done');
    assert.ok(done && done.response.id && typeof done.response.usage.totalTokens === 'number');
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
    const m = new DebateModel(b, { maxPerTurn: 2 });
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
    const m = new DebateModel(b, { maxPerTurn: 0 });
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
    const res = await new DebateModel(b, { draftGraceMs: 20 }).getResponse(req());
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
