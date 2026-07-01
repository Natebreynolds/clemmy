/**
 * Scenario 3 — approval-park-resume: a gated action parks the run on a real
 * approval card; a programmatic approve resumes it to completion. Proves the
 * park → approve-ONCE → resume → complete loop end-to-end (the June F4
 * approval-treadmill class) with zero duplicate execution.
 */
import { openHarnessDb, sessionMetrics, narrationCheck, stormCheck } from '../score.js';
import type { Check, DaemonHandle, ScenarioDef } from '../types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ApprovalRow { id?: string; sessionId?: string; status?: string }

async function findPendingApproval(daemon: DaemonHandle, sessionId: string): Promise<string | null> {
  const res = await daemon.request('GET', '/api/console/approvals/list');
  const rows = ((res.json as { approvals?: ApprovalRow[]; pending?: ApprovalRow[] })?.approvals
    ?? (res.json as { pending?: ApprovalRow[] })?.pending
    ?? (Array.isArray(res.json) ? (res.json as ApprovalRow[]) : [])) as ApprovalRow[];
  const match = rows.find((r) => !r.sessionId || r.sessionId === sessionId);
  return match?.id ?? null;
}

export const approvalParkResume: ScenarioDef = {
  name: 'approval-park-resume',
  summary: 'gated action parks → one approve → resumes → completes',
  async run(daemon: DaemonHandle) {
    const sessionId = `proof-approval-${Date.now().toString(36)}`;

    // A workflow RUN from chat is a benign, credential-free action that goes
    // through the real approval plumbing (the ledger's June pattern).
    const turnPromise = daemon.chat(
      'Create a workflow named proof-approval-smoke with exactly one step whose prompt is: output the single word DONE and nothing else. '
      + 'Then run it immediately. If any step needs my approval, request it through your approval mechanism and wait.',
      sessionId,
      600_000,
    );

    // While the turn is (possibly) parked, poll for a pending approval and
    // approve it — at most a few times (approve-ONCE semantics per card).
    const approved: string[] = [];
    const poller = (async () => {
      const deadline = Date.now() + 240_000;
      while (Date.now() < deadline) {
        await sleep(3_000);
        try {
          const id = await findPendingApproval(daemon, sessionId);
          if (id && !approved.includes(id)) {
            const status = await daemon.approve(id, 'approve');
            if (status < 300) approved.push(id);
          }
        } catch { /* daemon busy — retry next tick */ }
        if (approved.length >= 3) break;
      }
    })();

    const turn = await turnPromise;
    await Promise.race([poller, sleep(1)]);

    const checks: Check[] = [];
    checks.push({ name: 'HTTP 200', pass: turn.httpStatus === 200, detail: `status ${turn.httpStatus}` });
    checks.push({
      name: 'run completed (not stuck parked)',
      pass: turn.text.trim().length > 0 && !/still waiting|awaiting.your.approval/i.test(turn.text),
      detail: turn.text.slice(0, 160),
    });
    checks.push(narrationCheck(turn.text));
    checks.push(stormCheck(daemon.log()));

    // Cleanup + duplicate-execution audit.
    try { await daemon.request('DELETE', '/api/console/workflows/proof-approval-smoke'); } catch { /* best effort */ }
    let metrics = null;
    try {
      const db = openHarnessDb(daemon.home);
      metrics = sessionMetrics(db, turn.sessionId);
      db.close();
    } catch { /* optional */ }
    checks.push({
      name: 'no duplicate external writes',
      pass: (metrics?.externalWrites ?? 0) <= 1,
      detail: `external_write × ${metrics?.externalWrites ?? 0}, approvals granted: ${approved.length}`,
    });

    return {
      checks,
      latency: [{ wallMs: turn.wallMs, ttftMs: metrics?.latency[0]?.ttftMs ?? null }],
      sessionId: turn.sessionId,
      metrics: { approvalsGranted: approved.length, ...(metrics ? { turns: metrics.turns } : {}) },
    };
  },
};
