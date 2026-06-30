/**
 * LIVE smoke — Phase A observability path, end to end:
 *   appendWorkflowEvent (legacy lifecycle) → mirror bridge → operational-telemetry
 *   sqlite store → listOperationalEvents (the /api/console/telemetry query) AND the
 *   actionBus 'operational.event' stream (what /api/console/telemetry/stream forwards).
 *
 * Isolated CLEMENTINE_HOME (temp) so the running app's real telemetry DB is untouched.
 * Run: npx tsx scripts/smoke-operational-telemetry.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-otel-live-'));
process.env.CLEMENTINE_HOME = HOME;

const { appendWorkflowEvent } = await import('../src/execution/workflow-events.js');
const { listOperationalEvents } = await import('../src/runtime/operational-telemetry.js');
const { actionBus } = await import('../src/runtime/action-bus.js');

// Subscribe BEFORE emitting — this is exactly what the SSE endpoint does.
const streamed: Array<{ source: string; type: string }> = [];
const unsub = actionBus.subscribe((e) => {
  if (e.kind === 'operational.event') streamed.push({ source: e.event.source, type: e.event.type });
});

const wf = 'live-smoke';
const run = `r-${process.pid}`;
// A realistic run: fetch (tool calls) → send (approval-gated). Legacy kinds only —
// the bridge maps them into the operational taxonomy.
appendWorkflowEvent(wf, run, { kind: 'run_started' });
appendWorkflowEvent(wf, run, { kind: 'step_started', stepId: 'fetch' });
appendWorkflowEvent(wf, run, { kind: 'tool_called', stepId: 'fetch', meta: { tool: 'http_get' } });
appendWorkflowEvent(wf, run, { kind: 'tool_result', stepId: 'fetch' });
appendWorkflowEvent(wf, run, { kind: 'step_completed', stepId: 'fetch' });
appendWorkflowEvent(wf, run, { kind: 'step_started', stepId: 'send' });
appendWorkflowEvent(wf, run, { kind: 'approval_requested', stepId: 'send' });
appendWorkflowEvent(wf, run, { kind: 'approval_granted', stepId: 'send' });
appendWorkflowEvent(wf, run, { kind: 'step_completed', stepId: 'send' });

// Memory seam: a semantic-memory write must surface as semantic_fact_upserted.
const { rememberFact } = await import('../src/memory/facts.js');
rememberFact({ kind: 'project', content: `Phase A telemetry smoke fact ${process.pid}`, importance: 5 });

unsub();

const stored = listOperationalEvents({ workflowRunId: run, limit: 100 });
console.log(`\nStored operational events (the /api/console/telemetry query):`);
for (const e of [...stored].reverse()) {
  console.log(`  [${e.source}/${e.severity}] ${e.type}  step=${(e.payload as { stepId?: string }).stepId ?? ''}`);
}
console.log(`\nLive-streamed via actionBus (the /api/console/telemetry/stream forward): ${streamed.length}`);

const types = new Set(stored.map((e) => e.type));
const want = [
  'workflow_node_started', 'workflow_node_completed',
  'tool_call_started', 'tool_call_completed',
  'approval_required', 'approval_resolved',
];
const missing = want.filter((t) => !types.has(t));

// Memory seam (separate source — not tied to the workflow runId).
const memEvents = listOperationalEvents({ source: 'memory', limit: 50 });
const memOk = memEvents.some((e) => e.type === 'semantic_fact_upserted');
console.log(`\nMemory operational events: ${memEvents.length}` + (memOk ? '  (semantic_fact_upserted ✓)' : '  (MISSING semantic_fact_upserted)'));

// Every recorded operational event also rides the actionBus (the SSE forward).
const totalRecorded = stored.length + memEvents.length;
const ok = missing.length === 0 && memOk && streamed.length >= totalRecorded && stored.length > 0;
console.log(ok
  ? `\n✓ PASS — workflow/tool/safety (${stored.length}) + memory (${memEvents.length}) bridged → stored → queryable → live-streamed (${streamed.length}). All ${want.length} workflow types + semantic_fact_upserted present.`
  : `\n✗ FAIL — missing=[${missing}] memOk=${memOk} streamed=${streamed.length} totalRecorded=${totalRecorded}`);

try { rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(ok ? 0 : 1);
