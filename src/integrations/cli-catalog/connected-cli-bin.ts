import { lstatSync, mkdirSync, readlinkSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { CliHealth } from './auth-health.js';
import { cliHealthMatchesConnection, readCliHealthEntries, readConnectedCliState,
  withConnectedCliStateLock, CONNECTED_CLI_BIN_DIR } from './connected-cli-state.js';

const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function executable(file: string): boolean {
  try {
    const st = statSync(file);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function linkTarget(link: string): string | null {
  try { return lstatSync(link).isSymbolicLink() ? readlinkSync(link) : null; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Retire only a proved exact pin. Never sweep unrelated commands, regular
 * files or differing/newer symlink targets. Caller holds the roster lock. */
export function retireConnectedCliPin(connected: unknown, health: CliHealth | undefined): void {
  if (process.platform === 'win32' || !health || !cliHealthMatchesConnection(connected, health)) return;
  const dir = CONNECTED_CLI_BIN_DIR;
  if (!COMMAND_NAME.test(health.command) || typeof health.binaryPath !== 'string' || !path.isAbsolute(health.binaryPath)) return;
  const link = path.join(dir, health.command);
  if (linkTarget(link) !== health.binaryPath) return;
  // All cooperative publishers share the roster lock; also recheck directly
  // before removal so a differing target is never treated as ours.
  if (linkTarget(link) === health.binaryPath) unlinkSync(link);
}

export function connectedCliPinTarget(health: CliHealth): string | null {
  const binary = health.binaryPath;
  return health.installed && health.authStatus !== 'signed_out'
    && (!health.lastProbeError || health.authStatus === 'ok')
    && typeof binary === 'string' && path.isAbsolute(binary)
    && !binary.startsWith(CONNECTED_CLI_BIN_DIR + path.sep)
    && COMMAND_NAME.test(health.command) && executable(binary) ? binary : null;
}

/** Internal synchronous publication seam. The auth commit supplies the prior
 * observation so replacing selected A with unknown B can retire A exactly. */
export function syncConnectedCliBinLocked(
  entries: Record<string, CliHealth>,
  previousEntries: Record<string, CliHealth> = entries,
): void {
  if (process.platform === 'win32') return;
  const dir = CONNECTED_CLI_BIN_DIR;
  const state = readConnectedCliState();
  const persisted = readCliHealthEntries();
  for (const [id, health] of Object.entries(entries)) {
    if (!Object.hasOwn(state.entries, id) || state.forgotten.includes(id)) continue;
    const connected = state.entries[id];
    if (!health || health.id !== id || !cliHealthMatchesConnection(connected, health)
      || typeof health.command !== 'string' || !COMMAND_NAME.test(health.command)) continue;
    // A caller holding an old map cannot replace a newer persisted selection.
    if (Object.hasOwn(persisted, id) && JSON.stringify(persisted[id]) !== JSON.stringify(health)) continue;
    const binary = connectedCliPinTarget(health);
    const wanted = binary !== null;
    const link = path.join(dir, health.command);
    if (wanted && linkTarget(link) === binary) continue;
    const previous = previousEntries[id];
    retireConnectedCliPin(connected, previous);
    if (previous !== health) retireConnectedCliPin(connected, health);
    if (!wanted) continue;
    // An unproved target or regular file is never replaced.
    try { lstatSync(link); continue; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    mkdirSync(dir, { recursive: true });
    symlinkSync(binary!, link);
  }
}

/** Exact observed executables lead child PATH. No directory-wide empty-health
 * resync is used for disconnects, and this never probes or changes login. */
export function syncConnectedCliBin(entries: Record<string, CliHealth>): void {
  withConnectedCliStateLock(() => syncConnectedCliBinLocked(entries));
}
