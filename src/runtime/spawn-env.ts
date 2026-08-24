import path from 'node:path';
import os from 'node:os';
import { accessSync, mkdirSync, readdirSync, readFileSync, statSync, constants as fsConstants } from 'node:fs';

function existingDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function versionDirectories(root: string, suffix: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }))
    .map((name) => path.join(root, name, ...suffix))
    .filter(existingDirectory);
}

/**
 * Executable directories used by common user-level runtime managers. Discovery
 * is file-metadata-only: app startup never sources a login shell (which may be
 * interactive, slow, or side-effecting).
 */
export function userManagedExecutableDirs(home: string): string[] {
  if (!home) return [];
  const candidates = [
    path.join(home, '.volta', 'bin'),
    path.join(home, '.asdf', 'shims'),
    path.join(home, '.local', 'share', 'mise', 'shims'),
    path.join(home, '.mise', 'shims'),
    path.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
    path.join(home, '.fnm', 'aliases', 'default', 'bin'),
    ...versionDirectories(path.join(home, '.nvm', 'versions', 'node'), ['bin']),
    ...versionDirectories(path.join(home, '.local', 'share', 'fnm', 'node-versions'), ['installation', 'bin']),
    ...versionDirectories(path.join(home, '.fnm', 'node-versions'), ['installation', 'bin']),
  ];
  const npmPrefix = process.env.NPM_CONFIG_PREFIX ?? process.env.npm_config_prefix;
  if (npmPrefix?.trim()) candidates.push(path.join(npmPrefix.trim(), 'bin'));
  return [...new Set(candidates.filter(existingDirectory))];
}

function isolatedNpmCache(env: Record<string, string>): string | undefined {
  // An explicit user/operator override is authoritative, including the lowercase
  // spelling npm itself supports.
  if (env.NPM_CONFIG_CACHE?.trim() || env.npm_config_cache?.trim()) return undefined;
  let base: string;
  try {
    base = process.env.CLEMENTINE_HOME?.trim() || path.join(os.homedir(), '.clementine-next');
  } catch {
    return undefined;
  }
  const cache = path.join(base, 'cache', 'npm');
  try {
    mkdirSync(cache, { recursive: true, mode: 0o700 });
    if (!statSync(cache).isDirectory()) return undefined;
    accessSync(cache, fsConstants.W_OK | fsConstants.X_OK);
    return cache;
  } catch {
    // Spawn construction must remain usable even when the Clementine home is
    // temporarily read-only. In that case leave npm's own default untouched.
    return undefined;
  }
}

/**
 * macOS Electron apps launched from /Applications inherit a minimal PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`) — none of the dirs where Homebrew or
 * nvm install `node`/`npx`/`uvx`, NOR where user CLIs (sf, firecrawl, pc,
 * composio, hyperframes, …) live. Two failure modes share this single root:
 *
 *   1. Every stdio MCP server fails with `spawn npx ENOENT` on first call.
 *   2. Every CLI-backed skill the daemon shells out to gets
 *      "command not found" — and Clem then misreports the binary as "not
 *      installed", sending the user to reinstall something already present.
 *
 * The fix is one PATH-augmentation used at every spawn/discovery seam:
 * prepend (a) the directory of the node binary that's running us, plus
 * (b) the well-known Homebrew + system tool dirs. Idempotent — entries
 * already on PATH are skipped and the original order is preserved after
 * the prepends, so this can only WIDEN resolution, never change which
 * binary wins for a name already reachable.
 */
export function augmentPath(existing: string | undefined): string {
  const candidates: string[] = [];
  try {
    const dir = path.dirname(process.execPath);
    if (dir) candidates.push(dir);
  } catch {
    /* execPath unset is fine */
  }
  // The native installers for user CLIs (Claude Code → ~/.local/bin/claude,
  // plus many others) put their launcher here; a /Applications Electron launch
  // never inherits it. Add it before the system dirs so the daemon discovers
  // them (idempotent, widen-only).
  try {
    const home = os.homedir();
    if (home) {
      if (process.platform === 'win32') {
        candidates.push(path.join(home, 'scoop', 'shims'));
      } else {
        candidates.push(...userManagedExecutableDirs(home));
        candidates.push(path.join(home, '.local', 'bin'));
      }
    }
  } catch {
    /* homedir unavailable is fine */
  }

  if (process.platform === 'win32') {
    if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm'));
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps'));
    if (process.env.ProgramData) candidates.push(path.join(process.env.ProgramData, 'chocolatey', 'bin'));
    if (process.env.SCOOP) candidates.push(path.join(process.env.SCOOP, 'shims'));
  } else {
    candidates.push(
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/local/sbin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    );
  }

  const existingParts = (existing ?? '').split(path.delimiter).filter(Boolean);
  const seen = new Set(existingParts);
  const prepend: string[] = [];
  for (const dir of candidates) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    prepend.push(dir);
  }
  return [...prepend, ...existingParts].join(path.delimiter);
}


/**
 * User-declared environment for the CLIs Clem spawns.
 *
 * A global CLI's credentials frequently depend on environment, not just files:
 * which profile to assume, which config to read, which credential store to use.
 * Clem had no supported way to set any of it. The daemon's own .env is parsed
 * into a private object and read through getEnv() — it never reaches
 * process.env, so it never reached a child CLI either, and handing children the
 * whole daemon environment is not an option (it carries Clementine's own
 * secrets).
 *
 * So the surface is explicit and separate: state/cli-env.json, owned by the
 * user, applied to every CLI spawn. Vendor-neutral by construction — teaching
 * Clem about a new CLI's environment is a config edit, never a code change.
 *
 * PATH is refused: every CLI seam depends on the augmentation below, and a
 * silent override here would reintroduce the "binary not installed" class it
 * exists to prevent.
 */
const CLI_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
let cliEnvCache: { file: string; mtimeMs: number; values: Record<string, string> } | undefined;

export function userDeclaredCliEnv(): Record<string, string> {
  let file: string;
  try {
    const base = process.env.CLEMENTINE_HOME?.trim() || path.join(os.homedir(), '.clementine-next');
    file = path.join(base, 'state', 'cli-env.json');
  } catch {
    return {};
  }
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    cliEnvCache = undefined;
    return {};
  }
  // Keyed on path AND mtime: CLEMENTINE_HOME moves between runs (and in tests),
  // so an mtime-only key can serve one home's values to another.
  if (cliEnvCache?.file === file && cliEnvCache.mtimeMs === mtimeMs) return cliEnvCache.values;
  const values: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!CLI_ENV_KEY.test(key)) continue;
        if (key.toUpperCase() === 'PATH') continue;
        if (typeof value === 'string') values[key] = value;
        else if (typeof value === 'number' || typeof value === 'boolean') values[key] = String(value);
      }
    }
  } catch {
    // A malformed file must not make every CLI spawn fail. It is ignored, and
    // the user still sees the underlying command's own error.
    return {};
  }
  cliEnvCache = { file, mtimeMs, values };
  return values;
}

/**
 * Build a child-process env that inherits the parent environment but with
 * an augmented PATH, so binaries resolve on a packaged `.app` launch.
 * `extra` overrides win (matching the prior MCP-spawn behavior).
 */
export function mergedSpawnEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  const pathKey = process.platform === 'win32'
    ? Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'Path'
    : 'PATH';
  const currentPath = env[pathKey] ?? env.PATH;
  if (process.platform === 'win32') {
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === 'path' && key !== pathKey) delete env[key];
    }
  }
  env[pathKey] = augmentPath(currentPath);
  // Consider per-call overrides before choosing a default, otherwise a lowercase
  // `extra.npm_config_cache` would coexist with (and potentially lose to) our
  // uppercase default.
  const npmCache = isolatedNpmCache({ ...env, ...extra });
  if (npmCache) env.NPM_CONFIG_CACHE = npmCache;
  // User declarations win over the inherited environment (that is the point of
  // declaring them) but never over an explicit per-call override.
  return { ...env, ...userDeclaredCliEnv(), ...extra };
}
