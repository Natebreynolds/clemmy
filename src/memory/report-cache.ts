/**
 * A memory report the Memory screen polls (readiness, health) is computed
 * from dozens of queries on the daemon's own thread. Every poll recomputed it
 * even when nothing in memory had changed (live 2026-10-27: the readiness
 * read held the daemon loop 1.6–2.7 s every 30 s while the screen was open).
 *
 * The report is recomputed only after the memory store changed, and at most
 * once per floor while it keeps changing; an unchanged store serves the last
 * report. Change is read from SQLite's own data_version on a separate
 * read-only connection, which moves whenever any other connection commits.
 */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';

export interface MemoryReportCache<T> {
  read(now?: number): T;
  /** Drop the retained report so the next read recomputes. */
  reset(): void;
}

export function createMemoryReportCache<T>(input: {
  databasePath: string;
  compute: () => T;
  /** Minimum age of a retained report before a changed store recomputes it. */
  floorMs?: number;
}): MemoryReportCache<T> {
  const floorMs = input.floorMs ?? 15_000;
  let retained: { report: T; version: number; at: number } | null = null;
  let probe: Database.Database | null = null;
  const version = (): number | null => {
    try {
      if (!existsSync(input.databasePath)) return null;
      probe ??= new Database(input.databasePath, { readonly: true, fileMustExist: true });
      const value = probe.pragma('data_version', { simple: true });
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    } catch {
      try { probe?.close(); } catch { /* already closed */ }
      probe = null;
      return null;
    }
  };
  return {
    read(now = Date.now()) {
      const current = version();
      if (retained && current !== null
        && (current === retained.version || now - retained.at < floorMs)) return retained.report;
      const report = input.compute();
      retained = current === null ? null : { report, version: current, at: now };
      return report;
    },
    reset() { retained = null; },
  };
}
