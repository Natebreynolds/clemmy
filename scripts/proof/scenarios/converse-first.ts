/**
 * Scenario 7 — converse-first: an AMBIGUOUS multi-step action request must open
 * with a short consultative reply that asks a clarifying question — and must NOT
 * fire any mutating tool. Pins the converse-until-aligned interaction model
 * (clem-rubric.ts "CONVERSE FIRST") with a live turn, which no unit test observes.
 */
import { openHarnessDb, sessionMetrics, narrationCheck, reportBackCheck, stormCheck, MUTATING_TOOL_NAMES } from '../score.js';
import type { Check, DaemonHandle, ScenarioDef } from '../types.js';

export const converseFirst: ScenarioDef = {
  name: 'converse-first',
  summary: 'ambiguous multi-step ask → clarifying question, zero mutations',
  async run(daemon: DaemonHandle) {
    const sessionId = `proof-converse-${Date.now().toString(36)}`;

    // Deliberately ambiguous + multi-step + outward-facing: the rubric says this
    // exact shape opens with ONE plain clarifying question, not execution.
    const turn = await daemon.chat(
      'Clean up my pipeline and send the team an update about it.',
      sessionId,
      300_000,
    );

    const checks: Check[] = [];
    checks.push({ name: 'HTTP 200', pass: turn.httpStatus === 200, detail: `status ${turn.httpStatus}` });
    checks.push(reportBackCheck(turn.text));
    checks.push({
      name: 'reply asks a clarifying question',
      pass: /\?/.test(turn.text),
      detail: /\?/.test(turn.text) ? undefined : turn.text.slice(0, 200),
    });
    checks.push(narrationCheck(turn.text));
    checks.push(stormCheck(daemon.log()));

    let metrics = null;
    try {
      const db = openHarnessDb(daemon.home);
      metrics = sessionMetrics(db, turn.sessionId);
      db.close();
    } catch { /* tool-count check degrades below */ }
    const mutatingCalls = Object.entries(metrics?.toolCalls ?? {})
      .filter(([name]) => MUTATING_TOOL_NAMES.has(name))
      .reduce((a, [, n]) => a + n, 0);
    checks.push({
      name: 'zero mutating tool calls before alignment',
      pass: mutatingCalls === 0 && (metrics?.externalWrites ?? 0) === 0,
      detail: `mutating × ${mutatingCalls}, external_write × ${metrics?.externalWrites ?? 0}, tools: ${JSON.stringify(metrics?.toolCalls ?? {})}`,
    });

    return {
      checks,
      latency: [{ wallMs: turn.wallMs, ttftMs: metrics?.latency[0]?.ttftMs ?? null }],
      sessionId: turn.sessionId,
      metrics: metrics ? { turns: metrics.turns, toolCallTotal: metrics.toolCallTotal } : undefined,
    };
  },
};
