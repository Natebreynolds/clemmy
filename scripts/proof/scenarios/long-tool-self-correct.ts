/**
 * Scenario 2 — long-tool-self-correct: a slow tool call (70s sleep) must not
 * wedge, pause, or kill the run. Proves the "long tool call" class completes
 * without a mid-run "retry/switch/stop?" question (the 2026-06-25 prod pause)
 * and without narration/storms.
 */
import { openHarnessDb, sessionMetrics, narrationCheck, reportBackCheck, stormCheck } from '../score.js';
import type { Check, DaemonHandle, ScenarioDef } from '../types.js';

const MARKER = 'MARKER-XYZ-42';

export const longToolSelfCorrect: ScenarioDef = {
  name: 'long-tool-self-correct',
  summary: '70s shell sleep → completes, no mid-run pause',
  async run(daemon: DaemonHandle) {
    const sessionId = `proof-longtool-${Date.now().toString(36)}`;
    const turn = await daemon.chat(
      `Run this exact local shell command and then report its output verbatim: sleep 70 && echo ${MARKER}. `
      + 'It intentionally takes over a minute — wait for it, do not give up, do not ask me anything.',
      sessionId,
      600_000,
    );

    const checks: Check[] = [];
    checks.push({ name: 'HTTP 200', pass: turn.httpStatus === 200, detail: `status ${turn.httpStatus}` });
    checks.push(reportBackCheck(turn.text));
    checks.push({ name: 'marker in reply', pass: turn.text.includes(MARKER), detail: turn.text.slice(0, 160) });
    checks.push({
      name: 'no mid-run pause question',
      pass: !/retry.{0,20}switch.{0,20}stop|should I (retry|continue|keep waiting)|do you want me to/i.test(turn.text),
    });
    checks.push({ name: 'actually waited (wall ≥ 70s)', pass: turn.wallMs >= 70_000, detail: `${Math.round(turn.wallMs / 1000)}s` });
    checks.push(narrationCheck(turn.text));
    checks.push(stormCheck(daemon.log()));

    let metrics = null;
    try {
      const db = openHarnessDb(daemon.home);
      metrics = sessionMetrics(db, turn.sessionId);
      db.close();
    } catch { /* metrics optional here */ }

    return {
      checks,
      latency: [{ wallMs: turn.wallMs, ttftMs: metrics?.latency[0]?.ttftMs ?? metrics?.firstByteMs ?? null }],
      sessionId: turn.sessionId,
      metrics: metrics ? { turns: metrics.turns, toolCallTotal: metrics.toolCallTotal } : undefined,
    };
  },
};
