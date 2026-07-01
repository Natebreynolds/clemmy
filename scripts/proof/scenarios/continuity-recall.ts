/**
 * Scenario 5 — continuity-recall: multi-turn memory. Turn 1 teaches a
 * codeword; turn 2 asks for it back in a paraphrase. Proves session
 * continuity + the recall/primer path actually injects (the June audit's
 * "codeword recalled turn 2" smoke, automated).
 */
import { openHarnessDb, sessionMetrics, narrationCheck, reportBackCheck, stormCheck } from '../score.js';
import type { Check, DaemonHandle, ScenarioDef } from '../types.js';

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
    try {
      const db = openHarnessDb(daemon.home);
      metrics = sessionMetrics(db, turn2.sessionId);
      db.close();
    } catch { /* handled below */ }
    checks.push({
      name: 'context injected on turn 2 (primer/history)',
      pass: (metrics?.primerInjectedBytes ?? 0) > 0 || (metrics?.turns ?? 0) >= 2,
      detail: `primer bytes: ${metrics?.primerInjectedBytes ?? 'n/a'}, turns: ${metrics?.turns ?? 'n/a'}`,
    });

    return {
      checks,
      latency: [
        { wallMs: turn1.wallMs, ttftMs: metrics?.latency[0]?.ttftMs ?? null },
        { wallMs: turn2.wallMs, ttftMs: metrics?.latency[1]?.ttftMs ?? null },
      ],
      sessionId,
      metrics: metrics ? { turns: metrics.turns, tokensUsed: metrics.tokensUsed, primerInjectedBytes: metrics.primerInjectedBytes } : undefined,
    };
  },
};
