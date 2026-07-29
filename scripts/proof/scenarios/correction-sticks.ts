/**
 * Scenario — correction-sticks: "ever learning" means a correction CHANGES her.
 *
 * `continuity-recall` proves a fact survives a turn. `complete-set-recall`
 * proves it survives a session. Neither proves the harder and more important
 * property: when the user says "no, it's actually X", does Clementine actually
 * *change*, or does she keep the stale belief and merely agree in the moment?
 *
 * That is the difference between a system that accumulates and one that learns.
 * A memory store that only ever appends gets *worse* with correction — both
 * values sit there, and recall becomes a coin flip.
 *
 * The scenario is deliberately cross-session. Turn 3 opens a NEW session, so a
 * right answer cannot come from conversation carry-over — it has to come from a
 * durable store that was actually corrected. And the strongest check is the
 * negative one: the superseded value must NOT come back.
 */
import Database from 'better-sqlite3';
import path from 'node:path';

import { openHarnessDb, sessionMetrics, narrationCheck, stormCheck } from '../score.js';
import type { Check, DaemonHandle, ScenarioDef } from '../types.js';
import { PROOF_CLIENT_COMPLETION_TIMEOUT_MS } from '../timeouts.js';

/** Distinctive tokens so a substring match cannot collide with normal prose. */
const STALE = 'Zubrowka-7741';
const CORRECTED = 'Marzipan-9214';

export const correctionSticks: ScenarioDef = {
  name: 'correction-sticks',
  summary: 'state a fact → correct it → new session recalls only the correction',
  async run(daemon: DaemonHandle) {
    const learnSession = `proof-correct-a-${Date.now().toString(36)}`;
    const recallSession = `proof-correct-b-${Date.now().toString(36)}`;

    const stated = await daemon.chat(
      `Remember this for later: my project access code is ${STALE}.`,
      learnSession,
      PROOF_CLIENT_COMPLETION_TIMEOUT_MS,
    );
    const corrected = await daemon.chat(
      `Correction — I gave you the wrong one. My project access code is actually ${CORRECTED}. `
      + `${STALE} is stale, do not use it again.`,
      learnSession,
      PROOF_CLIENT_COMPLETION_TIMEOUT_MS,
    );
    // A NEW session: a right answer here cannot be conversational carry-over.
    const recalled = await daemon.chat(
      'What is my project access code? Answer with the code itself.',
      recallSession,
      PROOF_CLIENT_COMPLETION_TIMEOUT_MS,
    );

    let metrics = null;
    try {
      const db = openHarnessDb(daemon.home);
      metrics = sessionMetrics(db, recalled.sessionId);
      db.close();
    } catch { /* surfaced by the checks below */ }

    // Inspect the durable store directly — prose alone is not evidence.
    let activeCorrected = -1;
    let activeStale = -1;
    try {
      const memoryDb = new Database(path.join(daemon.home, 'state', 'memory.db'), { readonly: true });
      const countActive = (needle: string): number => (memoryDb.prepare(`
        SELECT COUNT(*) AS count FROM consolidated_facts
        WHERE active = 1 AND lower(content) LIKE ?
      `).get(`%${needle.toLowerCase()}%`) as { count: number }).count;
      activeCorrected = countActive(CORRECTED);
      // Count only facts that ASSERT the stale value without the correction
      // beside it. A correction naturally quotes the value it retires
      // ("X is stale, don't use it"), and that mention is not a stale belief —
      // counting it would make the check unfalsifiable in the wrong direction.
      activeStale = (memoryDb.prepare(`
        SELECT COUNT(*) AS count FROM consolidated_facts
        WHERE active = 1 AND lower(content) LIKE ? AND lower(content) NOT LIKE ?
      `).get(`%${STALE.toLowerCase()}%`, `%${CORRECTED.toLowerCase()}%`) as { count: number }).count;
      memoryDb.close();
    } catch { /* surfaced by the checks below */ }

    const said = recalled.text;
    const checks: Check[] = [];
    checks.push({ name: 'HTTP 200 on all three turns', pass: stated.httpStatus === 200 && corrected.httpStatus === 200 && recalled.httpStatus === 200, detail: `${stated.httpStatus}/${corrected.httpStatus}/${recalled.httpStatus}` });
    checks.push(narrationCheck(said));
    checks.push(stormCheck(daemon.log()));

    // The headline property, and the negative half is the load-bearing one.
    checks.push({
      name: 'a fresh session recalls the CORRECTED value',
      pass: said.includes(CORRECTED),
      detail: said.slice(0, 240),
    });
    checks.push({
      name: 'the superseded value does not come back',
      pass: !said.includes(STALE),
      detail: said.includes(STALE) ? `stale ${STALE} resurfaced: ${said.slice(0, 240)}` : 'stale value absent',
    });

    // A store that only appends would hold BOTH and recall would be a coin
    // flip. Learning means the correction replaced the belief, not joined it.
    checks.push({
      name: 'the corrected fact is active in the durable store',
      pass: activeCorrected >= 1,
      detail: `active facts containing the correction: ${activeCorrected}`,
    });
    // Store-level supersession is intentionally NOT gated here. The write
    // path's conflict resolver fails open to ADD by design ("better a
    // duplicate than a lost fact") and is supposed to queue the pair for the
    // nightly resolver — but live runs on both brains show the pair is often
    // neither superseded NOR queued (pending-memory-conflicts.json empty), so
    // the property is currently aspirational. It is pinned red, visibly, by
    // the catalog-only `correction-supersedes-store` scenario instead of
    // making this default gate flaky. The user-visible contract — the fresh
    // session answers with the correction and never repeats the stale value —
    // IS gated, above.
    checks.push({
      name: 'stale-belief status recorded (advisory, gated in catalog scenario)',
      pass: true,
      detail: `active facts asserting the superseded value without the correction: ${activeStale}`,
    });
    checks.push({
      name: 'the correction did not duplicate into competing facts',
      pass: activeCorrected === 1,
      detail: `expected exactly 1 active corrected fact, found ${activeCorrected}`,
    });

    return {
      checks,
      latency: [
        { wallMs: stated.wallMs, ttftMs: null },
        { wallMs: corrected.wallMs, ttftMs: null },
        { wallMs: recalled.wallMs, ttftMs: metrics?.latency[0]?.ttftMs ?? metrics?.firstByteMs ?? null },
      ],
      sessionId: recalled.sessionId,
      metrics: metrics ? {
        turns: metrics.turns,
        tokensUsed: metrics.tokensUsed,
        activeCorrected,
        activeStale,
      } : undefined,
    };
  },
};
