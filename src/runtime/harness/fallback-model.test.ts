import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';
import { withModelFallback, isOverloadError, isFalloverError, type FallbackTarget, __test__ } from './fallback-model.js';
import { BoundaryError } from '../boundary-error.js';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-fallback-model-test-'));
__test__.setDeadBrainsFileForTests(path.join(TMP, 'brain-auth-dead.json'));
__test__.setSilentBrainsFileForTests(path.join(TMP, 'brain-silent-cooldown.json'));

after(() => {
  __test__.setDeadBrainsFileForTests(null);
  __test__.setSilentBrainsFileForTests(null);
  rmSync(TMP, { recursive: true, force: true });
});

function req(): ModelRequest { return { input: 'hi', modelSettings: {}, tools: [], handoffs: [] } as unknown as ModelRequest; }
function resp(text: string): ModelResponse { return { output: [{ type: 'message', content: text }], usage: {} } as unknown as ModelResponse; }
const overload = () => ({ statusCode: 529, message: 'overloaded_error' });

function model(impl: Partial<Model>): Model {
  return {
    getResponse: impl.getResponse ?? (async () => resp('ok')),
    getStreamedResponse: impl.getStreamedResponse ?? (async function* () { yield { type: 'response_done', response: { output: [{ type: 'message' }] } } as any; }),
  } as Model;
}
function target(label: string, m: Model): FallbackTarget { return { label, getModel: () => m }; }
async function collect(it: AsyncIterable<unknown>): Promise<unknown[]> { const o: unknown[] = []; for await (const e of it) o.push(e); return o; }

test('isOverloadError: 529 yes, 429 no, BoundaryError(model.overloaded) yes', () => {
  assert.equal(isOverloadError({ statusCode: 529 }), true);
  assert.equal(isOverloadError({ statusCode: 429 }), false);
  assert.equal(isOverloadError({ statusCode: 400 }), false);
  assert.equal(isOverloadError(new BoundaryError({ kind: 'model.overloaded', retryable: true, userMessage: '', operatorMessage: '' })), true);
  assert.equal(isOverloadError(new BoundaryError({ kind: 'model.rate_limited', retryable: true, userMessage: '', operatorMessage: '' })), false);
});

test('isFalloverError: overload/5xx/TRANSPORT-TIMEOUT yes; 429 + 4xx no (the timeout is the real-world capacity case)', () => {
  assert.equal(isFalloverError({ statusCode: 529 }), true, 'overloaded');
  assert.equal(isFalloverError({ statusCode: 503 }), true, '5xx');
  // The load-bearing case: Anthropic at capacity HANGS → transport_timeout.
  assert.equal(isFalloverError(new BoundaryError({ kind: 'model.transport_timeout', retryable: true, userMessage: '', operatorMessage: '' })), true);
  assert.equal(isFalloverError({ message: 'fetch failed' }), true, 'a transport error classifies as transport_timeout');
  // Excluded: a 429 is account-wide quota — switching Claude tiers won't help.
  assert.equal(isFalloverError({ statusCode: 429 }), false, '429 not a fallover');
  assert.equal(isFalloverError({ statusCode: 400 }), false, '4xx not a fallover');
});

test('getStreamedResponse: a TRANSPORT TIMEOUT (the Anthropic-hang case) falls over — not just a clean 529', async () => {
  // This is the exact failure the user hit: Claude hangs (transport_timeout), the
  // resilient wrapper throws it, and the chain MUST advance instead of failing.
  let codexCalls = 0;
  const opus = model({ getStreamedResponse: async function* () { throw new BoundaryError({ kind: 'model.transport_timeout', retryable: true, userMessage: '', operatorMessage: 'hung' }); } });
  const codex = model({ getStreamedResponse: async function* () { codexCalls++; yield { type: 'response_done', response: { output: [{ type: 'message', content: 'from codex' }] } } as any; } });
  const out = await collect(withModelFallback([target('opus', opus), target('codex', codex)]).getStreamedResponse(req()));
  assert.equal(codexCalls, 1, 'a transport timeout fell over to Codex');
  assert.ok(out.length > 0);
});

test('single-element chain returns the model as-is (no wrapper)', () => {
  const m = model({});
  assert.equal(withModelFallback([target('only', m)]), m);
});

test('request capability: a tool-bearing turn skips a text-only fallback target', async () => {
  let textOnlyCalls = 0;
  let toolCapableCalls = 0;
  const textOnly = model({ getResponse: async () => { textOnlyCalls++; return resp('wrong'); } });
  const toolCapable = model({ getResponse: async () => { toolCapableCalls++; return resp('right'); } });
  const routed = withModelFallback([
    { label: 'text-only', getModel: () => textOnly, supportsRequest: (request) => (request.tools?.length ?? 0) === 0 },
    target('tool-capable', toolCapable),
  ]);
  const request = { ...req(), tools: [{ name: 'read_file' }] } as unknown as ModelRequest;
  const result = await routed.getResponse(request);
  assert.equal(textOnlyCalls, 0);
  assert.equal(toolCapableCalls, 1);
  assert.equal((result.output[0] as any).content, 'right');
});

test('request capability: a compatible text request may use the text-only target', async () => {
  let textOnlyCalls = 0;
  const textOnly = model({ getResponse: async () => { textOnlyCalls++; return resp('text'); } });
  const routed = withModelFallback([
    { label: 'text-only', getModel: () => textOnly, supportsRequest: (request) => (request.tools?.length ?? 0) === 0 },
    target('other', model({ getResponse: async () => resp('other') })),
  ]);
  await routed.getResponse(req());
  assert.equal(textOnlyCalls, 1);
});

test('getResponse: overload on primary falls back to the next brain', async () => {
  let opusCalls = 0, sonnetCalls = 0;
  const opus = model({ getResponse: async () => { opusCalls++; throw overload(); } });
  const sonnet = model({ getResponse: async () => { sonnetCalls++; return resp('from sonnet'); } });
  const res = await withModelFallback([target('opus', opus), target('sonnet', sonnet)]).getResponse(req());
  assert.equal(opusCalls, 1);
  assert.equal(sonnetCalls, 1);
  assert.equal((res.output[0] as any).content, 'from sonnet');
});

test('getResponse: a NON-overload error (400) does NOT fall back — it throws', async () => {
  let sonnetCalls = 0;
  const opus = model({ getResponse: async () => { throw { statusCode: 400, message: 'bad' }; } });
  const sonnet = model({ getResponse: async () => { sonnetCalls++; return resp('x'); } });
  await assert.rejects(() => withModelFallback([target('opus', opus), target('sonnet', sonnet)]).getResponse(req()));
  assert.equal(sonnetCalls, 0, 'never tried the fallback for a non-overload error');
});

test('getResponse: chain Opus->Sonnet->Codex, all overloaded except the last', async () => {
  const opus = model({ getResponse: async () => { throw overload(); } });
  const sonnet = model({ getResponse: async () => { throw overload(); } });
  const codex = model({ getResponse: async () => resp('from codex') });
  const res = await withModelFallback([target('opus', opus), target('sonnet', sonnet), target('codex', codex)]).getResponse(req());
  assert.equal((res.output[0] as any).content, 'from codex');
});

test('getStreamedResponse: overload before any yield falls back and streams the next brain', async () => {
  const opus = model({ getStreamedResponse: async function* () { throw overload(); } });
  const sonnet = model({ getStreamedResponse: async function* () {
    yield { type: 'response_started' } as any;
    yield { type: 'output_text_delta', delta: 'sonnet says hi' } as any;
    yield { type: 'response_done', response: { output: [{ type: 'message' }] } } as any;
  } });
  const events = await collect(withModelFallback([target('opus', opus), target('sonnet', sonnet)]).getStreamedResponse(req()));
  assert.ok((events as any[]).some((e) => e.type === 'output_text_delta' && e.delta === 'sonnet says hi'));
});

test('force-overload knob (dev-gated) skips the primary so the next brain answers', async () => {
  const prevDev = process.env.CLEMMY_DEV_OVERRIDES;
  const prevForce = process.env.CLEMMY_FORCE_CLAUDE_OVERLOAD;
  process.env.CLEMMY_DEV_OVERRIDES = '1';
  process.env.CLEMMY_FORCE_CLAUDE_OVERLOAD = '1';
  try {
    let opusCalls = 0, sonnetCalls = 0;
    const opus = model({ getResponse: async () => { opusCalls++; return resp('opus'); } });
    const sonnet = model({ getResponse: async () => { sonnetCalls++; return resp('sonnet'); } });
    const res = await withModelFallback([target('opus', opus), target('sonnet', sonnet)]).getResponse(req());
    assert.equal(opusCalls, 0, 'force knob skipped the primary');
    assert.equal(sonnetCalls, 1);
    assert.equal((res.output[0] as any).content, 'sonnet');
  } finally {
    if (prevDev === undefined) delete process.env.CLEMMY_DEV_OVERRIDES; else process.env.CLEMMY_DEV_OVERRIDES = prevDev;
    if (prevForce === undefined) delete process.env.CLEMMY_FORCE_CLAUDE_OVERLOAD; else process.env.CLEMMY_FORCE_CLAUDE_OVERLOAD = prevForce;
  }
});

test('getStreamedResponse: overload AFTER content yielded does NOT fall back (would duplicate)', async () => {
  let sonnetCalls = 0;
  const opus = model({ getStreamedResponse: async function* () {
    yield { type: 'output_text_delta', delta: 'partial' } as any;
    throw overload();
  } });
  const sonnet = model({ getStreamedResponse: async function* () { sonnetCalls++; yield { type: 'response_done', response: { output: [] } } as any; } });
  const got: any[] = [];
  await assert.rejects(async () => { for await (const e of withModelFallback([target('opus', opus), target('sonnet', sonnet)]).getStreamedResponse(req())) got.push(e); });
  assert.equal(sonnetCalls, 0, 'committed stream is not switched');
  assert.ok(got.some((e) => e.type === 'output_text_delta'));
});

// ─── Universal cross-provider fallover: 429 + first-byte-timeout (2026-06-21) ───

const rateLimited = () => ({ statusCode: 429, message: 'rate_limited' });

test('falloverOn429: a 429 on one provider falls over to the next (cross-provider quota is independent)', async () => {
  let nextCalls = 0;
  const glm = model({ getStreamedResponse: async function* () { throw rateLimited(); } });
  const codex = model({ getStreamedResponse: async function* () { nextCalls++; yield { type: 'output_text_delta', delta: 'from codex' } as any; } });
  const out = await collect(withModelFallback([target('glm', glm), target('codex', codex)], { falloverOn429: true }).getStreamedResponse(req()));
  assert.equal(nextCalls, 1, 'a 429 fell over to the next provider');
  assert.ok((out as any[]).some((e) => e.delta === 'from codex'));
});

test('default (no opts): a 429 does NOT fall over (same-provider tier behavior preserved)', async () => {
  let nextCalls = 0;
  const opus = model({ getStreamedResponse: async function* () { throw rateLimited(); } });
  const sonnet = model({ getStreamedResponse: async function* () { nextCalls++; yield { type: 'response_done', response: { output: [] } } as any; } });
  await assert.rejects(async () => { for await (const _ of withModelFallback([target('opus', opus), target('sonnet', sonnet)]).getStreamedResponse(req())) { /* drain */ } });
  assert.equal(nextCalls, 0, 'a 429 without the cross-provider opt-in does NOT switch tiers');
});

test('firstByteTimeoutMs: a brain that HANGS pre-content falls over to the next brain', async () => {
  let nextCalls = 0;
  // Hung brain: never yields a first event; respects the abort signal so the test cleans up fast.
  const hung = model({ getStreamedResponse: async function* (request: any) {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, 5_000);
      request?.signal?.addEventListener?.('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
    });
    yield { type: 'response_done', response: { output: [] } } as any;
  } });
  const codex = model({ getStreamedResponse: async function* () { nextCalls++; yield { type: 'output_text_delta', delta: 'rescued' } as any; } });
  const out = await collect(withModelFallback([target('hung', hung), target('codex', codex)], { firstByteTimeoutMs: 50 }).getStreamedResponse(req()));
  assert.equal(nextCalls, 1, 'the hung brain fell over to the next');
  assert.ok((out as any[]).some((e) => e.delta === 'rescued'));
});

test('firstByteTimeoutMs: a brain that answers quickly is NOT falsely failed over', async () => {
  let nextCalls = 0;
  const fast = model({ getStreamedResponse: async function* () { yield { type: 'output_text_delta', delta: 'fast reply' } as any; } });
  const codex = model({ getStreamedResponse: async function* () { nextCalls++; yield { type: 'output_text_delta', delta: 'should not run' } as any; } });
  const out = await collect(withModelFallback([target('fast', fast), target('codex', codex)], { firstByteTimeoutMs: 50 }).getStreamedResponse(req()));
  assert.equal(nextCalls, 0, 'a prompt brain is never failed over');
  assert.ok((out as any[]).some((e) => e.delta === 'fast reply'));
});

test('isFalloverError: a brain AUTH failure is recoverable → fall over to a valid brain (not terminal)', () => {
  // ClaudeAuthError (expired subscription) and reauth-worded errors → fallover.
  class ClaudeAuthError extends Error { constructor(m: string) { super(m); this.name = 'ClaudeAuthError'; } }
  assert.equal(isFalloverError(new ClaudeAuthError('Claude subscription token has expired')), true);
  assert.equal(isFalloverError(new Error('Claude token refresh failed (400): invalid_grant')), true);
  assert.equal(isFalloverError(new Error('HTTP 401 Unauthorized')), true);
  // A plain bad-request / validation error is NOT an auth fallover.
  assert.equal(isFalloverError(new Error('400 invalid schema for field x')), false);
});

// ─── Sticky dead-brain registry (2026-07-08) ────────────────────────────────
// Live logs showed 25 auth_expired fallovers over two days: the chain re-tried
// a dead-token brain on EVERY request before falling over. An auth failure
// must stick — the next request skips the dead brain entirely.
test('sticky auth-dead: after an auth failure, the NEXT request skips the dead brain entirely', async () => {
  const { reviveDeadBrains, isBrainAuthDead } = await import('./fallback-model.js');
  reviveDeadBrains();
  try {
    let deadCalls = 0, liveCalls = 0;
    const dead = model({ getResponse: async () => { deadCalls++; throw new Error('HTTP 401 Unauthorized'); } });
    const live = model({ getResponse: async () => { liveCalls++; return resp('from live'); } });
    const fb = withModelFallback([target('gpt-5.5-dead', dead), target('claude-live', live)]);
    await fb.getResponse(req()); // first request: probes dead → falls over → marks dead
    assert.equal(deadCalls, 1);
    assert.equal(liveCalls, 1);
    assert.equal(isBrainAuthDead('gpt-5.5-dead'), true, 'the auth failure stuck');
    assert.equal(__test__.getDeadBrainEntryForTests('gpt-5.5-dead')?.reason, 'model.auth_expired');
    await fb.getResponse(req()); // second request: dead brain is SKIPPED
    assert.equal(deadCalls, 1, 'the dead brain was not probed again');
    assert.equal(liveCalls, 2);
  } finally {
    reviveDeadBrains();
  }
});

test('sticky auth-dead: marker survives daemon restart and skips the dead brain during cooldown', async () => {
  const { reviveDeadBrains, isBrainAuthDead } = await import('./fallback-model.js');
  reviveDeadBrains();
  try {
    let deadCalls = 0, liveCalls = 0;
    const dead = model({ getResponse: async () => { deadCalls++; throw new Error('HTTP 401 Unauthorized'); } });
    const live = model({ getResponse: async () => { liveCalls++; return resp('from live'); } });
    const fb = withModelFallback([target('restart-dead', dead), target('restart-live', live)]);
    await fb.getResponse(req());
    assert.equal(deadCalls, 1);
    assert.equal(liveCalls, 1);
    assert.equal(isBrainAuthDead('restart-dead'), true);

    __test__.resetDeadBrainsMemoryForTests();
    const afterRestart = withModelFallback([target('restart-dead', dead), target('restart-live', live)]);
    await afterRestart.getResponse(req());
    assert.equal(deadCalls, 1, 'persisted auth-dead marker skipped the dead brain after restart');
    assert.equal(liveCalls, 2);
  } finally {
    reviveDeadBrains();
  }
});

test('sticky auth-dead: a transport timeout does NOT stick (transient failures stay per-request)', async () => {
  const { reviveDeadBrains, isBrainAuthDead } = await import('./fallback-model.js');
  reviveDeadBrains();
  try {
    let flakyCalls = 0;
    const flaky = model({ getResponse: async () => { flakyCalls++; throw new BoundaryError({ kind: 'model.transport_timeout', retryable: true, userMessage: '', operatorMessage: 'hung' }); } });
    const live = model({ getResponse: async () => resp('rescued') });
    const fb = withModelFallback([target('flaky', flaky), target('live', live)]);
    await fb.getResponse(req());
    assert.equal(isBrainAuthDead('flaky'), false, 'a timeout never sticks');
    await fb.getResponse(req());
    assert.equal(flakyCalls, 2, 'the flaky brain is probed again next request');
  } finally {
    reviveDeadBrains();
  }
});

test('silent cooldown: repeated transport timeouts skip the quiet brain briefly', async () => {
  const { reviveDeadBrains, isBrainSilenced } = await import('./fallback-model.js');
  reviveDeadBrains();
  try {
    let quietCalls = 0, liveCalls = 0;
    const quiet = model({ getResponse: async () => {
      quietCalls++;
      throw new BoundaryError({ kind: 'model.transport_timeout', retryable: true, userMessage: '', operatorMessage: 'hung' });
    } });
    const live = model({ getResponse: async () => { liveCalls++; return resp('from live'); } });
    const fb = withModelFallback([target('quiet-primary', quiet), target('quiet-live', live)]);

    await fb.getResponse(req());
    assert.equal(quietCalls, 1);
    assert.equal(liveCalls, 1);
    assert.equal(isBrainSilenced('quiet-primary'), false, 'one timeout is still treated as transient');

    await fb.getResponse(req());
    assert.equal(quietCalls, 2);
    assert.equal(liveCalls, 2);
    assert.equal(isBrainSilenced('quiet-primary'), true, 'the second timeout opens the short cooldown');
    assert.equal(__test__.getSilentBrainEntryForTests('quiet-primary')?.reason, 'model.transport_timeout');

    await fb.getResponse(req());
    assert.equal(quietCalls, 2, 'cooldown skipped the repeatedly silent brain');
    assert.equal(liveCalls, 3);
  } finally {
    reviveDeadBrains();
  }
});

test('silent cooldown: marker survives daemon restart and skips the quiet brain', async () => {
  const { reviveDeadBrains, isBrainSilenced } = await import('./fallback-model.js');
  reviveDeadBrains();
  try {
    let quietCalls = 0, liveCalls = 0;
    const quiet = model({ getResponse: async () => {
      quietCalls++;
      throw new BoundaryError({ kind: 'model.transport_timeout', retryable: true, userMessage: '', operatorMessage: 'hung' });
    } });
    const live = model({ getResponse: async () => { liveCalls++; return resp('from live'); } });
    const fb = withModelFallback([target('restart-quiet', quiet), target('restart-live', live)]);

    await fb.getResponse(req());
    await fb.getResponse(req());
    assert.equal(quietCalls, 2);
    assert.equal(liveCalls, 2);
    assert.equal(isBrainSilenced('restart-quiet'), true);

    __test__.resetSilentBrainsMemoryForTests();
    const afterRestart = withModelFallback([target('restart-quiet', quiet), target('restart-live', live)]);
    await afterRestart.getResponse(req());
    assert.equal(quietCalls, 2, 'persisted silent marker skipped the quiet brain after restart');
    assert.equal(liveCalls, 3);
  } finally {
    reviveDeadBrains();
  }
});

test('silent cooldown: a successful retry clears prior silent-failure history', async () => {
  const { reviveDeadBrains, isBrainSilenced } = await import('./fallback-model.js');
  reviveDeadBrains();
  try {
    let mode: 'timeout' | 'ok' = 'timeout';
    let primaryCalls = 0, liveCalls = 0;
    const primary = model({ getResponse: async () => {
      primaryCalls++;
      if (mode === 'timeout') {
        throw new BoundaryError({ kind: 'model.transport_timeout', retryable: true, userMessage: '', operatorMessage: 'hung' });
      }
      return resp('primary recovered');
    } });
    const live = model({ getResponse: async () => { liveCalls++; return resp('from live'); } });
    const fb = withModelFallback([target('recovering-primary', primary), target('recovering-live', live)]);

    await fb.getResponse(req());
    assert.equal(primaryCalls, 1);
    assert.equal(liveCalls, 1);
    assert.equal(isBrainSilenced('recovering-primary'), false);

    mode = 'ok';
    await fb.getResponse(req());
    assert.equal(primaryCalls, 2);
    assert.equal(liveCalls, 1);
    assert.equal(__test__.getSilentBrainEntryForTests('recovering-primary'), null, 'success cleared the prior failure count');

    mode = 'timeout';
    await fb.getResponse(req());
    assert.equal(primaryCalls, 3, 'the recovered brain is probed again');
    assert.equal(liveCalls, 2);
    assert.equal(isBrainSilenced('recovering-primary'), false, 'a fresh single timeout does not immediately silence it');
  } finally {
    reviveDeadBrains();
  }
});

test('silent cooldown: when EVERY brain is silenced, the full chain is still probed', async () => {
  const { reviveDeadBrains, isBrainSilenced } = await import('./fallback-model.js');
  reviveDeadBrains();
  try {
    let aMode: 'timeout' | 'ok' = 'timeout';
    let aCalls = 0, bCalls = 0;
    const a = model({ getResponse: async () => {
      aCalls++;
      if (aMode === 'ok') return resp('a recovered');
      throw new BoundaryError({ kind: 'model.transport_timeout', retryable: true, userMessage: '', operatorMessage: 'a hung' });
    } });
    const b = model({ getResponse: async () => {
      bCalls++;
      throw new BoundaryError({ kind: 'model.transport_timeout', retryable: true, userMessage: '', operatorMessage: 'b hung' });
    } });
    const fb = withModelFallback([target('all-silent-a', a), target('all-silent-b', b)]);

    await assert.rejects(() => fb.getResponse(req()));
    await assert.rejects(() => fb.getResponse(req()));
    assert.equal(isBrainSilenced('all-silent-a'), true);
    assert.equal(isBrainSilenced('all-silent-b'), true);

    aMode = 'ok';
    const res = await fb.getResponse(req());
    assert.equal(aCalls, 3, 'the all-silenced chain still probed from the top');
    assert.equal(bCalls, 2);
    assert.ok(JSON.stringify(res).includes('a recovered'));
  } finally {
    reviveDeadBrains();
  }
});

test('sticky auth-dead: when EVERY brain is marked dead, the full chain is probed anyway (never zero brains)', async () => {
  const { reviveDeadBrains, markBrainAuthDead } = await import('./fallback-model.js');
  reviveDeadBrains();
  try {
    markBrainAuthDead('a', 'model.auth_expired');
    markBrainAuthDead('b', 'model.auth_expired');
    let aCalls = 0;
    const a = model({ getResponse: async () => { aCalls++; return resp('a recovered'); } });
    const b = model({ getResponse: async () => resp('b') });
    const res = await withModelFallback([target('a', a), target('b', b)]).getResponse(req());
    assert.equal(aCalls, 1, 'an all-dead chain still probes (out-of-band re-auth recovers)');
    assert.ok(JSON.stringify(res).includes('a recovered'));
  } finally {
    reviveDeadBrains();
  }
});

test('sticky auth-dead: reviveDeadBrains() clears the mark (re-auth flow → immediate probe)', async () => {
  const { reviveDeadBrains, markBrainAuthDead, isBrainAuthDead } = await import('./fallback-model.js');
  reviveDeadBrains();
  markBrainAuthDead('gpt-5.5', 'model.auth_expired');
  assert.equal(isBrainAuthDead('gpt-5.5'), true);
  reviveDeadBrains('gpt-5.5');
  assert.equal(isBrainAuthDead('gpt-5.5'), false);
  markBrainAuthDead('x', 'model.auth_expired');
  markBrainAuthDead('y', 'model.auth_expired');
  reviveDeadBrains();
  assert.equal(isBrainAuthDead('x'), false);
  assert.equal(isBrainAuthDead('y'), false);
});

test('sticky auth-dead: the LAST brain failing with auth is marked too (next request routes around it)', async () => {
  const { reviveDeadBrains, isBrainAuthDead } = await import('./fallback-model.js');
  reviveDeadBrains();
  try {
    const ok = model({ getResponse: async () => resp('primary ok') });
    const dead = model({ getResponse: async () => { throw new Error('HTTP 401 Unauthorized'); } });
    // Force the primary to fail with overload so the LAST brain (auth-dead) is hit and throws.
    const overloaded = model({ getResponse: async () => { throw overload(); } });
    const fb = withModelFallback([target('primary', overloaded), target('last-dead', dead)]);
    await assert.rejects(() => fb.getResponse(req()));
    assert.equal(isBrainAuthDead('last-dead'), true, 'the last brain auth failure stuck');
    void ok;
  } finally {
    reviveDeadBrains();
  }
});
