/**
 * Scenario 5 — continuity-recall: multi-turn memory. Turn 1 teaches a
 * codeword; turn 2 asks for it back in a paraphrase. Proves session
 * continuity + the recall/primer path actually injects (the June audit's
 * "codeword recalled turn 2" smoke, automated).
 */
import { openHarnessDb, sessionMetrics, narrationCheck, reportBackCheck, stormCheck } from '../score.js';
import type { Check, DaemonHandle, ScenarioDef } from '../types.js';
import Database from 'better-sqlite3';
import path from 'node:path';

const CODEWORD = 'tangerine-osprey-42';

export const continuityRecall: ScenarioDef = {
  name: 'continuity-recall',
  summary: 'codeword taught turn 1 → paraphrased ask turn 2 → recalled',
  async run(daemon: DaemonHandle) {
    const sessionId = `proof-recall-${Date.now().toString(36)}`;

    const turn1 = await daemon.chat(
      `Remember this: the codeword for the Falcon project is "${CODEWORD}". Just confirm you've noted it — nothing else.`,
      sessionId,
      300_000,
    );
    const turn2 = await daemon.chat(
      'What was the secret phrase for that bird-themed project I told you about a moment ago?',
      sessionId,
      300_000,
    );

    const checks: Check[] = [];
    checks.push({ name: 'turn 1 HTTP 200', pass: turn1.httpStatus === 200, detail: `status ${turn1.httpStatus}` });
    checks.push({ name: 'turn 2 HTTP 200', pass: turn2.httpStatus === 200, detail: `status ${turn2.httpStatus}` });
    checks.push(reportBackCheck(turn2.text));
    checks.push({
      name: 'codeword recalled on turn 2',
      pass: turn2.text.toLowerCase().includes(CODEWORD),
      detail: turn2.text.toLowerCase().includes(CODEWORD) ? undefined : turn2.text.slice(0, 160),
    });
    checks.push({
      name: 'no amnesia symptom',
      pass: !/no (chat |conversation )?history|don'?t (have|recall) (any|that)|haven'?t told me/i.test(turn2.text),
    });
    checks.push(narrationCheck(turn2.text));
    checks.push(stormCheck(daemon.log()));

    let metrics = null;
    let decisionParseRetries = -1;
    try {
      const db = openHarnessDb(daemon.home);
      metrics = sessionMetrics(db, turn2.sessionId);
      decisionParseRetries = (db.prepare(`
        SELECT COUNT(*) AS count FROM events
        WHERE session_id = ? AND type = 'stall_retry_attempted'
          AND json_extract(data_json, '$.signal') = 'D_decision_unparsed'
      `).get(turn2.sessionId) as { count: number }).count;
      db.close();
    } catch { /* handled below */ }
    checks.push({
      name: 'context injected on turn 2 (primer/history)',
      pass: (metrics?.primerInjectedBytes ?? 0) > 0 || (metrics?.turns ?? 0) >= 2,
      detail: `primer bytes: ${metrics?.primerInjectedBytes ?? 'n/a'}, turns: ${metrics?.turns ?? 'n/a'}`,
    });
    checks.push({
      name: 'no completion-parse retry loop',
      pass: decisionParseRetries === 0 && (metrics?.turns ?? Number.POSITIVE_INFINITY) <= 4,
      detail: `decision retries: ${decisionParseRetries}, turn_started events: ${metrics?.turns ?? 'n/a'}`,
    });
    checks.push({
      name: 'remember mutation runs at most once',
      pass: (metrics?.toolCalls.memory_remember ?? 0) <= 1,
      detail: `memory_remember calls: ${metrics?.toolCalls.memory_remember ?? 'n/a'}`,
    });

    let activeCodewordFacts = -1;
    try {
      const memoryDb = new Database(path.join(daemon.home, 'state', 'memory.db'), { readonly: true });
      activeCodewordFacts = (memoryDb.prepare(`
        SELECT COUNT(*) AS count FROM consolidated_facts
        WHERE active = 1 AND lower(content) LIKE ?
      `).get(`%${CODEWORD.toLowerCase()}%`) as { count: number }).count;
      memoryDb.close();
    } catch { /* surfaced by the check */ }
    checks.push({
      name: 'one active canonical codeword fact',
      pass: activeCodewordFacts === 1,
      detail: `active facts containing the codeword: ${activeCodewordFacts}`,
    });

    return {
      checks,
      latency: [
        { wallMs: turn1.wallMs, ttftMs: metrics?.latency[0]?.ttftMs ?? metrics?.firstByteMs ?? null },
        { wallMs: turn2.wallMs, ttftMs: metrics?.latency[1]?.ttftMs ?? metrics?.firstByteMs ?? null },
      ],
      sessionId,
      metrics: metrics ? {
        turns: metrics.turns,
        tokensUsed: metrics.tokensUsed,
        primerInjectedBytes: metrics.primerInjectedBytes,
        memoryRememberCalls: metrics.toolCalls.memory_remember ?? 0,
        decisionParseRetries,
        activeCodewordFacts,
      } : undefined,
    };
  },
};
