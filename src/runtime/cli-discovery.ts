import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BASE_DIR } from '../config.js';

/**
 * Local CLI discovery. Two operations, both global:
 *
 *   - scanPath()  → walks every directory on $PATH and lists executable
 *                   files. No curated allowlist. Whatever's on the user's
 *                   machine is what we surface.
 *
 *   - probe(cmd)  → runs `<cmd> --version` and `<cmd> --help` and returns
 *                   the head of each. Lets the caller confirm "yes this
 *                   is a CLI, here's its surface" without us maintaining
 *                   a per-CLI table.
 *
 * Used by:
 *   - The agent (via local_cli_list / local_cli_probe MCP tools).
 *   - The dashboard (via /api/console/clis).
 *   - The setup wizard ("here's what's already on your machine").
 *
 * Cached scan result lives at ~/.clementine-next/state/cli-scan.json
 * with a short TTL so the dashboard isn't re-walking $PATH on every
 * render but a "scan now" button still shows fresh data.
 */

const SCAN_FILE = path.join(BASE_DIR, 'state', 'cli-scan.json');
const SCAN_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface CliEntry {
  /** Bare command name (basename) — what you'd type to run it. */
  command: string;
  /** Absolute path to the binary. */
  path: string;
  /** Whether `<cmd> --version` or `<cmd> --help` returned cleanly. */
  isLikelyCli: boolean;
  /** Trimmed first lines of `<cmd> --version` output, if any. */
  version?: string;
  /** Trimmed first lines of `<cmd> --help` output, if any. */
  helpHead?: string;
  /** When the probe ran. ISO8601. */
  probedAt?: string;
}

export interface CliScanResult {
  /** All executables found on $PATH, by basename. Pre-probe. */
  detected: { command: string; path: string }[];
  /** Subset that responded to --version or --help. Post-probe. */
  clis: CliEntry[];
  /** ISO8601 timestamp when the scan finished. */
  scannedAt: string;
}

interface RawScan {
  detected?: unknown;
  clis?: unknown;
  scannedAt?: unknown;
}

function ensureDir(): void {
  mkdirSync(path.dirname(SCAN_FILE), { recursive: true });
}

function isCacheFresh(scannedAt: string): boolean {
  const t = Date.parse(scannedAt);
  if (Number.isNaN(t)) return false;
  return Date.now() - t < SCAN_TTL_MS;
}

/**
 * Drop the cached scan so the next read forces a fresh walk. Call this
 * right after any operation that could plausibly add a CLI to $PATH
 * (brew install, npm install -g, uv tool install, etc.) so the agent
 * and dashboard see new tools immediately rather than waiting for the
 * 10-min TTL to expire.
 */
export function invalidateCachedScan(): void {
  try {
    if (existsSync(SCAN_FILE)) unlinkSync(SCAN_FILE);
  } catch {
    // Best-effort — if we can't delete the file the worst case is that
    // the cache stays stale for up to 10 minutes. Not worth bubbling.
  }
}

export function readCachedScan(): CliScanResult | undefined {
  if (!existsSync(SCAN_FILE)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(SCAN_FILE, 'utf-8')) as RawScan;
    if (typeof raw.scannedAt !== 'string') return undefined;
    if (!Array.isArray(raw.detected) || !Array.isArray(raw.clis)) return undefined;
    return {
      detected: raw.detected as CliScanResult['detected'],
      clis: raw.clis as CliEntry[],
      scannedAt: raw.scannedAt,
    };
  } catch {
    return undefined;
  }
}

function writeCachedScan(result: CliScanResult): void {
  ensureDir();
  const tmp = `${SCAN_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(result, null, 2), 'utf-8');
  renameSync(tmp, SCAN_FILE);
}

/**
 * Walk every directory on $PATH and collect executable files. Returns
 * { command, path } pairs deduped by command name (first occurrence on
 * PATH wins, matching shell resolution order).
 */
export function scanPath(): { command: string; path: string }[] {
  const PATH = process.env.PATH ?? '';
  const dirs = PATH.split(path.delimiter).filter(Boolean);
  const seen = new Map<string, string>();

  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // unreadable or non-existent — skip silently
    }
    for (const entry of entries) {
      if (seen.has(entry)) continue;
      // Skip obvious non-CLI noise: hidden files, archives.
      if (entry.startsWith('.')) continue;
      if (/\.(so|dylib|dll|a|o)$/.test(entry)) continue;

      const full = path.join(dir, entry);
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
        // Executable bit set for anyone.
        if (!(st.mode & 0o111)) continue;
        seen.set(entry, full);
      } catch {
        continue;
      }
    }
  }

  return Array.from(seen.entries())
    .map(([command, p]) => ({ command, path: p }))
    .sort((a, b) => a.command.localeCompare(b.command));
}

/**
 * Run a single shell-resolved command with a short timeout. Returns
 * stdout+stderr joined, or undefined if the command exited non-zero,
 * timed out, or errored. We don't distinguish — for probing, we just
 * want to know "did it respond like a CLI."
 */
function runQuick(command: string, args: string[], timeoutMs = 2000): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // No shell — direct exec is faster and avoids shell-injection surface.
    });
    const chunks: Buffer[] = [];
    const onData = (b: Buffer): void => { chunks.push(b); };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch (_) { /* noop */ }
      resolve(undefined);
    }, timeoutMs);
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        // Some CLIs return non-zero on --help (rare); still consider
        // it a CLI if we got reasonable output.
        const text = Buffer.concat(chunks).toString('utf-8').trim();
        resolve(text.length > 0 ? text : undefined);
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf-8').trim());
    });
  });
}

function headLines(text: string, max = 3, perLine = 200): string | undefined {
  if (!text) return undefined;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, max);
  if (lines.length === 0) return undefined;
  return lines.map((l) => l.length <= perLine ? l : `${l.slice(0, perLine)}…`).join(' / ');
}

/**
 * macOS Command Line Tools stubs that live at /usr/bin/ on every
 * Mac. Invoking ANY of them without Xcode / CLT installed pops a
 * system-level installer GUI ("The X command requires the command
 * line developer tools. Install?"). That dialog cannot be suppressed
 * from our side — the stub binary triggers it via private
 * xcselect_invoke_xcrun.
 *
 * Probing these on daemon-boot warmup makes Clementine spam the
 * dialog on every fresh open, which is exactly what users saw with
 * xcscontrol after 0.4.0 shipped.
 *
 * Skip them unless a real Command Line Tools or Xcode backing binary
 * exists. This keeps dashboard warmup and `local_cli_list` from
 * triggering system prompts.
 */
const STUB_BINARIES_THAT_TRIGGER_SYSTEM_INSTALLER = new Set<string>([
  'actool',
  'git',
  'python',
  'python3',
  'pip',
  'pip3',
  'cmpdylib',
  'xcscontrol',
  'xcrun',
  'xcodebuild',
  'xcode-select',
  'xcs',
  'xcsdiagnose',
  'xed',
  'xcsbuildd',
  'xcstool',
  'swift',
  'swiftc',
  'metal',
  'metallib',
  'clang',
  'clang++',
  'codesign_allocate',
  'cc',
  'c++',
  'gcc',
  'g++',
  'make',
  'lldb',
  'lldb-mi',
  'dsymutil',
  'dwarfdump',
  'ld',
  'as',
  'nm',
  'otool',
  'size',
  'strings',
  'strip',
  'libtool',
  'install_name_tool',
  'lipo',
  'ranlib',
  'unwinddump',
]);

const SYSTEM_BINARIES_THAT_LAUNCH_GUI_OR_INSTALLER = new Set<string>([
  // Tcl/Tk's `wish` launches a GUI app even for a harmless-looking
  // `--version` probe. On fresh installs this showed up as repeated
  // "Wish quit unexpectedly" dialogs.
  'wish',
  'wish8.5',
  'wish8.6',
  // Apple's Java shims can open a separate "install Java" system dialog.
  'appletviewer',
  'java',
  'javac',
  'javadoc',
  'javap',
  'jcmd',
  'jconsole',
  'jdb',
  'jdeps',
  'jfr',
  'jhsdb',
  'jimage',
  'jinfo',
  'jlink',
  'jmap',
  'jmod',
  'jpackage',
  'jps',
  'jrunscript',
  'jshell',
  'jstack',
  'jstat',
  'jstatd',
  'keytool',
  'orbd',
  'pack200',
  'policytool',
  'rmic',
  'rmid',
  'rmiregistry',
  'serialver',
  'servertool',
  'tnameserv',
  'unpack200',
]);

const DEVELOPER_TOOL_BACKING_DIRS = [
  '/Library/Developer/CommandLineTools/usr/bin',
  '/Applications/Xcode.app/Contents/Developer/usr/bin',
  '/Library/Developer/CommandLineTools/Toolchains/XcodeDefault.xctoolchain/usr/bin',
  '/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin',
];

export type SafeCliProbe =
  | { skipped: false; command: string; path: string }
  | { skipped: true; command: string; path: string; reason: string };

function executableFile(candidate: string): boolean {
  try {
    const st = statSync(candidate);
    return st.isFile() && Boolean(st.mode & 0o111);
  } catch {
    return false;
  }
}

function developerToolBackingPath(command: string): string | undefined {
  for (const dir of DEVELOPER_TOOL_BACKING_DIRS) {
    const candidate = path.join(dir, command);
    if (executableFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * True if a real Xcode or Command Line Tools install backs the
 * `/usr/bin/*` stubs. We detect this with file-stat only (never
 * executes a binary — executing would itself trigger the installer).
 *
 * Result is cached for process lifetime: CLT either gets installed or
 * it doesn't during a daemon run; we don't need to re-stat constantly.
 * Tests can call `_resetCltDetectionCache()` if they need a fresh read.
 */
let cltInstalledCache: boolean | undefined;
export function isDeveloperToolchainInstalled(): boolean {
  if (cltInstalledCache !== undefined) return cltInstalledCache;
  // `git` is present in both CLT and full Xcode install layouts. If a
  // real backing binary exists at any of the known toolchain dirs, the
  // toolchain is installed.
  cltInstalledCache = Boolean(developerToolBackingPath('git'));
  return cltInstalledCache;
}

/** Test-only: drop the cached CLT detection so the next call re-stats. */
export function _resetCltDetectionCache(): void {
  cltInstalledCache = undefined;
}

export function resolveSafeCliProbe(command: string, resolved: string): SafeCliProbe {
  // STRUCTURAL GUARD: when no Xcode/CLT is installed, every binary at
  // `/usr/bin/*` that isn't already known to the system is a potential
  // CLT shim. Invoking ANY of them — git, cmpdylib, wish, future
  // unknowns — pops Apple's installer GUI. Detect "no toolchain present"
  // once via file-stat and short-circuit before we run anything.
  //
  // Binaries outside /usr/bin (Homebrew, asdf, npm globals, /usr/local)
  // are real and fine to probe regardless of CLT state.
  if (resolved.startsWith('/usr/bin/') && !isDeveloperToolchainInstalled()) {
    return {
      skipped: true,
      command,
      path: resolved,
      reason: 'Skipped /usr/bin binary: macOS Command Line Tools not installed (would trigger the system installer). Install Xcode CLT or a non-system version of this binary, then retry.',
    };
  }

  if (SYSTEM_BINARIES_THAT_LAUNCH_GUI_OR_INSTALLER.has(command) && resolved.startsWith('/usr/bin/')) {
    return {
      skipped: true,
      command,
      path: resolved,
      reason: 'Skipped macOS system binary to avoid opening a GUI or installer dialog.',
    };
  }

  if (/^wish(?:\d+(?:\.\d+)?)?$/.test(command)) {
    return {
      skipped: true,
      command,
      path: resolved,
      reason: 'Skipped Tcl/Tk wish because probing it opens a GUI app instead of behaving like a CLI.',
    };
  }

  if (!STUB_BINARIES_THAT_TRIGGER_SYSTEM_INSTALLER.has(command)) {
    return { skipped: false, command, path: resolved };
  }
  // Only skip when the resolved path is the system stub location.
  // If the user has a brew/non-system override (e.g. /opt/homebrew/bin/swift
  // via swiftly), the override is real and probing it is fine.
  if (!resolved.startsWith('/usr/bin/')) {
    return { skipped: false, command, path: resolved };
  }
  const backing = developerToolBackingPath(command);
  if (backing) return { skipped: false, command: backing, path: backing };
  return {
    skipped: true,
    command,
    path: resolved,
    reason: 'Skipped macOS Command Line Tools stub to avoid opening the system installer.',
  };
}

export function findSafeCliCommand(command: string): SafeCliProbe | null {
  const resolved = whichOnPath(command);
  if (!resolved) return null;
  return resolveSafeCliProbe(command, resolved);
}

/**
 * Probe a single command. Returns null if the binary isn't on PATH.
 * Otherwise returns a CliEntry with whatever we learned. Tries
 * --version first, falls back to --help. If both fail the entry comes
 * back with `isLikelyCli: false` so callers can choose to hide it.
 *
 * Special case: macOS Command Line Tools stubs (see set above) are
 * skipped because invoking them triggers a system-level installer
 * GUI we can't suppress.
 */
export async function probe(command: string, candidatePath?: string): Promise<CliEntry | null> {
  const resolved = candidatePath ?? whichOnPath(command);
  if (!resolved) return null;

  const safe = resolveSafeCliProbe(command, resolved);
  if (safe.skipped) {
    return {
      command,
      path: resolved,
      isLikelyCli: false,
      helpHead: safe.reason,
      probedAt: new Date().toISOString(),
    };
  }

  const versionOut = await runQuick(safe.command, ['--version']);
  const helpOut = versionOut ? undefined : await runQuick(safe.command, ['--help']);

  const version = headLines(versionOut ?? '', 2);
  const helpHead = headLines(helpOut ?? '', 4);

  return {
    command,
    path: safe.path,
    isLikelyCli: Boolean(version || helpHead),
    version,
    helpHead,
    probedAt: new Date().toISOString(),
  };
}

function whichOnPath(command: string): string | undefined {
  const PATH = process.env.PATH ?? '';
  for (const dir of PATH.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, command);
    try {
      const st = statSync(candidate);
      if (st.isFile() && (st.mode & 0o111)) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Full scan: walk $PATH, then probe each binary in bounded-concurrency
 * batches so we don't fork 200 children at once. Returns the result
 * AND writes it to the cache so the dashboard has fresh data.
 */
export async function fullScan(opts: { concurrency?: number } = {}): Promise<CliScanResult> {
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 6, 16));
  const detected = scanPath();
  const clis: CliEntry[] = [];

  let i = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = i;
      i += 1;
      if (idx >= detected.length) return;
      const { command, path: p } = detected[idx];
      const entry = await probe(command, p).catch(() => null);
      if (entry && entry.isLikelyCli) clis.push(entry);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  clis.sort((a, b) => a.command.localeCompare(b.command));

  const result: CliScanResult = {
    detected,
    clis,
    scannedAt: new Date().toISOString(),
  };
  writeCachedScan(result);
  return result;
}

/**
 * Lighter entry point for the dashboard: return the cached scan if
 * fresh, otherwise run a new scan. Pass force=true to bypass the
 * cache (the "scan now" button).
 */
export async function getOrRefreshScan(opts: { force?: boolean } = {}): Promise<CliScanResult> {
  if (!opts.force) {
    const cached = readCachedScan();
    if (cached && isCacheFresh(cached.scannedAt)) return cached;
  }
  return fullScan();
}

/**
 * Filter the cached CLI list by a substring (case-insensitive). Used by
 * the agent's local_cli_list tool to keep result size down when it
 * already knows what it's looking for ("sf", "aws", etc.).
 */
export function filterClis(scan: CliScanResult, filter?: string): CliEntry[] {
  if (!filter || !filter.trim()) return scan.clis;
  const needle = filter.trim().toLowerCase();
  // Exact match wins — when the caller passes `filter: "sf"` they want
  // `sf`, not `csfdiagnose` (substring noise).
  const exact = scan.clis.filter((c) => c.command.toLowerCase() === needle);
  if (exact.length > 0) return exact;
  // CRITICAL fallback: some CLIs (e.g. `sf`, which embeds Node.js) FAIL
  // the --version probe under the macOS sandbox the daemon runs under,
  // so they end up in scan.detected (the raw binary list) but NOT in
  // scan.clis (the probed-cleanly list). They ARE installed, the model
  // just can't see them via clis. When clis has no exact match, look
  // at detected for one — that's the same correctness signal the user
  // would get from `which <name>` in their terminal.
  const fromDetected = scan.detected.find((d) => d.command.toLowerCase() === needle);
  if (fromDetected) {
    const safe = resolveSafeCliProbe(fromDetected.command, fromDetected.path);
    if (safe.skipped) return [];
    return [{
      command: fromDetected.command,
      path: safe.path,
      isLikelyCli: true,
      // No version/helpHead — the probe failed at scan time, but the
      // binary exists on $PATH. The model should treat this as
      // "installed but unprobed" and rely on a direct probe via
      // `local_cli_probe` or `run_shell_command <cmd> --version` to
      // confirm runtime behavior.
    }];
  }
  // Fall back to substring across clis for genuinely fuzzy lookups
  // ("docker" → docker + dockerd).
  return scan.clis.filter((c) => c.command.toLowerCase().includes(needle));
}
