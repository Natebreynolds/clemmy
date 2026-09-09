/**
 * Run: npx tsx --test src/tools/worker-tools.test.ts
 *
 * F2 + cross-provider parity — the Claude SDK brain's run_worker fan-out primitive.
 * Verifies (1) the worker lane picker: a Claude worker role → the Claude SDK lane;
 * a NON-Claude worker role → the cross-provider @openai/agents lane (parity with the
 * orchestrator), unless CLEMMY_SDK_BRAIN_CROSS_WORKER reverts it to the Claude brain
 * (surfacing the ignored model); (2) the kill-switch string parsing; (3) run_worker
 * is on the BRAIN surface but NOT the WORKER surface (no recursion). Isolated
 * CLEMENTINE_HOME.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-worker-tools-'));

const { pickSdkBrainWorkerLane, sdkBrainCrossWorkerEnabled } = await import('./worker-tools.js');
const { CLAUDE_AGENT_SDK_FULL_TOOLS, CLAUDE_AGENT_SDK_WORKER_TOOLS } = await import('../runtime/harness/claude-agent-sdk.js');

const BRAIN = 'claude-opus-4-8';

// ── pickSdkBrainWorkerLane: the pure lane decision (deterministic, no connectivity)
test('a Claude worker role runs on the Claude SDK lane (honors "workers = Sonnet 5")', () => {
  const r = pickSdkBrainWorkerLane('claude-sonnet-5', { crossEnabled: true, claudeBrainModel: BRAIN, resolvedProvider: 'claude' });
  assert.deepEqual(r, { modelId: 'claude-sonnet-5', claudeLane: true, source: 'default' });
});

test('a NON-Claude worker role runs on the CROSS-PROVIDER lane when enabled (the parity fix)', () => {
  const r = pickSdkBrainWorkerLane('gpt-5.4-mini', { crossEnabled: true, claudeBrainModel: BRAIN, resolvedProvider: 'codex' });
  assert.deepEqual(r, { modelId: 'gpt-5.4-mini', claudeLane: false, source: 'default' });
});

test('a NON-Claude worker role reverts to the Claude brain when the kill-switch is off (ignored model surfaced)', () => {
  const r = pickSdkBrainWorkerLane('gpt-5.4-mini', { crossEnabled: false, claudeBrainModel: BRAIN, resolvedProvider: 'codex' });
  assert.deepEqual(r, { modelId: BRAIN, claudeLane: true, source: 'fallback', ignoredNonClaudeModel: 'gpt-5.4-mini' });
});

test('an unset worker role falls open to the Claude brain on the Claude SDK lane (no ignored-model warning)', () => {
  const r = pickSdkBrainWorkerLane(undefined, { crossEnabled: true, claudeBrainModel: BRAIN });
  assert.deepEqual(r, { modelId: BRAIN, claudeLane: true, source: 'default' });
});

test('a Claude-shaped BYO worker stays on the cross-provider lane', () => {
  const r = pickSdkBrainWorkerLane('claude-custom', {
    crossEnabled: true,
    claudeBrainModel: BRAIN,
    resolvedProvider: 'byo',
  });
  assert.deepEqual(r, { modelId: 'claude-custom', claudeLane: false, source: 'default' });
});

test('the resolution source rides through the lane pick (policy picks stay attributed as policy)', () => {
  const claude = pickSdkBrainWorkerLane('claude-sonnet-5', { crossEnabled: true, claudeBrainModel: BRAIN, resolvedProvider: 'claude', resolvedSource: 'policy' });
  assert.equal(claude.source, 'policy');
  const cross = pickSdkBrainWorkerLane('gpt-5.4-mini', { crossEnabled: true, claudeBrainModel: BRAIN, resolvedProvider: 'codex', resolvedSource: 'binding' });
  assert.equal(cross.source, 'binding');
  // A policy-resolved model that the kill-switch then IGNORES ran as a fallback,
  // not a policy pick — the decision row must not credit the policy.
  const ignored = pickSdkBrainWorkerLane('gpt-5.4-mini', { crossEnabled: false, claudeBrainModel: BRAIN, resolvedProvider: 'codex', resolvedSource: 'policy' });
  assert.equal(ignored.source, 'fallback');
});

// ── sdkBrainCrossWorkerEnabled: default-ON kill-switch, reverts on off/0/false
function withEnv(over: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(over)) { prev[k] = process.env[k]; if (over[k] === undefined) delete process.env[k]; else process.env[k] = over[k]; }
  try { fn(); } finally { for (const k of Object.keys(over)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
}

test('sdkBrainCrossWorkerEnabled: default on; off/0/false revert; anything else stays on', () => {
  withEnv({ CLEMMY_SDK_BRAIN_CROSS_WORKER: undefined }, () => assert.equal(sdkBrainCrossWorkerEnabled(), true));
  for (const v of ['off', '0', 'false', 'OFF', 'False']) {
    withEnv({ CLEMMY_SDK_BRAIN_CROSS_WORKER: v }, () => assert.equal(sdkBrainCrossWorkerEnabled(), false, `"${v}" reverts`));
  }
  withEnv({ CLEMMY_SDK_BRAIN_CROSS_WORKER: 'on' }, () => assert.equal(sdkBrainCrossWorkerEnabled(), true));
});

test('run_worker is on the BRAIN surface but NOT the WORKER surface (no recursion)', () => {
  assert.ok(CLAUDE_AGENT_SDK_FULL_TOOLS.includes('run_worker' as never), 'the brain can fan out');
  assert.ok(!CLAUDE_AGENT_SDK_WORKER_TOOLS.includes('run_worker' as never), 'a worker can NOT spawn workers');
});

// ── "no hollow done": the Claude-lane worker guard + the handler ok-gate ──────
//
// The invariant: a worker that returns malformed / empty / non-structured output
// must NEVER silently surface as a hollow success (or a generic apology). It is
// enforced by a chain: (1) the runner wrappers normalize empty/whitespace/cap
// output into an `ERROR:` envelope BEFORE the handler sees it; (2) the run_worker
// handler's ok-gate `ok = !/^\s*ERROR:/i.test(text)` marks that envelope FAILED;
// (3) the fan-out ledger reports "M of N failed". These tests pin links (1) + (2)
// at the reachable seams — the Claude lane guard (runClaudeAgentSdkWorker, which
// is directly mockable) and the handler's respawn-guard + no-session branches
// (drivable without faking connected-provider state, since they return before
// route resolution).
//
// NOTE on the handler's inline ok-gate: `/^\s*ERROR:/i.test('')` is false, so a
// truly-empty string would compute ok:true. That gap is UNREACHABLE in
// production — both runner wrappers (runClaudeAgentSdkWorker line ~118 and
// runCrossProviderWorker via normalizeWorkerOutput) convert empty/whitespace/cap
// to an `ERROR:` envelope first. The tests below pin those guards so the
// invariant cannot silently regress by someone weakening a wrapper.
const { runClaudeAgentSdkWorker, setClaudeAgentSdkWorkerRunForTest } = await import(
  '../runtime/harness/claude-agent-worker.js'
);
const { registerWorkerTools } = await import('./worker-tools.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const { exactToolOutputForInvocation, formatRecallableToolText, DEFAULT_TOOL_RESULT_MAX_CHARS } = await import('../runtime/harness/tool-output-format.js');
const {
  appendEvent,
  beginRunAttempt,
  createSession,
  finishRunAttempt,
  getToolOutput,
  getToolOutputForInvocation,
  listEvents,
} = await import('../runtime/harness/eventlog.js');
const { reviseWorkContract, summarizeWorkManifest } = await import('../runtime/harness/work-manifest.js');
const { ToolCallsCounter, withHarnessRunContext } = await import('../runtime/harness/brackets.js');
const {
  activateDispatchLease,
  revokeDispatchLease,
  runWithDispatchLease,
} = await import('../runtime/harness/dispatch-lease.js');
const { runWithToolAbortSignal } = await import('../runtime/tool-abort-context.js');
const { _resetWorkerConcurrencyForTest } = await import('../agents/worker-concurrency.js');
const {
  _resetWorkerBatchExecutionsForTest,
  _setWorkerBatchRuntimeForTest,
} = await import('../agents/worker-batch-execution.js');

// The EXACT ok-gate the run_worker handler applies to a worker's result text
// (worker-tools.ts): an `ERROR:`-prefixed envelope is a FAILED item.
const handlerOkGate = (text: string): boolean => !/^\s*ERROR:/i.test(text ?? '');

const packet = (item: string) => ({
  objective: `Research the SEO posture of ${item} for the parent fan-out batch.`,
  item,
  resolvedTools: 'none needed',
  externalMcpToolNames: null,
  context: `Prospect: ${item}. Use only the facts in this packet.`,
  instructions: 'Return the compact summary; if the item fails, the final line must start with ERROR:.',
  expectedOutput: 'One line: domain authority + top keyword, or ERROR: <reason>.',
  intent: null as string | null,
});

async function withInnerSdk<T>(
  impl: (opts: unknown) => Promise<{ text: string; toolUses: string[]; limitHit?: boolean }>,
  fn: () => Promise<T>,
): Promise<T> {
  setClaudeAgentSdkWorkerRunForTest(impl as never);
  try {
    return await fn();
  } finally {
    setClaudeAgentSdkWorkerRunForTest(null);
  }
}

test('Claude-lane guard: an EMPTY worker result becomes an ERROR: envelope the ok-gate marks FAILED (not a hollow done)', async () => {
  const r = await withInnerSdk(
    async () => ({ text: '', toolUses: [] }),
    () => runClaudeAgentSdkWorker(packet('Acme LLP — acme.example'), 'claude-sonnet-5', 'sess-empty'),
  );
  assert.match(r.text, /^ERROR:/, 'empty inner output is surfaced as an ERROR envelope');
  assert.ok(r.text.trim().length > 0, 'the surfaced text is a clear error, never empty');
  assert.equal(handlerOkGate(r.text), false, 'the handler ok-gate marks it FAILED');
});

test('Claude-lane guard: WHITESPACE-only worker output is also failed, never a hollow success', async () => {
  const r = await withInnerSdk(
    async () => ({ text: '   \n\t  ', toolUses: [] }),
    () => runClaudeAgentSdkWorker(packet('Maple Law — maple-law.example'), 'claude-sonnet-5', 'sess-ws'),
  );
  assert.match(r.text, /^ERROR:/);
  assert.equal(handlerOkGate(r.text), false);
});

test('Claude-lane guard: a turn-CAP (limitHit) becomes an ERROR: envelope naming the turn cap; a partial is preserved, not lost', async () => {
  const capped = await withInnerSdk(
    async () => ({ text: '', toolUses: [], limitHit: true }),
    () => runClaudeAgentSdkWorker(packet('Qux Legal — qux.example'), 'claude-sonnet-5', 'sess-cap'),
  );
  assert.match(capped.text, /^ERROR:/);
  assert.match(capped.text, /turn cap/i, 'the cap is named so worker_capped fires + the respawn guard sees it');
  assert.equal(handlerOkGate(capped.text), false);

  const partial = await withInnerSdk(
    async () => ({ text: 'found 3 of 5 keywords', toolUses: [], limitHit: true }),
    () => runClaudeAgentSdkWorker(packet('Zed & Co — zed.example'), 'claude-sonnet-5', 'sess-cap2'),
  );
  assert.match(partial.text, /^ERROR:/, 'a capped item is still FAILED even with partial work');
  assert.match(partial.text, /found 3 of 5 keywords/, 'the partial output is preserved, never silently dropped');
});

test('Claude-lane guard: a genuine answer passes through verbatim and the ok-gate marks it done (no over-eager ERROR)', async () => {
  const answer = 'Acme LLP: domain authority 38, top keyword "acme law" pos 4.';
  const r = await withInnerSdk(
    async () => ({ text: answer, toolUses: [] }),
    () => runClaudeAgentSdkWorker(packet('Acme LLP — acme.example'), 'claude-sonnet-5', 'sess-ok'),
  );
  assert.equal(r.text, answer, 'a real success is handed back unchanged');
  assert.equal(handlerOkGate(r.text), true);
});

// ── run_worker HANDLER branches drivable without faking provider state ────────
// (both return BEFORE route resolution, so no connected-provider setup is needed).
function captureRunWorker(): (params: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  let handler: ((params: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }> }>) | undefined;
  const stubServer = {
    tool: (name: string, _desc: string, _schema: unknown, cb: (params: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }> }>) => {
      if (name === 'run_worker') handler = cb;
    },
  };
  registerWorkerTools(stubServer as never);
  if (!handler) throw new Error('run_worker handler was not registered');
  return handler;
}

test('handler respawn-guard: re-spawning an ALREADY-CAPPED item is refused with a visible ERROR + a failed worker_result (never a hollow re-run)', async () => {
  const sessionId = 'sess-handler-respawn';
  const item = 'Birch Legal — birch-law.example';
  // events FK-references sessions(id) — create the run's session first.
  createSession({ id: sessionId, kind: 'chat' });
  // Seed the prior turn-cap this run so the respawn guard trips on the re-spawn.
  appendEvent({ sessionId, turn: 0, role: 'system', type: 'worker_capped', data: { item } });

  const handler = captureRunWorker();
  const res = await withToolOutputContext({ sessionId }, () => handler(packet(item)));
  const text = res.content[0].text;
  assert.match(text, /^ERROR:/, 'the refusal is surfaced as an ERROR the orchestrator sees');
  assert.match(text, /already exhausted|NOT re-spawned/i);
  assert.equal(handlerOkGate(text), false);

  const results = listEvents(sessionId, { types: ['worker_result'] });
  const mine = results.find((e) => (e.data as { item?: string } | undefined)?.item === item);
  assert.ok(mine, 'a worker_result was recorded for the refused item');
  assert.equal((mine!.data as { ok?: boolean }).ok, false, 'recorded as FAILED, not a silent success');
});

test('handler no-session branch: without a live session context the item is a visible ERROR, not empty and not an apology', async () => {
  const handler = captureRunWorker();
  const res = await handler(packet('No Session LLP — no-session.example')); // no withToolOutputContext
  const text = res.content[0].text;
  assert.match(text, /^ERROR:/);
  assert.ok(text.trim().length > 0);
  assert.equal(handlerOkGate(text), false);
});

test('ordinary no-manifest batch fails closed without accepted-source durable ownership', async () => {
  const sessionId = 'sess-worker-batch-unowned';
  createSession({ id: sessionId, kind: 'execution' });
  const handler = captureRunWorker();
  const result = await withToolOutputContext({
    sessionId,
    callId: 'call_unowned_batch',
    toolName: 'run_worker',
  }, () => handler({
    ...packet('unused'),
    item: null,
    items: ['one', 'two'],
  }));
  assert.match(result.content[0].text, /^ERROR:/);
  assert.match(result.content[0].text, /accepted-source dispatch lease/);
  assert.equal(listEvents(sessionId, { types: ['worker_started'] }).length, 0);
});

test('SDK-brain handler refuses a quantified successful subset before spawning any worker', async () => {
  const sessionId = 'sess-handler-quantified-subset';
  createSession({ id: sessionId, kind: 'execution' });
  const input = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Research these 10 prospects and summarize each one.' },
  });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'turn_started',
    data: { sourceUserSeq: input.seq },
  });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'fanout_policy_decision',
    data: { sourceUserSeq: input.seq, detected: true, itemCount: 10 },
  });

  const handler = captureRunWorker();
  const res = await withHarnessRunContext(
    {
      sessionId,
      sourceUserSeq: input.seq,
      counter: new ToolCallsCounter(20),
    },
    () => withToolOutputContext({ sessionId }, () => handler({
      ...packet('unused'),
      item: null,
      items: Array.from({ length: 7 }, (_, index) => `prospect-${index + 1}`),
      workManifest: {
        id: 'prospects',
        contractVersion: '1',
        phase: 'research',
        mode: 'declare',
        phases: [{ id: 'research' }],
      },
    })),
  );
  const text = res.content[0].text;
  assert.match(text, /^ERROR:/);
  assert.match(text, /7\/10/);
  assert.match(text, /full 10-item `items` array/);
  assert.equal(
    listEvents(sessionId, { types: ['worker_started'] }).length,
    0,
    'the Claude/SDK lane cannot spend on or report a partial universe',
  );
});

test('SDK-brain handler reuses a completed logical manifest item when the resumed packet changes', async () => {
  const sessionId = 'sess-handler-manifest-resume';
  const item = 'Account A — account-a.example';
  const resumeTail = 'FINAL_RESUME_FIELD=account-a-accepted';
  const largeResult = `${'x'.repeat(65_537 - resumeTail.length)}${resumeTail}`;
  const priorAuthMode = process.env.AUTH_MODE;
  process.env.AUTH_MODE = 'claude_oauth';
  createSession({ id: sessionId, kind: 'chat' });
  const handler = captureRunWorker();
  const initial = {
    ...packet(item),
    workManifest: {
      id: 'account-research',
      contractVersion: '1',
      phase: 'research',
      mode: 'declare',
      phases: [{ id: 'research' }],
    },
  };
  let dispatches = 0;
  try {
    await withInnerSdk(
      async () => {
        dispatches += 1;
        return { text: dispatches === 1 ? largeResult : 'batch research result', toolUses: [] };
      },
      async () => {
        const firstCallId = 'call_sdk_manifest_initial';
        const first = await withToolOutputContext({
          sessionId, callId: firstCallId, toolName: 'run_worker', settlementNonce: randomUUID(),
        }, () => handler(initial));
        assert.ok(first.content[0].text.length < 65_537, 'model-facing tool context stays bounded');
        assert.equal(getToolOutput(sessionId, firstCallId)?.output, largeResult, 'the bounded return has a lossless exact-output handle');

        const resumed = {
          ...initial,
          instructions: 'A restart occurred. Reconcile prior durable progress before doing any work.',
          workManifest: { ...initial.workManifest, mode: 'reconcile' },
        };
        const resumeCallId = 'call_sdk_manifest_resume';
        const resumeContext = { sessionId, callId: resumeCallId, toolName: 'run_worker', settlementNonce: randomUUID() };
        const second = await withToolOutputContext(resumeContext, () => handler(resumed));
        assert.match(second.content[0].text, /Durable receipt: this item was already complete/);
        assert.match(second.content[0].text, /No worker ran and no action was repeated/);
        assert.match(second.content[0].text, /Do not call run_worker again for this phase; synthesize the user-facing result now/);
        const exactResume = getToolOutput(sessionId, resumeCallId)?.output ?? '';
        assert.match(exactResume, new RegExp(resumeTail), 'the 65,537-byte result is reused through its load-bearing tail');
        assert.doesNotMatch(exactResume, /…\(truncated\)/, 'resume never records the legacy successful prefix marker');
        assert.ok(exactResume === largeResult, 'reuse preserves every original worker byte, including its load-bearing tail');
        assert.ok(getToolOutputForInvocation(sessionId, resumeCallId, resumeContext.settlementNonce)?.output === largeResult,
          'the exact resumed invocation retains raw work without host annotations');
        const visible = second.content[0].text;
        assert.ok(visible.length <= DEFAULT_TOOL_RESULT_MAX_CHARS, 'reuse guidance stays inside the existing model-output ceiling');
        assert.ok(exactToolOutputForInvocation({ ...resumeContext, compactResult: visible }) === largeResult,
          'the annotated model return redeems the original bytes for this invocation');
        const wrappedAgain = withToolOutputContext(resumeContext, () => formatRecallableToolText(visible));
        assert.equal(wrappedAgain, visible, 'the next default-sized adapter preserves host guidance and exact receipt');
        for (const wrongIdentity of [
          { ...resumeContext, settlementNonce: randomUUID() },
          { ...resumeContext, callId: 'unrelated-worker-call' },
          { ...resumeContext, toolName: 'unrelated_tool' },
        ]) {
          assert.equal(exactToolOutputForInvocation({ ...wrongIdentity, compactResult: visible }), visible,
            'copied annotation and receipt cannot borrow another invocation or tool');
        }
        const inventedReceipt = 'Durable receipt: this item was already complete. No worker ran and no action was repeated.';
        assert.equal(exactToolOutputForInvocation({ ...resumeContext, compactResult: inventedReceipt }), inventedReceipt,
          'host-looking prose without the exact nonce/digest cannot vouch for the retained raw worker result');

        const batch = {
          ...packet('unused batch placeholder'),
          item: null,
          items: ['Account B — account-b.example', 'Account C — account-c.example'],
          workManifest: {
            id: 'account-research-batch',
            contractVersion: '1',
            phase: 'research',
            mode: 'declare',
            phases: [{ id: 'research' }],
          },
        };
        const firstBatch = await withToolOutputContext({ sessionId }, () => handler(batch));
        assert.match(firstBatch.content[0].text, /Batch complete: 2\/2 items succeeded/);
        const dispatchesAfterFirstBatch = dispatches;

        const resumedBatch = await withToolOutputContext({ sessionId }, () => handler({
          ...batch,
          instructions: 'Recover the completed batch and synthesize; do not repeat it.',
          workManifest: { ...batch.workManifest, mode: 'reconcile' },
        }));
        assert.match(resumedBatch.content[0].text, /Durable receipt: all 2\/2 requested items were already complete/);
        assert.match(resumedBatch.content[0].text, /No worker ran and no action was repeated/);
        assert.match(resumedBatch.content[0].text, /complete "research" phase is already proven/);
        assert.match(resumedBatch.content[0].text, /Do not call run_worker again for this phase; synthesize the user-facing result now/);
        assert.equal(dispatches, dispatchesAfterFirstBatch, 'the completed SDK-brain batch did not spawn again');
      },
    );

    assert.equal(dispatches, 3, 'one single item and two batch items executed exactly once each');
    assert.equal(listEvents(sessionId, { types: ['worker_started'] }).length, 3);
    const routes = listEvents(sessionId, { types: ['worker_model_routed'] });
    assert.equal(routes.length, 3, 'every real SDK-brain worker emits canonical exact-model route evidence');
    for (const route of routes) {
      const data = route.data as { model?: string; effectiveModel?: string; provider?: string; lane?: string };
      assert.ok(data.model, 'worker route names the model');
      assert.equal(data.effectiveModel, data.model);
      assert.ok(data.provider, 'worker route names the explicit provider');
      assert.equal(data.lane, 'sdk_brain');
    }
    const results = listEvents(sessionId, { types: ['worker_result'] });
    assert.equal(results.length, 6, 'single + batch no-op reuse remain observable');
    assert.match(String((results[1].data as { reason?: string }).reason), /durable manifest success/i);
    assert.equal(
      summarizeWorkManifest(sessionId, 'account-research')?.items[0]?.phases.research.attempts,
      2,
      'reuse leaves the original running/succeeded checkpoint history intact',
    );
  } finally {
    if (priorAuthMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = priorAuthMode;
  }
});

test('SDK-brain handler re-executes a target when a manifest contract requires revalidation', async () => {
  const sessionId = 'sess-handler-manifest-revalidate';
  const item = 'Account A — account-a.example';
  const priorAuthMode = process.env.AUTH_MODE;
  process.env.AUTH_MODE = 'claude_oauth';
  createSession({ id: sessionId, kind: 'chat' });
  const handler = captureRunWorker();
  const initial = {
    ...packet(item),
    instructions: 'Include the exact item id and the marker BASELINE.',
    expectedOutput: 'ITEM_ID | BASELINE | one short observation',
    workManifest: {
      id: 'account-revalidation',
      contractVersion: '1',
      phase: 'research',
      mode: 'declare' as const,
      phases: [{ id: 'research' }],
    },
  };
  let dispatches = 0;
  try {
    await withInnerSdk(
      async () => {
        dispatches += 1;
        return {
          text: dispatches === 1
            ? 'Account A | BASELINE | initial observation'
            : 'Account A | REVALIDATED | revised observation',
          toolUses: [],
        };
      },
      async () => {
        const first = await withToolOutputContext({ sessionId }, () => handler(initial));
        assert.match(first.content[0].text, /BASELINE/);

        reviseWorkContract({
          sessionId,
          manifestId: 'account-revalidation',
          fromVersion: 1,
          toVersion: 2,
          instruction: 'Replace BASELINE with REVALIDATED and revalidate the item.',
          evidencePolicy: 'revalidate',
        });

        const revised = await withToolOutputContext({ sessionId }, () => handler({
          ...initial,
          instructions: 'Include the exact item id and the marker REVALIDATED.',
          expectedOutput: 'ITEM_ID | REVALIDATED | one short observation',
          workManifest: {
            ...initial.workManifest,
            contractVersion: '2',
            mode: 'reconcile' as const,
          },
        }));
        assert.match(revised.content[0].text, /REVALIDATED/);
        assert.doesNotMatch(revised.content[0].text, /BASELINE/);
      },
    );

    assert.equal(dispatches, 2, 'the revised contract runs fresh work instead of target-only reuse');
    assert.equal(listEvents(sessionId, { types: ['worker_started'] }).length, 2);
    assert.equal(summarizeWorkManifest(sessionId, 'account-revalidation')?.contractVersion, '2');
    assert.equal(summarizeWorkManifest(sessionId, 'account-revalidation')?.remaining, 0);
    assert.equal(
      listEvents(sessionId, { types: ['worker_result'] }).some((event) => (
        String((event.data as { reason?: string }).reason ?? '').includes('target already completed')
      )),
      false,
    );
  } finally {
    if (priorAuthMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = priorAuthMode;
  }
});

test('SDK-brain handler never treats the same target as the same no-manifest operation', async () => {
  const sessionId = 'sess-handler-distinct-target-operations';
  const item = 'Account A — account-a.example';
  const priorAuthMode = process.env.AUTH_MODE;
  process.env.AUTH_MODE = 'claude_oauth';
  createSession({ id: sessionId, kind: 'execution' });
  const handler = captureRunWorker();
  let dispatches = 0;
  try {
    await withInnerSdk(
      async () => {
        dispatches += 1;
        return {
          text: dispatches === 1
            ? 'Account A | RESEARCHED | source facts'
            : 'Account A | VALIDATED | verification result',
          toolUses: [],
        };
      },
      async () => {
        const researched = await withToolOutputContext({ sessionId }, () => handler({
          ...packet(item),
          objective: 'Research the account from the supplied source facts.',
          instructions: 'Return the researched source facts.',
          expectedOutput: 'ITEM_ID | RESEARCHED | source facts',
        }));
        assert.match(researched.content[0].text, /RESEARCHED/);

        const validated = await withToolOutputContext({ sessionId }, () => handler({
          ...packet(item),
          objective: 'Validate the prior account research for completeness.',
          instructions: 'Return an independent validation result.',
          expectedOutput: 'ITEM_ID | VALIDATED | verification result',
        }));
        assert.match(validated.content[0].text, /VALIDATED/);
        assert.doesNotMatch(validated.content[0].text, /RESEARCHED/);
      },
    );

    assert.equal(dispatches, 2, 'same target with a different operation is fresh work');
    assert.equal(listEvents(sessionId, { types: ['worker_started'] }).length, 2);
  } finally {
    if (priorAuthMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = priorAuthMode;
  }
});

test('SDK-brain handler does not suppress an intentional repeated packet in chat', async () => {
  const sessionId = 'sess-handler-chat-repeat';
  const priorAuthMode = process.env.AUTH_MODE;
  process.env.AUTH_MODE = 'claude_oauth';
  createSession({ id: sessionId, kind: 'chat' });
  const handler = captureRunWorker();
  const input = packet('Account A — account-a.example');
  let dispatches = 0;
  try {
    await withInnerSdk(
      async () => {
        dispatches += 1;
        return { text: `Account A | CHAT RUN ${dispatches}`, toolUses: [] };
      },
      async () => {
        const first = await withToolOutputContext({ sessionId }, () => handler(input));
        const second = await withToolOutputContext({ sessionId }, () => handler(input));
        assert.match(first.content[0].text, /CHAT RUN 1/);
        assert.match(second.content[0].text, /CHAT RUN 2/);
      },
    );

    assert.equal(dispatches, 2, 'a reusable chat may intentionally repeat the same request');
    assert.equal(listEvents(sessionId, { types: ['worker_started'] }).length, 2);
  } finally {
    if (priorAuthMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = priorAuthMode;
  }
});

test('SDK-brain handler still reuses an exact packet replay inside one execution run', async () => {
  const sessionId = 'sess-handler-execution-replay';
  const priorAuthMode = process.env.AUTH_MODE;
  process.env.AUTH_MODE = 'claude_oauth';
  createSession({ id: sessionId, kind: 'execution' });
  const handler = captureRunWorker();
  const input = packet('Account A — account-a.example');
  let dispatches = 0;
  try {
    await withInnerSdk(
      async () => {
        dispatches += 1;
        return { text: 'Account A | EXECUTED ONCE', toolUses: [] };
      },
      async () => {
        const first = await withToolOutputContext({ sessionId }, () => handler(input));
        const replay = await withToolOutputContext({ sessionId }, () => handler(input));
        assert.match(first.content[0].text, /EXECUTED ONCE/);
        assert.match(replay.content[0].text, /EXECUTED ONCE/);
      },
    );

    assert.equal(dispatches, 1, 'an exact execution replay reuses the durable packet result');
    assert.equal(listEvents(sessionId, { types: ['worker_started'] }).length, 1);
    assert.equal(
      listEvents(sessionId, { types: ['worker_result'] }).some((event) => (
        String((event.data as { reason?: string }).reason ?? '').includes('reused prior completed result')
      )),
      true,
    );
  } finally {
    if (priorAuthMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = priorAuthMode;
  }
});

test('RESTART-GATE fan-out width: a 3-item batch overlaps at least 2 workers (N≥3 → real fan-out)', async () => {
  // The north-star fan-out promise, pinned at the engine's worker pool: for a
  // collect-N construct with N≥3, item work must actually overlap — not run as
  // a disguised sequential loop (live Discord has never shown worker
  // crossings). Default session cap is 6, so 3 items must reach width ≥ 2.
  const sessionId = 'sess-fanout-width';
  const priorAuthMode = process.env.AUTH_MODE;
  process.env.AUTH_MODE = 'claude_oauth';
  createSession({ id: sessionId, kind: 'chat' });
  const handler = captureRunWorker();
  let inflight = 0;
  let peak = 0;
  try {
    const res = await withInnerSdk(
      async () => {
        inflight += 1;
        peak = Math.max(peak, inflight);
        await new Promise((resolve) => setTimeout(resolve, 60));
        inflight -= 1;
        return { text: 'item done', toolUses: [] };
      },
      () => withToolOutputContext({ sessionId }, () => handler({
        ...packet('unused batch placeholder'),
        item: null,
        items: ['Shop A — shopa.example', 'Shop B — shopb.example', 'Shop C — shopc.example'],
        workManifest: {
          id: 'coffee-shops',
          contractVersion: '1',
          phase: 'research',
          mode: 'declare',
          phases: [{ id: 'research' }],
        },
      })),
    );
    assert.match(res.content[0].text, /Batch complete: 3\/3 items succeeded/);
    assert.ok(peak >= 2, `worker width must be ≥ 2 for 3 items (observed peak ${peak})`);
    assert.equal(listEvents(sessionId, { types: ['worker_started'] }).length, 3);
  } finally {
    if (priorAuthMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = priorAuthMode;
  }
});

test('P0 gate: cap-6 252/253 deadline boundary parks the remainder without orphaned work', async () => {
  const priorAuthMode = process.env.AUTH_MODE;
  const priorSessionCap = process.env.CLEMMY_WORKER_MAX_CONCURRENCY;
  const priorGlobalCap = process.env.CLEMMY_WORKER_MAX_CONCURRENCY_GLOBAL;
  const priorReduceTier = process.env.CLEMMY_REDUCE_TIER;
  const priorFanoutDigest = process.env.CLEMMY_CHAT_FANOUT_DIGEST;
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_WORKER_MAX_CONCURRENCY = '6';
  process.env.CLEMMY_WORKER_MAX_CONCURRENCY_GLOBAL = '6';
  // This gate measures provider-body admission, not the independently tested
  // fan-out summarizer. Keep post-body reduction deterministic and in-band.
  process.env.CLEMMY_REDUCE_TIER = 'off';
  process.env.CLEMMY_CHAT_FANOUT_DIGEST = 'off';
  _resetWorkerConcurrencyForTest();

  type WorkerWait = {
    resolve: () => void;
    reject: (error: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  };
  const waits: WorkerWait[] = [];
  let logicalNowMs = 0;
  type LogicalTimer = { at: number; active: boolean; fn: () => void };
  const logicalTimers: LogicalTimer[] = [];
  const installLogicalBatchRuntime = (): void => {
    _setWorkerBatchRuntimeForTest({
      now: () => logicalNowMs,
      setTimer: (fn, delayMs) => {
        const timer: LogicalTimer = { at: logicalNowMs + delayMs, active: true, fn };
        logicalTimers.push(timer);
        return timer;
      },
      clearTimer: (raw) => { (raw as LogicalTimer).active = false; },
    });
  };
  installLogicalBatchRuntime();
  let started = 0;
  let inFlight = 0;
  let peak = 0;
  const waitUntil = async (predicate: () => boolean, label: string): Promise<void> => {
    for (let spin = 0; spin < 50_000; spin += 1) {
      if (predicate()) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error(`controllable worker clock did not reach ${label} (started=${started}, inFlight=${inFlight})`);
  };
  const advanceRound = async (): Promise<void> => {
    logicalNowMs += 7_000;
    const current = waits.splice(0, waits.length);
    for (const wait of current) {
      if (wait.signal && wait.onAbort) wait.signal.removeEventListener('abort', wait.onAbort);
      wait.resolve();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const timer of logicalTimers) {
      if (timer.active && timer.at <= logicalNowMs) {
        timer.active = false;
        timer.fn();
      }
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const owners = new Map<string, {
    sourceUserSeq: number;
    attempt: ReturnType<typeof beginRunAttempt>;
    parentLease: ReturnType<typeof activateDispatchLease>;
  }>();
  const ownerFor = (sessionId: string) => {
    const existing = owners.get(sessionId);
    if (existing) return existing;
    createSession({ id: sessionId, kind: 'execution' });
    const source = appendEvent({
      sessionId,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      data: { text: 'Run this exact ordinary worker batch.' },
    });
    const attempt = beginRunAttempt(sessionId, { runId: `${sessionId}:p0-deadline` });
    const parentLease = activateDispatchLease({
      sessionId,
      scopeId: `${sessionId}:p0-deadline-parent`,
      runAttemptId: attempt.attemptId,
    });
    const owner = { sourceUserSeq: source.seq, attempt, parentLease };
    owners.set(sessionId, owner);
    return owner;
  };
  const runBatch = async (count: number, sessionId: string, controller: AbortController) => {
    const owner = ownerFor(sessionId);
    const items = Array.from({ length: count }, (_, index) => `deadline-item-${String(index + 1).padStart(3, '0')}`);
    const handler = captureRunWorker();
    const call = {
      ...packet('unused deadline placeholder'),
      model: 'claude-sonnet-5',
      item: null,
      items,
    };
    return runWithDispatchLease(
      owner.parentLease,
      () => withHarnessRunContext(
        {
          sessionId,
          sourceUserSeq: owner.sourceUserSeq,
          counter: new ToolCallsCounter(2_000),
          dispatchLease: owner.parentLease,
          runAttemptId: owner.attempt.attemptId,
        },
        () => runWithToolAbortSignal(
          controller.signal,
          () => withToolOutputContext({
            sessionId,
            sourceUserSeq: owner.sourceUserSeq,
            callId: 'call_deadline_batch',
            toolName: 'run_worker',
          }, () => handler(call)),
          logicalNowMs + 300_000,
        ),
      ),
    );
  };

  try {
    await withInnerSdk(
      async (rawOptions) => {
        const signal = (rawOptions as { abortSignal?: AbortSignal }).abortSignal;
        started += 1;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
          await new Promise<void>((resolve, reject) => {
            const wait: WorkerWait = { resolve, reject, ...(signal ? { signal } : {}) };
            if (signal) {
              wait.onAbort = () => reject(signal.reason ?? new Error('worker generation aborted'));
              if (signal.aborted) {
                wait.onAbort();
                return;
              }
              signal.addEventListener('abort', wait.onAbort, { once: true });
            }
            waits.push(wait);
          });
          return { text: 'deadline item done', toolUses: [] };
        } finally {
          inFlight -= 1;
        }
      },
      async () => {
        const one = runBatch(1, 'sess-deadline-single', new AbortController());
        await waitUntil(() => started === 1 && inFlight === 1, 'one supervised worker');
        logicalNowMs = 298_000;
        for (const timer of logicalTimers) if (timer.active && timer.at <= logicalNowMs) { timer.active = false; timer.fn(); }
        let parkedSingle: Awaited<typeof one> | undefined;
        void one.then((value) => { parkedSingle = value; });
        await waitUntil(() => parkedSingle !== undefined, 'single-worker cancellation and drain');
        assert.equal(inFlight, 0, 'the singleton body must be drained before the parent receives a remainder');
        assert.match(parkedSingle!.content[0].text, /0\/1 settled; 0 failed; 0 in_flight; 1 pending/);
        // Remove the rejected controllable wait; it cannot complete later.
        waits.splice(0, waits.length);
        logicalNowMs = 0;
        started = 0;
        peak = 0;
        const at252 = new AbortController();
        const completes252 = runBatch(252, 'sess-deadline-252', at252);
        await waitUntil(() => started === 6, 'the first cap-6 wave for 252');
        for (let round = 1; round <= 42; round += 1) {
          await advanceRound();
          if (round < 42) await waitUntil(() => started === (round + 1) * 6, `252 round ${round + 1}`);
        }
        const complete252Result = await completes252;
        assert.match(complete252Result.content[0].text, /Batch complete: 252\/252 items succeeded/);
        assert.equal(logicalNowMs, 294_000, '252 items consume exactly 42 seven-second waves');
        assert.equal(peak, 6, 'the production semaphore, not the test, owns effective width 6');
        assert.equal(inFlight, 0);

        logicalNowMs = 0;
        started = 0;
        peak = 0;
        const at253 = new AbortController();
        const crosses253 = runBatch(253, 'sess-deadline-253', at253);
        await waitUntil(() => started === 6, 'the first cap-6 wave for 253');
        for (let round = 1; round <= 42; round += 1) {
          await advanceRound();
          if (round < 42) await waitUntil(() => started === (round + 1) * 6, `253 round ${round + 1}`);
        }
        const parked253 = await crosses253;
        assert.equal(logicalNowMs, 294_000);
        assert.equal(started, 252, 'the 253rd body is not started when only 6s remain for an observed 7s item');
        assert.equal(inFlight, 0, 'typed park is withheld until every started body settles');
        assert.match(parked253.content[0].text, /Batch parked safely/);
        assert.match(parked253.content[0].text, /252\/253 settled; 0 failed; 0 in_flight; 1 pending/);
        assert.match(parked253.content[0].text, /"pending":\["deadline-item-253"\]/);

        // Same ordinary no-manifest batch, fresh caller budget: the 252 exact
        // receipts are reused and only the pending body crosses the provider.
        // Clear every process-local scheduler/semaphore hint first: restart
        // recovery must come from durable source-bound receipts, never a Map.
        _resetWorkerBatchExecutionsForTest();
        _resetWorkerConcurrencyForTest();
        installLogicalBatchRuntime();
        const resumed = runBatch(253, 'sess-deadline-253', new AbortController());
        await waitUntil(() => started === 253 && inFlight === 1, 'only the pending 253rd body on resume');
        await advanceRound();
        const resumedResult = await resumed;
        assert.match(resumedResult.content[0].text, /Batch complete: 253\/253 items succeeded/);
        assert.equal(started, 253, '252 settled bodies were not executed again');
        assert.equal(inFlight, 0);
        assert.equal(waits.length, 0, 'no queued or active worker clock remains orphaned');
      },
    );
  } finally {
    // Keep a failed assertion from leaving a controllable provider promise.
    while (waits.length > 0) await advanceRound();
    for (const owner of owners.values()) {
      revokeDispatchLease(owner.parentLease);
      finishRunAttempt(owner.attempt, 'completed');
    }
    _resetWorkerBatchExecutionsForTest();
    _resetWorkerConcurrencyForTest();
    if (priorAuthMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = priorAuthMode;
    if (priorSessionCap === undefined) delete process.env.CLEMMY_WORKER_MAX_CONCURRENCY;
    else process.env.CLEMMY_WORKER_MAX_CONCURRENCY = priorSessionCap;
    if (priorGlobalCap === undefined) delete process.env.CLEMMY_WORKER_MAX_CONCURRENCY_GLOBAL;
    else process.env.CLEMMY_WORKER_MAX_CONCURRENCY_GLOBAL = priorGlobalCap;
    if (priorReduceTier === undefined) delete process.env.CLEMMY_REDUCE_TIER;
    else process.env.CLEMMY_REDUCE_TIER = priorReduceTier;
    if (priorFanoutDigest === undefined) delete process.env.CLEMMY_CHAT_FANOUT_DIGEST;
    else process.env.CLEMMY_CHAT_FANOUT_DIGEST = priorFanoutDigest;
  }
});

// ── ONE LOOP, MANY BRAINS: per-packet model override (permissive)
test('a routable packet model wins over intent/role routing', async () => {
  const { resolveSdkBrainWorker } = await import('./worker-tools.js');
  const route = resolveSdkBrainWorker('research', 'gpt-5.6-terra');
  assert.equal(route.modelId, 'gpt-5.6-terra', 'the exact packet model runs this worker');
  assert.equal(route.claudeLane, false, 'a non-Claude packet model rides the cross-provider lane');
});

test('an unroutable packet model falls through the chain — NEVER refuses the dispatch', async () => {
  const { resolveSdkBrainWorker } = await import('./worker-tools.js');
  const route = resolveSdkBrainWorker(undefined, 'totally-unknown-model-xyz');
  assert.ok(route.modelId, `a worker still runs on the resolvable chain: ${JSON.stringify(route)}`);
});
