/**
 * Run: npx tsx --test src/agents/agent-delegations.test.ts
 *
 * CLOSES THE SECOND HALF OF THE DELEGATION GAP.
 *
 * `complete_delegation` (team-tools) let delegated work finish, but only on the
 * path Clementine drives: it reads the acting agent from the PROCESS-GLOBAL
 * `CLEMENTINE_TEAM_AGENT`, which is meaningless in the shared daemon where every
 * autonomy agent runs in one process. So a delegate could never pick up its own
 * work on its own cadence — `wakeTriggers` listed 'delegation' and nothing
 * consumed it.
 *
 * These tools bind the agent's slug at construction, exactly like
 * `buildAgentCommsTools`, so attribution is correct without any env variable.
 * Two properties matter most and are pinned below:
 *
 *   1. In ONE process, agent A's tools cannot touch agent B's delegation.
 *      This is the guarantee the env-based version could not make.
 *   2. A claim is a LEASE, not a lock. A cycle that dies mid-work must not
 *      strand the delegation forever.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'clemmy-agent-deleg-test-'));
process.env.HOME = tmpHome;
process.env.CLEMENTINE_HOME = path.join(tmpHome, '.clementine-next');
mkdirSync(process.env.CLEMENTINE_HOME, { recursive: true });

type Mod = typeof import('./agent-delegations.js');
let buildAgentDelegationTools: Mod['buildAgentDelegationTools'];
let renderOpenDelegations: Mod['renderOpenDelegations'];
let DELEGATION_CLAIM_LEASE_MS: Mod['DELEGATION_CLAIM_LEASE_MS'];
let setBridgeImplsForTests: typeof import('../runtime/harness/respond-bridge.js')['_setBridgeImplsForTests'];
let resetEventLog: typeof import('../runtime/harness/eventlog.js')['resetEventLog'];

const DELEGATIONS = () => path.join(process.env.CLEMENTINE_HOME!, 'delegations');

function seed(toAgent: string, id: string, extra: Record<string, unknown> = {}): void {
  const dir = path.join(DELEGATIONS(), toAgent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    id,
    fromAgent: 'clementine',
    toAgent,
    task: `Do the thing ${id}`,
    expectedOutput: 'A result',
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...extra,
  }, null, 2), 'utf-8');
}

function read(toAgent: string, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(DELEGATIONS(), toAgent, `${id}.json`), 'utf-8')) as Record<string, unknown>;
}

/** Invoke a slug-bound tool by name. */
async function run(slug: string, name: string, args: Record<string, unknown>): Promise<string> {
  const tools = buildAgentDelegationTools(slug) as Array<{
    name: string;
    invoke?: (ctx: unknown, input: string) => Promise<string>;
    execute?: (args: Record<string, unknown>) => Promise<string>;
  }>;
  const found = tools.find((t) => t.name === name);
  assert.ok(found, `tool ${name} not built for ${slug}`);
  if (typeof found.execute === 'function') return await found.execute(args);
  return await found.invoke!({}, JSON.stringify(args));
}

before(async () => {
  ({ buildAgentDelegationTools, renderOpenDelegations, DELEGATION_CLAIM_LEASE_MS } =
    await import('./agent-delegations.js'));
  ({ _setBridgeImplsForTests: setBridgeImplsForTests } =
    await import('../runtime/harness/respond-bridge.js'));
  ({ resetEventLog } = await import('../runtime/harness/eventlog.js'));
});

beforeEach(() => {
  rmSync(DELEGATIONS(), { recursive: true, force: true });
  resetEventLog();
  setBridgeImplsForTests({});
  process.env.AUTH_MODE = 'api_key';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'off';
  process.env.CLEMMY_HARNESS_CRON = 'on';
  delete process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
});

after(() => {
  setBridgeImplsForTests({});
  rmSync(tmpHome, { recursive: true, force: true });
});

test('a woken agent can see the work assigned to it, and only that work', () => {
  seed('analyst', 'aaa1');
  seed('builder', 'bbb1');

  const analystView = renderOpenDelegations('analyst');
  assert.match(analystView, /aaa1/);
  assert.doesNotMatch(analystView, /bbb1/, 'an agent must not see another agent-s queue');

  const builderView = renderOpenDelegations('builder');
  assert.match(builderView, /bbb1/);
  assert.doesNotMatch(builderView, /aaa1/);
});

test('completed work drops out of the agent view', () => {
  seed('analyst', 'done1', { status: 'completed', result: 'x' });
  assert.doesNotMatch(renderOpenDelegations('analyst'), /done1/);
});

test('an agent with nothing assigned renders nothing (no empty section noise)', () => {
  assert.equal(renderOpenDelegations('analyst'), '');
});

test('claiming marks the work in progress and names the owner', async () => {
  seed('analyst', 'c1');
  const out = await run('analyst', 'delegation_claim', { delegation_id: 'c1' });
  assert.match(out, /c1/);

  const record = read('analyst', 'c1');
  assert.equal(record.status, 'in_progress');
  assert.equal(record.claimedBy, 'analyst');
  assert.ok(typeof record.claimedAt === 'string' && record.claimedAt);
});

test('CONTENTION: a second agent cannot claim work it was not given — same process', async () => {
  seed('analyst', 'c2');
  await run('analyst', 'delegation_claim', { delegation_id: 'c2' });

  // `builder`'s tools are constructed in the SAME process. With the old
  // process-global env identity this was indistinguishable from `analyst`.
  const refused = await run('builder', 'delegation_claim', { delegation_id: 'c2' });
  assert.match(refused, /not assigned/i);
  assert.equal(read('analyst', 'c2').claimedBy, 'analyst', 'the refusal must not mutate state');
});

test('CONTENTION: an already-claimed delegation is not re-claimed while the lease holds', async () => {
  seed('analyst', 'c3');
  await run('analyst', 'delegation_claim', { delegation_id: 'c3' });
  const second = await run('analyst', 'delegation_claim', { delegation_id: 'c3' });
  assert.match(second, /already in progress/i, 'a later cycle must not restart in-flight work');
});

test('LEASE: a stale claim can be reclaimed so a dead cycle never strands work', async () => {
  const stale = new Date(Date.now() - DELEGATION_CLAIM_LEASE_MS - 60_000).toISOString();
  seed('analyst', 'c4', { status: 'in_progress', claimedBy: 'analyst', claimedAt: stale });

  const out = await run('analyst', 'delegation_claim', { delegation_id: 'c4' });
  assert.doesNotMatch(out, /already in progress/i, 'an expired lease must be reclaimable');
  const record = read('analyst', 'c4');
  assert.equal(record.status, 'in_progress');
  assert.notEqual(record.claimedAt, stale, 'reclaim refreshes the lease');
});

test('an agent completes its own work, attributed to itself with no env involvement', async () => {
  delete process.env.CLEMENTINE_TEAM_AGENT; // prove identity does not come from here
  seed('analyst', 'd1');
  await run('analyst', 'delegation_claim', { delegation_id: 'd1' });
  await run('analyst', 'delegation_complete', { delegation_id: 'd1', result: 'Three risks: a, b, c' });

  const record = read('analyst', 'd1');
  assert.equal(record.status, 'completed');
  assert.equal(record.result, 'Three risks: a, b, c');
  assert.equal(record.completedBy, 'analyst');
  assert.equal(record.onBehalfOf, undefined, 'the assignee did it — no on-behalf-of marker');
});

test('CONTENTION: agent B cannot complete agent A-s delegation in the same process', async () => {
  seed('analyst', 'd2');
  const refused = await run('builder', 'delegation_complete', { delegation_id: 'd2', result: 'not mine' });
  assert.match(refused, /not assigned/i);
  assert.equal(read('analyst', 'd2').status, 'pending', 'the refusal must not mutate state');
});

test('PATH SAFETY: a delegation id cannot traverse into another agent queue', async () => {
  seed('builder', 'cross-queue');
  const refused = await run('analyst', 'delegation_claim', {
    delegation_id: '../builder/cross-queue',
  });
  assert.match(refused, /not assigned|invalid/i);
  assert.equal(
    read('builder', 'cross-queue').status,
    'pending',
    'a model-supplied id must never resolve outside the bound queue directory',
  );
});

test('OWNERSHIP: malformed records in an agent directory are neither rendered nor mutable', async () => {
  seed('analyst', 'spoofed-owner', { toAgent: 'builder' });
  assert.doesNotMatch(
    renderOpenDelegations('analyst'),
    /spoofed-owner/,
    'directory placement alone does not establish record ownership',
  );
  const refused = await run('analyst', 'delegation_claim', { delegation_id: 'spoofed-owner' });
  assert.match(refused, /not assigned|invalid/i);
  assert.equal(read('analyst', 'spoofed-owner').status, 'pending');

  seed('analyst', 'filename-id', { id: 'different-record-id' });
  assert.doesNotMatch(
    renderOpenDelegations('analyst'),
    /different-record-id|filename-id/,
    'the durable id must agree with the containing filename',
  );
  const idRefused = await run('analyst', 'delegation_complete', {
    delegation_id: 'filename-id',
    result: 'must not land',
  });
  assert.match(idRefused, /not assigned|invalid/i);
  assert.equal(read('analyst', 'filename-id').status, 'pending');
});

test('exactly-once: a completed delegation is not silently rewritten', async () => {
  seed('analyst', 'd3');
  await run('analyst', 'delegation_complete', { delegation_id: 'd3', result: 'first' });
  const again = await run('analyst', 'delegation_complete', { delegation_id: 'd3', result: 'second' });
  assert.match(again, /already completed/i);
  assert.equal(read('analyst', 'd3').result, 'first', 'the first result stays authoritative');
});

test('completing without claiming is allowed — the claim is coordination, not a gate', async () => {
  seed('analyst', 'd4');
  await run('analyst', 'delegation_complete', { delegation_id: 'd4', result: 'straight through' });
  assert.equal(read('analyst', 'd4').status, 'completed');
});

test('a missing delegation is reported rather than silently dropped', async () => {
  // Lookup is scoped to the agent's own queue, so "unknown id" and "someone
  // else's work" are indistinguishable from here — which is the point.
  assert.match(await run('analyst', 'delegation_claim', { delegation_id: 'nope' }), /not assigned to you/i);
  assert.match(await run('analyst', 'delegation_complete', { delegation_id: 'nope', result: 'x' }), /not assigned to you/i);
});

// ─── Wiring: assigned work must actually reach the cycle input ───
// The tools above are useless if a woken agent never sees what it was given.
// This pins the one line in autonomy-v2 that puts it there.

test('WIRING: delegated work reaches the agent cycle input', async () => {
  const { _testOnly_buildAgentInput } = await import('./autonomy-v2.js');
  seed('analyst', 'w1');

  const record = {
    slug: 'analyst',
    name: 'Analyst',
    description: 'Test analyst.',
    canMessage: [],
    allowedTools: [],
    tier: 2,
  } as unknown as Parameters<typeof _testOnly_buildAgentInput>[0];

  const input = _testOnly_buildAgentInput(record, [], { slug: 'analyst' });
  assert.match(input, /w1/, 'the agent must see the delegation id it needs to claim');
  assert.match(input, /Do the thing w1/, 'and the task itself');
});

test('WIRING: an agent with no delegated work gains no empty section', async () => {
  const { _testOnly_buildAgentInput } = await import('./autonomy-v2.js');
  const record = {
    slug: 'idle-agent',
    name: 'Idle',
    description: 'Test idle agent.',
    canMessage: [],
    allowedTools: [],
    tier: 2,
  } as unknown as Parameters<typeof _testOnly_buildAgentInput>[0];

  const input = _testOnly_buildAgentInput(record, [], { slug: 'idle-agent' });
  assert.doesNotMatch(input, /delegated to you/i, 'quiet agents pay no prompt cost');
});

// ─── Configured-but-inert must not be silent ───
// Nathan had AUTONOMY_V2_AGENTS set and reasonably assumed his agents were
// running. They were not: this engine needs a raw OpenAI key, which an
// OAuth-only install does not have, and it returned quietly on every tick.
// A capability that is configured but cannot run has to say so.

test('autonomy warns exactly once when configured but unable to run', async () => {
  const mod = await import('./autonomy-v2.js');
  mod._testOnly_resetAutonomyUnavailableWarning();

  // The once-only latch is the property that keeps a 15s daemon tick from
  // turning an honest warning into a log storm.
  assert.equal(mod.claimAutonomyUnavailableWarning(), true, 'first tick reports');
  assert.equal(mod.claimAutonomyUnavailableWarning(), false, 'later ticks stay quiet');

  mod._testOnly_resetAutonomyUnavailableWarning();
  assert.equal(mod.claimAutonomyUnavailableWarning(), true, 'a fresh process reports again');
});

test('a configured-but-keyless autonomy pass does no work and does not throw', async () => {
  const mod = await import('./autonomy-v2.js');
  mod._testOnly_resetAutonomyUnavailableWarning();

  const prevAgents = process.env.AUTONOMY_V2_AGENTS;
  const prevKey = process.env.OPENAI_API_KEY;
  process.env.AUTONOMY_V2_AGENTS = 'proof-analyst';
  delete process.env.OPENAI_API_KEY;
  try {
    const summary = await mod.processAgentAutonomyV2();
    assert.equal(summary.attempted, 0, 'no agent cycle is attempted without a key');
    assert.equal(summary.failed, 0, 'and it is not reported as a failure');
  } finally {
    if (prevAgents === undefined) delete process.env.AUTONOMY_V2_AGENTS;
    else process.env.AUTONOMY_V2_AGENTS = prevAgents;
    if (prevKey !== undefined) process.env.OPENAI_API_KEY = prevKey;
  }
});

// ─── OAuth/runtime engine: autonomy must run on BOTH OAuths ───
// (owner directive, live date). The SDK engine needs a raw OpenAI key, which
// OAuth-primary installs never have. These tests drive a full cycle through a
// fake brain runtime — the same interface Claude OAuth and Codex OAuth serve —
// and assert the delegated work actually completes with correct attribution.

// The engine routes cycles through respondPreferHarness('cron', …) — the same
// gated path cron jobs use. Stub that harness at its construction/run seams:
// explicit decision-only authority must never rely on the wider break-glass
// legacy assistant fallback.
interface HarnessStubReply {
  text: string;
  stoppedReason?: 'success' | 'pending-approval' | 'error';
}

function fakeHarnessAssistant(responses: HarnessStubReply[]): {
  assistant: unknown;
  prompts: string[];
  authority: Array<string[] | undefined>;
  legacyCalls: () => number;
} {
  const prompts: string[] = [];
  const authority: Array<string[] | undefined> = [];
  let legacyCallCount = 0;
  setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
    buildAgent: (async (options: { allowedToolNames?: string[] }) => {
      authority.push(options.allowedToolNames);
      return {};
    }) as never,
    runConversation: (async (options: { sessionId: string; input: string; buildAgent?: () => Promise<unknown> }) => {
      // Contract mirror: capability resolves during the turn.
      await options.buildAgent?.();
      prompts.push(options.input);
      const response = responses.shift();
      if (!response) throw new Error('unexpected harness conversation call');
      const stoppedReason = response.stoppedReason ?? 'success';
      const lastDecision = {
        summary: response.text,
        reply: response.text,
        done: stoppedReason === 'success',
        nextAction: stoppedReason === 'pending-approval' ? 'awaiting_approval' : 'completed',
        reason: null,
      };
      if (stoppedReason === 'pending-approval') {
        return {
          sessionId: options.sessionId,
          status: 'awaiting_approval',
          steps: 1,
          lastTurn: 1,
          lastDecision,
        };
      }
      if (stoppedReason === 'error') {
        return {
          sessionId: options.sessionId,
          status: 'failed',
          steps: 1,
          lastTurn: 1,
          lastDecision,
          error: response.text,
        };
      }
      return {
        sessionId: options.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision,
      };
    }) as never,
  });
  return {
    prompts,
    authority,
    legacyCalls: () => legacyCallCount,
    assistant: {
      async respond() {
        legacyCallCount += 1;
        throw new Error('explicit decision-only authority must not use legacy assistant.respond');
      },
      getRuntime() {
        return { async run() { throw new Error('runtime.run must not be used — it is the codex-native lane'); } };
      },
    },
  };
}

function seedTeamAgent(slug: string): void {
  const dir = path.join(process.env.CLEMENTINE_HOME!, 'vault', '00-System', 'agents', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'agent.md'), [
    '---',
    `slug: ${slug}`,
    `name: ${slug}`,
    'description: Runtime engine test agent.',
    'canMessage: []',
    'allowedTools: []',
    'tier: 2',
    'autonomyEnabled: true',
    'proactive: true',
    'cadenceMinutes: 30',
    '---',
    `You are ${slug}.`,
  ].join('\n'), 'utf-8');
}

test('RUNTIME ENGINE: a keyless cycle completes delegated work through the brain runtime', async () => {
  const mod = await import('./autonomy-v2.js');
  mod._testOnly_resetAutonomyUnavailableWarning();

  seedTeamAgent('rt-analyst');
  seed('rt-analyst', 'rt1');

  const decision = JSON.stringify({
    summary: 'Claimed and completed the delegated summary task.',
    commitments: ['Watch for follow-up work'],
    actions: [
      { type: 'claim_delegation', delegationId: 'rt1' },
      { type: 'complete_delegation', delegationId: 'rt1', result: 'Risks: freeze writes, backfill, cut over.' },
    ],
  });
  const harness = fakeHarnessAssistant([{ text: decision }]);
  const { assistant, prompts } = harness;

  const prevAgents = process.env.AUTONOMY_V2_AGENTS;
  const prevKey = process.env.OPENAI_API_KEY;
  process.env.AUTONOMY_V2_AGENTS = 'rt-analyst';
  delete process.env.OPENAI_API_KEY;
  try {
    const summary = await mod.processAgentAutonomyV2(assistant as never);
    assert.equal(summary.attempted, 1);
    assert.equal(summary.succeeded, 1, 'the cycle must succeed through the runtime');
    assert.equal(harness.legacyCalls(), 0, 'the harness, not break-glass legacy fallback, serves the cycle');
    assert.deepEqual(harness.authority, [[]], 'the runtime binds decision-only authority at harness construction');
  } finally {
    if (prevAgents === undefined) delete process.env.AUTONOMY_V2_AGENTS;
    else process.env.AUTONOMY_V2_AGENTS = prevAgents;
    if (prevKey !== undefined) process.env.OPENAI_API_KEY = prevKey;
  }

  // The agent saw its delegated work in the cycle input…
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /rt1/, 'the delegation id reaches the cycle prompt');

  // …and the durable record closed with truthful attribution.
  const record = read('rt-analyst', 'rt1');
  assert.equal(record.status, 'completed');
  assert.equal(record.result, 'Risks: freeze writes, backfill, cut over.');
  assert.equal(record.completedBy, 'rt-analyst', 'the agent itself, never a process-global');
});

test('RUNTIME ENGINE: malformed actions are dropped, never guessed at', async () => {
  const mod = await import('./autonomy-v2.js');
  const actions = mod.sanitizeRuntimeCycleActions([
    { type: 'complete_delegation', delegationId: 'x' },            // missing result
    { type: 'claim_delegation' },                                   // missing id
    { type: 'delete_everything', delegationId: 'x' },               // unknown verb
    { type: 'claim_delegation', delegationId: '../builder/secret' }, // path traversal
    { type: 'notify_user', title: 'ok', body: 'fine' },             // valid
    'garbage',
  ]);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'notify_user');
});

test('RUNTIME ENGINE: a prose-only reply fails the cycle instead of inventing actions', async () => {
  const mod = await import('./autonomy-v2.js');
  seedTeamAgent('rt-flake');
  seed('rt-flake', 'rt2');

  const harness = fakeHarnessAssistant([
    { text: 'I looked around and everything seems fine!' },
  ]);
  const { assistant } = harness;
  const prevAgents = process.env.AUTONOMY_V2_AGENTS;
  const prevKey = process.env.OPENAI_API_KEY;
  process.env.AUTONOMY_V2_AGENTS = 'rt-flake';
  delete process.env.OPENAI_API_KEY;
  try {
    const summary = await mod.processAgentAutonomyV2(assistant as never);
    // A bare-prose reply must FAIL the cycle outright: live, a mid-turn
    // recovery narration was accepted as a summary-only decision and scored
    // success while the delegated work sat untouched. Prose is not a decision.
    assert.equal(summary.attempted, 1);
    assert.equal(summary.failed, 1, 'prose-only replies are not successful cycles');
    assert.equal(harness.legacyCalls(), 0);
    assert.deepEqual(harness.authority, [[]], 'the prose-producing turn stays decision-only');
  } finally {
    if (prevAgents === undefined) delete process.env.AUTONOMY_V2_AGENTS;
    else process.env.AUTONOMY_V2_AGENTS = prevAgents;
    if (prevKey !== undefined) process.env.OPENAI_API_KEY = prevKey;
  }
  assert.equal(harness.prompts.length, 1, 'prose is rejected directly instead of being treated as a decision');
  assert.equal(read('rt-flake', 'rt2').status, 'pending', 'no action was invented from prose');
});

test('an out-of-range wake preference is clamped, never voids the decision', async () => {
  const mod = await import('./autonomy-v2.js');
  // Live failure class: a PERFECT decision with followUpMinutes below the
  // schema floor was nulled wholesale, actions included, failing the cycle.
  const d = mod.sanitizeAgentDecisionOutput(JSON.stringify({
    summary: 'Completed the delegated task.',
    commitments: [],
    followUpMinutes: 3,
    actions: [{ type: 'complete_delegation', delegationId: 'x', result: 'done' }],
  }));
  assert.ok(d, 'the decision must survive');
  assert.equal(d.followUpMinutes, 5, 'clamped to the floor, not discarded');
  const high = mod.sanitizeAgentDecisionOutput(JSON.stringify({ summary: 's', commitments: [], followUpMinutes: 99999 }));
  assert.equal(high?.followUpMinutes, 1440, 'clamped to the ceiling');
});

// ─── Validator repairs (owner's second agent, live date) ───

test('HONESTY: a parked/blocked turn is never a successful cycle and consumes nothing', async () => {
  const mod = await import('./autonomy-v2.js');
  seedTeamAgent('rt-parked');
  seed('rt-parked', 'rp1');

  const harness = fakeHarnessAssistant([{
    text: 'I need approval before continuing.',
    stoppedReason: 'pending-approval',
  }]);
  const { assistant } = harness;

  const prevAgents = process.env.AUTONOMY_V2_AGENTS;
  const prevKey = process.env.OPENAI_API_KEY;
  process.env.AUTONOMY_V2_AGENTS = 'rt-parked';
  delete process.env.OPENAI_API_KEY;
  try {
    const summary = await mod.processAgentAutonomyV2(assistant as never);
    assert.equal(summary.succeeded, 0, 'a parked turn must not count as success');
    assert.equal(summary.failed, 1, 'it is recorded truthfully as not-completed');
    assert.equal(harness.legacyCalls(), 0);
    assert.deepEqual(harness.authority, [[]]);
  } finally {
    if (prevAgents === undefined) delete process.env.AUTONOMY_V2_AGENTS;
    else process.env.AUTONOMY_V2_AGENTS = prevAgents;
    if (prevKey !== undefined) process.env.OPENAI_API_KEY = prevKey;
  }
  assert.equal(read('rt-parked', 'rp1').status, 'pending', 'the delegation is untouched for retry');
});

test('HONESTY: an error turn is not a successful cycle', async () => {
  const mod = await import('./autonomy-v2.js');
  seedTeamAgent('rt-err');
  seed('rt-err', 're1');
  const harness = fakeHarnessAssistant([{
    text: 'runtime exploded',
    stoppedReason: 'error',
  }]);
  const { assistant } = harness;
  const prevAgents = process.env.AUTONOMY_V2_AGENTS;
  process.env.AUTONOMY_V2_AGENTS = 'rt-err';
  try {
    const summary = await mod.processAgentAutonomyV2(assistant as never);
    assert.equal(summary.succeeded, 0);
    assert.equal(summary.failed, 1);
    assert.equal(harness.legacyCalls(), 0);
    assert.deepEqual(harness.authority, [[]]);
  } finally {
    if (prevAgents === undefined) delete process.env.AUTONOMY_V2_AGENTS;
    else process.env.AUTONOMY_V2_AGENTS = prevAgents;
  }
  assert.equal(read('rt-err', 're1').status, 'pending');
});

test('PROVENANCE: a completed delegation says its result is model prose', async () => {
  const mod = await import('./agent-delegations.js');
  seed('rt-prov', 'pv1');
  mod.completeDelegationFor('rt-prov', 'pv1', 'Three risks: a, b, c');
  const record = read('rt-prov', 'pv1');
  assert.equal(record.resultEvidence, 'model_prose', 'the record never implies independent verification');
});

test('WAKE: open delegated work wakes the agent, paced by backoff', async () => {
  const mod = await import('./autonomy-v2.js');
  seedTeamAgent('rt-wake');
  seed('rt-wake', 'w9');

  // Cadence NOT due (fresh lastRunAt) — only the delegation can wake it.
  const stateDir = path.join(process.env.CLEMENTINE_HOME!, 'agents-state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, 'rt-wake.json'), JSON.stringify({
    slug: 'rt-wake', engine: 'v2', lastRunAt: new Date().toISOString(),
  }), 'utf-8');

  const decision = JSON.stringify({
    summary: 'Completed delegated work on delegation wake.',
    commitments: [],
    actions: [{ type: 'complete_delegation', delegationId: 'w9', result: 'Done: a, b, c.' }],
  });
  const harness = fakeHarnessAssistant([{ text: decision }]);
  const { assistant } = harness;

  const prevAgents = process.env.AUTONOMY_V2_AGENTS;
  process.env.AUTONOMY_V2_AGENTS = 'rt-wake';
  try {
    const summary = await mod.processAgentAutonomyV2(assistant as never);
    assert.equal(summary.succeeded, 1, 'the delegation itself must wake the agent');
    assert.equal(harness.legacyCalls(), 0);
    assert.deepEqual(harness.authority, [[]]);
  } finally {
    if (prevAgents === undefined) delete process.env.AUTONOMY_V2_AGENTS;
    else process.env.AUTONOMY_V2_AGENTS = prevAgents;
  }
  assert.equal(read('rt-wake', 'w9').status, 'completed');

  // And with a future nextWakeAt (failure backoff), the same state SKIPS.
  seed('rt-wake', 'w10');
  writeFileSync(path.join(stateDir, 'rt-wake.json'), JSON.stringify({
    slug: 'rt-wake', engine: 'v2', lastRunAt: new Date().toISOString(),
    nextWakeAt: new Date(Date.now() + 60_000).toISOString(),
  }), 'utf-8');
  process.env.AUTONOMY_V2_AGENTS = 'rt-wake';
  try {
    const summary2 = await mod.processAgentAutonomyV2(assistant as never);
    assert.equal(summary2.skipped, 1, 'backoff paces the delegation wake');
  } finally {
    if (prevAgents === undefined) delete process.env.AUTONOMY_V2_AGENTS;
    else process.env.AUTONOMY_V2_AGENTS = prevAgents;
  }
  assert.equal(read('rt-wake', 'w10').status, 'pending');
});
