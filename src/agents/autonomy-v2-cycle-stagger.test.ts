/**
 * Run: npx tsx --test src/agents/autonomy-v2-cycle-stagger.test.ts
 *
 * END-TO-END pins: at most ONE real autonomy cycle fires per daemon tick on
 * either engine, and admission rotates after each fired cycle.
 *
 * Same family as the v3.0.1 catch-up stampede: after downtime EVERY opted-in
 * agent's cadence is due in the same tick, and the runtime path awaits each
 * cycle inside one daemon phase — N full brain turns starve workflow
 * scheduling, briefs, and the watchdog for their sum. Always starting with the
 * alphabetically first due agent has the opposite failure: one persistent
 * inbox/provider failure can starve every later agent forever. Holding is free
 * by construction here: a held agent stamps nothing, stays due, and fires on
 * the next ~15s tick — a non-event against a 30-minute cadence.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-autonomy-stagger-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
const {
  processAgentAutonomyV2,
  _testOnly_autonomyAbortSettlementGraceMs,
  _testOnly_buildCycleFailureState,
  _testOnly_isInboxWakeDue,
  _testOnly_resetAutonomyAdmissionCursor,
  _testOnly_setAutonomyCoordinatorNow,
  _testOnly_setRuntimeCycleImpl,
  _testOnly_setSdkAgentBuilder,
  _testOnly_setSdkCycleImpl,
  _testOnly_waitForAutonomyLaneIdle,
} = await import('./autonomy-v2.js');
const { AGENT_INBOX_DIR, AGENT_STATE_DIR, AGENTS_DIR } = await import('../tools/shared.js');

function seedAgent(slug: string): void {
  mkdirSync(path.join(AGENTS_DIR, slug), { recursive: true });
  writeFileSync(path.join(AGENTS_DIR, slug, 'agent.md'), [
    '---',
    `name: ${slug}`,
    'description: stagger pin agent',
    'role: specialist',
    '---',
    '',
    'Test agent.',
  ].join('\n'), 'utf-8');
}

afterEach(() => {
  _testOnly_setRuntimeCycleImpl();
  _testOnly_setSdkAgentBuilder();
  _testOnly_setSdkCycleImpl();
  _testOnly_setAutonomyCoordinatorNow();
  _testOnly_resetAutonomyAdmissionCursor();
});
const stubAssistant = {} as never;

test('all agents due at once (post-downtime shape) drain ONE per tick, none lost, none repeated', async () => {
  const slugs = ['stag-alpha', 'stag-beta', 'stag-gamma'];
  for (const slug of slugs) seedAgent(slug);
  process.env.AUTONOMY_V2_AGENTS = slugs.join(',');

  /** Mirrors the real due/stamp contract: after a real turn the agent no-ops
   *  until its next cadence. No-op scans must not consume the tick budget. */
  const turnsByCall: string[] = [];
  const ranOnce = new Set<string>();
  _testOnly_setRuntimeCycleImpl(async (_assistant, record) => {
    if (ranOnce.has(record.slug)) return { runId: '', success: true, outcomes: [] };
    ranOnce.add(record.slug);
    turnsByCall.push(record.slug);
    return { runId: `run-${record.slug}`, success: true, outcomes: [] };
  });

  const firedPerTick: string[][] = [];
  for (let tick = 0; tick < 5 && new Set(firedPerTick.flat()).size < 3; tick++) {
    const before = turnsByCall.length;
    await processAgentAutonomyV2(stubAssistant);
    const fired = [...new Set(turnsByCall.slice(before))];
    firedPerTick.push(fired);
    assert.ok(fired.length <= 1,
      `at most one agent's cycle per tick — got ${JSON.stringify(fired)} on tick ${tick}`);
  }

  const allFired = new Set(firedPerTick.flat());
  assert.deepEqual([...allFired].sort(), ['stag-alpha', 'stag-beta', 'stag-gamma'],
    'every due agent still gets its cycle — held means NEXT TICK, never dropped');

  // Drained: with every cadence freshly stamped, the next pass fires nothing.
  const before = turnsByCall.length;
  await processAgentAutonomyV2(stubAssistant);
  assert.equal(turnsByCall.length, before, 'no agent re-fires inside its cadence window');
});

test('a persistently failing first agent cannot starve later due agents', async () => {
  const slugs = ['fair-alpha', 'fair-beta', 'fair-gamma'];
  for (const slug of slugs) seedAgent(slug);
  process.env.AUTONOMY_V2_AGENTS = slugs.join(',');

  // This models a first agent whose pending inbox remains due because every
  // provider turn fails. The seam intentionally keeps every agent due so this
  // test isolates fair admission from the wake/backoff calculation below.
  const turns: string[] = [];
  _testOnly_setRuntimeCycleImpl(async (_assistant, record) => {
    turns.push(record.slug);
    if (record.slug === 'fair-alpha') {
      return { runId: `failed-${turns.length}`, success: false, outcomes: [], error: 'provider unavailable' };
    }
    return { runId: `run-${record.slug}-${turns.length}`, success: true, outcomes: [] };
  });

  const summaries = [];
  for (let tick = 0; tick < 4; tick++) {
    const before = turns.length;
    summaries.push(await processAgentAutonomyV2(stubAssistant));
    assert.equal(turns.length - before, 1, `tick ${tick} admitted exactly one real brain cycle`);
  }

  assert.deepEqual(
    turns,
    ['fair-alpha', 'fair-beta', 'fair-gamma', 'fair-alpha'],
    'admission resumes after the last fired agent instead of restarting at the first record',
  );
  assert.equal(summaries[0].failed, 1);
  assert.equal(summaries[1].succeeded, 1);
  assert.equal(summaries[2].succeeded, 1);
});

test('a timed-out turn holds the global lane until its provider promise settles', async () => {
  const slugs = ['overlap-alpha', 'overlap-beta'];
  for (const slug of slugs) seedAgent(slug);
  process.env.AUTONOMY_V2_AGENTS = slugs.join(',');

  const turns: string[] = [];
  let releaseFirst: (() => void) | undefined;
  _testOnly_setRuntimeCycleImpl(async (_assistant, record) => {
    turns.push(record.slug);
    if (record.slug === 'overlap-alpha') {
      return await new Promise<never>((_resolve, reject) => {
        // Deliberately ignore the AbortSignal: providers can take time to
        // observe cancellation after the caller's wait budget expires.
        releaseFirst = () => reject(new Error('test cleanup: provider turn settled'));
      });
    }
    return { runId: `run-${record.slug}`, success: true, outcomes: [] };
  });

  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
    realSetTimeout(callback, (delay ?? 0) >= 60_000 ? 1 : delay, ...args)) as typeof setTimeout;

  try {
    const first = await processAgentAutonomyV2(stubAssistant);
    assert.equal(first.failed, 1, 'the caller wait budget expires');

    const second = await processAgentAutonomyV2(stubAssistant);
    assert.equal(second.skipped, 1, 'the next tick holds while any prior autonomy turn is physically active');
    assert.deepEqual(turns, ['overlap-alpha'], 'a different agent cannot overlap the timed-out provider turn');
  } finally {
    globalThis.setTimeout = realSetTimeout;
    releaseFirst?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  const resumed = await processAgentAutonomyV2(stubAssistant);
  assert.equal(resumed.succeeded, 1);
  assert.deepEqual(turns, ['overlap-alpha', 'overlap-beta'], 'round-robin service resumes after physical settlement');
});

test('a provider that ignores abort cannot freeze unrelated autonomy agents forever', async () => {
  const slugs = ['wedged-alpha', 'wedged-beta'];
  for (const slug of slugs) seedAgent(slug);
  process.env.AUTONOMY_V2_AGENTS = slugs.join(',');

  let coordinatorNow = Date.now();
  _testOnly_setAutonomyCoordinatorNow(() => coordinatorNow);
  const turns: string[] = [];
  let releaseWedged: (() => void) | undefined;
  _testOnly_setRuntimeCycleImpl(async (_assistant, record) => {
    turns.push(record.slug);
    if (record.slug === 'wedged-alpha') {
      return await new Promise<never>((_resolve, reject) => {
        releaseWedged = () => reject(new Error('test cleanup: wedged provider finally settled'));
      });
    }
    return { runId: `run-${record.slug}`, success: true, outcomes: [] };
  });

  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
    realSetTimeout(callback, (delay ?? 0) >= 60_000 ? 1 : delay, ...args)) as typeof setTimeout;

  try {
    const first = await processAgentAutonomyV2(stubAssistant);
    assert.equal(first.failed, 1, 'the wedged provider exhausts the caller wait budget');

    const duringGrace = await processAgentAutonomyV2(stubAssistant);
    assert.equal(duringGrace.skipped, 1, 'cancellation gets a bounded physical-settlement grace');
    assert.deepEqual(turns, ['wedged-alpha'], 'no other heavy turn overlaps during grace');

    coordinatorNow += _testOnly_autonomyAbortSettlementGraceMs + 1;
    const afterGrace = await processAgentAutonomyV2(stubAssistant);
    assert.equal(afterGrace.succeeded, 1, 'unrelated agents resume after cancellation grace expires');
    assert.deepEqual(
      turns,
      ['wedged-alpha', 'wedged-beta'],
      'the wedged slug stays single-flight while the next agent remains live',
    );
  } finally {
    globalThis.setTimeout = realSetTimeout;
    releaseWedged?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
});

test('two providers that ignore abort open a bounded circuit instead of accumulating zombie turns', async () => {
  const slugs = ['circuit-alpha', 'circuit-beta', 'circuit-gamma'];
  for (const slug of slugs) seedAgent(slug);
  process.env.AUTONOMY_V2_AGENTS = slugs.join(',');

  let coordinatorNow = Date.now();
  _testOnly_setAutonomyCoordinatorNow(() => coordinatorNow);
  const turns: string[] = [];
  const release: Array<() => void> = [];
  _testOnly_setRuntimeCycleImpl(async (_assistant, record) => {
    turns.push(record.slug);
    if (record.slug !== 'circuit-gamma') {
      return await new Promise<never>((_resolve, reject) => {
        release.push(() => reject(new Error(`test cleanup: ${record.slug} settled`)));
      });
    }
    return { runId: `run-${record.slug}`, success: true, outcomes: [] };
  });

  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
    realSetTimeout(callback, (delay ?? 0) >= 60_000 ? 1 : delay, ...args)) as typeof setTimeout;

  try {
    assert.equal((await processAgentAutonomyV2(stubAssistant)).failed, 1);
    coordinatorNow += _testOnly_autonomyAbortSettlementGraceMs + 1;
    assert.equal((await processAgentAutonomyV2(stubAssistant)).failed, 1);
    coordinatorNow += _testOnly_autonomyAbortSettlementGraceMs + 1;

    const circuitOpen = await processAgentAutonomyV2(stubAssistant);
    assert.equal(circuitOpen.skipped, 1);
    assert.deepEqual(
      turns,
      ['circuit-alpha', 'circuit-beta'],
      'a third provider turn is not admitted while two physical calls remain wedged',
    );

    release.shift()?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const recovered = await processAgentAutonomyV2(stubAssistant);
    assert.equal(recovered.succeeded, 1, 'one physical settlement closes the two-zombie circuit');
    assert.deepEqual(
      turns,
      ['circuit-alpha', 'circuit-beta', 'circuit-gamma'],
      'healthy round-robin work resumes as soon as the bounded circuit has capacity',
    );
  } finally {
    globalThis.setTimeout = realSetTimeout;
    for (const settle of release) settle();
    await _testOnly_waitForAutonomyLaneIdle();
  }
});

test('failure backoff paces inbox wakes without delaying urgent inbox after success', () => {
  const now = Date.now();
  const future = new Date(now + 90_000).toISOString();
  const past = new Date(now - 1).toISOString();
  const failedState = _testOnly_buildCycleFailureState(
    {},
    'inbox-backoff',
    'provider unavailable',
    now,
    ['failed-item'],
  );

  assert.equal(
    _testOnly_isInboxWakeDue(
      ['failed-item'],
      { ...failedState, nextWakeAt: future },
      now,
    ),
    false,
    'a pending inbox must not bypass the retry time recorded by a failed cycle',
  );
  assert.equal(
    _testOnly_isInboxWakeDue(
      ['failed-item'],
      { ...failedState, nextWakeAt: past },
      now,
    ),
    true,
    'the same pending inbox wakes as soon as failure backoff expires',
  );
  assert.equal(
    _testOnly_isInboxWakeDue(['new-item'], { nextWakeAt: future }, now),
    true,
    'a successful cycle follow-up schedule does not suppress newly arrived inbox work',
  );
  assert.equal(
    _testOnly_isInboxWakeDue(
      ['failed-item', 'urgent-new-item'],
      { ...failedState, nextWakeAt: future },
      now,
    ),
    true,
    'a new request bypasses backoff that belongs only to an older failed inbox set',
  );
  assert.equal(_testOnly_isInboxWakeDue([], {}, now), false);
});

test('SDK preflight failure durably paces the failed inbox but a new request still wakes', async () => {
  const slug = 'sdk-preflight-backoff';
  seedAgent(slug);
  process.env.AUTONOMY_V2_AGENTS = slug;
  mkdirSync(AGENT_INBOX_DIR, { recursive: true });
  const inboxPath = path.join(AGENT_INBOX_DIR, `${slug}.json`);
  const statePath = path.join(AGENT_STATE_DIR, `${slug}.json`);
  const createdAt = new Date().toISOString();
  const writePendingInbox = (ids: string[]): void => {
    writeFileSync(inboxPath, JSON.stringify(ids.map((id) => ({
      id,
      type: 'request',
      createdAt,
      status: 'pending',
      content: `Work item ${id}`,
    })), null, 2), 'utf-8');
  };
  writePendingInbox(['original-request']);

  let buildAttempts = 0;
  _testOnly_setSdkAgentBuilder(async () => {
    buildAttempts += 1;
    throw new Error('model construction unavailable');
  });

  const failed = await processAgentAutonomyV2();
  assert.equal(failed.failed, 1, 'a due preflight rejection is a failed observable cycle');
  assert.equal(buildAttempts, 1);
  const firstState = JSON.parse(readFileSync(statePath, 'utf-8')) as {
    lastError?: string;
    nextWakeAt?: string;
    failedInboxFingerprint?: string;
  };
  assert.match(firstState.lastError ?? '', /model construction unavailable/);
  assert.ok(Date.parse(firstState.nextWakeAt ?? '') > Date.now(), 'preflight failure persists retry pacing');
  assert.ok(firstState.failedInboxFingerprint, 'the exact pending inbox set owns that backoff');

  const held = await processAgentAutonomyV2();
  assert.equal(held.skipped, 1, 'the unchanged failed inbox remains inside its backoff window');
  assert.equal(buildAttempts, 1, 'unchanged failed work does not rebuild the model every daemon tick');

  writePendingInbox(['original-request', 'urgent-new-request']);
  const urgent = await processAgentAutonomyV2();
  assert.equal(urgent.failed, 1, 'a newly arrived request bypasses the older inbox fingerprint');
  assert.equal(buildAttempts, 2, 'production SDK setup is attempted immediately for the changed inbox');
  const secondState = JSON.parse(readFileSync(statePath, 'utf-8')) as {
    failedInboxFingerprint?: string;
  };
  assert.notEqual(
    secondState.failedInboxFingerprint,
    firstState.failedInboxFingerprint,
    'the next failure takes ownership of the new complete pending set',
  );
});

test('OpenAI SDK fallback uses the same one-cycle round-robin policy without live auth', async () => {
  const slugs = ['sdk-alpha', 'sdk-beta', 'sdk-gamma'];
  for (const slug of slugs) seedAgent(slug);
  process.env.AUTONOMY_V2_AGENTS = slugs.join(',');

  const turns: string[] = [];
  _testOnly_setSdkCycleImpl(async (record) => {
    turns.push(record.slug);
    return { runId: `sdk-${record.slug}-${turns.length}`, success: true, outcomes: [] };
  });

  for (let tick = 0; tick < 3; tick++) {
    const before = turns.length;
    const summary = await processAgentAutonomyV2();
    assert.equal(turns.length - before, 1, `SDK tick ${tick} admitted exactly one cycle`);
    assert.equal(summary.succeeded, 1);
  }

  assert.deepEqual(
    turns,
    ['sdk-alpha', 'sdk-beta', 'sdk-gamma'],
    'the SDK fallback rotates fairly instead of starting every opted-in agent with Promise.all',
  );
});
