import { execFile } from 'node:child_process';
import pino from 'pino';

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
 * command string. macOS-only by design (the product ships mac-only);
 * the AppleScript automation needs the user's one-time TCC approval
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
/** Test seam — tests must never open a real Terminal window. */
export function _testOnly_setOsaExec(fn?: OsaExec): void {
  osaExec = fn ?? realOsaExec;
}

/** AppleScript string literal escaping: backslashes first, then quotes. */
export function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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
  if (process.platform !== 'darwin') {
    return {
      ok: false,
      command,
      message: `Terminal hand-off is macOS-only. Run \`${command}\` in your own terminal instead.`,
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
