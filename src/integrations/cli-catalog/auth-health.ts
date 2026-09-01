import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { BASE_DIR } from '../../config.js';
import { findSafeCliCommand } from '../../runtime/cli-discovery.js';
import { mergedSpawnEnv } from '../../runtime/spawn-env.js';
import { getSavedClis } from '../../runtime/saved-clis.js';
import {
  CLI_CATALOG,
  findCatalogEntry,
  readConnectedClis,
  type CliAuthProbe,
  type CliCatalogEntry,
} from './catalog.js';

/**
 * CLI auth-state health for the user's roster (connected catalog CLIs +
 * saved bare-name CLIs). Before this, "installed but signed out" was
 * invisible for every CLI except gh and composio — a workflow using the
 * Railway CLI would only discover the expired login by failing mid-run.
 *
 * Probes are READ-ONLY by contract (catalog.CliAuthProbe) and every spawn
 * goes through the same safety seams as the rest of the product:
 * findSafeCliCommand (darwin CLT/MDM guards), mergedSpawnEnv (GUI-launch
 * PATH), cwd = BASE_DIR (TCC-safe). gh and composio delegate to their
 * existing richer probes — this engine adapts their shapes, it never
 * duplicates their bench/dead-latch logic.
 */

const logger = pino({ name: 'clementine-next.cli-auth-health' });

export type CliAuthStatus = 'ok' | 'signed_out' | 'unknown' | 'error';

/** What the most recent probe did when it produced no verdict. */
export interface CliProbeError {
  exitCode: number | null;
  timedOut: boolean;
  /** Leading stderr (stdout+stderr when the executor does not split them),
   *  ANSI-stripped and capped at PROBE_ERROR_HEAD_CHARS. */
  stderrHead: string;
}

export interface CliHealth {
  /** Catalog id, or `saved:<command>` for roster-only bare names. */
  id: string;
  command: string;
  installed: boolean;
  authStatus: CliAuthStatus;
  username?: string;
  checkedAt: string;
  /**
   * Present when `authStatus` is a KEPT verdict: the latest probe failed
   * transiently (timeout, non-zero exit without the signed-out pattern, an
   * exception) and produced no verdict of its own, so the previous one stands.
   * ISO time of the probe that last produced the standing verdict. Cleared by
   * the next probe that yields a verdict.
   */
  staleSince?: string;
  /** The transient failure that left the previous verdict standing. */
  lastProbeError?: CliProbeError;
}

const PROBE_ERROR_HEAD_CHARS = 200;

const HEALTH_FILE = path.join(BASE_DIR, 'state', 'cli-auth-health.json');
/** Mirror of composio's CLI_STATUS_TTL_MS — probes are cheap but not free. */
const HEALTH_MEMO_TTL_MS = 45_000;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const SWEEP_CONCURRENCY = 3;

interface HealthFile {
  version: 'v1';
  entries: Record<string, CliHealth>;
}

const memo = new Map<string, { at: number; value: CliHealth }>();
const inFlight = new Map<string, Promise<CliHealth>>();
type RecoveredListener = (health: CliHealth) => void;
const recoveredListeners = new Set<RecoveredListener>();
const signedOutListeners = new Set<RecoveredListener>();

/** Strip ANSI escapes before classification — netlify (and friends) color
 *  their status output, which would defeat plain-text patterns. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001B\[[0-9;]*[A-Za-z]/g, '');
}

function readHealthFile(): Record<string, CliHealth> {
  if (!existsSync(HEALTH_FILE)) return {};
  try {
    const parsed = JSON.parse(readFileSync(HEALTH_FILE, 'utf-8')) as HealthFile;
    return parsed && parsed.entries ? parsed.entries : {};
  } catch {
    // A cache, not evidence — a corrupt file resets to empty and the next
    // sweep rebuilds it. Transition dedupe degrades to at-most-one-extra
    // event, which the notification id-bucketing absorbs.
    return {};
  }
}

function writeHealthFile(entries: Record<string, CliHealth>): void {
  mkdirSync(path.dirname(HEALTH_FILE), { recursive: true });
  const tmp = `${HEALTH_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 'v1', entries } satisfies HealthFile, null, 2), 'utf-8');
  renameSync(tmp, HEALTH_FILE);
}

/** Last persisted health, no probes — safe for request paths. */
export function readPersistedHealth(): Record<string, CliHealth> {
  return readHealthFile();
}

export function invalidateCliHealth(id?: string): void {
  if (id === undefined) memo.clear();
  else memo.delete(id);
}

/** Subscribe to signed_out→ok transitions (fired at most once per
 *  transition, across restarts via the persisted last-known state). */
export function onCliAuthRecovered(fn: RecoveredListener): () => void {
  recoveredListeners.add(fn);
  return () => recoveredListeners.delete(fn);
}

/** Subscribe to transitions INTO signed_out (fired once per transition —
 *  ok/unknown/error → signed_out; a signed_out re-probe never re-fires). */
export function onCliSignedOut(fn: RecoveredListener): () => void {
  signedOutListeners.add(fn);
  return () => signedOutListeners.delete(fn);
}

// ─── Probe execution ────────────────────────────────────────────────

export interface ProbeExecResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  /** stderr alone, when the executor can separate it (the real executor does). */
  stderr?: string;
}

type ProbeExec = (binaryPath: string, args: string[], timeoutMs: number) => Promise<ProbeExecResult>;

const realExec: ProbeExec = (binaryPath, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(binaryPath, args, {
      timeout: timeoutMs,
      cwd: BASE_DIR,
      env: mergedSpawnEnv(),
      maxBuffer: 256 * 1024,
    }, (err, stdout, stderr) => {
      const output = [stdout, stderr].filter(Boolean).join('\n');
      if (err && (err as { killed?: boolean }).killed) {
        resolve({ exitCode: null, output, timedOut: true, stderr });
        return;
      }
      const code = err ? ((err as { code?: unknown }).code as number | null ?? 1) : 0;
      resolve({ exitCode: typeof code === 'number' ? code : 1, output, timedOut: false, stderr });
    });
  });

let execImpl: ProbeExec = realExec;
/** Test seam: probes are live logins away from being side-effectful, so
 *  tests always inject. Pass undefined to restore the real executor. */
export function _testOnly_setProbeExec(fn?: ProbeExec): void {
  execImpl = fn ?? realExec;
}

type CommandResolver = typeof findSafeCliCommand;
let resolveCommandImpl: CommandResolver = findSafeCliCommand;
/** Test seam for INSTALLED-ness. Resolution hits the real PATH before any
 *  probe runs, so a transition test could only pass on a machine that happened
 *  to have that CLI installed — green on a dev laptop, red on a CI runner.
 *  Mirrors _testOnly_setProbeExec; pass undefined to restore the real lookup. */
export function _testOnly_setCommandResolver(fn?: CommandResolver): void {
  resolveCommandImpl = fn ?? findSafeCliCommand;
}

/** Pure classification — pinned by the truth-table test.
 *  Order matters: the signed-out pattern outranks exit code because some
 *  CLIs report signed-out states with exit 0 (gcloud prints `[]`). */
export function classifyProbeOutput(
  probe: CliAuthProbe,
  result: ProbeExecResult,
): { authStatus: CliAuthStatus; username?: string } {
  const text = stripAnsi(result.output);
  if (result.timedOut) return { authStatus: 'error' };
  if (probe.signedOutPattern) {
    try {
      if (new RegExp(probe.signedOutPattern, 'im').test(text)) return { authStatus: 'signed_out' };
    } catch { /* a malformed pattern must not take the probe down */ }
  }
  if (result.exitCode === 0 && text.trim()) {
    let username: string | undefined;
    if (probe.usernameCapture) {
      try {
        username = new RegExp(probe.usernameCapture, 'im').exec(text)?.[1];
      } catch { /* capture is best-effort */ }
    }
    return { authStatus: 'ok', ...(username ? { username } : {}) };
  }
  return { authStatus: 'error' };
}

// ─── Roster assembly ────────────────────────────────────────────────

interface RosterItem {
  id: string;
  command: string;
  probe?: CliAuthProbe;
}

function rosterItems(): RosterItem[] {
  const items = new Map<string, RosterItem>();
  const connected = readConnectedClis();
  for (const record of Object.values(connected)) {
    const catalog = findCatalogEntry(record.id);
    items.set(record.id, {
      id: record.id,
      command: record.command,
      probe: record.authProbe ?? catalog?.authProbe,
    });
  }
  // Saved bare names join catalog metadata by command; no match → probe-less
  // (installed-ness still surfaces). A saved command that IS a connected
  // catalog CLI dedupes onto the catalog id above.
  const byCommand = new Map<string, CliCatalogEntry>(CLI_CATALOG.map((entry) => [entry.command, entry]));
  const connectedCommands = new Set(Object.values(connected).map((record) => record.command));
  for (const command of getSavedClis()) {
    if (connectedCommands.has(command)) continue;
    const catalog = byCommand.get(command);
    if (catalog && items.has(catalog.id)) continue;
    items.set(catalog?.id ?? `saved:${command}`, {
      id: catalog?.id ?? `saved:${command}`,
      command,
      probe: catalog?.authProbe,
    });
  }
  return [...items.values()];
}

// ─── Delegated rich probes (gh / composio) ──────────────────────────

async function delegatedHealth(item: RosterItem): Promise<CliHealth | null> {
  const checkedAt = new Date().toISOString();
  try {
    if (item.id === 'github') {
      const { getGitHubCliStatus } = await import('../github-cli.js');
      const status = await getGitHubCliStatus();
      return {
        id: item.id,
        command: item.command,
        installed: status.installed,
        authStatus: !status.installed ? 'unknown'
          : status.authStatus === 'ok' ? 'ok'
          : status.authStatus === 'invalid' ? 'signed_out'
          : 'error',
        ...(status.username ? { username: status.username } : {}),
        checkedAt,
        // A delegated probe that neither confirmed nor denied the login is a
        // transient like any other: it produced no verdict.
        ...(status.installed && status.authStatus !== 'ok' && status.authStatus !== 'invalid'
          ? { lastProbeError: { exitCode: null, timedOut: false, stderrHead: '' } }
          : {}),
      };
    }
    if (item.id === 'composio' || item.command === 'composio') {
      const { getComposioCliStatus } = await import('../composio/cli.js');
      const status = await getComposioCliStatus();
      return {
        id: item.id,
        command: item.command,
        installed: status.installed,
        authStatus: !status.installed ? 'unknown' : status.authenticated ? 'ok' : 'signed_out',
        checkedAt,
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message, cli: item.id }, 'delegated CLI health probe failed');
    return {
      id: item.id,
      command: item.command,
      installed: true,
      authStatus: 'error',
      checkedAt,
      lastProbeError: { exitCode: null, timedOut: false, stderrHead: probeErrorHead(message) },
    };
  }
  return null;
}

function probeErrorHead(text: string | undefined): string {
  return stripAnsi(text ?? '').replace(/\s+/g, ' ').trim().slice(0, PROBE_ERROR_HEAD_CHARS);
}

// ─── Health resolution ──────────────────────────────────────────────

async function probeHealth(item: RosterItem): Promise<CliHealth> {
  const delegated = await delegatedHealth(item);
  if (delegated) return delegated;

  const checkedAt = new Date().toISOString();
  const safe = resolveCommandImpl(item.command);
  if (!safe || safe.skipped || !safe.path) {
    // Not on PATH, or resolvable only to a binary the safety seam refuses
    // to execute (CLT stub, MDM tool) — treat both as not-probeable.
    return { id: item.id, command: item.command, installed: false, authStatus: 'unknown', checkedAt };
  }
  if (!item.probe) {
    return { id: item.id, command: item.command, installed: true, authStatus: 'unknown', checkedAt };
  }
  const result = await execImpl(safe.path, item.probe.args, item.probe.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  const verdict = classifyProbeOutput(item.probe, result);
  return {
    id: item.id,
    command: item.command,
    installed: true,
    ...verdict,
    checkedAt,
    // 'error' from the classifier means "no verdict" — a timeout, a non-zero
    // exit that did not match the signed-out pattern, or silence. Record what
    // happened so commit can keep the last real verdict instead of caching a
    // transient as if the login had failed.
    ...(verdict.authStatus === 'error'
      ? {
          lastProbeError: {
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            stderrHead: probeErrorHead(result.stderr ?? result.output),
          },
        }
      : {}),
  };
}

/**
 * A probe that produced no verdict must not overwrite one that did. Only the
 * signed-out pattern flips a login to signed_out; a timeout or an unexplained
 * non-zero exit keeps the previous 'ok' (or 'signed_out') standing and marks it
 * stale, and a first-ever probe with nothing to keep stays 'unknown' — never
 * 'error', which every surface renders as an auth failure the user must fix.
 */
function settleTransientProbe(next: CliHealth, previous: CliHealth | undefined): CliHealth {
  if (!next.lastProbeError) return next;
  const kept = previous?.authStatus === 'ok' || previous?.authStatus === 'signed_out'
    ? previous.authStatus
    : 'unknown';
  const staleSince = previous ? (previous.staleSince ?? previous.checkedAt) : undefined;
  const settled: CliHealth = {
    id: next.id,
    command: next.command,
    installed: next.installed,
    authStatus: kept,
    ...(kept === 'ok' && previous?.username ? { username: previous.username } : {}),
    checkedAt: next.checkedAt,
    ...(staleSince ? { staleSince } : {}),
    lastProbeError: next.lastProbeError,
  };
  logger.warn({
    cli: next.id,
    command: next.command,
    exitCode: next.lastProbeError.exitCode,
    timedOut: next.lastProbeError.timedOut,
    stderrHead: next.lastProbeError.stderrHead,
    keptVerdict: kept,
    ...(staleSince ? { staleSince } : {}),
  }, 'CLI auth probe produced no verdict; keeping the last one');
  return settled;
}

/** Human line for surfaces that show the status text: "checked 3h ago, last
 *  probe failed (exit 1)" while a kept verdict is stale; null otherwise. */
export function cliHealthStaleNote(health: CliHealth, now: number = Date.now()): string | null {
  if (!health.lastProbeError) return null;
  const since = Date.parse(health.staleSince ?? health.checkedAt);
  const ageMs = Number.isFinite(since) ? Math.max(0, now - since) : 0;
  const age = ageMs < 60_000 ? 'just now'
    : ageMs < 3_600_000 ? `${Math.round(ageMs / 60_000)}m ago`
    : ageMs < 86_400_000 ? `${Math.round(ageMs / 3_600_000)}h ago`
    : `${Math.round(ageMs / 86_400_000)}d ago`;
  const why = health.lastProbeError.timedOut ? 'timed out'
    : health.lastProbeError.exitCode === null ? 'failed'
    : `exit ${health.lastProbeError.exitCode}`;
  return `checked ${age}, last probe failed (${why})`;
}

/** Persist + fire the recovered event on a signed_out→ok transition.
 *  The persisted previous state is the transition authority so a daemon
 *  restart can neither double-fire nor swallow a recovery. */
function commitHealth(probed: CliHealth): CliHealth {
  const entries = readHealthFile();
  const previous = entries[probed.id];
  const next = settleTransientProbe(probed, previous);
  entries[next.id] = next;
  writeHealthFile(entries);
  if (previous?.authStatus === 'signed_out' && next.authStatus === 'ok') {
    for (const listener of recoveredListeners) {
      try {
        listener(next);
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err), cli: next.id }, 'cli-auth recovered listener failed');
      }
    }
  }
  if (previous?.authStatus !== 'signed_out' && next.authStatus === 'signed_out') {
    for (const listener of signedOutListeners) {
      try {
        listener(next);
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err), cli: next.id }, 'cli signed-out listener failed');
      }
    }
  }
  return next;
}

export async function getCliHealth(id: string, opts: { force?: boolean } = {}): Promise<CliHealth> {
  const cached = memo.get(id);
  if (!opts.force && cached && Date.now() - cached.at < HEALTH_MEMO_TTL_MS) return cached.value;
  const running = inFlight.get(id);
  if (running && !opts.force) return running;

  const item = rosterItems().find((candidate) => candidate.id === id)
    ?? ((): RosterItem | undefined => {
      const catalog = findCatalogEntry(id);
      return catalog ? { id, command: catalog.command, probe: catalog.authProbe } : undefined;
    })();
  if (!item) {
    return {
      id,
      command: id.replace(/^saved:/, ''),
      installed: false,
      authStatus: 'unknown',
      checkedAt: new Date().toISOString(),
    };
  }
  const promise = probeHealth(item)
    .then((probed) => {
      // Memoize the SETTLED record: a transient must not be served for 45s
      // as 'error' while the persisted truth kept the last verdict.
      const health = commitHealth(probed);
      memo.set(id, { at: Date.now(), value: health });
      return health;
    })
    .finally(() => inFlight.delete(id));
  inFlight.set(id, promise);
  return promise;
}

/** Probe the whole roster, bounded concurrency. Used by the slow daemon
 *  sweep and the Connect refresh kick — never by a blocking request path. */
export async function getRosterHealth(opts: { force?: boolean } = {}): Promise<CliHealth[]> {
  const items = rosterItems();
  const results: CliHealth[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(SWEEP_CONCURRENCY, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      try {
        results.push(await getCliHealth(item.id, opts));
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err), cli: item.id }, 'roster health probe failed');
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// ─── Slow daemon sweep ──────────────────────────────────────────────

const SWEEP_INTERVAL_MS = 30 * 60_000;
let sweepTimer: NodeJS.Timeout | undefined;

/**
 * Idempotent 30-minute roster sweep. Keeps the persisted health map fresh
 * enough for transition detection (signed-out notifications, recovery
 * resume) without a hot loop — Connect refreshes on demand for anything
 * more current. Kill-switch: CLEMMY_CLI_HEALTH_SWEEP=off.
 */
export function startCliHealthSweep(): void {
  if (sweepTimer) return;
  if ((process.env.CLEMMY_CLI_HEALTH_SWEEP ?? 'on').trim().toLowerCase() === 'off') return;
  const tick = (): void => {
    void getRosterHealth().catch((err) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'cli health sweep failed');
    });
  };
  // First pass shortly after boot (after the CLI warm scan), then slow.
  const boot = setTimeout(tick, 60_000);
  boot.unref?.();
  sweepTimer = setInterval(tick, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

export function _testOnly_stopCliHealthSweep(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = undefined;
}
