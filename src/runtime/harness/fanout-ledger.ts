/**
 * FIX 7 — per-run fan-out coverage ledger. A thin, in-memory reconciliation of
 * "N items requested → which delivered, which failed" derived from run_worker
 * results, so a batch that partly failed reports honestly ("M of N failed")
 * instead of a hollow "done". Keyed by callId (dedupe-safe); `item` is a label.
 *
 * Pure + best-effort: a bug here must never break a turn. Scoped to a single
 * live run/turn (in-memory) — durable large-N progress is the forEach-workflow
 * path's job, not this. Behind CLEMMY_FANOUT_LEDGER (default off) because it
 * flips a previously-"done" partial batch to "blocked" — a report-back change
 * that needs its own soak before default-on.
 */
import { getRuntimeEnv } from '../../config.js';

export interface LedgerEntry {
  item: string | null;
  ok: boolean;
  reason?: string;
}

export interface LedgerSummary {
  total: number;
  done: number;
  failed: number;
  failedItems: string[];
}

// sessionId -> (callId -> entry). callId is the primary key so a re-emitted
// result for the same worker call updates rather than double-counts.
const ledgerBySession = new Map<string, Map<string, LedgerEntry>>();

export function fanoutLedgerEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_FANOUT_LEDGER', 'off') ?? 'off').toLowerCase() === 'on';
}

export function recordWorkerResult(input: {
  sessionId: string;
  callId: string;
  item?: string | null;
  ok: boolean;
  reason?: string;
}): void {
  try {
    if (!input.sessionId || !input.callId) return;
    let bySession = ledgerBySession.get(input.sessionId);
    if (!bySession) {
      // Crude bound for a long-lived daemon: drop the oldest-ish wholesale
      // rather than grow unboundedly. Ledgers are short-lived per run.
      if (ledgerBySession.size > 500) ledgerBySession.clear();
      bySession = new Map();
      ledgerBySession.set(input.sessionId, bySession);
    }
    bySession.set(input.callId, {
      item: input.item ?? null,
      ok: input.ok,
      reason: input.reason ? input.reason.slice(0, 200) : undefined,
    });
  } catch {
    // ledger is best-effort; never throw into a tool hook
  }
}

export function summarizeLedger(sessionId: string): LedgerSummary {
  const empty: LedgerSummary = { total: 0, done: 0, failed: 0, failedItems: [] };
  try {
    const bySession = ledgerBySession.get(sessionId);
    if (!bySession || bySession.size === 0) return empty;
    let done = 0;
    const failedItems: string[] = [];
    for (const entry of bySession.values()) {
      if (entry.ok) {
        done += 1;
      } else {
        failedItems.push(entry.item ?? '(unlabeled item)');
      }
    }
    return { total: bySession.size, done, failed: failedItems.length, failedItems };
  } catch {
    return empty;
  }
}

export function clearLedger(sessionId: string): void {
  try {
    ledgerBySession.delete(sessionId);
  } catch {
    /* best effort */
  }
}
