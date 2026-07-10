/**
 * Scenario 3 — approval-park-resume: launch one real workflow step whose local
 * write is protected by the runner-owned declarative approval gate. The proof
 * resolves that card programmatically, then verifies one approval, one write,
 * one artifact, one completed run, and the exact step provider/transport.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { openHarnessDb, sessionMetrics, stormCheck } from '../score.js';
import type { Check, DaemonHandle, ScenarioDef } from '../types.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const WORKFLOW_NAME = 'proof-workflow-approved-write';
const STEP_ID = 'write-approved-artifact';
const TERMINAL_RUN_STATUSES = new Set(['completed', 'error', 'failed', 'cancelled']);

interface ApprovalRow {
  approvalId?: string;
  sessionId?: string;
  status?: string;
}

interface WorkflowRunRow {
  id?: string;
  status?: string;
  output?: unknown;
  stepOutputs?: unknown;
  error?: unknown;
}

interface ApprovalAuditRow {
  approval_id: string;
  session_id: string;
  status: string;
  resolution: string | null;
  tool: string | null;
}

interface WorkflowEventRow {
  kind?: string;
  stepId?: string;
  output?: unknown;
}

function approvalsFromResponse(json: unknown): ApprovalRow[] {
  if (Array.isArray(json)) return json as ApprovalRow[];
  if (!json || typeof json !== 'object') return [];
  const body = json as { approvals?: unknown; pending?: unknown };
  if (Array.isArray(body.approvals)) return body.approvals as ApprovalRow[];
  return Array.isArray(body.pending) ? body.pending as ApprovalRow[] : [];
}

async function pendingApprovalsForRun(daemon: DaemonHandle, runId: string): Promise<ApprovalRow[]> {
  const res = await daemon.request('GET', '/api/console/approvals/list');
  if (res.status >= 300) return [];
  const gateSessionId = `workflow-gate:${runId}:${STEP_ID}`;
  const stepSessionId = `workflow:${runId}:${STEP_ID}`;
  return approvalsFromResponse(res.json).filter((row) => (
    row.status !== 'resolved'
    && (row.sessionId === gateSessionId || row.sessionId === stepSessionId)
  ));
}

async function workflowRun(daemon: DaemonHandle, runId: string): Promise<WorkflowRunRow | null> {
  const res = await daemon.request('GET', `/api/console/workflows/${WORKFLOW_NAME}/runs`);
  if (res.status >= 300 || !res.json || typeof res.json !== 'object') return null;
  const rows = (res.json as { runs?: unknown }).runs;
  if (!Array.isArray(rows)) return null;
  return (rows as WorkflowRunRow[]).find((row) => row.id === runId) ?? null;
}

async function waitForInitialApproval(
  daemon: DaemonHandle,
  runId: string,
): Promise<{ approval: ApprovalRow | null; run: WorkflowRunRow | null }> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const [approvals, run] = await Promise.all([
      pendingApprovalsForRun(daemon, runId),
      workflowRun(daemon, runId),
    ]);
    if (approvals[0]?.approvalId) return { approval: approvals[0], run };
    if (run?.status && TERMINAL_RUN_STATUSES.has(run.status)) return { approval: null, run };
    await sleep(1_000);
  }
  return { approval: null, run: await workflowRun(daemon, runId) };
}

async function waitForTerminalRun(
  daemon: DaemonHandle,
  runId: string,
  approvedId: string,
): Promise<{ run: WorkflowRunRow | null; unexpectedApprovals: ApprovalRow[] }> {
  const deadline = Date.now() + 420_000;
  while (Date.now() < deadline) {
    const [approvals, run] = await Promise.all([
      pendingApprovalsForRun(daemon, runId),
      workflowRun(daemon, runId),
    ]);
    const unexpectedApprovals = approvals.filter((row) => row.approvalId && row.approvalId !== approvedId);
    if (unexpectedApprovals.length > 0) return { run, unexpectedApprovals };
    if (run?.status && TERMINAL_RUN_STATUSES.has(run.status)) return { run, unexpectedApprovals: [] };
    await sleep(1_500);
  }
  return { run: await workflowRun(daemon, runId), unexpectedApprovals: [] };
}

function approvalAudit(daemon: DaemonHandle, runId: string): ApprovalAuditRow[] {
  const db = openHarnessDb(daemon.home);
  try {
    return db.prepare(
      `SELECT approval_id, session_id, status, resolution, tool
         FROM pending_approvals
        WHERE session_id IN (?, ?)
        ORDER BY requested_at ASC`,
    ).all(
      `workflow-gate:${runId}:${STEP_ID}`,
      `workflow:${runId}:${STEP_ID}`,
    ) as ApprovalAuditRow[];
  } finally {
    db.close();
  }
}

function actualToolDispatchCount(daemon: DaemonHandle, sessionId: string, tool: string): number {
  const db = openHarnessDb(daemon.home);
  try {
    const row = db.prepare(
      `SELECT COUNT(*) AS count
         FROM events
        WHERE session_id = ?
          AND type = 'tool_called'
          AND json_extract(data_json, '$.tool') = ?
          AND (
            json_type(data_json, '$.args') IS NOT NULL
            OR json_type(data_json, '$.arguments') IS NOT NULL
          )`,
    ).get(sessionId, tool) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  } finally {
    db.close();
  }
}

function workflowEvents(daemon: DaemonHandle, runId: string): WorkflowEventRow[] {
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
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try { return [JSON.parse(line) as WorkflowEventRow]; } catch { return []; }
    });
}

export const approvalParkResume: ScenarioDef = {
  name: 'approval-park-resume',
  summary: 'workflow write parks → one approval → one artifact → exact routed completion',
  routeExpectation: 'exact-workflow-step',
  async run(daemon: DaemonHandle) {
    const nonce = Date.now().toString(36);
    const marker = `WORKFLOW_APPROVAL_OK:${nonce}`;
    const target = path.join(daemon.home, 'proof', `workflow-approved-${nonce}.txt`);
    mkdirSync(path.dirname(target), { recursive: true });

    const checks: Check[] = [];
    let runId = '';
    let finalRun: WorkflowRunRow | null = null;
    let approvedId = '';
    let stepSessionId = '';
    const startedAt = Date.now();

    try {
      const create = await daemon.request('POST', '/api/console/workflows', {
        name: WORKFLOW_NAME,
        description: 'Proof-only approval-bearing workflow; safe local write.',
        enabled: false,
        steps: [{
          id: STEP_ID,
          sideEffect: 'write',
          requiresApproval: true,
          approvalPreview: `Create one proof artifact at ${target}`,
          allowedTools: ['write_file'],
          output: { type: 'object', required_keys: ['marker', 'path'], non_empty: ['marker', 'path'] },
          prompt: [
            `Call write_file exactly once to create ${JSON.stringify(target)}.`,
            `The complete file content must be exactly this one line: ${marker}`,
            'Do not use shell, do not create another file, and do not call write_file a second time.',
            `After the write succeeds, emit the final structured step result {"marker":${JSON.stringify(marker)},"path":${JSON.stringify(target)}}.`,
            'Use workflow_step_result exactly once when that result tool is exposed; otherwise return the same object through the provider structured-output channel.',
          ].join(' '),
        }],
      });
      checks.push({ name: 'approval workflow fixture created', pass: create.status < 300, detail: `status ${create.status}` });

      if (create.status < 300) {
        const queued = await daemon.request('POST', `/api/console/workflows/${WORKFLOW_NAME}/run`, {
          targetStepId: STEP_ID,
        });
        runId = String((queued.json as { id?: unknown } | null)?.id ?? '');
        stepSessionId = runId ? `workflow:${runId}:${STEP_ID}` : '';
        checks.push({ name: 'single-step workflow run queued', pass: queued.status < 300 && Boolean(runId), detail: `status ${queued.status}, run ${runId || 'missing'}` });
      }

      if (runId) {
        const initial = await waitForInitialApproval(daemon, runId);
        finalRun = initial.run;
        approvedId = initial.approval?.approvalId ?? '';
        checks.push({
          name: 'runner parked on one programmatic approval',
          pass: Boolean(approvedId),
          detail: approvedId || `no approval; run status ${initial.run?.status ?? 'unknown'}`,
        });
        checks.push({
          name: 'artifact absent before approval',
          pass: !existsSync(target),
          detail: existsSync(target) ? `${target} existed before approval` : target,
        });

        if (approvedId) {
          const approvalStatus = await daemon.approve(approvedId, 'approve');
          checks.push({ name: 'programmatic approval accepted', pass: approvalStatus < 300, detail: `status ${approvalStatus}, id ${approvedId}` });
          if (approvalStatus < 300) {
            const terminal = await waitForTerminalRun(daemon, runId, approvedId);
            finalRun = terminal.run;
            checks.push({
              name: 'no second approval after resume',
              pass: terminal.unexpectedApprovals.length === 0,
              detail: terminal.unexpectedApprovals.map((row) => row.approvalId).filter(Boolean).join(', ') || 'none',
            });
          }
        }
      }

      const artifactText = existsSync(target) ? readFileSync(target, 'utf-8').trim() : '';
      const events = runId ? workflowEvents(daemon, runId) : [];
      const approvalRows = runId ? approvalAudit(daemon, runId) : [];
      let stepMetrics = null;
      if (stepSessionId) {
        const db = openHarnessDb(daemon.home);
        try { stepMetrics = sessionMetrics(db, stepSessionId); } finally { db.close(); }
      }
      const rawWriteEvents = stepMetrics?.toolCalls.write_file ?? 0;
      const writeDispatches = stepSessionId ? actualToolDispatchCount(daemon, stepSessionId, 'write_file') : 0;
      const completedSteps = events.filter((event) => event.kind === 'step_completed' && event.stepId === STEP_ID);
      const completedRuns = events.filter((event) => event.kind === 'run_completed');
      const serializedRun = JSON.stringify(finalRun ?? {});

      checks.push({ name: 'workflow run completed', pass: finalRun?.status === 'completed', detail: `status ${finalRun?.status ?? 'missing'}${finalRun?.error ? `, error ${String(finalRun.error).slice(0, 180)}` : ''}` });
      checks.push({ name: 'exactly one write_file dispatch', pass: writeDispatches === 1, detail: `dispatches ${writeDispatches}; lifecycle events ${rawWriteEvents}; all tools ${JSON.stringify(stepMetrics?.toolCalls ?? {})}` });
      checks.push({ name: 'exact artifact content landed', pass: artifactText === marker, detail: artifactText ? artifactText.slice(0, 180) : `${target} missing or empty` });
      checks.push({ name: 'exactly one approval was minted and resolved', pass: approvalRows.length === 1 && approvalRows[0]?.status === 'resolved' && approvalRows[0]?.resolution === 'approved', detail: JSON.stringify(approvalRows) });
      checks.push({ name: 'workflow step completed exactly once', pass: completedSteps.length === 1, detail: `step_completed × ${completedSteps.length}` });
      checks.push({ name: 'workflow outcome reported exactly once', pass: completedRuns.length === 1 && serializedRun.includes(marker), detail: `run_completed × ${completedRuns.length}; marker in run record=${serializedRun.includes(marker)}` });
      checks.push(stormCheck(daemon.log()));

      return {
        checks,
        latency: [{ wallMs: Date.now() - startedAt, ttftMs: stepMetrics?.latency[0]?.ttftMs ?? stepMetrics?.firstByteMs ?? null }],
        sessionId: stepSessionId || undefined,
        metrics: {
          runId: runId || null,
          approvalId: approvedId || null,
          approvalsMinted: approvalRows.length,
          writeDispatches,
          rawWriteEvents,
          stepCompletedEvents: completedSteps.length,
          runCompletedEvents: completedRuns.length,
        },
      };
    } finally {
      if (runId && finalRun?.status !== 'completed') {
        try { await daemon.request('POST', `/api/console/workflows/${WORKFLOW_NAME}/runs/${runId}/cancel`, {}); } catch { /* best effort */ }
      }
      try { await daemon.request('DELETE', `/api/console/workflows/${WORKFLOW_NAME}`); } catch { /* best effort */ }
    }
  },
};
