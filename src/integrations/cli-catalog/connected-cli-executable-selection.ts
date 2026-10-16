import path from 'node:path';
import { readFileSync } from 'node:fs';
import { BASE_DIR } from '../../config.js';
import { cliHealthExecutableIdentity } from './cli-executable-identity.js';
import { cliHealthMatchesConnection } from './cli-connection-revision.js';

export type ConnectedCliExecutableSelection =
  | { status: 'unbound'; reason: 'not_connected' | 'not_observed' }
  | { status: 'selected'; executablePath: string; executableIdentity: string }
  | { status: 'blocked'; reason: 'forgotten' | 'malformed_roster' | 'roster_identity_mismatch'
    | 'malformed_health' | 'health_identity_mismatch' | 'connection_revision_mismatch' | 'not_installed'
    | 'missing_executable_identity' | 'unsupported_windows_launcher' };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The reviewed carrier has a literal-argv, shell:false contract. Windows
 * batch/PowerShell launchers need a different, explicitly bound interpreter
 * contract; an extension or a successful login cannot supply one. */
export function reviewedCliExecutablePathIsSupported(
  executablePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== 'win32' || path.win32.extname(executablePath).toLowerCase() === '.exe';
}

/** Windows regular .exe files do not require POSIX execute bits. This only
 * admits the existing direct executable launch contract; it never adds a
 * shell association or batch/script interpreter. The OS still loads the
 * program, and the descriptor boundary pins/rechecks its exact bytes. */
export function reviewedCliExecutableFileIsSupported(input: {
  executablePath: string; isFile: boolean; mode: number | bigint; platform?: NodeJS.Platform;
}): boolean {
  const platform = input.platform ?? process.platform;
  if (!input.isFile || !reviewedCliExecutablePathIsSupported(input.executablePath, platform)) return false;
  if (platform === 'win32') return true;
  if (typeof input.mode === 'number' && !Number.isInteger(input.mode)) return false;
  return (BigInt(input.mode) & 0o111n) !== 0n;
}

/** Select only the executable observed for this exact connected CLI. This is
 * not authentication/account/operation readiness. A failed auth probe can
 * still identify its executable; the reviewed descriptor boundary separately
 * rechecks the real file and bytes before any operation is offered or run.
 *
 * Missing observations retain bootstrap PATH discovery. Once an observation
 * exists, malformed/missing executable facts block rather than silently
 * selecting another same-named program from PATH. No probes or I/O occur. */
export function selectConnectedCliExecutable(
  target: { id: string; command: string },
  input: { connected: unknown; health: unknown; forgotten: readonly string[]; platform?: NodeJS.Platform },
): ConnectedCliExecutableSelection {
  const platform = input.platform ?? process.platform;
  if (input.forgotten.includes(target.id)) return { status: 'blocked', reason: 'forgotten' };
  if (!record(input.connected)) return { status: 'blocked', reason: 'malformed_roster' };
  if (!Object.hasOwn(input.connected, target.id)) return { status: 'unbound', reason: 'not_connected' };
  const connected = input.connected[target.id];
  if (!record(connected)) return { status: 'blocked', reason: 'malformed_roster' };
  if (!Object.hasOwn(connected, 'id') || !Object.hasOwn(connected, 'command')
    || connected.id !== target.id || connected.command !== target.command) {
    return { status: 'blocked', reason: 'roster_identity_mismatch' };
  }
  if (!record(input.health)) return { status: 'blocked', reason: 'malformed_health' };
  if (!Object.hasOwn(input.health, target.id)) return { status: 'unbound', reason: 'not_observed' };
  const health = input.health[target.id];
  if (!record(health)) return { status: 'blocked', reason: 'malformed_health' };
  if (!Object.hasOwn(health, 'id') || !Object.hasOwn(health, 'command')
    || health.id !== target.id || health.command !== target.command) {
    return { status: 'blocked', reason: 'health_identity_mismatch' };
  }
  if (!cliHealthMatchesConnection(connected, health)) {
    return { status: 'blocked', reason: 'connection_revision_mismatch' };
  }
  if (health.installed === false) return { status: 'blocked', reason: 'not_installed' };
  if (!Object.hasOwn(health, 'installed') || health.installed !== true) return { status: 'blocked', reason: 'malformed_health' };
  const binary = Object.hasOwn(health, 'binaryPath') && typeof health.binaryPath === 'string' ? health.binaryPath : undefined;
  const identity = cliHealthExecutableIdentity(binary, platform);
  if (!binary || !identity) return { status: 'blocked', reason: 'missing_executable_identity' };
  if (!reviewedCliExecutablePathIsSupported(binary, platform)) {
    return { status: 'blocked', reason: 'unsupported_windows_launcher' };
  }
  return { status: 'selected', executablePath: binary, executableIdentity: identity };
}

function readMetadata(file: string): unknown {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : null; }
}

/** Read only the existing metadata files. Missing files are bootstrap state;
 * corrupt files are unknown and must not be normalized into PATH fallback.
 * No auth engine, session store, probe or native database is imported. */
export function readConnectedCliExecutableSelection(
  target: { id: string; command: string },
  options: { baseDir?: string; platform?: NodeJS.Platform } = {},
): ConnectedCliExecutableSelection {
  const state = path.join(options.baseDir ?? BASE_DIR, 'state');
  const roster = readMetadata(path.join(state, 'connected-clis.json'));
  const health = readMetadata(path.join(state, 'cli-auth-health.json'));
  const validRoster = record(roster) && roster.version === 'v1' && Object.hasOwn(roster, 'entries');
  const validHealth = record(health) && health.version === 'v1' && Object.hasOwn(health, 'entries');
  const forgotten = validRoster && roster.forgotten !== undefined ? roster.forgotten : [];
  if (!Array.isArray(forgotten) || !forgotten.every(id => typeof id === 'string')) {
    return { status: 'blocked', reason: 'malformed_roster' };
  }
  return selectConnectedCliExecutable(target, {
    connected: roster === undefined ? {} : validRoster ? roster.entries : null,
    health: health === undefined ? {} : validHealth ? health.entries : null,
    forgotten,
    platform: options.platform,
  });
}
