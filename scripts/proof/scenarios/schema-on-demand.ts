/**
 * Cross-brain schema-on-demand proof.
 *
 * The requested capability is deliberately described without spelling its
 * underscore tool name. A healthy lean surface must discover the omitted
 * schema, dispatch it through call_tool, and return grounded output. This pins
 * both sides of the contract: prompt efficiency must not become capability
 * loss, and the model must not answer "tool unavailable" after a weak match.
 */
import {
  narrationCheck,
  openHarnessDb,
  reportBackCheck,
  sessionMetrics,
  stormCheck,
} from '../score.js';
import type { Check, DaemonHandle, ScenarioDef } from '../types.js';

export const schemaOnDemand: ScenarioDef = {
  name: 'schema-on-demand',
  summary: 'cold schema → discover → gated dispatch → grounded workspace paths',
  routeExpectation: 'exact-brain',
  async run(daemon: DaemonHandle) {
    const sessionId = `proof-schema-demand-${Date.now().toString(36)}`;
    const turn = await daemon.chat(
      'Use your local tools to discover and report the configured workspace root paths. '
      + 'If the required tool is not currently loaded, discover it and invoke it. '
      + 'Do not run shell commands. Return only the paths.',
      sessionId,
      300_000,
    );

    const checks: Check[] = [
      { name: 'HTTP 200', pass: turn.httpStatus === 200, detail: `status ${turn.httpStatus}` },
      reportBackCheck(turn.text),
      {
        name: 'reply is grounded in the isolated workspace',
        pass: turn.text.includes(daemon.home),
        detail: turn.text.slice(0, 240),
      },
      narrationCheck(turn.text),
      stormCheck(daemon.log()),
    ];

    let metrics = null;
    let failedOpenVerdicts = -1;
    try {
      const db = openHarnessDb(daemon.home);
      metrics = sessionMetrics(db, turn.sessionId);
      failedOpenVerdicts = (db.prepare(`
        SELECT COUNT(*) AS count
        FROM events
        WHERE session_id = ?
          AND type = 'verdict_recorded'
          AND json_extract(data_json, '$.failedOpen') = 1
      `).get(turn.sessionId) as { count: number }).count;
      db.close();
    } catch { /* surfaced by checks below */ }

    const calls = metrics?.toolCalls ?? {};
    checks.push({
      name: 'schema acquisition stayed bounded',
      // Codex/GLM receive a compact name catalog and can go straight to
      // call_tool. Claude has no permanent catalog block and normally searches
      // first. Both are correct; forcing search would add a wasteful call.
      pass: (calls.tool_search ?? 0) <= 2 && (calls.call_tool ?? 0) <= 2,
      detail: `tool_search × ${calls.tool_search ?? 0}, call_tool × ${calls.call_tool ?? 0}`,
    });
    checks.push({
      name: 'deferred tool used the gated dispatcher',
      pass: (calls.call_tool ?? 0) >= 1 && (calls.workspace_roots ?? 0) >= 1,
      detail: `call_tool × ${calls.call_tool ?? 0}, workspace_roots × ${calls.workspace_roots ?? 0}`,
    });
    checks.push({
      name: 'no shell fallback',
      pass: (calls.run_shell_command ?? 0) === 0,
      detail: `run_shell_command × ${calls.run_shell_command ?? 0}`,
    });
    checks.push({
      name: 'completion did not fail open',
      pass: failedOpenVerdicts === 0,
      detail: `failed-open verdicts: ${failedOpenVerdicts}`,
    });

    return {
      checks,
      latency: [{
        wallMs: turn.wallMs,
        ttftMs: metrics?.latency[0]?.ttftMs ?? metrics?.firstByteMs ?? null,
      }],
      sessionId: turn.sessionId,
      metrics: metrics ? {
        turns: metrics.turns,
        tokensUsed: metrics.tokensUsed,
        toolCalls: calls,
      } : undefined,
    };
  },
};
