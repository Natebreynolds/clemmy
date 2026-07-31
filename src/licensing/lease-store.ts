/**
 * The cached lease, and everything we remember about our last conversation
 * with the license server.
 *
 * This file is what makes the product usable offline: the lease it holds is
 * self-verifying, so a laptop with no network — or a license server that is
 * down — keeps working until the lease's grace window runs out.
 *
 * It is a plain 0600 JSON file, not a secret store. The lease is a signed
 * statement about this install; reading it grants nothing, and forging one
 * requires the server's private key.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import type { LeasePayload } from './lease.js';

export type LicenseCheckOutcome = 'ok' | 'rejected' | 'unreachable' | 'never';

export interface LeaseRecord {
  /** The compact signed lease, exactly as the server sent it. */
  leaseCompact?: string;
  /** Cached decode of the above — convenience only; the compact form is truth. */
  payload?: LeasePayload;
  activationId?: string;
  /** Highest server timestamp ever seen, so a backdated clock buys nothing. */
  serverTimeHighWater?: number;
  lastCheckAt?: string;
  lastCheckOutcome?: LicenseCheckOutcome;
  /** Verbatim server message when rejected — the user deserves the real reason. */
  lastCheckMessage?: string;
  consecutiveFailures?: number;
  /** Set when the local clock is behind the high-water mark. Advisory only. */
  clockUntrusted?: boolean;
}

function leaseFile(stateDir?: string): string {
  return path.join(stateDir ?? path.join(BASE_DIR, 'state'), 'license-lease.json');
}

export function readLeaseRecord(stateDir?: string): LeaseRecord {
  const file = leaseFile(stateDir);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as LeaseRecord;
  } catch {
    // A corrupt cache must not brick the install; treat it as "no lease yet"
    // and let the next check repair it.
    return {};
  }
}

export function writeLeaseRecord(next: LeaseRecord, stateDir?: string): void {
  const file = leaseFile(stateDir);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Temp file + rename: rename is atomic on POSIX, so a crash mid-write can
  // never leave a torn lease that would read as "unlicensed".
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

export function updateLeaseRecord(patch: Partial<LeaseRecord>, stateDir?: string): LeaseRecord {
  const current = readLeaseRecord(stateDir);
  const next: LeaseRecord = { ...current, ...patch };
  // The high-water mark only ever moves forward.
  if (patch.serverTimeHighWater !== undefined) {
    next.serverTimeHighWater = Math.max(current.serverTimeHighWater ?? 0, patch.serverTimeHighWater);
  }
  writeLeaseRecord(next, stateDir);
  return next;
}

export function clearLeaseRecord(stateDir?: string): void {
  writeLeaseRecord({}, stateDir);
}
