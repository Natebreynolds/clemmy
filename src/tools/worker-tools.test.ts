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
  assert.deepEqual(r, { modelId: 'claude-sonnet-5', claudeLane: true });
});

test('a NON-Claude worker role runs on the CROSS-PROVIDER lane when enabled (the parity fix)', () => {
  const r = pickSdkBrainWorkerLane('gpt-5.4-mini', { crossEnabled: true, claudeBrainModel: BRAIN, resolvedProvider: 'codex' });
  assert.deepEqual(r, { modelId: 'gpt-5.4-mini', claudeLane: false });
});

test('a NON-Claude worker role reverts to the Claude brain when the kill-switch is off (ignored model surfaced)', () => {
  const r = pickSdkBrainWorkerLane('gpt-5.4-mini', { crossEnabled: false, claudeBrainModel: BRAIN, resolvedProvider: 'codex' });
  assert.deepEqual(r, { modelId: BRAIN, claudeLane: true, ignoredNonClaudeModel: 'gpt-5.4-mini' });
});

test('an unset worker role falls open to the Claude brain on the Claude SDK lane (no ignored-model warning)', () => {
  const r = pickSdkBrainWorkerLane(undefined, { crossEnabled: true, claudeBrainModel: BRAIN });
  assert.deepEqual(r, { modelId: BRAIN, claudeLane: true });
});

test('a Claude-shaped BYO worker stays on the cross-provider lane', () => {
  const r = pickSdkBrainWorkerLane('claude-custom', {
    crossEnabled: true,
    claudeBrainModel: BRAIN,
    resolvedProvider: 'byo',
  });
  assert.deepEqual(r, { modelId: 'claude-custom', claudeLane: false });
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
const { createSession, appendEvent, listEvents } = await import('../runtime/harness/eventlog.js');

// The EXACT ok-gate the run_worker handler applies to a worker's result text
// (worker-tools.ts): an `ERROR:`-prefixed envelope is a FAILED item.
const handlerOkGate = (text: string): boolean => !/^\s*ERROR:/i.test(text ?? '');

const packet = (item: string) => ({
  objective: `Research the SEO posture of ${item} for the parent fan-out batch.`,
  item,
  resolvedTools: 'none needed',
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
