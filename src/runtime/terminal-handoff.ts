import { execFile } from 'node:child_process';
import pino from 'pino';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { runWindowsPowerShell } from './windows-powershell.js';
import { windowsSystemRoot } from './windows-process-tree.js';
import { findSafeCliCommand } from './cli-discovery.js';
import { mergedSpawnEnv } from './spawn-env.js';

/**
 * Terminal hand-off for INTERACTIVE CLI logins (vercel's method picker,
 * stripe's press-Enter pairing, `aws configure`…). The daemon can't run
 * these itself — its job runner has no TTY, so the prompt would hang.
 * Instead, Clementine opens the user's real Terminal with the login
 * command already running: the user answers the prompts in a shell THEY
 * own, the browser popup opens as normal, and the auth-health probe
 * detects the signed_out→ok flip so Clem can report "you're in" and the
 * recovery machinery resumes any parked work.
 *
 * Safety shape mirrors the catalog auth jobs: the command is resolved
 * SERVER-SIDE from CLI_CATALOG by id — callers can never inject a
 * command string. Windows opens a real PowerShell window; macOS uses
 * AppleScript and needs the user's one-time TCC approval
 * ("Clementine wants to control Terminal"), and a denial comes back as
 * a clear error, not a silent no-op.
 */

const logger = pino({ name: 'clementine-next.terminal-handoff' });

/** How long the post-handoff watcher force-probes for the sign-in flip.
 *  Interactive logins are human-paced; five minutes covers a slow OAuth
 *  dance without leaving a poller running forever. */
const WATCH_TIMEOUT_MS = 5 * 60_000;
const WATCH_INTERVAL_MS = 10_000;

export interface TerminalHandoffResult {
  ok: boolean;
  command: string;
  message: string;
}

type OsaExec = (args: string[]) => Promise<{ ok: boolean; stderr: string }>;

const realOsaExec: OsaExec = (args) =>
  new Promise((resolve) => {
    execFile('/usr/bin/osascript', args, { timeout: 15_000 }, (err, _stdout, stderr) => {
      resolve({ ok: !err, stderr: String(stderr ?? (err instanceof Error ? err.message : '')) });
    });
  });

let osaExec: OsaExec = realOsaExec;
let windowsTerminalExec = runWindowsPowerShell;
let resolveWindowsTerminalCli = findSafeCliCommand;
export function _testOnly_setWindowsTerminalResolver(value?: typeof findSafeCliCommand): void {
  resolveWindowsTerminalCli = value ?? findSafeCliCommand;
}
export function _testOnly_setWindowsTerminalExec(value?: typeof runWindowsPowerShell): void {
  windowsTerminalExec = value ?? runWindowsPowerShell;
}
/** Test seam — tests must never open a real Terminal window. */
export function _testOnly_setOsaExec(fn?: OsaExec): void {
  osaExec = fn ?? realOsaExec;
}

/** AppleScript string literal escaping: backslashes first, then quotes. */
export function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const WINDOWS_TERMINAL_PROGRAM = `
$words = @($payload.argv | ForEach-Object { "'" + ([string]$_).Replace("'", "''") + "'" })
$directory = "'" + ([string]$payload.cwd).Replace("'", "''") + "'"
$inner = 'Set-Location -LiteralPath ' + $directory + '; & ' + ($words -join ' ')
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))
$terminal = Start-Process -FilePath $payload.powershell -ArgumentList @('-NoProfile', '-NoExit', '-EncodedCommand', $encoded) -WorkingDirectory $payload.cwd -WindowStyle Normal -PassThru
if (-not $terminal.Id) { throw 'No terminal launch receipt' }
Write-Output $terminal.Id
`;

/** Only server-owned catalog recipes reach this seam. No secrets or shell
 * placeholders may be substituted into a login's process arguments. */
export async function openWindowsCatalogTerminal(command: string): Promise<void> {
  const argv = command.trim().split(/\s+/);
  if (!argv.length || !argv.every(word => /^[A-Za-z0-9_./:=@+-]+$/.test(word))) {
    throw new Error('This sign-in needs its dedicated setup flow; no terminal was opened.');
  }
  const executable = resolveWindowsTerminalCli(argv[0]!);
  if (!executable || executable.skipped || !executable.path) {
    throw new Error('The configured CLI executable is unavailable; no terminal was opened. Rescan command-line tools in Connect after installing it.');
  }
  argv[0] = executable.path;
  const pid = await windowsTerminalExec(WINDOWS_TERMINAL_PROGRAM, { argv, cwd: BASE_DIR,
    powershell: path.win32.join(windowsSystemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') },
  { env: mergedSpawnEnv() });
  if (!/^[1-9][0-9]*$/.test(pid)) throw new Error('Windows did not confirm a terminal launch.');
}

const activeWatchers = new Map<string, NodeJS.Timeout>();

/** Force-probe the CLI until it flips to ok (the commitHealth transition
 *  fires the recovery event → parked-work resume + truthful reporting) or
 *  the watch window closes. Idempotent per CLI id. */
function watchForSignIn(catalogId: string): void {
  const existing = activeWatchers.get(catalogId);
  if (existing) clearInterval(existing);
  const startedAt = Date.now();
  const timer = setInterval(() => {
    void (async () => {
      try {
        const { getCliHealth, invalidateCliHealth } = await import('../integrations/cli-catalog/auth-health.js');
        invalidateCliHealth(catalogId);
        const health = await getCliHealth(catalogId, { force: true });
        if (health.authStatus === 'ok' || Date.now() - startedAt > WATCH_TIMEOUT_MS) {
          clearInterval(timer);
          activeWatchers.delete(catalogId);
        }
      } catch {
        // Probe hiccups end the watcher at the timeout; the 30-min sweep
        // remains the backstop.
        if (Date.now() - startedAt > WATCH_TIMEOUT_MS) {
          clearInterval(timer);
          activeWatchers.delete(catalogId);
        }
      }
    })();
  }, WATCH_INTERVAL_MS);
  timer.unref?.();
  activeWatchers.set(catalogId, timer);
}

export function _testOnly_stopSignInWatchers(): void {
  for (const timer of activeWatchers.values()) clearInterval(timer);
  activeWatchers.clear();
}

/**
 * Open the user's Terminal with the catalog CLI's login command running.
 * Command source is the catalog ONLY (lookup by id).
 */
export async function openTerminalAuthSession(catalogId: string): Promise<TerminalHandoffResult> {
  const { findCatalogEntry } = await import('../integrations/cli-catalog/catalog.js');
  const entry = findCatalogEntry(catalogId);
  if (!entry) {
    return { ok: false, command: '', message: `Unknown catalog CLI: ${catalogId}` };
  }
  const command = entry.authCommand ?? `${entry.command} login`;
  if (process.platform === 'win32') {
    try {
      await openWindowsCatalogTerminal(command);
      watchForSignIn(entry.id);
      return { ok: true, command,
        message: `Opened a PowerShell window running \`${command}\`. Complete the sign-in there; Clementine will verify the connection and resume waiting work once sign-in is confirmed.` };
    } catch (error) {
      return { ok: false, command,
        message: `${error instanceof Error ? error.message : 'Could not open PowerShell.'} Check whether a sign-in window already opened before retrying. If none opened, run \`${command}\` in your own terminal instead.` };
    }
  }
  if (process.platform !== 'darwin') {
    return {
      ok: false,
      command,
      message: `Automatic terminal hand-off is unavailable on this host. Run \`${command}\` in your own terminal instead.`,
    };
  }
  const escaped = escapeAppleScriptString(command);
  const result = await osaExec([
    '-e', 'tell application "Terminal" to activate',
    '-e', `tell application "Terminal" to do script "${escaped}"`,
  ]);
  if (!result.ok) {
    // -1743 = TCC automation denial; -1712 = AppleEvent timeout, which in
    // practice means the "allow Clementine to control Terminal" dialog is
    // sitting unanswered (observed live on first use). Name the fix for
    // each instead of a bare error.
    const denied = /-1743|not authoriz/i.test(result.stderr);
    const timedOut = /-1712|timed out/i.test(result.stderr);
    logger.warn({ cli: catalogId, stderr: result.stderr.slice(0, 400) }, 'terminal hand-off failed');
    return {
      ok: false,
      command,
      message: denied
        ? `macOS blocked Clementine from controlling Terminal. Allow it under System Settings → Privacy & Security → Automation → Clementine → Terminal, then try again — or run \`${command}\` yourself.`
        : timedOut
          ? `macOS is waiting for permission — look for a dialog asking to allow Clementine to control Terminal, click Allow, then try again. (The Terminal window may also have opened late; check before re-running.) Fallback: run \`${command}\` yourself.`
          : `Could not open Terminal automatically. Run \`${command}\` in your own terminal instead.`,
    };
  }
  watchForSignIn(entry.id);
  logger.info({ cli: catalogId, command }, 'terminal auth hand-off opened');
  return {
    ok: true,
    command,
    message: `Opened Terminal running \`${command}\`. Finish the prompts there (a browser window may open); Clementine will detect the sign-in and resume anything that was waiting on it.`,
  };
}
