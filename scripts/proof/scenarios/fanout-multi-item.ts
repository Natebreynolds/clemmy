/**
 * Scenario 1 — fanout-multi-item: the 2026-07-01 "5-firm SEO" stress shape,
 * made hermetic (fictional firms, generative work only — no external calls).
 * Proves: a same-shape multi-item job completes ALL items without parking on
 * a turn budget, and the brain elects fan-out (run_worker waves) rather than
 * grinding serially.
 */
import { openHarnessDb, sessionMetrics, narrationCheck, reportBackCheck, stormCheck, tokenCeilingCheck } from '../score.js';
import type { Check, DaemonHandle, ScenarioDef } from '../types.js';

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
  async run(daemon: DaemonHandle) {
    const sessionId = `proof-fanout-${Date.now().toString(36)}`;
    const turn = await daemon.chat(PROMPT, sessionId, 900_000);

    const checks: Check[] = [];
    checks.push({ name: 'HTTP 200', pass: turn.httpStatus === 200, detail: `status ${turn.httpStatus}` });
    checks.push(reportBackCheck(turn.text));

    const missing = FIRMS.filter((f) => !turn.text.toLowerCase().includes(f.toLowerCase()));
    checks.push({
      name: 'all 5 firms covered',
      pass: missing.length === 0,
      detail: missing.length ? `missing: ${missing.join(', ')}` : undefined,
    });
    checks.push({
      name: 'no park / continue ask',
      pass: !/say continue|awaiting.continue|reached (the )?turn|maximum number of turns/i.test(turn.text),
    });
    checks.push(narrationCheck(turn.text));
    checks.push(stormCheck(daemon.log()));

    let metrics = null;
    try {
      const db = openHarnessDb(daemon.home);
      metrics = sessionMetrics(db, turn.sessionId);
      db.close();
    } catch { /* scored checks below handle null */ }

    // The SDK brain lane logs each worker as a worker_result event; the Codex
    // lane logs run_worker tool_called events. Either is proof of fan-out.
    const workerCalls = Math.max(metrics?.toolCalls['run_worker'] ?? 0, metrics?.workerResults ?? 0);
    checks.push({
      name: 'fan-out elected (workers ≥ 2)',
      pass: workerCalls >= 2,
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
      latency: [{ wallMs: turn.wallMs, ttftMs: metrics?.latency[0]?.ttftMs ?? metrics?.firstByteMs ?? null }],
      sessionId: turn.sessionId,
      metrics: metrics ? { turns: metrics.turns, toolCallTotal: metrics.toolCallTotal, toolCalls: metrics.toolCalls, tokensUsed: metrics.tokensUsed, autoContinues: metrics.autoContinues } : undefined,
    };
  },
};
