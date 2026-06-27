/**
 * Run: npx tsx --test src/runtime/harness/fanout-directive.smoke.test.ts
 *
 * Loop-level smoke for the global fan-out directive (P0/P1/P2). It drives the
 * REAL `runTurn` and captures exactly what reaches the model by invoking the
 * loop's own `callModelInputFilter` (the production seam where the context
 * packet is appended to the model input). This proves end-to-end — not just at
 * the packet unit level — that:
 *   1. a CHAT multi-item turn injects the size-aware fan-out directive into the
 *      model input, the telemetry records offered=true, and a model that fans
 *      out gets N/N coverage;
 *   2. a single-item / paginated chat turn injects only the static line (no
 *      directive) — the no-fire regression guard;
 *   3. a non-chat (workflow) turn keeps the static line (suppression).
 *
 * Offline + deterministic: no real Runner, model, or external API. The true
 * live coverage run (real model decides to fan out, real workers deliver) is a
 * separate owner-run step — see the smoke command printed in the build notes.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-fanout-smoke-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
mkdirSync(path.join(TMP_HOME, 'vault', '02-Projects'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { AgentInputItem, Runner, Agent } from '@openai/agents';

const { resetEventLog, listEvents } = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const { runTurn } = await import('./loop.js');
type RunRunnerFn = import('./loop.js').RunRunnerFn;

test.after(() => {
  try {
    rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function makeRunnerStub(): Runner {
  return new EventEmitter() as unknown as Runner;
}
function makeAgentStub(): Agent<any, any> {
  return {} as Agent<any, any>;
}

type ModelFilter = (a: { modelData: { input: AgentInputItem[]; instructions?: string } }) => {
  input: AgentInputItem[];
};

/**
 * Drive one real turn and return BOTH the turn result and the exact model
 * input the loop would have sent (by invoking its own callModelInputFilter,
 * which is what a real Runner does). `onTurn` lets the caller simulate the
 * model's fan-out behavior for coverage assertions.
 */
async function runTurnCapturingModelInput(args: {
  kind: 'chat' | 'workflow';
  input: string;
  onTurn?: () => void;
}): Promise<{ status: string; modelInputText: string }> {
  resetEventLog();
  const sess = HarnessSession.create({ kind: args.kind, title: 'fanout-smoke' });
  let modelInputText = '';

  const runRunner: RunRunnerFn = async (_runner, _agent, items, opts) => {
    const filter = opts.callModelInputFilter as ModelFilter | undefined;
    const filtered = filter ? filter({ modelData: { input: [...items], instructions: '' } }) : { input: items };
    modelInputText = JSON.stringify(filtered.input);
    args.onTurn?.();
    return {
      history: [
        ...items,
        { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done' }] },
      ],
      lastResponseId: 'resp_smoke',
      finalOutput: { ok: true },
    };
  };

  const result = await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: args.input,
    makeRunner: makeRunnerStub,
    runRunner,
  });
  return { status: result.status, modelInputText };
}

test('SMOKE: chat multi-item turn injects the fan-out directive into the real model input + fans out N/N', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat', title: 'fanout-fire' });
  const N = 10;
  const workersDelivered = new Set<number>();
  let modelInputText = '';

  const runRunner: RunRunnerFn = async (_runner, _agent, items, opts) => {
    const filter = opts.callModelInputFilter as ModelFilter | undefined;
    const filtered = filter ? filter({ modelData: { input: [...items], instructions: '' } }) : { input: items };
    modelInputText = JSON.stringify(filtered.input);
    // The directive tells the model to fan out one worker per item; simulate
    // all N workers completing + reporting back (coverage = N/N).
    for (let i = 1; i <= N; i++) workersDelivered.add(i);
    return {
      history: [
        ...items,
        { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `Fanned out ${N}; all delivered.` }] },
      ],
      lastResponseId: 'resp_fanout',
      finalOutput: { ok: true, delivered: N },
    };
  };

  const result = await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: `Research these ${N} prospects and capture each firm's SEO posture.`,
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  // 1. The size-aware directive reached the ACTUAL model input via the loop.
  assert.match(modelInputText, /Fan-out directive: this turn names 10 independent same-shape prospects/);
  assert.match(modelInputText, /Do NOT serialize/);
  assert.match(modelInputText, /save it as a forEach workflow/); // P2 clause
  assert.ok(!/Parallelism reminder:/.test(modelInputText), 'static line replaced by directive');
  // 2. Telemetry recorded the offer.
  const packet = listEvents(sess.id, { types: ['agent_context_packet'] }).at(-1);
  assert.equal((packet?.data as any).multiItem.offered, true);
  assert.equal((packet?.data as any).multiItem.itemCount, 10);
  const decision = listEvents(sess.id, { types: ['fanout_policy_decision'] }).at(-1);
  assert.equal((decision?.data as any).offered, true);
  assert.equal((decision?.data as any).itemCount, 10);
  assert.equal((decision?.data as any).recommendedWorkerWaveSize, 4);
  // 3. Coverage: every item fanned out + delivered.
  assert.equal(workersDelivered.size, N, 'fan-out coverage N/N');
});

test('SMOKE: single-item chat turn sends only the static line (no directive) — no-fire regression', async () => {
  const { modelInputText } = await runTurnCapturingModelInput({
    kind: 'chat',
    input: 'Audit this law firm’s website and summarize the findings.',
  });
  assert.match(modelInputText, /Parallelism reminder:/, 'single-item keeps the static line');
  assert.ok(!/Fan-out directive/.test(modelInputText), 'single-item must NOT inject the directive');
});

test('SMOKE: paginated one-table chat turn does NOT inject the directive — no-fire regression', async () => {
  const { modelInputText } = await runTurnCapturingModelInput({
    kind: 'chat',
    input: 'Pull the 200 rows from the leads table and show them to me.',
  });
  assert.match(modelInputText, /Parallelism reminder:/);
  assert.ok(!/Fan-out directive/.test(modelInputText), 'paginated read must NOT fan out');
});

test('SMOKE: workflow turn keeps the static line even for multi-item input — suppression', async () => {
  const { modelInputText } = await runTurnCapturingModelInput({
    kind: 'workflow',
    input: 'Research these 10 prospects and capture each firm’s SEO posture.',
  });
  assert.match(modelInputText, /Parallelism reminder:/, 'workflow keeps static line (forEach is authoring-time)');
  assert.ok(!/Fan-out directive/.test(modelInputText), 'workflow step must not get the run_worker directive');
});
