/**
 * Scenario 6 — gated-mutation: a local mutating tool that is VISIBLE on the MCP
 * server but NOT in the Claude SDK fast-allow list. Claude must round-trip
 * through canUseTool; schema-on-demand providers may expose it first-class or
 * use their generic dispatcher. Every lane must persist a successful inner call.
 *
 * This is the exact class of the 2026-07-02 end-of-day failure: task_hygiene
 * reached canUseTool, the allow response lacked `updatedInput`, the CLI's
 * control-protocol Zod parse rejected it, and the tool call died ("permission-
 * gate ZodError") — so the ledger cleanup silently never ran. The prior proof
 * scenarios only exercised allowlisted tools (CLI auto-allow, canUseTool never
 * fired) and missed it.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openHarnessDb, sessionMetrics, narrationCheck, reportBackCheck, stormCheck } from '../score.js';
import type { Check, DaemonHandle, ScenarioDef } from '../types.js';

export const gatedMutation: ScenarioDef = {
  name: 'gated-mutation',
  summary: 'catalog local mutation → provider gate → successful inner execution',
  routeExpectation: 'exact-brain',
  async run(daemon: DaemonHandle) {
    const sessionId = `proof-gated-${Date.now().toString(36)}`;
    const taskId = `T-${String(Date.now()).slice(-9)}`;
    const tasksPath = path.join(daemon.home, 'vault', '05-Tasks', 'TASKS.md');
    mkdirSync(path.dirname(tasksPath), { recursive: true });
    writeFileSync(tasksPath, [
      '---',
      'type: tasks',
      '---',
      '',
      '# Tasks',
      '',
      '## Pending',
      '',
      `- [ ] {${taskId}} Proof gated mutation row !!high 📅 2000-01-01`,
      '',
      '## Completed',
      '',
    ].join('\n'), 'utf-8');

    const turn = await daemon.chat(
      'Call the task_hygiene tool exactly once with {"apply":true,"close_stale_unowned_before":"2099-01-01"}, '
      + 'then report exactly what it returned. Do not describe the tool — actually call it. '
      + 'If the call errors, quote the error verbatim.',
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
    let successfulHygieneReturns = 0;
    try {
      const db = openHarnessDb(daemon.home);
      metrics = sessionMetrics(db, turn.sessionId);
      const rows = db.prepare(
        `SELECT data_json
           FROM events
          WHERE session_id = ?
            AND type = 'tool_returned'
            AND json_extract(data_json, '$.tool') = 'task_hygiene'`,
      ).all(turn.sessionId) as Array<{ data_json: string }>;
      successfulHygieneReturns = rows.filter((row) => {
        try {
          const data = JSON.parse(row.data_json) as { result?: unknown; preview?: unknown; error?: unknown };
          const output = String(data.result ?? data.preview ?? data.error ?? '');
          return /Task ledger hygiene \(apply\)/.test(output)
            && /Repaired: 1\b/.test(output)
            && /Compacted rows out of Pending: 1\b/.test(output)
            && !/hygiene failed/i.test(output);
        } catch {
          return false;
        }
      }).length;
      db.close();
    } catch { /* covered by the check below */ }
    const hygieneCalls = metrics?.toolCalls?.task_hygiene ?? 0;
    checks.push({
      name: 'task_hygiene completed through the provider gate',
      pass: hygieneCalls === 1 && successfulHygieneReturns >= 1,
      detail: `calls ${hygieneCalls}, successful returns ${successfulHygieneReturns}; all tools: ${JSON.stringify(metrics?.toolCalls ?? {})}`,
    });
    let taskBody = '';
    try { taskBody = readFileSync(tasksPath, 'utf-8'); } catch { /* check fails below */ }
    const pendingSection = taskBody.slice(taskBody.indexOf('## Pending'), taskBody.indexOf('## Completed'));
    const completedSection = taskBody.slice(taskBody.indexOf('## Completed'));
    checks.push({
      name: 'seeded task row moved from Pending to Completed',
      pass: !pendingSection.includes(taskId) && new RegExp(`- \\[x\\] \\{${taskId}\\}`).test(completedSection),
      detail: taskBody ? `${taskId}: pending=${pendingSection.includes(taskId)}, completed=${completedSection.includes(taskId)}` : `${tasksPath} missing`,
    });

    return {
      checks,
      latency: [{ wallMs: turn.wallMs, ttftMs: metrics?.latency[0]?.ttftMs ?? metrics?.firstByteMs ?? null }],
      sessionId: turn.sessionId,
      metrics: metrics ? { turns: metrics.turns, toolCallTotal: metrics.toolCallTotal } : undefined,
    };
  },
};
