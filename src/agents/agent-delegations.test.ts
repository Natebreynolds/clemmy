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
import { test, before, beforeEach } from 'node:test';
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
});

beforeEach(() => {
  rmSync(DELEGATIONS(), { recursive: true, force: true });
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
