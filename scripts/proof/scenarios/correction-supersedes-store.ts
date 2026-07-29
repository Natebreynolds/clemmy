/**
 * Catalog-only scenario — correction-supersedes-store: the ASPIRATIONAL half
 * of the correction contract, kept deliberately red until the class is fixed.
 *
 * `correction-sticks` (default gate) pins what is true today: a fresh session
 * answers with the corrected value and never repeats the stale one. This
 * scenario pins what is NOT yet true: that the superseded belief is retired in
 * the durable store — either deactivated immediately, or at minimum recorded in
 * the pending-memory-conflicts queue so the nightly resolver can retire it.
 *
 * Live evidence (2026-07-29, both brains, multiple runs): the pair is often
 * neither superseded nor queued — the conflict resolver's fail-open ADD ran
 * without recording the pending conflict, so the stale belief is orphaned
 * active forever. Until that write path tracks the pair, this stays red on
 * purpose. Do NOT green it by weakening the checks.
 */
import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { Check, DaemonHandle, ScenarioDef } from '../types.js';
import { PROOF_CLIENT_COMPLETION_TIMEOUT_MS } from '../timeouts.js';

const STALE = 'Quillon-3317';
const CORRECTED = 'Verdanth-8846';

export const correctionSupersedesStore: ScenarioDef = {
  name: 'correction-supersedes-store',
  summary: 'ASPIRATIONAL: a correction retires the stale belief in the store, or queues it for retirement',
  async run(daemon: DaemonHandle) {
    const session = `proof-supersede-${Date.now().toString(36)}`;
    await daemon.chat(`Remember this: the deploy freeze codeword is ${STALE}.`, session, PROOF_CLIENT_COMPLETION_TIMEOUT_MS);
    await daemon.chat(
      `Correction — the deploy freeze codeword is actually ${CORRECTED}, not ${STALE}. Retire the old one.`,
      session,
      PROOF_CLIENT_COMPLETION_TIMEOUT_MS,
    );

    let staleOnlyActive = -1;
    try {
      const db = new Database(path.join(daemon.home, 'state', 'memory.db'), { readonly: true });
      staleOnlyActive = (db.prepare(`
        SELECT COUNT(*) AS count FROM consolidated_facts
        WHERE active = 1 AND lower(content) LIKE ? AND lower(content) NOT LIKE ?
      `).get(`%${STALE.toLowerCase()}%`, `%${CORRECTED.toLowerCase()}%`) as { count: number }).count;
      db.close();
    } catch { /* surfaced below */ }

    let queuedPairs = 0;
    try {
      const queueFile = path.join(daemon.home, 'state', 'pending-memory-conflicts.json');
      if (existsSync(queueFile)) {
        const parsed = JSON.parse(readFileSync(queueFile, 'utf-8')) as unknown[];
        queuedPairs = Array.isArray(parsed) ? parsed.length : 0;
      }
    } catch { /* surfaced below */ }

    const checks: Check[] = [{
      name: 'stale belief is retired OR tracked for retirement',
      pass: staleOnlyActive === 0 || queuedPairs > 0,
      detail: `stale-only active facts: ${staleOnlyActive}; pending-conflict queue entries: ${queuedPairs}`,
    }];

    return { checks, latency: [{ wallMs: 0, ttftMs: null }], sessionId: session, metrics: { turns: 2, staleOnlyActive, queuedPairs } };
  },
};
