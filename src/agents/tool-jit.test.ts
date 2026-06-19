import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectToolsForTurn, toolJitEnabled, TOOL_JIT_CORE, TOOL_JIT_MANDATED, type JitTool, type JitRankFn } from './tool-jit.js';

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> | void {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  try {
    const r = fn();
    if (r instanceof Promise) return r.finally(restore);
    restore();
  } catch (e) {
    restore();
    throw e;
  }
}

// A representative surface: a few CORE tools + several JIT-able ones.
const CORE_SAMPLE = ['memory_recall', 'composio_execute_tool', 'execution_create', 'read_file'];
const JITABLE = ['workflow_create', 'workflow_update', 'space_save', 'git_status', 'task_add'];
const TOOLS: JitTool[] = [...CORE_SAMPLE, ...JITABLE].map((name) => ({ name, description: `desc for ${name}` }));

test('flag default OFF: exposes the full surface, never reduced', async () => {
  await withEnv({ CLEMMY_TOOL_JIT: undefined }, async () => {
    assert.equal(toolJitEnabled(), false);
    const sel = await selectToolsForTurn({ userInput: 'create a workflow', tools: TOOLS });
    assert.equal(sel.reduced, false);
    assert.equal(sel.reason, 'jit-off');
    assert.equal(sel.exposed.size, TOOLS.length);
  });
});

test('flag ON but empty query: exposes everything (no signal to retrieve on)', async () => {
  await withEnv({ CLEMMY_TOOL_JIT: 'on' }, async () => {
    const sel = await selectToolsForTurn({ userInput: '   ', tools: TOOLS });
    assert.equal(sel.reduced, false);
    assert.equal(sel.reason, 'no-query');
    assert.equal(sel.exposed.size, TOOLS.length);
  });
});

test('flag ON, ranker returns no signal: falls back to the full surface', async () => {
  await withEnv({ CLEMMY_TOOL_JIT: 'on' }, async () => {
    const noSignal: JitRankFn = async () => undefined;
    const sel = await selectToolsForTurn({ userInput: 'create a workflow', tools: TOOLS, rankFn: noSignal });
    assert.equal(sel.reduced, false);
    assert.equal(sel.reason, 'no-semantic-signal');
    assert.equal(sel.exposed.size, TOOLS.length);
  });
});

test('flag ON with a real ranking: CORE kept + relevant retrieved, irrelevant dropped', async () => {
  await withEnv({ CLEMMY_TOOL_JIT: 'on', CLEMMY_TOOL_JIT_TOPK: undefined, CLEMMY_TOOL_JIT_MIN_SCORE: undefined }, async () => {
    const ranker: JitRankFn = async (_q, tools) => {
      const m = new Map<string, number>();
      for (const t of tools) m.set(t.name, 0); // default low
      m.set('workflow_create', 0.92);
      m.set('workflow_update', 0.40);
      m.set('space_save', 0.05); // below the 0.18 floor → dropped
      m.set('git_status', 0.02); // dropped
      m.set('task_add', 0.0); // dropped
      return m;
    };
    const sel = await selectToolsForTurn({ userInput: 'create then update a workflow', tools: TOOLS, rankFn: ranker });
    assert.equal(sel.reduced, true);
    // every CORE tool present in the surface survives, regardless of score
    for (const c of CORE_SAMPLE) assert.ok(sel.exposed.has(c), `core ${c} must survive`);
    // high-scoring JIT tools retrieved
    assert.ok(sel.exposed.has('workflow_create'));
    assert.ok(sel.exposed.has('workflow_update'));
    // below-floor JIT tools dropped
    assert.ok(!sel.exposed.has('space_save'));
    assert.ok(!sel.exposed.has('git_status'));
    assert.ok(!sel.exposed.has('task_add'));
    assert.equal(sel.droppedCount, 3);
  });
});

test('CORE is never dropped even when scored below the floor', async () => {
  await withEnv({ CLEMMY_TOOL_JIT: 'on' }, async () => {
    // Force the ranker to score a core tool at 0 — it must still be exposed.
    const ranker: JitRankFn = async (_q, tools) => new Map(tools.map((t) => [t.name, 0]));
    const sel = await selectToolsForTurn({ userInput: 'anything', tools: TOOLS, rankFn: ranker });
    for (const c of CORE_SAMPLE) assert.ok(sel.exposed.has(c), `core ${c} survives a 0 score`);
  });
});

test('topK env caps the retrieved set', async () => {
  await withEnv({ CLEMMY_TOOL_JIT: 'on', CLEMMY_TOOL_JIT_TOPK: '1', CLEMMY_TOOL_JIT_MIN_SCORE: '0' }, async () => {
    const ranker: JitRankFn = async (_q, tools) => {
      const m = new Map<string, number>();
      tools.forEach((t, i) => m.set(t.name, (tools.length - i) / tools.length)); // decreasing
      return m;
    };
    const sel = await selectToolsForTurn({ userInput: 'x', tools: TOOLS, rankFn: ranker });
    const retrievedNonCore = [...sel.exposed].filter((n) => !TOOL_JIT_CORE.has(n));
    assert.equal(retrievedNonCore.length, 1, 'only top-1 JIT-able tool retrieved');
  });
});

test('all-core surface: nothing to JIT, exposes everything', async () => {
  await withEnv({ CLEMMY_TOOL_JIT: 'on' }, async () => {
    const coreOnly: JitTool[] = CORE_SAMPLE.map((name) => ({ name }));
    const sel = await selectToolsForTurn({ userInput: 'do a thing', tools: coreOnly });
    assert.equal(sel.reduced, false);
    assert.equal(sel.reason, 'no-jit-candidates');
  });
});

test('TOOL_JIT_CORE includes the acquisition escape-hatch + execution lane', () => {
  // These are load-bearing: dropping them would dead-end common flows.
  for (const must of ['composio_search_tools', 'composio_execute_tool', 'execution_create', 'memory_recall', 'run_shell_command']) {
    assert.ok(TOOL_JIT_CORE.has(must), `${must} must be in the always-loaded core`);
  }
});

test('MANDATED ⊆ CORE: every mandated tool is in the always-loaded core', () => {
  for (const m of TOOL_JIT_MANDATED) {
    assert.ok(TOOL_JIT_CORE.has(m), `mandated tool ${m} must be in TOOL_JIT_CORE`);
  }
});

test('worst-case ranker (every candidate scores 0): all MANDATED tools still survive', async () => {
  // The real safety guarantee: even if semantic retrieval surfaces NOTHING, no
  // mandated tool is ever dropped. Build a surface of all mandated tools + some
  // droppable ones, score everything 0, and assert mandated all survive.
  await withEnv({ CLEMMY_TOOL_JIT: 'on', CLEMMY_TOOL_JIT_MIN_SCORE: '0.5' }, async () => {
    const droppable = ['workflow_create', 'space_save', 'git_status'];
    const tools: JitTool[] = [...TOOL_JIT_MANDATED, ...droppable].map((name) => ({ name, description: name }));
    const zero: JitRankFn = async (_q, ts) => new Map(ts.map((t) => [t.name, 0]));
    const sel = await selectToolsForTurn({ userInput: 'anything at all', tools, rankFn: zero });
    for (const m of TOOL_JIT_MANDATED) {
      assert.ok(sel.exposed.has(m), `mandated ${m} must survive a zero-score ranker`);
    }
    // and the droppable ones are gone (proves the reduction actually happened)
    for (const d of droppable) assert.ok(!sel.exposed.has(d), `droppable ${d} should be dropped at score 0 < 0.5`);
  });
});
