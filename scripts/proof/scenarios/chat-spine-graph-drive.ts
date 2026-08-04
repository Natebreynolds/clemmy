/**
 * chat-spine-graph-drive: the Clem 4 smoke's grep, as a permanent proof.
 *
 * The chat spine conversion (7068265d + 70174bfc) is default-on with no
 * rollout gate; its ONLY fallback is per-turn, automatic, and loud — one
 * console line containing "fell back to legacy order". A live turn that
 * answers normally could still have fallen back, so behavioral checks alone
 * cannot prove the graph drove it. The daemon log can: zero fallback lines
 * across real turns means every one of them was executor-driven.
 *
 * Two live turns (conversational + retrieval-shaped) rather than one, so the
 * assertion covers both compiled fast-path shapes in the same daemon.
 */
import { stormCheck } from '../score.js';
import type { Check, DaemonHandle, ScenarioDef } from '../types.js';

const FALLBACK_MARKER = 'fell back to legacy order';

export const chatSpineGraphDrive: ScenarioDef = {
  name: 'chat-spine-graph-drive',
  summary: 'live chat turns are driven by the compiled graph — zero legacy-order fallbacks',
  async run(daemon: DaemonHandle) {
    const nonce = Date.now().toString(36);
    const checks: Check[] = [];
    const startedAt = Date.now();

    const conversational = await daemon.chat(
      'Good morning — quick sanity check: in one sentence, what kinds of things can you help me with today?',
      `proof-spine-conv-${nonce}`,
      300_000,
    );
    checks.push({ name: 'conversational turn answered (HTTP 200)', pass: conversational.httpStatus === 200, detail: `status ${conversational.httpStatus}` });
    checks.push({ name: 'conversational reply is nonempty', pass: conversational.text.trim().length > 0, detail: conversational.text.slice(0, 120) });

    const retrieval = await daemon.chat(
      'What do you currently know about my preferences or prior work? Answer briefly from what you can recall.',
      `proof-spine-recall-${nonce}`,
      300_000,
    );
    checks.push({ name: 'retrieval-shaped turn answered (HTTP 200)', pass: retrieval.httpStatus === 200, detail: `status ${retrieval.httpStatus}` });
    checks.push({ name: 'retrieval reply is nonempty', pass: retrieval.text.trim().length > 0, detail: retrieval.text.slice(0, 120) });

    // The smoke's grep. Loud by design in the spine; silent here means every
    // accepted turn above was driven by its compiled graph.
    const log = daemon.log();
    const fallbackLines = log
      .split('\n')
      .filter((line) => line.includes(FALLBACK_MARKER));
    checks.push({
      name: 'zero legacy-order fallbacks — the graph drove every turn',
      pass: fallbackLines.length === 0,
      detail: fallbackLines.length === 0 ? undefined : fallbackLines.slice(0, 3).join(' | ').slice(0, 400),
    });
    checks.push(stormCheck(log));

    return {
      checks,
      latency: [{ wallMs: Date.now() - startedAt, ttftMs: null }],
      sessionId: conversational.sessionId,
      metrics: { fallbackLines: fallbackLines.length },
    };
  },
};
