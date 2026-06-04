/**
 * End-to-end runtime smoke for the workflow-reliability batch.
 * Drives the REAL execution engine (processWorkflowRuns → processOneRunFile →
 * executeWorkflow → finalizer/detectBlockedSteps → notifications) against a
 * throwaway CLEMENTINE_HOME, using a stub assistant on the legacy path
 * (useHarness:false) so there is NO LLM and NO Codex token involved.
 *
 * Run: npx tsx scripts/smoke-workflow-reliability.mts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'clemmy-wf-smoke-'));
process.env.CLEMENTINE_HOME = path.join(TMP_HOME, '.clementine-next');
process.env.WORKFLOW_USE_HARNESS = 'off'; // belt-and-suspenders; steps also set useHarness:false
fs.mkdirSync(process.env.CLEMENTINE_HOME, { recursive: true });

const { writeWorkflow } = await import('../src/memory/workflow-store.js');
const { prepareWorkflowForWrite, autoRepairWorkflowDefinition } = await import('../src/execution/workflow-enforce.js');
const { processWorkflowRuns } = await import('../src/execution/workflow-runner.js');
const { loadNotifications } = await import('../src/runtime/notifications.js');
const { WORKFLOW_RUNS_DIR } = await import('../src/tools/shared.js');

let failures = 0;
const check = (label: string, cond: boolean, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
};

// ── Stub assistant: routes by the step/item content in the message ──────────
const stub = {
  async respond(req: { sessionId: string; message: string }) {
    const m = req.message;
    let text = '{"ok":true}';
    if (/Step:\s*fetch/.test(m)) text = '{"value":"FETCH_PAYLOAD_42"}';
    else if (/Step:\s*analyze/.test(m)) {
      // Proves data flowed: the rendered {{steps.fetch.output}} must be present.
      text = m.includes('FETCH_PAYLOAD_42')
        ? '{"ok":true,"sawUpstream":true}'
        : '{"ok":false,"sawUpstream":false}';
    } else if (/Step:\s*list/.test(m)) {
      text = '[{"lead":"alpha"},{"lead":"beta"},{"lead":"gamma"}]';
    } else if (/Step:\s*each/.test(m)) {
      // 2 of 3 items politely BLOCK (no throw) — the exact silent-success hole.
      text = m.includes('gamma')
        ? '{"ok":true,"lead":"gamma"}'
        : '{"blocked":true,"reason":"no email for this lead"}';
    }
    return { text, sessionId: req.sessionId };
  },
} as unknown as Parameters<typeof processWorkflowRuns>[0];

const queueRun = (workflowName: string): string => {
  fs.mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const id = `run-${randomUUID().slice(0, 8)}`;
  fs.writeFileSync(
    path.join(WORKFLOW_RUNS_DIR, `${id}.json`),
    JSON.stringify({ id, workflow: workflowName, status: 'queued', createdAt: new Date().toISOString() }, null, 2),
  );
  return id;
};
const readRun = (id: string) =>
  JSON.parse(fs.readFileSync(path.join(WORKFLOW_RUNS_DIR, `${id}.json`), 'utf8'));

// ════════════════════════════════════════════════════════════════════════
// SMOKE A — auto-repair wires a binding gap, and at RUNTIME data flows.
// ════════════════════════════════════════════════════════════════════════
console.log('\n── SMOKE A: author-time auto-repair + runtime data flow ──');
const aRaw = {
  name: 'zz-smoke-autorepair',
  description: 'smoke: fetch then analyze with an unwired {{steps.fetch.output}}',
  enabled: true,
  trigger: { manual: true },
  steps: [
    { id: 'fetch', prompt: 'fetch the data', useHarness: false },
    // NOTE: no dependsOn — references fetch output but isn't wired (the gap).
    { id: 'analyze', prompt: 'analyze {{steps.fetch.output}}', useHarness: false },
  ],
} as Parameters<typeof prepareWorkflowForWrite>[0];

const aRepair = autoRepairWorkflowDefinition(aRaw);
check('auto-repair wired analyze → dependsOn:[fetch]',
  JSON.stringify(aRepair.def.steps[1].dependsOn) === '["fetch"]',
  JSON.stringify(aRepair.def.steps[1].dependsOn));
const aPrep = prepareWorkflowForWrite(aRaw);
check('repaired workflow passes validation (was refused raw)', aPrep.ok, aPrep.errors.join('; '));
writeWorkflow('zz-smoke-autorepair', aPrep.def);
const aRunId = queueRun('zz-smoke-autorepair');
await processWorkflowRuns(stub);
const aRun = readRun(aRunId);
check('run completed', aRun.status === 'completed', aRun.status);
check('analyze saw the upstream payload at runtime (data flowed)',
  String(aRun.stepOutputs?.analyze ?? '').includes('"sawUpstream":true'),
  String(aRun.stepOutputs?.analyze));
check('run is NOT flagged needs-attention (clean success)', !aRun.needsAttention, String(aRun.needsAttention));

// ════════════════════════════════════════════════════════════════════════
// SMOKE B — forEach where 2/3 items politely BLOCK → needs-attention report.
// ════════════════════════════════════════════════════════════════════════
console.log('\n── SMOKE B: forEach polite-block report-back ──');
const bRaw = {
  name: 'zz-smoke-foreach-block',
  description: 'smoke: list then per-item process where most items politely block',
  enabled: true,
  trigger: { manual: true },
  steps: [
    { id: 'list', prompt: 'produce a list of leads', useHarness: false },
    { id: 'each', prompt: 'process {{item.lead}}', forEach: 'list', useHarness: false }, // dep auto-wired
  ],
} as Parameters<typeof prepareWorkflowForWrite>[0];
const bPrep = prepareWorkflowForWrite(bRaw);
check('forEach dep auto-wired (each → dependsOn:[list])',
  JSON.stringify(bPrep.def.steps[1].dependsOn) === '["list"]',
  JSON.stringify(bPrep.def.steps[1].dependsOn));
writeWorkflow('zz-smoke-foreach-block', bPrep.def);
const bRunId = queueRun('zz-smoke-foreach-block');
await processWorkflowRuns(stub);
const bRun = readRun(bRunId);
check('run status completed (engine finished)', bRun.status === 'completed', bRun.status);
check('run flagged needs-attention (polite blocks NOT masked as success)',
  bRun.needsAttention === true, String(bRun.needsAttention));
const bNotes = loadNotifications().filter((n: { metadata?: { runId?: string } }) => n.metadata?.runId === bRunId);
const bBody = bNotes.map((n: { body?: string }) => n.body ?? '').join('\n');
check('completion notification reports "2 of 3 items report a block"',
  /2 of 3 items? report a block/.test(bBody), bBody.slice(0, 200));

// ════════════════════════════════════════════════════════════════════════
// SMOKE C — invalid timezone is refused at author time (every seam).
// ════════════════════════════════════════════════════════════════════════
console.log('\n── SMOKE C: timezone validation ──');
const cBad = prepareWorkflowForWrite({
  name: 'zz-smoke-badtz',
  description: 'smoke: bad timezone should be refused',
  enabled: true,
  trigger: { schedule: '0 8 * * *', timezone: 'America/Los_Angles' },
  steps: [{ id: 'a', prompt: 'do a thing' }],
} as Parameters<typeof prepareWorkflowForWrite>[0]);
check('bad IANA timezone is refused', !cBad.ok && cBad.errors.some((e) => /Invalid timezone/.test(e)),
  cBad.errors.join('; '));

// ── cleanup ─────────────────────────────────────────────────────────────
fs.rmSync(TMP_HOME, { recursive: true, force: true });
console.log(`\n${failures === 0 ? '✅ ALL SMOKES PASSED' : `❌ ${failures} SMOKE CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
