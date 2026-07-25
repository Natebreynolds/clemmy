/**
 * Optional live Fusion canary. The answer is deterministic, read-only, and
 * small; the value of the scenario is proving the real cross-model route and
 * bounded verdict contract inside an isolated daemon, not testing arithmetic.
 */
import { narrationCheck, openHarnessDb, reportBackCheck, sessionMetrics, stormCheck } from '../score.js';
import type { Check, DaemonHandle, ScenarioDef } from '../types.js';

export const fusionBoundedVerifier: ScenarioDef = {
  name: 'fusion-bounded-verifier',
  summary: 'Codex authors → distinct checker accepts/corrects one bounded final',
  routeExpectation: 'exact-brain',
  async run(daemon: DaemonHandle) {
    const sessionId = `proof-fusion-${Date.now().toString(36)}`;
    const turn = await daemon.chat(
      'Cross-check this deterministic calculation and answer in one short sentence: how many cells are in a 17 by 19 grid?',
      sessionId,
      300_000,
    );

    let metrics = null;
    try {
      const db = openHarnessDb(daemon.home);
      metrics = sessionMetrics(db, turn.sessionId);
      db.close();
    } catch {
      /* route/Fusion checks in the runner fail closed with precise evidence */
    }

    const checks: Check[] = [
      { name: 'HTTP 200', pass: turn.httpStatus === 200, detail: `status ${turn.httpStatus}` },
      reportBackCheck(turn.text),
      {
        name: 'deterministic answer survived verification',
        pass: /\b323\b/.test(turn.text),
        detail: turn.text.slice(0, 240),
      },
      {
        name: 'typed verifier protocol never leaked to the user',
        pass: !/"verdict"\s*:|checker-(?:accepted|corrected|failed|timeout)/i.test(turn.text),
        detail: turn.text.slice(0, 240),
      },
      narrationCheck(turn.text),
      stormCheck(daemon.log()),
    ];

    return {
      checks,
      latency: [{ wallMs: turn.wallMs, ttftMs: metrics?.latency[0]?.ttftMs ?? metrics?.firstByteMs ?? null }],
      sessionId: turn.sessionId,
      metrics: metrics ? { turns: metrics.turns, toolCallTotal: metrics.toolCallTotal } : undefined,
    };
  },
};
