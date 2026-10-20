import type Database from 'better-sqlite3';
import { openEventLog } from './eventlog.js';
import { parseResolvedCallAuthority } from './resolved-call-authority.js';
import { readPendingUnacknowledgedWritesForSourceRead } from './pending-unacknowledged-writes-read.js';
export type { PendingUnacknowledgedWrite, ResolvedUnacknowledgedWrite, PendingUnacknowledgedWrites } from './pending-unacknowledged-writes-read.js';

export function readPendingUnacknowledgedWritesForSource(input: { sessionId: string; sourceUserSeq: number }, suppliedDatabase?: Database.Database) {
  return readPendingUnacknowledgedWritesForSourceRead(input, () => suppliedDatabase ?? openEventLog(), { parseResolvedCallAuthority });
}
