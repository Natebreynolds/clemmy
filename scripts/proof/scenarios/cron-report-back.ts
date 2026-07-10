/**
 * Scenario 4 — cron-report-back: a scheduled workflow fires UNATTENDED within
 * its window and completes (the June ledger's 03:50 proof, automated). Proves
 * the scheduler tick → enqueue → run → report chain with no human in the loop.
 */
import type { Check, DaemonHandle, ScenarioDef } from '../types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WF_NAME = 'proof-cron-smoke';

interface RunRow {
  id?: string;
  status?: string;
  source?: string;
  output?: unknown;
  stepOutputs?: Record<string, unknown>;
  notifiedAt?: string;
}

export const cronReportBack: ScenarioDef = {
  name: 'cron-report-back',
  summary: 'scheduled workflow fires unattended within its window',
  routeExpectation: 'exact-workflow-step',
  async run(daemon: DaemonHandle) {
    const checks: Check[] = [];
    const started = Date.now();

    // Schedule 2 minutes out (minute-granular cron; scheduler tick is 15s).
    const fireAt = new Date(Date.now() + 2 * 60_000);
    const cron = `${fireAt.getMinutes()} ${fireAt.getHours()} * * *`;
    const create = await daemon.request('POST', '/api/console/workflows', {
      name: WF_NAME,
      description: 'proof harness cron smoke — safe to delete',
      triggerSchedule: cron,
      enabled: true,
      steps: [
        { id: 'produce', prompt: 'Output exactly the line: proof-cron-ok. Nothing else. No tools.' },
        { id: 'report', dependsOn: ['produce'], prompt: 'State the exact line the previous step produced. No tools.' },
      ],
    });
    checks.push({ name: 'workflow created + scheduled', pass: create.status < 300, detail: `status ${create.status} cron="${cron}"` });

    let run: RunRow | undefined;
    if (create.status < 300) {
      // Window: up to 4.5 min (2-min lead + run time + tick slack).
      const deadline = Date.now() + 270_000;
      while (Date.now() < deadline) {
        await sleep(10_000);
        try {
          const res = await daemon.request('GET', `/api/console/workflows/${WF_NAME}/runs`);
          const runs = ((res.json as { runs?: RunRow[] })?.runs ?? []) as RunRow[];
          run = runs.find((r) => r.status === 'completed') ?? runs[0];
          if ((run?.status === 'completed' && run.notifiedAt) || run?.status === 'failed') break;
        } catch { /* poll again */ }
      }
    }
    checks.push({ name: 'run fired unattended within window', pass: Boolean(run), detail: run ? `status ${run.status}` : 'no run appeared' });
    checks.push({ name: 'run completed', pass: run?.status === 'completed', detail: run?.status ?? 'n/a' });
    checks.push({ name: 'run originated from the scheduler', pass: run?.source === 'schedule', detail: run?.source ?? 'n/a' });
    const persistedOutput = JSON.stringify({ output: run?.output, stepOutputs: run?.stepOutputs });
    checks.push({
      name: 'exact scheduled result was persisted',
      pass: persistedOutput.includes('proof-cron-ok'),
      detail: persistedOutput.slice(0, 260),
    });
    checks.push({
      name: 'scheduled result report-back was durably marked',
      pass: typeof run?.notifiedAt === 'string' && run.notifiedAt.length > 0,
      detail: run?.notifiedAt ?? 'notifiedAt missing',
    });

    try { await daemon.request('DELETE', `/api/console/workflows/${WF_NAME}`); } catch { /* best effort */ }

    return {
      checks,
      latency: [{ wallMs: Date.now() - started, ttftMs: null }],
      sessionId: run?.id ? `workflow:${run.id}:report` : undefined,
      metrics: { cron, runStatus: run?.status ?? null, source: run?.source ?? null, notifiedAt: run?.notifiedAt ?? null },
    };
  },
};
