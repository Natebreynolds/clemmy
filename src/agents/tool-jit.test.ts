import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectToolsForTurn, toolJitEnabled, TOOL_JIT_CORE, TOOL_JIT_MANDATED, assignToolJitArm, resolveToolJitDecision, toolJitExperimentEnabled, type JitTool, type JitRankFn } from './tool-jit.js';

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

test('REL-5 guard: selectToolsForTurn does NOT re-gate on the global flag (A/B jit arm works with global OFF)', async () => {
  // Whether JIT runs is decided by resolveToolJitDecision at the call site, NOT here.
  // With the global CLEMMY_TOOL_JIT OFF but a real ranking, selection MUST still reduce —
  // otherwise the A/B jit arm (which activates without the global flag) is a silent no-op.
  await withEnv({ CLEMMY_TOOL_JIT: 'off' }, async () => {
    assert.equal(toolJitEnabled(), false);
    const ranker: JitRankFn = async (_q, ts) => new Map(ts.map((t) => [t.name, t.name === 'workflow_create' ? 0.9 : 0]));
    const sel = await selectToolsForTurn({ userInput: 'create a workflow', tools: TOOLS, rankFn: ranker });
    assert.equal(sel.reduced, true, 'must reduce even with the global flag off');
    assert.ok(sel.exposed.has('workflow_create'));
    assert.ok(!sel.exposed.has('space_save'));
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

test('workspace authoring intents pin the space tools even under a worst-case JIT ranker', async () => {
  await withEnv({ CLEMMY_TOOL_JIT: 'on', CLEMMY_TOOL_JIT_MIN_SCORE: '0.5' }, async () => {
    const spaceTools = [
      'space_get',
      'space_get_view',
      'space_get_runner',
      'space_list',
      'space_save',
      'space_edit_view',
      'space_edit_runner',
      'space_revert_runner',
      'space_refresh',
      'space_try_runner',
      'space_set_data',
    ];
    const otherDroppable = ['workflow_create', 'git_status', 'task_add'];
    const tools: JitTool[] = [...CORE_SAMPLE, ...spaceTools, ...otherDroppable]
      .map((name) => ({ name, description: name }));
    const zero: JitRankFn = async (_q, ts) => new Map(ts.map((t) => [t.name, 0]));

    const sel = await selectToolsForTurn({
      userInput: 'Build a live dashboard workspace for my pipeline with a follow-up action',
      tools,
      rankFn: zero,
    });

    assert.equal(sel.reduced, true, 'the test must still prove JIT reduced unrelated tools');
    for (const must of spaceTools) assert.ok(sel.exposed.has(must), `${must} must survive workspace-intent JIT`);
    for (const dropped of otherDroppable) assert.ok(!sel.exposed.has(dropped), `${dropped} should still be droppable`);
  });
});

test('workspace intent pinning also catches natural dashboard requests that omit the word workspace', async () => {
  await withEnv({ CLEMMY_TOOL_JIT: 'on', CLEMMY_TOOL_JIT_MIN_SCORE: '0.5' }, async () => {
    const tools: JitTool[] = [...CORE_SAMPLE, 'space_save', 'space_refresh', 'workflow_create']
      .map((name) => ({ name, description: name }));
    const zero: JitRankFn = async (_q, ts) => new Map(ts.map((t) => [t.name, 0]));

    const sel = await selectToolsForTurn({
      userInput: 'Make me a live dashboard for my sales pipeline',
      tools,
      rankFn: zero,
    });

    assert.ok(sel.exposed.has('space_save'), 'space_save must survive natural workspace-build wording');
    assert.ok(sel.exposed.has('space_refresh'), 'space_refresh must survive natural workspace-build wording');
    assert.ok(!sel.exposed.has('workflow_create'), 'unrelated JIT-able tools should still drop');
  });
});

// --- Live A/B: bucketing + decision ---------------------------------------

test('assignToolJitArm is deterministic + stable per session', () => {
  const a = assignToolJitArm('sess-abc');
  const b = assignToolJitArm('sess-abc');
  assert.equal(a, b, 'same session → same arm (no flapping)');
  assert.ok(a === 'jit' || a === 'control');
});

test('assignToolJitArm honors the ratio extremes (all-jit / all-control)', () => {
  withEnv({ CLEMMY_TOOL_JIT_AB_RATIO: '1' }, () => {
    for (const s of ['a', 'b', 'c', 'd', 'e']) assert.equal(assignToolJitArm(s), 'jit');
  });
  withEnv({ CLEMMY_TOOL_JIT_AB_RATIO: '0' }, () => {
    for (const s of ['a', 'b', 'c', 'd', 'e']) assert.equal(assignToolJitArm(s), 'control');
  });
});

test('assignToolJitArm splits a population roughly by ratio', () => {
  withEnv({ CLEMMY_TOOL_JIT_AB_RATIO: '0.5' }, () => {
    let jit = 0;
    const n = 400;
    for (let i = 0; i < n; i++) if (assignToolJitArm(`session-${i}`) === 'jit') jit++;
    // sha1-hash uniformity → expect ~50%; allow a wide band so it's not flaky.
    assert.ok(jit > n * 0.35 && jit < n * 0.65, `expected ~50% jit, got ${jit}/${n}`);
  });
});

test('resolveToolJitDecision: lane gate always wins (autonomous lane never JITs)', () => {
  withEnv({ CLEMMY_TOOL_JIT: 'on', CLEMMY_TOOL_JIT_AB: 'on' }, () => {
    const d = resolveToolJitDecision({ allowLane: false, sessionId: 'sess-x' });
    assert.equal(d.active, false);
    assert.equal(d.experiment, false);
  });
});

test('resolveToolJitDecision: A/B off → global flag governs (no arm)', () => {
  withEnv({ CLEMMY_TOOL_JIT: 'on', CLEMMY_TOOL_JIT_AB: undefined }, () => {
    const d = resolveToolJitDecision({ allowLane: true, sessionId: 'sess-x' });
    assert.equal(d.active, true);
    assert.equal(d.experiment, false);
    assert.equal(d.arm, null);
  });
  withEnv({ CLEMMY_TOOL_JIT: undefined, CLEMMY_TOOL_JIT_AB: undefined }, () => {
    // default-on: unset global flag now activates JIT.
    assert.equal(resolveToolJitDecision({ allowLane: true, sessionId: 'sess-x' }).active, true);
  });
  withEnv({ CLEMMY_TOOL_JIT: 'off', CLEMMY_TOOL_JIT_AB: undefined }, () => {
    assert.equal(resolveToolJitDecision({ allowLane: true, sessionId: 'sess-x' }).active, false);
  });
});

test('resolveToolJitDecision: A/B on → per-session arm governs, regardless of global flag', () => {
  // experiment on, global OFF: the jit arm still activates (arm overrides global).
  withEnv({ CLEMMY_TOOL_JIT: undefined, CLEMMY_TOOL_JIT_AB: 'on', CLEMMY_TOOL_JIT_AB_RATIO: '1' }, () => {
    const d = resolveToolJitDecision({ allowLane: true, sessionId: 'sess-x' });
    assert.equal(d.experiment, true);
    assert.equal(d.arm, 'jit');
    assert.equal(d.active, true);
  });
  // control arm: inactive even if global flag is ON.
  withEnv({ CLEMMY_TOOL_JIT: 'on', CLEMMY_TOOL_JIT_AB: 'on', CLEMMY_TOOL_JIT_AB_RATIO: '0' }, () => {
    const d = resolveToolJitDecision({ allowLane: true, sessionId: 'sess-x' });
    assert.equal(d.arm, 'control');
    assert.equal(d.active, false);
  });
});

test('resolveToolJitDecision: A/B on but no sessionId → falls back to global flag', () => {
  withEnv({ CLEMMY_TOOL_JIT: 'on', CLEMMY_TOOL_JIT_AB: 'on' }, () => {
    const d = resolveToolJitDecision({ allowLane: true, sessionId: null });
    assert.equal(d.experiment, false, 'no session → cannot bucket → global flag');
    assert.equal(d.active, true);
  });
});

test('toolJitExperimentEnabled reads CLEMMY_TOOL_JIT_AB', () => {
  withEnv({ CLEMMY_TOOL_JIT_AB: undefined }, () => assert.equal(toolJitExperimentEnabled(), false));
  withEnv({ CLEMMY_TOOL_JIT_AB: 'on' }, () => assert.equal(toolJitExperimentEnabled(), true));
});

test('MANDATED ⊆ CORE: every mandated tool is in the always-loaded core', () => {
  for (const m of TOOL_JIT_MANDATED) {
    assert.ok(TOOL_JIT_CORE.has(m), `mandated tool ${m} must be in TOOL_JIT_CORE`);
  }
});

test('Claude SDK brain: the agentic profile execution tools survive a worst-case JIT (strand-protection)', async () => {
  // jit-claude-3: the Claude SDK brain reduces its tool surface to CORE + top-K of the
  // AGENTIC profile. Even when NOTHING ranks (zero-score), the execution tools the
  // agentic brain depends on must survive — else JIT would brick real work.
  const { CLAUDE_AGENT_SDK_FULL_TOOLS } = await import('../runtime/harness/claude-agent-sdk.js');
  await withEnv({ CLEMMY_TOOL_JIT: 'on', CLEMMY_TOOL_JIT_MIN_SCORE: '0.5' }, async () => {
    const profile = [...new Set(CLAUDE_AGENT_SDK_FULL_TOOLS)] as string[];
    const tools: JitTool[] = profile.map((name) => ({ name, description: name }));
    const zero: JitRankFn = async (_q, ts) => new Map(ts.map((t) => [t.name, 0]));
    const sel = await selectToolsForTurn({ userInput: 'anything', tools, rankFn: zero });
    for (const must of ['run_shell_command', 'composio_execute_tool', 'write_file', 'execution_create', 'execution_complete', 'memory_recall']) {
      if (profile.includes(must)) {
        assert.ok(sel.exposed.has(must), `agentic execution tool ${must} must survive worst-case JIT`);
      }
    }
  });
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
