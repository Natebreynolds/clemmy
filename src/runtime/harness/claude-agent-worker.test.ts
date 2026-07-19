import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-claude-agent-worker-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const STATE_DIR = path.join(TMP_HOME, 'state');
mkdirSync(STATE_DIR, { recursive: true });
writeFileSync(
  path.join(STATE_DIR, 'claude-auth.json'),
  JSON.stringify({
    accessToken: 'sk-ant-oat01-worker-test-token',
    refreshToken: 'refresh-token',
    expiresAt: Date.now() + 60 * 60 * 1000,
  }),
  'utf-8',
);

const mod = await import('./claude-agent-worker.js');
const {
  claudeAgentSdkWorkerEnabled,
  renderClaudeAgentWorkerSystemAppend,
  runClaudeAgentSdkWorker,
  setClaudeAgentSdkWorkerRunForTest,
} = mod;

beforeEach(() => {
  setClaudeAgentSdkWorkerRunForTest(null);
  delete process.env.CLEMMY_CLAUDE_AGENT_SDK_WORKER;
  delete process.env.CLEMMY_CLAUDE_AGENT_SDK_WORKER_MAX_TURNS;
  delete process.env.MODEL_ROUTING_MODE;
  delete process.env.BYO_MODEL_BASE_URL;
  delete process.env.BYO_MODEL_API_KEY;
  delete process.env.BYO_MODEL_ID;
});

after(() => {
  setClaudeAgentSdkWorkerRunForTest(null);
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const packet = {
  objective: 'Design a concise report section using an installed skill.',
  item: 'report hero',
  resolvedTools: 'skill_read',
  context: 'Use skill claude-worker-smoke.',
  instructions: 'Use the installed skill before writing.',
  expectedOutput: 'One compact design direction.',
  intent: 'design',
};

test('claudeAgentSdkWorkerEnabled defaults on for Claude models and is kill-switchable', () => {
  assert.equal(claudeAgentSdkWorkerEnabled('claude-sonnet-4-6'), true);
  assert.equal(claudeAgentSdkWorkerEnabled('gpt-5.4'), false);
  process.env.CLEMMY_CLAUDE_AGENT_SDK_WORKER = 'off';
  assert.equal(claudeAgentSdkWorkerEnabled('claude-sonnet-4-6'), false);
});

test('Claude-shaped all_in BYO model does not enter the Claude SDK worker lane', () => {
  process.env.MODEL_ROUTING_MODE = 'all_in';
  process.env.BYO_MODEL_BASE_URL = 'https://byo.example.test/v1';
  process.env.BYO_MODEL_API_KEY = 'byo-key';
  process.env.BYO_MODEL_ID = 'claude-custom';
  assert.equal(claudeAgentSdkWorkerEnabled('claude-custom'), false);
});

test('renderClaudeAgentWorkerSystemAppend tells Claude to use named skills and stay read-only', () => {
  const prompt = renderClaudeAgentWorkerSystemAppend(packet);
  assert.match(prompt, /READ-ONLY\/local-context/);
  assert.match(prompt, /call `skill_read`/);
  assert.match(prompt, /Worker intent: design/);
});

test('runClaudeAgentSdkWorker builds a worker packet prompt with read-only tools', async () => {
  let captured: any;
  setClaudeAgentSdkWorkerRunForTest(async (options) => {
    captured = options;
    return {
      text: 'worker ok',
      sessionId: 'sdk-worker-session',
      model: 'claude-sonnet-4-6',
      toolUses: ['mcp__clementine-local__skill_read'],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  });

  const result = await runClaudeAgentSdkWorker(packet, 'claude-sonnet-4-6');
  assert.equal(result.text, 'worker ok');
  assert.equal(result.sdkSessionId, 'sdk-worker-session');
  assert.deepEqual(result.toolUses, ['mcp__clementine-local__skill_read']);
  assert.equal(captured.modelId, 'claude-sonnet-4-6');
  // intent:'design' is a HEAVY (multi-step) intent → intent-aware cap widens the
  // base 12 to 18 so it finishes on the first attempt (the 2026-06-22 fan-out fix,
  // default-on under CLEMMY_WORKER_THRASH_GUARD).
  assert.equal(captured.maxTurns, 18);
  assert.match(captured.prompt, /\[WORKER JOB PACKET\]/);
  assert.ok(captured.allowedLocalMcpTools.includes('skill_read'));
  assert.ok(captured.allowedLocalMcpTools.includes('memory_search'));
  assert.equal(captured.allowedLocalMcpTools.includes('run_shell_command'), false);
  assert.equal(captured.allowedLocalMcpTools.includes('write_file'), false);
  assert.equal(captured.nativeMcpScopeInput, 'skill_read');
  assert.equal(captured.nativeMcpScopeMode, 'resolved_tools');
});

// ── 2026-06-22 fan-out fix: SDK-lane cap visibility + intent-aware cap ─────────
// This is the lane Alexander's claude_oauth workers take. Both behaviors gated under
// CLEMMY_WORKER_THRASH_GUARD (default on). Asserted via the injected-run seam.

const researchPacket = {
  objective: 'analyze one client', item: 'Northstar Legal — northstar-legal.example',
  resolvedTools: 'dataforseo', context: 'x', instructions: 'x', expectedOutput: 'x',
  intent: 'research',
};
const ordinaryPacket = { ...researchPacket, intent: null };

function withThrashGuard<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.CLEMMY_WORKER_THRASH_GUARD;
  if (value === undefined) delete process.env.CLEMMY_WORKER_THRASH_GUARD;
  else process.env.CLEMMY_WORKER_THRASH_GUARD = value;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.CLEMMY_WORKER_THRASH_GUARD;
    else process.env.CLEMMY_WORKER_THRASH_GUARD = prev;
  });
}

test('guard ON: a turn-cap (limitHit) becomes an ERROR: envelope the ledger + worker_capped can see', async () => {
  await withThrashGuard('on', async () => {
    setClaudeAgentSdkWorkerRunForTest(async () => ({
      text: 'I reached the turn budget. Say "continue" to keep going.', limitHit: true, toolUses: [],
    }));
    const r = await runClaudeAgentSdkWorker(researchPacket, 'claude-opus-4-8', 'sess-cap');
    assert.match(r.text, /^ERROR:/, 'capped worker returns an ERROR: result');
    assert.match(r.text, /hit its turn cap/i, 'contains the phrase hooks.ts:380 keys worker_capped on');
    assert.match(r.text, /Partial:/, 'preserves the partial work for context');
  });
});

test('guard ON: the SDK receives the INTENT-AWARE cap (research widens to 18, null keeps base 12)', async () => {
  await withThrashGuard('on', async () => {
    let captured: any;
    setClaudeAgentSdkWorkerRunForTest(async (options) => { captured = options; return { text: 'done', toolUses: [] }; });
    await runClaudeAgentSdkWorker(researchPacket, 'claude-opus-4-8', 'sess-r');
    assert.equal(captured.maxTurns, 18, 'research intent gets the widened ceiling');
    await runClaudeAgentSdkWorker(ordinaryPacket, 'claude-opus-4-8', 'sess-o');
    assert.equal(captured.maxTurns, 12, 'ordinary worker keeps the base cap (default 12)');
  });
});

test('workers receive stable isolated tracker scopes while retaining parent session authority', async () => {
  await withThrashGuard('on', async () => {
    const captured: any[] = [];
    setClaudeAgentSdkWorkerRunForTest(async (options) => {
      captured.push(options);
      return { text: 'done', toolUses: [] };
    });
    await runClaudeAgentSdkWorker(researchPacket, 'claude-opus-4-8', 'sess-parent', 77);
    await runClaudeAgentSdkWorker(researchPacket, 'claude-opus-4-8', 'sess-parent');
    await runClaudeAgentSdkWorker({ ...researchPacket, item: 'Different firm' }, 'claude-opus-4-8', 'sess-parent');
    assert.equal(captured[0].sessionId, 'sess-parent');
    assert.equal(captured[0].sourceUserSeq, 77, 'worker inherits the exact parent user turn instead of session-global latest input');
    assert.equal(captured[0].trackerScopeId, captured[1].trackerScopeId, 'resume/retry keeps the packet-stable scope');
    assert.notEqual(captured[0].trackerScopeId, captured[2].trackerScopeId, 'different workers never share a tracker');
    assert.match(captured[0].trackerScopeId, /^sess-parent::worker:/);
    assert.equal('skipSessionGrindGate' in captured[0], false, 'workers no longer disable enforcement');
  });
});

test('guard OFF: byte-identical rollback — friendly text verbatim + base cap regardless of intent', async () => {
  await withThrashGuard('off', async () => {
    let captured: any;
    setClaudeAgentSdkWorkerRunForTest(async (options) => {
      captured = options;
      return { text: 'I reached the turn budget. Say "continue" to keep going.', limitHit: true, toolUses: [] };
    });
    const r = await runClaudeAgentSdkWorker(researchPacket, 'claude-opus-4-8', 'sess-off');
    assert.equal(r.text, 'I reached the turn budget. Say "continue" to keep going.', 'friendly text verbatim');
    assert.doesNotMatch(r.text, /^ERROR:/);
    assert.equal(captured.maxTurns, 12, 'no intent widening when the guard is off');
  });
});

test('empty output still normalizes to an ERROR: (unchanged pre-existing behavior)', async () => {
  await withThrashGuard('on', async () => {
    setClaudeAgentSdkWorkerRunForTest(async () => ({ text: '   ', limitHit: false, toolUses: [] }));
    const r = await runClaudeAgentSdkWorker(ordinaryPacket, 'claude-opus-4-8', 'sess-empty');
    assert.match(r.text, /^ERROR: Claude SDK worker produced no output/);
  });
});
