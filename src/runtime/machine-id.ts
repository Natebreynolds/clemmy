import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BASE_DIR } from '../config.js';

/**
 * Stable per-machine identifier used to scope memory that's specific
 * to "this device" — e.g. tool-choice records (a Salesforce CLI might
 * work on one laptop and not another, so the choice can't be a single
 * cross-machine fact).
 *
 * First call generates a UUID v4 and writes it to
 *   ~/.clementine-next/state/machine-id
 * Subsequent calls read that file. If the file is unreadable for any
 * reason, fall back to os.hostname() so dependent features still work
 * (they just won't survive a hostname change).
 *
 * The file is intentionally NOT included in any sync backup beyond
 * the vault itself — when a user copies their vault to another
 * machine the machine-id stays separate, and the destination machine
 * generates its own. This is what gives us "different machines may
 * pick different tools for the same intent" naturally.
 */
const MACHINE_ID_FILE = path.join(BASE_DIR, 'state', 'machine-id');

let cached: string | null = null;

export function getMachineId(): string {
  if (cached) return cached;
  cached = readOrCreateMachineId();
  return cached;
}

function readOrCreateMachineId(): string {
  try {
    if (existsSync(MACHINE_ID_FILE)) {
      const raw = readFileSync(MACHINE_ID_FILE, 'utf-8').trim();
      if (raw) return raw;
    }
    const id = randomUUID();
    mkdirSync(path.dirname(MACHINE_ID_FILE), { recursive: true });
    writeFileSync(MACHINE_ID_FILE, `${id}\n`, 'utf-8');
    return id;
  } catch {
    return safeHostname();
  }
}

function safeHostname(): string {
  try {
    const h = os.hostname();
    return h && h.length > 0 ? h : 'unknown-host';
  } catch {
    return 'unknown-host';
  }
}

/** Test-only: clear the in-process cache so the next call re-reads. */
export function resetMachineIdCacheForTests(): void {
  cached = null;
}
