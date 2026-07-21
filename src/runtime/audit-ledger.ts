/**
 * Durable audit ledger (2026-07-20, attorney-bar integrity audit B3/B1) —
 * the "audit Clementine like an employee" record.
 *
 * The raw trust records (external_write events, approval cards/resolutions)
 * lived only in harness.db sessions, which are REAPED at 14 days (events +
 * pending_approvals are ON DELETE CASCADE), and workflow run records unlink
 * at 7 — so "who did Clem write to, when, under whose approval" was GONE two
 * weeks after the chat went terminal, and reconstructing even a fresh run
 * meant hand-joining four stores. For an office replacing an employee with
 * Clementine, that trail is the difference between auditable and not.
 *
 * This ledger is:
 *  - WRITTEN AT EVENT TIME from the two canonical seams (eventlog.appendEvent
 *    for external_write/external_write_failed/approval_requested; the approval
 *    registry's resolve() for resolutions) — every lane, present and future,
 *    inherits it automatically.
 *  - APPEND-ONLY JSONL, one file per month under BASE_DIR/audit/ — outside
 *    every session/run GC path; nothing in the codebase deletes it.
 *  - JOINABLE: each line carries sessionId (run-scoped step sessions share the
 *    workflow:<runId> prefix), callId, approvalId, targets, and timestamps, so
 *    one grep/export reconstructs a run end-to-end.
 *  - Best-effort by contract: a ledger failure never blocks the action itself
 *    (the primary event stores remain authoritative for execution decisions).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { BASE_DIR } from '../config.js';

const logger = pino({ name: 'clementine.audit-ledger' });

export const AUDIT_DIR = path.join(BASE_DIR, 'audit');

/** Event types mirrored from eventlog.appendEvent. Resolutions are ledgered
 *  from the approval registry's resolve() (the single canonical seam) instead,
 *  so a surface that also emits an approval_resolved event never duplicates. */
export const AUDIT_MIRRORED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'external_write',
  'external_write_failed',
  'approval_requested',
]);

export interface AuditRecord {
  at: string;
  kind: string;
  sessionId?: string;
  [key: string]: unknown;
}

function monthlyFile(at: Date): string {
  return path.join(AUDIT_DIR, `audit-${at.toISOString().slice(0, 7)}.jsonl`);
}

/** Append one record. Never throws; a failure logs and moves on. */
export function appendAuditRecord(record: Omit<AuditRecord, 'at'> & { at?: string }): void {
  try {
    const at = record.at ?? new Date().toISOString();
    mkdirSync(AUDIT_DIR, { recursive: true });
    appendFileSync(monthlyFile(new Date(at)), `${JSON.stringify({ at, ...record })}\n`, 'utf-8');
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), kind: record.kind }, 'audit ledger append failed');
  }
}

export interface AuditReadFilter {
  /** Matches sessionId exactly OR as a prefix (a workflow run's step sessions
   *  all share the `workflow:<runId>` prefix — pass that to get the whole run). */
  sessionPrefix?: string;
  sinceIso?: string;
  kinds?: string[];
  limit?: number;
}

/** Read matching records, oldest-first. Scans the monthly files. */
export function readAuditRecords(filter: AuditReadFilter = {}): AuditRecord[] {
  try {
    if (!existsSync(AUDIT_DIR)) return [];
    const kinds = filter.kinds && filter.kinds.length > 0 ? new Set(filter.kinds) : null;
    const out: AuditRecord[] = [];
    for (const file of readdirSync(AUDIT_DIR).filter((f) => /^audit-\d{4}-\d{2}\.jsonl$/.test(f)).sort()) {
      for (const line of readFileSync(path.join(AUDIT_DIR, file), 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        let record: AuditRecord;
        try { record = JSON.parse(line) as AuditRecord; } catch { continue; } // a torn tail line never breaks the read
        if (kinds && !kinds.has(record.kind)) continue;
        if (filter.sinceIso && record.at < filter.sinceIso) continue;
        if (filter.sessionPrefix) {
          const sess = typeof record.sessionId === 'string' ? record.sessionId : '';
          if (!(sess === filter.sessionPrefix || sess.startsWith(filter.sessionPrefix))) continue;
        }
        out.push(record);
        if (filter.limit && out.length >= filter.limit) return out;
      }
    }
    return out;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'audit ledger read failed');
    return [];
  }
}
