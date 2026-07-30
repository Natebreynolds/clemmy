/**
 * Run: npx tsx --test src/agents/autonomy-v2-cycle-stagger.test.ts
 *
 * END-TO-END pin: at most ONE real autonomy cycle fires per daemon tick on
 * the runtime engine (the shipped OAuth default).
 *
 * Same family as the v3.0.1 catch-up stampede: after downtime EVERY opted-in
 * agent's cadence is due in the same tick, and the runtime path awaits each
 * cycle sequentially inside one daemon phase — N full brain turns back to
 * back, starving workflow scheduling, briefs, and the watchdog for their sum.
 * Holding is free by construction here: a held agent stamps nothing, stays
 * due, and fires on the next ~15s tick — a non-event against a 30-minute
 * cadence. This suite drives processAgentAutonomyV2 itself with a stub brain
 * and asserts the drain is one agent per call, nobody lost, nobody repeated
 * inside a single pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-autonomy-stagger-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
process.env.AUTONOMY_V2_AGENTS = 'stag-alpha,stag-beta,stag-gamma';

const { processAgentAutonomyV2, _testOnly_setRuntimeCycleImpl } = await import('./autonomy-v2.js');
const { AGENTS_DIR } = await import('../tools/shared.js');

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

/** Stub cycle (injected via the test seam — the real cycle hard-requires live
 *  brain auth): mirrors the real due/stamp contract. An agent not yet run is
 *  DUE and returns a runId; once run it is inside its cadence window and
 *  no-ops with runId '' — exactly what runAgentCycleViaRuntime does. */
const turnsByCall: string[] = [];
const ranOnce = new Set<string>();
_testOnly_setRuntimeCycleImpl(async (_assistant, record) => {
  if (ranOnce.has(record.slug)) return { runId: '', success: true, outcomes: [] };
  ranOnce.add(record.slug);
  turnsByCall.push(record.slug);
  return { runId: `run-${record.slug}`, success: true, outcomes: [] };
});
const stubAssistant = {} as never;

test('all agents due at once (post-downtime shape) drain ONE per tick, none lost, none repeated', async () => {
  for (const slug of ['stag-alpha', 'stag-beta', 'stag-gamma']) seedAgent(slug);

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
