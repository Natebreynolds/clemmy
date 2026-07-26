/**
 * Scenario 1 — fanout-multi-item: the 2026-07-01 "5-firm SEO" stress shape,
 * made hermetic (fictional firms, generative work only — no external calls).
 * Proves: a same-shape multi-item job completes ALL items without parking on
 * a turn budget, and the brain elects fan-out (run_worker waves) rather than
 * grinding serially.
 */
import { openHarnessDb, sessionMetrics, narrationCheck, reportBackCheck, stormCheck, tokenCeilingCheck } from '../score.js';
import type { Check, DaemonHandle, ScenarioDef } from '../types.js';
import { dispatchBackground, waitForTerminal } from './background-proof-helpers.js';

const FIRMS = [
  'Auric & Vale Law',
  'Meridian Injury Group',
  'Copperline Defense',
  'Harborlight Estate Law',
  'Bluegrass Family Legal',
];

const PROMPT = `For EACH of these 5 (fictional) law firms, produce an SEO snapshot: 3 bullet strengths, 3 bullet gaps, and a one-line recommended focus keyword. Firms:
${FIRMS.map((f, i) => `${i + 1}. ${f}`).join('\n')}

This is same-shape work per firm — parallelize it rather than grinding through serially. Finish ALL 5 firms in this run (do not stop early or ask to continue), then close with a comparison table ranking all five by SEO opportunity. Everything is fictional — invent plausible details; do not use external tools or live data.`;

export const fanoutMultiItem: ScenarioDef = {
  name: 'fanout-multi-item',
  summary: '5 same-shape items → all complete, fan-out elected, no park',
  routeExpectation: 'exact-brain',
  async run(daemon: DaemonHandle) {
    const sessionId = `proof-fanout-${Date.now().toString(36)}`;
    const startedAt = Date.now();
    const dispatched = await dispatchBackground(daemon, sessionId, PROMPT);
    const settled = await waitForTerminal(daemon, dispatched.taskId, 20 * 60_000);
    const task = settled.detail.task;
    const result = task.resultFull ?? task.result ?? '';

    const checks: Check[] = [];
    checks.push({ name: 'HTTP 200', pass: dispatched.turn.httpStatus === 200, detail: `status ${dispatched.turn.httpStatus}` });
    checks.push({
      name: 'durable fan-out task completed',
      pass: task.status === 'done',
      detail: `${task.status}: ${task.error ?? result.slice(0, 220)}`,
    });
    checks.push(reportBackCheck(result));

    const missing = FIRMS.filter((f) => !result.toLowerCase().includes(f.toLowerCase()));
    checks.push({
      name: 'all 5 firms covered',
      pass: missing.length === 0,
      detail: missing.length ? `missing: ${missing.join(', ')}` : undefined,
    });
    checks.push({
      name: 'no park / continue ask',
      pass: !/say continue|awaiting.continue|reached (the )?turn|maximum number of turns/i.test(result),
    });
    checks.push(narrationCheck(result));
    checks.push(stormCheck(daemon.log()));

    let metrics = null;
    try {
      const db = openHarnessDb(daemon.home);
      metrics = sessionMetrics(db, task.runSessionId);
      db.close();
    } catch { /* scored checks below handle null */ }

    // One batched run_worker call is the intended API. Actual worker_result
    // events prove that all five isolated workers ran; counting top-level calls
    // would mistake correct batching for no fan-out.
    const workerCalls = metrics?.workerResults ?? 0;
    checks.push({
      name: 'fan-out elected (5 isolated workers)',
      pass: workerCalls === FIRMS.length,
      detail: `workers × ${workerCalls}${metrics?.workerFailures ? ` (${metrics.workerFailures} failed)` : ''}`,
    });
    checks.push({
      name: 'no limit-exceeded park',
      pass: (metrics?.limitExceededEvents ?? 0) === 0,
      detail: metrics ? `limit events: ${metrics.limitExceededEvents}` : 'no eventlog session found',
    });
    checks.push(tokenCeilingCheck(metrics, 400_000));

    return {
      checks,
      latency: [{ wallMs: Date.now() - startedAt, ttftMs: metrics?.latency[0]?.ttftMs ?? metrics?.firstByteMs ?? null }],
      sessionId: task.runSessionId,
      metrics: metrics ? { turns: metrics.turns, toolCallTotal: metrics.toolCallTotal, toolCalls: metrics.toolCalls, tokensUsed: metrics.tokensUsed, autoContinues: metrics.autoContinues } : undefined,
    };
  },
};
