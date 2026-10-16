import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../../config.js';
import { withFileLockSyncStrict } from '../../runtime/atomic-json.js';
import type { CliHealth } from './auth-health.js';
import type { ConnectedCliRecord } from './catalog.js';
export { cliHealthMatchesConnection, connectedCliRevision } from './cli-connection-revision.js';

export const CONNECTED_CLI_FILE = path.join(BASE_DIR, 'state', 'connected-clis.json');
export const CONNECTED_CLI_BIN_DIR = path.join(BASE_DIR, 'state', 'connected-cli-bin');
const HEALTH_FILE = path.join(BASE_DIR, 'state', 'cli-auth-health.json');

export interface ConnectedCliState {
  entries: Record<string, ConnectedCliRecord>;
  forgotten: string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The one short, synchronous ownership boundary for roster/health/pin writes.
 * It never waits for a probe, resolution, child or another event-loop turn. */
export function withConnectedCliStateLock<T>(work: () => T): T {
  mkdirSync(path.dirname(CONNECTED_CLI_FILE), { recursive: true });
  return withFileLockSyncStrict(CONNECTED_CLI_FILE, () => {
    readConnectedCliState({ strict: true });
    return work();
  }, { timeoutMs: 0 });
}

export function readConnectedCliState(options: { strict?: boolean } = {}): ConnectedCliState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(CONNECTED_CLI_FILE, 'utf8'));
    if (!record(parsed) || parsed.version !== 'v1' || !record(parsed.entries)
      || parsed.forgotten !== undefined && (!Array.isArray(parsed.forgotten)
        || !parsed.forgotten.every(id => typeof id === 'string'))) {
      throw new Error('Malformed connected CLI state');
    }
    return { entries: parsed.entries as Record<string, ConnectedCliRecord>,
      forgotten: Array.isArray(parsed.forgotten) ? parsed.forgotten.filter((id): id is string => typeof id === 'string') : [] };
  } catch (error) {
    if (options.strict && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { entries: {}, forgotten: [] };
  }
}

function writeState(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(temp, file);
}

/** Call only while holding withConnectedCliStateLock. */
export function writeConnectedCliState(state: ConnectedCliState): void {
  writeState(CONNECTED_CLI_FILE, { version: 'v1', entries: state.entries,
    ...(state.forgotten.length ? { forgotten: state.forgotten } : {}) });
}

export function readCliHealthEntries(): Record<string, CliHealth> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(HEALTH_FILE, 'utf8'));
    return record(parsed) && parsed.version === 'v1' && record(parsed.entries) ? parsed.entries as Record<string, CliHealth> : {};
  } catch { return {}; }
}

/** Call only while holding withConnectedCliStateLock. This is an observation
 * cache, not the CLI's credentials or login configuration. */
export function writeCliHealthEntries(entries: Record<string, CliHealth>): void {
  writeState(HEALTH_FILE, { version: 'v1', entries });
}
