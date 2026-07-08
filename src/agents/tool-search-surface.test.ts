/**
 * Run: npx tsx --test src/agents/tool-search-surface.test.ts
 *
 * Schema-on-demand surface switch (Phase 1), behind CLEMMY_CODEX_TOOL_SEARCH.
 *   - OFF (default): byte-identical full first-class surface — no call_tool, no
 *     catalog block, no tool_search_scope event (the whole path is inert).
 *   - ON: first-class = structural + hot set; non-hot discovery tools leave the
 *     schema surface, call_tool + the catalog block appear, and the telemetry event
 *     records the split. The reduced surface is a strict subset of the full one.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-toolsearch-surface-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildOrchestratorAgent } = await import('./orchestrator.js');
const { createSession, listEvents, resetEventLog } = await import('../runtime/harness/eventlog.js');

// A discovery tool that is NOT in the hot set for a benign query (not TOOL_JIT_MANDATED,
// no recall/LRU) → it must be first-class OFF but catalog-only ON.
const CATALOG_ONLY_WHEN_ON = 'workflow_import_framework';
const USER_INPUT = 'hello there, how are you today';

function namesOf(agent: { tools?: Array<{ name?: string }> }): Set<string> {
  return new Set((agent.tools ?? []).map((t) => t.name).filter((n): n is string => Boolean(n)));
}

async function renderInstructions(agent: { instructions?: unknown }): Promise<string> {
  const instr = agent.instructions;
  if (typeof instr === 'function') {
    return String(await (instr as (ctx: unknown, agent: unknown) => unknown)({ context: {} }, agent));
  }
  return String(instr ?? '');
}

function withFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.CLEMMY_CODEX_TOOL_SEARCH;
  if (value === undefined) delete process.env.CLEMMY_CODEX_TOOL_SEARCH;
  else process.env.CLEMMY_CODEX_TOOL_SEARCH = value;
  const restore = () => {
    if (prev === undefined) delete process.env.CLEMMY_CODEX_TOOL_SEARCH;
    else process.env.CLEMMY_CODEX_TOOL_SEARCH = prev;
  };
  return fn().finally(restore);
}

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('OFF (default): no call_tool, no catalog block, full discovery surface, no telemetry', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const agent = await withFlag('off', () =>
    buildOrchestratorAgent({ sessionId: sess.id, userInput: USER_INPUT, allowToolJit: true }));
  const names = namesOf(agent);

  assert.ok(!names.has('call_tool'), 'call_tool must be absent when off');
  assert.ok(names.has('tool_search'), 'tool_search (Phase 0) is still present when off');
  assert.ok(names.has(CATALOG_ONLY_WHEN_ON), 'every discovery tool is first-class when off');
  const instr = await renderInstructions(agent);
  assert.ok(!instr.includes('[tool-catalog]'), 'no catalog block injected when off');
  assert.equal(listEvents(sess.id, { types: ['tool_search_scope'] }).length, 0, 'no telemetry when inert');
});

test('ON: first-class = structural + hot set; non-hot discovery moves to the catalog', async () => {
  resetEventLog();
  const onSess = createSession({ kind: 'chat' });
  const offSess = createSession({ kind: 'chat' });

  const onAgent = await withFlag('on', () =>
    buildOrchestratorAgent({ sessionId: onSess.id, userInput: USER_INPUT, allowToolJit: true }));
  const offAgent = await withFlag('off', () =>
    buildOrchestratorAgent({ sessionId: offSess.id, userInput: USER_INPUT, allowToolJit: true }));

  const on = namesOf(onAgent);
  const off = namesOf(offAgent);

  // call_tool appears only ON.
  assert.ok(on.has('call_tool'), 'call_tool is first-class when on');
  assert.ok(!off.has('call_tool'), 'call_tool absent when off');

  // Hot-set members are real first-class tools when on.
  assert.ok(on.has('tool_search'), 'tool_search (mandated) stays first-class');
  assert.ok(on.has('memory_recall'), 'a TOOL_JIT_MANDATED tool stays first-class');

  // A non-hot discovery tool leaves the schema surface.
  assert.ok(off.has(CATALOG_ONLY_WHEN_ON), `${CATALOG_ONLY_WHEN_ON} is first-class off`);
  assert.ok(!on.has(CATALOG_ONLY_WHEN_ON), `${CATALOG_ONLY_WHEN_ON} is catalog-only on`);

  // The reduced ON surface is a strict subset of the full OFF surface (+ call_tool).
  for (const n of on) {
    if (n !== 'call_tool') assert.ok(off.has(n), `${n} (first-class on) must also be first-class off`);
  }
  assert.ok(off.size > on.size, 'the on surface is smaller — tools moved to the catalog');

  // The catalog block is injected and lists the catalog-only tool.
  const instr = await renderInstructions(onAgent);
  assert.ok(instr.includes('[tool-catalog]'), 'catalog block injected when on');
  assert.ok(instr.includes(CATALOG_ONLY_WHEN_ON), 'the catalog lists the tools it moved off first-class');

  // Telemetry records the split.
  const scope = listEvents(onSess.id, { types: ['tool_search_scope'] });
  assert.equal(scope.length, 1, 'one tool_search_scope event emitted');
  const data = scope[0].data as { active?: boolean; firstClassCount?: number; catalogCount?: number; estCatalogTokens?: number };
  assert.equal(data.active, true);
  assert.ok((data.firstClassCount ?? 0) > 0, 'firstClassCount recorded');
  assert.ok((data.catalogCount ?? 0) > 0, 'catalogCount recorded');
  assert.ok((data.estCatalogTokens ?? 0) > 0, 'estCatalogTokens recorded');
});
