/**
 * Live regression for the 2026-07-19 wrong-roster/slow-recall incident.
 *
 * Turn 1 stores one complete, evidence-backed eight-person roster in an
 * isolated proof home. Turn 2 runs in a fresh session and explicitly permits
 * local memory only. Passing proves that complete-set facts survive projection,
 * outrank same-day episode noise, and do not open an external MCP surface just
 * because the user says "no emails".
 */
import { openHarnessDb, sessionMetrics, narrationCheck, reportBackCheck, stormCheck } from '../score.js';
import type { Check, DaemonHandle, ScenarioDef } from '../types.js';

const ROSTER = [
  ['Avery Rowan', 'avery.rowan@example.com'],
  ['Blair Solis', 'blair.solis@example.com'],
  ['Casey Harbor', 'casey.harbor@example.com'],
  ['Devon Quill', 'devon.quill@example.com'],
  ['Emery Vale', 'emery.vale@example.com'],
  ['Frankie Moss', 'frankie.moss@example.com'],
  ['Gray Linden', 'gray.linden@example.com'],
  ['Harper Wren', 'harper.wren@example.com'],
] as const;

const FACT = `The complete Northstar live-proof team roster has exactly 8 active people: ${ROSTER
  .map(([name, email]) => `${name} (${email})`)
  .join(', ')}.`;

export const completeSetRecall: ScenarioDef = {
  name: 'complete-set-recall',
  summary: 'eight-person roster stored once → exact cross-session local-memory recall',
  routeExpectation: 'exact-brain',
  async run(daemon: DaemonHandle) {
    const suffix = Date.now().toString(36);
    const storeSession = `proof-complete-set-store-${suffix}`;
    const recallSession = `proof-complete-set-recall-${suffix}`;

    const stored = await daemon.chat(
      `Use local memory only. Do not call any external connector. Call memory_remember exactly once with kind=project and this exact content, preserving every character: ${FACT} Then confirm briefly.`,
      storeSession,
      300_000,
    );
    const recalled = await daemon.chat(
      'Use only Clementine\'s local memory. Do not call any external connector. Do not write or change memory. Identify all eight active people on the complete Northstar live-proof team roster. Return names only, no emails, and do not invent.',
      recallSession,
      300_000,
    );

    const checks: Check[] = [
      { name: 'store turn HTTP 200', pass: stored.httpStatus === 200, detail: `status ${stored.httpStatus}` },
      { name: 'cross-session recall HTTP 200', pass: recalled.httpStatus === 200, detail: `status ${recalled.httpStatus}` },
      reportBackCheck(recalled.text),
      narrationCheck(recalled.text),
      stormCheck(daemon.log()),
    ];
    for (const [name] of ROSTER) {
      checks.push({
        name: `recalled ${name}`,
        pass: recalled.text.toLowerCase().includes(name.toLowerCase()),
        detail: recalled.text.toLowerCase().includes(name.toLowerCase()) ? undefined : recalled.text.slice(0, 240),
      });
    }

    let metrics = null;
    let localOnlyScope = false;
    try {
      const db = openHarnessDb(daemon.home);
      metrics = sessionMetrics(db, recallSession);
      const row = db.prepare(`
        SELECT data_json FROM events
        WHERE session_id = ? AND type = 'mcp_tool_scope'
        ORDER BY seq DESC LIMIT 1
      `).get(recallSession) as { data_json?: string } | undefined;
      if (row?.data_json) {
        const scope = JSON.parse(row.data_json) as { maxTools?: number; allowedServerSlugs?: string[] };
        localOnlyScope = scope.maxTools === 0 && (scope.allowedServerSlugs?.length ?? 0) === 0;
      }
      db.close();
    } catch { /* checks below report missing evidence */ }

    checks.push({ name: 'explicit local-only turn exposed zero external MCP tools', pass: localOnlyScope });
    checks.push({
      name: 'recall turn made no external writes',
      pass: (metrics?.externalWrites ?? 0) === 0,
      detail: `external writes: ${metrics?.externalWrites ?? 'n/a'}`,
    });
    checks.push({
      name: 'recall converged without a tool-search spiral',
      pass: (metrics?.toolCallTotal ?? Number.POSITIVE_INFINITY) <= 2,
      detail: `tool calls: ${metrics?.toolCallTotal ?? 'n/a'} ${JSON.stringify(metrics?.toolCalls ?? {})}`,
    });

    return {
      checks,
      latency: [{ wallMs: recalled.wallMs, ttftMs: metrics?.latency[0]?.ttftMs ?? metrics?.firstByteMs ?? null }],
      sessionId: recallSession,
      metrics: metrics ? {
        turns: metrics.turns,
        tokensUsed: metrics.tokensUsed,
        toolCallTotal: metrics.toolCallTotal,
        toolCalls: metrics.toolCalls,
        primerInjectedBytes: metrics.primerInjectedBytes,
      } : undefined,
    };
  },
};
