/**
 * FIX 7 — per-run fan-out coverage ledger. A thin, in-memory reconciliation of
 * "N items requested → which delivered, which failed" derived from run_worker
 * results, so a batch that partly failed reports honestly ("M of N failed")
 * instead of a hollow "done". Keyed by callId (dedupe-safe); `item` is a label.
 *
 * Pure + best-effort: a bug here must never break a turn. Scoped to a single
 * live run/turn (in-memory) — durable large-N progress is the forEach-workflow
 * path's job, not this. Default ON (CLEMMY_FANOUT_LEDGER=off to disable): on a
 * partial batch the background classifier reports "M of N failed" (blocked)
 * instead of a hollow done.
 */
import { getRuntimeEnv } from '../../config.js';
import { listEvents } from './eventlog.js';

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

// Default ON (validated 2026-06-02). `=off` is the emergency kill-switch.
// On a partial fan-out batch the background classifier reports "M of N failed"
// (blocked) instead of a hollow done — honest report-back for all users.
export function fanoutLedgerEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_FANOUT_LEDGER', 'on') ?? 'on').toLowerCase() !== 'off';
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

/**
 * Wave 4 Stage 1 (durable swarm resume): coverage summarized DIRECTLY from the
 * durable `worker_result` event log — the true, restart-surviving source — instead
 * of the per-process in-memory ledger. This is what `fanoutCoverageBlock` reads,
 * so a resumed swarm reports honest "M of N" with NO reliance on rehydrating a
 * volatile ledger (the earlier rehydrate keyed `pk:`/`it:` while the live hook
 * keyed by raw callId, so the two double-counted after resume, and the
 * auto-continue `clearLedger` wiped the rehydrated entries — adversarial review
 * ledger F1/F2). Dedups by packetKey (else item, else a per-event id); events
 * arrive ASC by seq so the LAST outcome wins (a failed-then-succeeded item
 * collapses to ok — no phantom failure after a successful retry/resume).
 * Best-effort: any read error yields empty coverage (callers treat total:0 as
 * "no fan-out to gate", never a hollow done).
 */
export function summarizeFanoutCoverage(sessionId: string): LedgerSummary {
  const empty: LedgerSummary = { total: 0, done: 0, failed: 0, failedItems: [] };
  try {
    if (!sessionId) return empty;
    const results = listEvents(sessionId, { types: ['worker_result'] });
    const byKey = new Map<string, { item: string | null; ok: boolean }>();
    let idx = 0;
    for (const e of results) {
      const d = e.data as { item?: unknown; ok?: unknown; packetKey?: unknown } | undefined;
      if (!d || typeof d.ok !== 'boolean') continue;
      const key = (typeof d.packetKey === 'string' && d.packetKey)
        ? `pk:${d.packetKey}`
        : (typeof d.item === 'string' && d.item ? `it:${d.item}` : `idx:${idx}`);
      byKey.set(key, { item: typeof d.item === 'string' ? d.item : null, ok: d.ok });
      idx += 1;
    }
    let done = 0;
    const failedItems: string[] = [];
    for (const v of byKey.values()) {
      if (v.ok) done += 1;
      else failedItems.push(v.item ?? '(unlabeled item)');
    }
    return { total: byKey.size, done, failed: failedItems.length, failedItems };
  } catch {
    return empty;
  }
}
