/**
 * Scenario 6 — gated-mutation: a local mutating tool that is VISIBLE on the MCP
 * server but NOT in the SDK allowedTools list, so the call must round-trip
 * through the host canUseTool gate's ALLOW path (auto-approve, no human).
 *
 * This is the exact class of the 2026-07-02 end-of-day failure: task_hygiene
 * reached canUseTool, the allow response lacked `updatedInput`, the CLI's
 * control-protocol Zod parse rejected it, and the tool call died ("permission-
 * gate ZodError") — so the ledger cleanup silently never ran. The prior proof
 * scenarios only exercised allowlisted tools (CLI auto-allow, canUseTool never
 * fired) and missed it.
 */
import { openHarnessDb, sessionMetrics, narrationCheck, reportBackCheck, stormCheck } from '../score.js';
import type { Check, DaemonHandle, ScenarioDef } from '../types.js';

export const gatedMutation: ScenarioDef = {
  name: 'gated-mutation',
  summary: 'non-allowlisted local tool → canUseTool allow → tool actually executes',
  routeExpectation: 'exact-brain',
  async run(daemon: DaemonHandle) {
    const sessionId = `proof-gated-${Date.now().toString(36)}`;

    const turn = await daemon.chat(
      'Call the task_hygiene tool right now to tidy the task ledger, then report exactly what it returned. '
      + 'Do not describe the tool — actually call it. If the call errors, quote the error verbatim.',
      sessionId,
      300_000,
    );

    const checks: Check[] = [];
    checks.push({ name: 'HTTP 200', pass: turn.httpStatus === 200, detail: `status ${turn.httpStatus}` });
    checks.push(reportBackCheck(turn.text));
    checks.push({
      name: 'no permission-gate schema error',
      pass: !/updatedInput|ZodError|permission.?gate/i.test(turn.text),
      detail: /updatedInput|ZodError|permission.?gate/i.test(turn.text) ? turn.text.slice(0, 200) : undefined,
    });
    checks.push(narrationCheck(turn.text));
    checks.push(stormCheck(daemon.log()));

    let metrics = null;
    try {
      const db = openHarnessDb(daemon.home);
      metrics = sessionMetrics(db, turn.sessionId);
      db.close();
    } catch { /* covered by the check below */ }
    const hygieneCalls = metrics?.toolCalls?.task_hygiene ?? 0;
    checks.push({
      name: 'task_hygiene actually called (gate allow worked)',
      pass: hygieneCalls >= 1,
      detail: `task_hygiene × ${hygieneCalls}; all tools: ${JSON.stringify(metrics?.toolCalls ?? {})}`,
    });

    return {
      checks,
      latency: [{ wallMs: turn.wallMs, ttftMs: metrics?.latency[0]?.ttftMs ?? metrics?.firstByteMs ?? null }],
      sessionId: turn.sessionId,
      metrics: metrics ? { turns: metrics.turns, toolCallTotal: metrics.toolCallTotal } : undefined,
    };
  },
};
