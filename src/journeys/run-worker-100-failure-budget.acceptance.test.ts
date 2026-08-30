/**
 * Completes the 100-item worker release contract with two governing variants:
 * partial failure and deadline exhaustion. Both recover in another OS process
 * and execute only unfinished items.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/journeys/run-worker-100-failure-budget.acceptance.test.ts
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { after, test } from 'node:test';
import os from 'node:os';
import path from 'node:path';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-run-worker-100-failure-budget-'));
const ITEM_COUNT = 100;
const WIDTH = 6;
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.AUTH_MODE = 'claude_oauth';
process.env.CLEMMY_MODEL_ROLES_REGISTRY = 'on';
process.env.CLEMMY_MODEL_ROLES = JSON.stringify([{
  role: 'worker', modelId: 'claude-sonnet-4-6', scope: 'durable', source: 'generated-worker-gate',
}]);
process.env.CLEMMY_WORKER_MAX_CONCURRENCY = String(WIDTH);
process.env.CLEMMY_WORKER_MAX_CONCURRENCY_GLOBAL = String(WIDTH);
process.env.CLEMMY_REDUCE_TIER = 'off';
process.env.CLEMMY_CHAT_FANOUT_DIGEST = 'off';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-run-worker-100-failure-budget\n', 'utf8');

const { registerWorkerTools } = await import('../tools/worker-tools.js');
const { setClaudeAgentSdkWorkerRunForTest } = await import('../runtime/harness/claude-agent-worker.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const { ToolCallsCounter, withHarnessRunContext } = await import('../runtime/harness/brackets.js');
const { summarizeWorkManifest } = await import('../runtime/harness/work-manifest.js');
const { runWithToolAbortSignal } = await import('../runtime/tool-abort-context.js');
const { _resetWorkerConcurrencyForTest } = await import('../agents/worker-concurrency.js');
const {
  _resetWorkerBatchExecutionsForTest,
  _setWorkerBatchRuntimeForTest,
} = await import('../agents/worker-batch-execution.js');

type ToolResult = { content: Array<{ type: 'text'; text: string }> };
let runWorker: ((input: unknown) => Promise<ToolResult>) | undefined;
registerWorkerTools({
  tool(name: string, _description: string, _schema: unknown, handler: (input: unknown) => Promise<ToolResult>) {
    if (name === 'run_worker') runWorker = handler;
  },
} as never);
assert.ok(runWorker);

after(() => {
  setClaudeAgentSdkWorkerRunForTest(null);
  _resetWorkerBatchExecutionsForTest();
  _resetWorkerConcurrencyForTest();
  eventlog.closeEventLog();
  rmSync(HOME, { recursive: true, force: true });
});

function itemsFor(label: string): string[] {
  return Array.from({ length: ITEM_COUNT }, (_, index) =>
    `${label}-${String(index + 1).padStart(3, '0')}`);
}

function packetFromPrompt(prompt: string): Record<string, unknown> {
  const marker = '\nPacket JSON:\n';
  const offset = prompt.lastIndexOf(marker);
  assert.ok(offset >= 0, 'worker received the canonical packet');
  return JSON.parse(prompt.slice(offset + marker.length)) as Record<string, unknown>;
}

function manifestCall(input: {
  objective: string;
  items: string[];
  manifestId: string;
  mode: 'declare' | 'reconcile';
}) {
  return {
    objective: input.objective,
    item: null,
    items: input.items,
    resolvedTools: 'none needed',
    externalMcpToolNames: null,
    context: 'Each generated item is a complete closed fixture input.',
    instructions: input.mode === 'declare'
      ? 'Return one exact item result; failures must begin with ERROR:.'
      : 'Reuse settled evidence and execute only unfinished items.',
    expectedOutput: 'OK::<exact item id>, or ERROR: <reason>.',
    intent: null,
    model: null,
    workManifest: {
      id: input.manifestId,
      contractVersion: '1',
      phase: 'analyze',
      mode: input.mode,
      phases: [{ id: 'analyze', label: 'generated item analysis', dependsOn: null }],
      aliases: null,
    },
    expectedWork: null,
  };
}

function acceptedSource(sessionId: string, text: string): number {
  eventlog.createSession({ id: sessionId, kind: 'chat' });
  return eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  }).seq;
}

async function invoke(input: {
  sessionId: string;
  sourceUserSeq: number;
  callId: string;
  call: ReturnType<typeof manifestCall>;
  signal?: AbortSignal;
  deadlineAt?: number;
}): Promise<string> {
  const run = () => withHarnessRunContext({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    counter: new ToolCallsCounter(2_000),
    behaviorScopeId: `${input.sessionId}::${input.callId}`,
  }, () => withToolOutputContext({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    callId: input.callId,
    toolName: 'run_worker',
  }, () => runWorker!(input.call)));
  const result = input.signal
    ? await runWithToolAbortSignal(input.signal, run, input.deadlineAt)
    : await run();
  return result.content[0]?.text ?? '';
}

function phaseCounts(sessionId: string, manifestId: string): { succeeded: number; failed: number } {
  const manifest = summarizeWorkManifest(sessionId, manifestId);
  return {
    succeeded: manifest?.items.filter((item) => item.phases.analyze?.status === 'succeeded').length ?? 0,
    failed: manifest?.items.filter((item) => item.phases.analyze?.status === 'failed').length ?? 0,
  };
}

function resumeInFreshProcess(input: {
  sessionId: string;
  sourceUserSeq: number;
  callId: string;
  objective: string;
  items: string[];
  manifestId: string;
}): {
  pid: number;
  crossings: number;
  crossedItems: string[];
  complete: boolean;
  reused: boolean;
  succeeded: number;
  failed: number;
} {
  eventlog.closeEventLog();
  const fixture = path.join(import.meta.dirname, 'run-worker-100-restart.fixture.ts');
  const child = spawnSync(process.execPath, ['--import', 'tsx', fixture], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: {
      ...process.env,
      CLEMENTINE_HOME: HOME,
      CLEMMY_TEST_ISOLATED_HOME: '1',
      CLEM_RUN_WORKER_100_RESTART_INPUT: Buffer.from(JSON.stringify({
        ...input,
        contractVersion: '1',
        phase: 'analyze',
      }), 'utf8').toString('base64url'),
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  const line = child.stdout.trim().split('\n').findLast((candidate) => candidate.startsWith('{'));
  assert.ok(line, child.stdout);
  return JSON.parse(line) as ReturnType<typeof resumeInFreshProcess>;
}

test('100-item partial failure names every failed item and a new process retries only those seven', async () => {
  eventlog.resetEventLog();
  _resetWorkerBatchExecutionsForTest();
  _resetWorkerConcurrencyForTest();
  const sessionId = 'worker-100-partial-failure';
  const sourceUserSeq = acceptedSource(sessionId, 'Analyze exactly one hundred generated items and report partial failures honestly.');
  const items = itemsFor('partial');
  const failedItems = new Set(items.filter((_item, index) => index % 15 === 0).slice(0, 7));
  const attempts = new Map<string, number>();
  setClaudeAgentSdkWorkerRunForTest(async (options) => {
    const item = String(packetFromPrompt(String((options as { prompt?: unknown }).prompt ?? '')).item ?? '');
    attempts.set(item, (attempts.get(item) ?? 0) + 1);
    return failedItems.has(item)
      ? { text: `ERROR: generated failure for ${item}`, toolUses: [] }
      : { text: `OK::${item}`, toolUses: [] };
  });
  const objective = 'Analyze each generated item independently and preserve exact per-item completion truth.';
  const manifestId = 'worker-100-partial-manifest';
  const first = await invoke({
    sessionId,
    sourceUserSeq,
    callId: 'partial-first',
    call: manifestCall({ objective, items, manifestId, mode: 'declare' }),
  });
  assert.match(first, /Batch finished with FAILURES: 93\/100 succeeded/);
  for (const item of failedItems) assert.match(first, new RegExp(item));
  assert.equal(attempts.size, ITEM_COUNT);
  assert.deepEqual(phaseCounts(sessionId, manifestId), { succeeded: 93, failed: 7 });

  const resumed = resumeInFreshProcess({
    sessionId,
    sourceUserSeq,
    callId: 'partial-restart',
    objective,
    items,
    manifestId,
  });
  assert.notEqual(resumed.pid, process.pid);
  assert.equal(resumed.crossings, 7, 'the restart executes only the seven failed items');
  assert.deepEqual(new Set(resumed.crossedItems), failedItems);
  assert.equal(resumed.complete, true);
  assert.equal(resumed.reused, true);
  assert.deepEqual({ succeeded: resumed.succeeded, failed: resumed.failed }, { succeeded: 100, failed: 0 });
});

test('100-item deadline parks a named not-attempted remainder and a new process runs only that remainder', async () => {
  eventlog.resetEventLog();
  _resetWorkerBatchExecutionsForTest();
  _resetWorkerConcurrencyForTest();
  const sessionId = 'worker-100-budget-exhaustion';
  const sourceUserSeq = acceptedSource(sessionId, 'Analyze exactly one hundred generated items within the fixed run budget.');
  const items = itemsFor('budget');
  const objective = 'Analyze generated items without silently dropping work when the fixed run window ends.';
  const manifestId = 'worker-100-budget-manifest';

  type Waiter = { resolve: () => void; reject: (error: unknown) => void; signal?: AbortSignal; onAbort?: () => void };
  type LogicalTimer = { at: number; active: boolean; fn: () => void };
  const waits: Waiter[] = [];
  const timers: LogicalTimer[] = [];
  let now = 0;
  let started = 0;
  let inflight = 0;
  _setWorkerBatchRuntimeForTest({
    now: () => now,
    setTimer: (fn, delayMs) => {
      const timer = { at: now + delayMs, active: true, fn };
      timers.push(timer);
      return timer;
    },
    clearTimer: (raw) => { (raw as LogicalTimer).active = false; },
  });
  setClaudeAgentSdkWorkerRunForTest(async (options) => {
    const signal = (options as { abortSignal?: AbortSignal }).abortSignal;
    started += 1;
    inflight += 1;
    try {
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = { resolve, reject, ...(signal ? { signal } : {}) };
        if (signal) {
          waiter.onAbort = () => reject(signal.reason ?? new Error('worker aborted'));
          if (signal.aborted) return waiter.onAbort();
          signal.addEventListener('abort', waiter.onAbort, { once: true });
        }
        waits.push(waiter);
      });
      const item = String(packetFromPrompt(String((options as { prompt?: unknown }).prompt ?? '')).item ?? '');
      return { text: `OK::${item}`, toolUses: [] };
    } finally {
      inflight -= 1;
    }
  });
  const waitUntil = async (predicate: () => boolean, label: string): Promise<void> => {
    for (let spin = 0; spin < 50_000; spin += 1) {
      if (predicate()) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error(`logical worker runtime did not reach ${label}; started=${started}, inflight=${inflight}`);
  };
  const advance = async (): Promise<void> => {
    now += 100;
    const current = waits.splice(0, waits.length);
    for (const waiter of current) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.resolve();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const timer of timers) {
      if (timer.active && timer.at <= now) {
        timer.active = false;
        timer.fn();
      }
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  };

  const controller = new AbortController();
  const pending = invoke({
    sessionId,
    sourceUserSeq,
    callId: 'budget-first',
    call: manifestCall({ objective, items, manifestId, mode: 'declare' }),
    signal: controller.signal,
    deadlineAt: 1_000,
  });
  try {
    await waitUntil(() => started === WIDTH, 'first worker wave');
    for (let round = 1; round <= 9; round += 1) {
      await advance();
      if (round < 9) await waitUntil(() => started === (round + 1) * WIDTH, `worker wave ${round + 1}`);
    }
    const parked = await pending;
    assert.equal(started, 54);
    assert.equal(inflight, 0);
    assert.match(parked, /54\/100 settled; 0 failed; 0 in_flight; 46 pending \(not attempted\)/);
    const remainderLine = parked.split('\n').find((line) => line.startsWith('RUN_WORKER_REMAINDER '));
    assert.ok(remainderLine);
    const remainder = JSON.parse(remainderLine.slice('RUN_WORKER_REMAINDER '.length)) as {
      settled: string[];
      failed: string[];
      in_flight: string[];
      pending: string[];
    };
    assert.equal(remainder.settled.length, 54);
    assert.deepEqual(remainder.failed, []);
    assert.deepEqual(remainder.in_flight, []);
    assert.deepEqual(remainder.pending, items.slice(54));
    assert.deepEqual(phaseCounts(sessionId, manifestId), { succeeded: 54, failed: 0 });
  } finally {
    while (waits.length > 0) await advance();
    _setWorkerBatchRuntimeForTest(null);
    setClaudeAgentSdkWorkerRunForTest(null);
  }

  const resumed = resumeInFreshProcess({
    sessionId,
    sourceUserSeq,
    callId: 'budget-restart',
    objective,
    items,
    manifestId,
  });
  assert.notEqual(resumed.pid, process.pid);
  assert.equal(resumed.crossings, 46, 'the restarted process runs only the not-attempted remainder');
  assert.deepEqual(resumed.crossedItems, items.slice(54));
  assert.equal(resumed.complete, true);
  assert.equal(resumed.reused, true);
  assert.deepEqual({ succeeded: resumed.succeeded, failed: resumed.failed }, { succeeded: 100, failed: 0 });
});
