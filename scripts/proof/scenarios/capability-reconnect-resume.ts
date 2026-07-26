/**
 * Recoverable workflow capability proof:
 *   model step completes → exact mutation parks before dispatch → connection
 *   appears → two concurrent manual resumes race → same run dispatches once.
 *
 * The Composio lane is a proof-local CLI shim provisioned inside the disposable
 * home. No real account, network service, or external write is reachable.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { openHarnessDb, sessionMetrics, stormCheck } from '../score.js';
import type { Check, DaemonHandle, ScenarioDef } from '../types.js';

const WORKFLOW_NAME = 'proof-capability-reconnect';
const PREPARE_STEP = 'prepare';
const WRITE_STEP = 'publish';
const TOOL = 'PROOFAPP_CREATE_RECORD';
const TERMINAL = new Set(['completed', 'completed_with_errors', 'error', 'failed', 'cancelled']);

interface CapabilityBlock {
  stepId?: string;
  tool?: string;
  toolkit?: string;
  reason?: string;
  provenNoDispatch?: boolean;
  state?: string;
  resumedAt?: string;
  resumeAuthorityConsumedAt?: string;
}

interface WorkflowRunRow {
  id?: string;
  status?: string;
  error?: unknown;
  capabilityBlock?: CapabilityBlock;
}

interface WorkflowEvent {
  kind?: string;
  stepId?: string;
  error?: string;
  meta?: Record<string, unknown>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function workflowRun(daemon: DaemonHandle, runId: string): Promise<WorkflowRunRow | null> {
  const response = await daemon.request('GET', `/api/console/workflows/${WORKFLOW_NAME}/runs`);
  if (response.status >= 300 || !response.json || typeof response.json !== 'object') return null;
  const rows = (response.json as { runs?: unknown }).runs;
  if (!Array.isArray(rows)) return null;
  return (rows as WorkflowRunRow[]).find((row) => row.id === runId) ?? null;
}

async function waitForRun(
  daemon: DaemonHandle,
  runId: string,
  predicate: (run: WorkflowRunRow) => boolean,
  timeoutMs = 8 * 60_000,
): Promise<WorkflowRunRow | null> {
  const deadline = Date.now() + timeoutMs;
  let last: WorkflowRunRow | null = null;
  while (Date.now() < deadline) {
    last = await workflowRun(daemon, runId);
    if (last && predicate(last)) return last;
    await sleep(250);
  }
  return last;
}

function workflowEvents(daemon: DaemonHandle, runId: string): WorkflowEvent[] {
  const file = path.join(
    daemon.home,
    'vault',
    '00-System',
    'workflows',
    WORKFLOW_NAME,
    'runs',
    runId,
    'events.jsonl',
  );
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try { return [JSON.parse(line) as WorkflowEvent]; } catch { return []; }
    });
}

function dispatches(daemon: DaemonHandle): string[] {
  const file = path.join(daemon.home, 'proof-composio-dispatches.log');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
}

export const capabilityReconnectResume: ScenarioDef = {
  name: 'capability-reconnect-resume',
  summary: 'workflow parks before disconnected write → reconnect → same run resumes once',
  routeExpectation: 'exact-workflow-step',
  async run(daemon: DaemonHandle) {
    const startedAt = Date.now();
    const checks: Check[] = [];
    const create = await daemon.request('POST', '/api/console/workflows', {
      name: WORKFLOW_NAME,
      description: 'Proof-only capability reconnect workflow.',
      enabled: true,
      steps: [
        {
          id: PREPARE_STEP,
          sideEffect: 'read',
          allowedTools: [],
          output: { type: 'object', required_keys: ['marker'], non_empty: ['marker'] },
          prompt: [
            'Return the exact structured result {"marker":"CAPABILITY_PREPARED"}.',
            'Use workflow_step_result exactly once when exposed; otherwise use the provider structured-output channel.',
            'Do not call any other tool.',
          ].join(' '),
        },
        {
          id: WRITE_STEP,
          dependsOn: [PREPARE_STEP],
          sideEffect: 'write',
          call: {
            tool: TOOL,
            args: { record_id: 'proof-record-1', marker: 'CAPABILITY_PREPARED' },
          },
        },
      ],
    });
    checks.push({ name: 'capability workflow fixture created', pass: create.status < 300, detail: `status ${create.status}` });

    let runId = '';
    if (create.status < 300) {
      const queued = await daemon.request('POST', `/api/console/workflows/${WORKFLOW_NAME}/run`, {});
      runId = String((queued.json as { id?: unknown } | null)?.id ?? '');
      checks.push({ name: 'capability workflow run queued', pass: queued.status < 300 && Boolean(runId), detail: `status ${queued.status}, run ${runId || 'missing'}` });
    }

    const blocked = runId
      ? await waitForRun(daemon, runId, (run) => run.status === 'blocked_capability')
      : null;
    checks.push({
      name: 'first disconnected write parked instead of failing',
      pass: blocked?.status === 'blocked_capability',
      detail: blocked ? `${blocked.status}: ${String(blocked.error ?? '')}` : 'run missing',
    });
    checks.push({
      name: 'park carries typed pre-dispatch authority',
      pass: blocked?.capabilityBlock?.stepId === WRITE_STEP
        && blocked.capabilityBlock.tool === TOOL
        && blocked.capabilityBlock.reason === 'not-connected'
        && blocked.capabilityBlock.provenNoDispatch === true
        && blocked.capabilityBlock.state === 'blocked',
      detail: JSON.stringify(blocked?.capabilityBlock ?? null),
    });

    const beforeEvents = runId ? workflowEvents(daemon, runId) : [];
    const prepareBefore = beforeEvents.filter((event) => event.kind === 'step_completed' && event.stepId === PREPARE_STEP).length;
    checks.push({
      name: 'completed upstream model work was preserved at the park',
      pass: prepareBefore === 1,
      detail: `prepare completions ${prepareBefore}`,
    });
    checks.push({
      name: 'zero fake provider dispatches occurred before reconnect',
      pass: dispatches(daemon).length === 0,
      detail: JSON.stringify(dispatches(daemon)),
    });

    // Simulate the user completing Composio login, then invalidate the same
    // runtime caches the real Connect flow invalidates.
    writeFileSync(path.join(daemon.home, 'proof-composio-connected'), 'connected\n', 'utf8');
    const refreshed = await daemon.request('POST', '/api/composio/refresh', {});
    checks.push({ name: 'reconnected capability refreshed runtime state', pass: refreshed.status === 200, detail: `status ${refreshed.status}` });

    const resumePath = `/api/console/workflows/${WORKFLOW_NAME}/runs/${encodeURIComponent(runId)}/resume-capability`;
    const [resumeA, resumeB] = runId
      ? await Promise.all([
          daemon.request('POST', resumePath, {}),
          daemon.request('POST', resumePath, {}),
        ])
      : [{ status: 0, json: {} }, { status: 0, json: {} }];
    checks.push({
      name: 'concurrent manual resumes converged idempotently',
      pass: resumeA.status === 200 && resumeB.status === 200,
      detail: JSON.stringify([{ status: resumeA.status, body: resumeA.json }, { status: resumeB.status, body: resumeB.json }]),
    });

    const finished = runId
      ? await waitForRun(daemon, runId, (run) => TERMINAL.has(String(run.status)), 10 * 60_000)
      : null;
    const afterEvents = runId ? workflowEvents(daemon, runId) : [];
    const prepareAfter = afterEvents.filter((event) => event.kind === 'step_completed' && event.stepId === PREPARE_STEP).length;
    const paused = afterEvents.filter((event) => event.kind === 'run_paused' && event.meta?.reason === 'capability_blocked');
    const resumed = afterEvents.filter((event) => event.kind === 'run_resumed' && event.meta?.reason === 'capability_retry');
    const fakeDispatches = dispatches(daemon);

    checks.push({
      name: 'same workflow run completed after reconnect',
      pass: finished?.id === runId && finished?.status === 'completed',
      detail: JSON.stringify(finished ?? null),
    });
    checks.push({
      name: 'upstream step was not replayed during resume',
      pass: prepareAfter === 1,
      detail: `prepare completions before=${prepareBefore}, after=${prepareAfter}`,
    });
    checks.push({
      name: 'external mutation dispatched exactly once after reconnect',
      pass: fakeDispatches.length === 1 && fakeDispatches[0] === TOOL,
      detail: JSON.stringify(fakeDispatches),
    });
    checks.push({
      name: 'one-shot resume authority was consumed durably',
      pass: finished?.capabilityBlock?.state === 'consumed'
        && Boolean(finished.capabilityBlock.resumedAt)
        && Boolean(finished.capabilityBlock.resumeAuthorityConsumedAt),
      detail: JSON.stringify(finished?.capabilityBlock ?? null),
    });
    checks.push({
      name: 'capability pause and resume are both visible in the run graph',
      pass: paused.length === 1 && resumed.length >= 1,
      detail: `paused ${paused.length}, resumed ${resumed.length}`,
    });
    checks.push(stormCheck(daemon.log()));

    let metrics = null;
    const stepSessionId = runId ? `workflow:${runId}:${PREPARE_STEP}` : '';
    try {
      const db = openHarnessDb(daemon.home);
      metrics = sessionMetrics(db, stepSessionId);
      db.close();
    } catch { /* exact route checks surface missing evidence */ }

    return {
      checks,
      latency: [{ wallMs: Date.now() - startedAt, ttftMs: metrics?.latency[0]?.ttftMs ?? metrics?.firstByteMs ?? null }],
      sessionId: stepSessionId,
      metrics: metrics ? { turns: metrics.turns, toolCallTotal: metrics.toolCallTotal } : undefined,
    };
  },
};
