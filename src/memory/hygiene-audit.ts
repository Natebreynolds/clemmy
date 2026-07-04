import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';

/**
 * A small, bounded audit trail for AUTOMATIC memory hygiene (nightly decay +
 * dedup). Soft-delete already makes every retirement recoverable; this makes it
 * REVIEWABLE — the owner can see what the janitor retired last night, and why,
 * then restore anything it shouldn't have touched. Best-effort + bounded (last
 * N lines) — it must never break a daemon tick, and it never drives a mutation
 * (read-only telemetry; the facts themselves remain the source of truth and are
 * still visible via the inactive-facts view).
 */
const AUDIT_FILE = path.join(BASE_DIR, 'state', 'memory-hygiene.jsonl');
const MAX_LINES = 2000;

export interface HygieneAuditEntry {
  at: string;
  kind: 'decay' | 'dedup' | 'autoclean' | 'approve-dedup' | 'approve-lift' | 'approve-retire' | 'approve-improve' | 'merge' | 'memory-heal' | 'memory-heal-revert';
  ids: number[];
  detail?: Record<string, unknown>;
}

export function appendHygieneAudit(entry: HygieneAuditEntry): void {
  try {
    mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    appendFileSync(AUDIT_FILE, `${JSON.stringify(entry)}\n`);
    // Bound the file so months of nightly passes can't grow it unbounded.
    const lines = readFileSync(AUDIT_FILE, 'utf-8').split('\n').filter(Boolean);
    if (lines.length > MAX_LINES) {
      writeFileSync(AUDIT_FILE, `${lines.slice(-MAX_LINES).join('\n')}\n`);
    }
  } catch {
    // best-effort; an audit write must never break the hygiene tick.
  }
}

export function readHygieneAudit(limit = 200): HygieneAuditEntry[] {
  try {
    if (!existsSync(AUDIT_FILE)) return [];
    const lines = readFileSync(AUDIT_FILE, 'utf-8').split('\n').filter(Boolean);
    return lines
      .slice(-Math.max(1, limit))
      .reverse()
      .map((line) => { try { return JSON.parse(line) as HygieneAuditEntry; } catch { return null; } })
      .filter((e): e is HygieneAuditEntry => e !== null);
  } catch {
    return [];
  }
}
