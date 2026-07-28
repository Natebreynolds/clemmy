/**
 * Scenario — clean-turn-isolation: a trivial no-tools turn must stay LEAN and
 * ISOLATED. Pins three regression classes the token/schema work created:
 *
 *   1. TOOL SILENCE — a "what is 12*11" turn dispatches ZERO tools (no
 *      recall grind, no discovery sweep, no worker).
 *   2. TOKEN FLOOR — that turn's prompt stays bounded (≤ 30K input tokens).
 *      The pre-pruning failure mode was ~85K of registered-but-hidden tool
 *      schemas billed on every trivial turn; this catches any slide back.
 *   3. CONVERSATION ISOLATION — a scratch phrase given in session A with an
 *      explicit do-not-store instruction must not surface in a fresh
 *      session B. (Durable memory is deliberately user-global; this pins
 *      that DECLINED ephemera stays ephemeral, not that memory is siloed.)
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { openHarnessDb, sessionMetrics, reportBackCheck } from '../score.js';
import type { Check, DaemonHandle, ScenarioDef } from '../types.js';

const SCRATCH_PHRASE = 'quartz-lantern-echo';
const MAX_TRIVIAL_INPUT_TOKENS = 30_000;

function sessionInputTokens(home: string, sessionId: string): { calls: number; inputTokens: number } {
  const dir = path.join(home, 'state', 'token-usage');
  let calls = 0;
  let inputTokens = 0;
  if (!existsSync(dir)) return { calls, inputTokens };
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ndjson')) continue;
    for (const line of readFileSync(path.join(dir, file), 'utf-8').split('\n')) {
      if (!line.includes(sessionId)) continue;
      try {
        const row = JSON.parse(line) as { source?: string; inputTokens?: number };
        if (typeof row.source === 'string' && row.source.includes(sessionId)) {
          calls += 1;
          inputTokens += row.inputTokens ?? 0;
        }
      } catch { /* skip malformed line */ }
    }
  }
  return { calls, inputTokens };
}

export const cleanTurnIsolation: ScenarioDef = {
  name: 'clean-turn-isolation',
  summary: 'trivial no-tools turn: zero tools, bounded prompt, declined ephemera stays out of other sessions',
  routeExpectation: 'exact-brain',
  async run(daemon: DaemonHandle) {
    const checks: Check[] = [];
    const suffix = Date.now().toString(36);
    const sessionA = `proof-isolation-a-${suffix}`;
    const sessionB = `proof-isolation-b-${suffix}`;

    // Session A: ephemeral scratch content with an explicit do-not-store line.
    const turnA = await daemon.chat(
      `For this conversation only, here is a scratch phrase: ${SCRATCH_PHRASE}. `
      + 'Do NOT store it in memory or anywhere durable — just acknowledge you saw it.',
      sessionA,
      180_000,
    );
    checks.push({ name: 'session A acknowledged (HTTP 200)', pass: turnA.httpStatus === 200, detail: `status ${turnA.httpStatus}` });

    // Session B, turn 1: the trivial no-tools turn under measurement.
    const turnB = await daemon.chat(
      'What is 12 * 11? Reply with only the number.',
      sessionB,
      180_000,
    );
    checks.push({ name: 'trivial turn answers correctly', pass: /\b132\b/.test(turnB.text), detail: turnB.text.slice(0, 80) });
    checks.push(reportBackCheck(turnB.text));

    try {
      const db = openHarnessDb(daemon.home);
      const metrics = sessionMetrics(db, turnB.sessionId);
      const toolNames = Object.keys(metrics?.toolCalls ?? {});
      checks.push({
        name: 'trivial turn dispatched ZERO tools',
        pass: toolNames.length === 0,
        detail: toolNames.join(',') || 'none',
      });
      db.close();
    } catch (error) {
      checks.push({ name: 'harness.db readable for tool audit', pass: false, detail: String(error).slice(0, 120) });
    }

    const usage = sessionInputTokens(daemon.home, sessionB);
    checks.push({
      name: `trivial turn prompt bounded (≤ ${MAX_TRIVIAL_INPUT_TOKENS.toLocaleString()} input tokens)`,
      pass: usage.calls >= 1 && usage.inputTokens <= MAX_TRIVIAL_INPUT_TOKENS,
      detail: `${usage.inputTokens} input tokens across ${usage.calls} provider call(s)`,
    });

    // Session B, turn 2: declined ephemera must not resurface.
    const probe = await daemon.chat(
      'Have we discussed any scratch phrase or codeword in another conversation? '
      + 'If you know one, say it verbatim; otherwise reply exactly NONE.',
      sessionB,
      180_000,
    );
    checks.push({
      name: 'declined scratch phrase does not leak into a fresh session',
      pass: !probe.text.toLowerCase().includes(SCRATCH_PHRASE),
      detail: probe.text.slice(0, 120),
    });

    return {
      sessionId: turnB.sessionId,
      checks,
      latency: [{ wallMs: turnB.wallMs, ttftMs: null }],
    };
  },
};
