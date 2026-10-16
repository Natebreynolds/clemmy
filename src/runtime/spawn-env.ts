import path from 'node:path';
import os from 'node:os';
import { accessSync, closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, statSync,
  constants as fsConstants, type BigIntStats } from 'node:fs';
import { childEnvValue, mergeChildEnvLayers, type ChildEnvLayer } from './child-env-layers.js';

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

/** The Node install nvm's own `default` alias names: the one the owner's
 *  terminal runs. Sorting installs by number alone put a stale v24 (with a
 *  month-old codex CLI on it) ahead of the owner's chosen v22. Follows alias
 *  chains such as `lts/*`; null when no default resolves to an install. */
function nvmDefaultBin(home: string): string | null {
  const nvm = path.join(home, '.nvm');
  let value: string;
  try { value = readFileSync(path.join(nvm, 'alias', 'default'), 'utf8').trim(); } catch { return null; }
  for (let hop = 0; hop < 3 && value && !/^v?\d/.test(value); hop += 1) {
    try { value = readFileSync(path.join(nvm, 'alias', value), 'utf8').trim(); } catch { return null; }
  }
  if (!/^v?\d/.test(value)) return null;
  const want = value.startsWith('v') ? value : `v${value}`;
  const match = versionDirectories(path.join(nvm, 'versions', 'node'))
    .find((dir) => { const name = path.basename(dir); return name === want || name.startsWith(`${want}.`); });
  return match && existingDirectory(path.join(match, 'bin')) ? path.join(match, 'bin') : null;
}

/** nvm's default install first, then the rest newest-first. */
function nvmExecutableDirs(home: string): string[] {
  const all = versionDirectories(path.join(home, '.nvm', 'versions', 'node'), ['bin']);
  const preferred = nvmDefaultBin(home);
  return preferred ? [preferred, ...all.filter((dir) => dir !== preferred)] : all;
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
    ...nvmExecutableDirs(home),
    ...versionDirectories(path.join(home, '.local', 'share', 'fnm', 'node-versions'), ['installation', 'bin']),
    ...versionDirectories(path.join(home, '.fnm', 'node-versions'), ['installation', 'bin']),
  ];
  const npmPrefix = process.env.NPM_CONFIG_PREFIX ?? process.env.npm_config_prefix;
  if (npmPrefix?.trim()) candidates.push(path.join(npmPrefix.trim(), 'bin'));
  return [...new Set(candidates.filter(existingDirectory))];
}

function isolatedNpmCache(env: Record<string, string>, platform: NodeJS.Platform): string | undefined {
  // An explicit user/operator override is authoritative, including the lowercase
  // spelling npm itself supports.
  if (childEnvValue(env, 'NPM_CONFIG_CACHE', platform) !== undefined
    || childEnvValue(env, 'npm_config_cache', platform) !== undefined) return undefined;
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
let cliEnvCache: { file: string; generation: string; values: Readonly<Record<string, string>> } | undefined;

function cliEnvGeneration(stat: BigIntStats): string {
  return `${stat.dev}\0${stat.ino}\0${stat.ctimeNs}\0${stat.mtimeNs}\0${stat.size}`;
}

/** Read one stable file generation while preserving the existing support for
 * user-owned symlinks. File-handle checks bind the bytes, and the final path
 * check rejects a replacement or retarget that happened during the read. */
function readCliEnvValues(file: string, before: BigIntStats): Record<string, string> {
  const generation = cliEnvGeneration(before);
  const fd = openSync(file, 'r');
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || cliEnvGeneration(opened) !== generation) throw new Error('CLI environment changed before read');
    const text = readFileSync(fd, 'utf8');
    const afterRead = fstatSync(fd, { bigint: true });
    const afterPath = statSync(file, { bigint: true });
    if (!afterRead.isFile() || !afterPath.isFile()
      || cliEnvGeneration(afterRead) !== generation || cliEnvGeneration(afterPath) !== generation) {
      throw new Error('CLI environment changed during read');
    }
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('CLI environment is not an object');
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).flatMap(([key, value]) => {
      if (!CLI_ENV_KEY.test(key) || key.toUpperCase() === 'PATH') return [];
      if (typeof value === 'string') return [[key, value]];
      if (typeof value === 'number' || typeof value === 'boolean') return [[key, String(value)]];
      return [];
    }));
  } finally {
    closeSync(fd);
  }
}

export function userDeclaredCliEnv(): Record<string, string> {
  let file: string;
  try {
    const base = process.env.CLEMENTINE_HOME?.trim() || path.join(os.homedir(), '.clementine-next');
    file = path.join(base, 'state', 'cli-env.json');
  } catch {
    cliEnvCache = undefined;
    return {};
  }
  try {
    const before = statSync(file, { bigint: true });
    if (!before.isFile()) throw new Error('CLI environment is not a file');
    const generation = cliEnvGeneration(before);
    // Atomic replacement and restored mtime must invalidate the old settings.
    // Keep the path too: tests and separate homes must never share declarations.
    if (cliEnvCache?.file === file && cliEnvCache.generation === generation) {
      return Object.fromEntries(Object.entries(cliEnvCache.values));
    }
    const values = Object.freeze(readCliEnvValues(file, before));
    cliEnvCache = { file, generation, values };
    return Object.fromEntries(Object.entries(values));
  } catch {
    // Missing, malformed, unreadable or raced settings never retain a previous
    // generation. A later call can observe a recovered file normally.
    cliEnvCache = undefined;
    return {};
  }
}

/**
 * Build a child-process env that inherits the parent environment but with
 * an augmented PATH, so binaries resolve on a packaged `.app` launch.
 * `extra` overrides win (matching the prior MCP-spawn behavior).
 */
/**
 * Links that pin each connected CLI's command to the executable its health
 * check verified (kept by the CLI auth-health commit). It leads a child's PATH,
 * so a same-named package elsewhere on PATH cannot shadow the CLI the owner
 * connected. Absent until a check verifies a binary.
 */
export function connectedCliBinDir(): string | undefined {
  try {
    const base = process.env.CLEMENTINE_HOME?.trim() || path.join(os.homedir(), '.clementine-next');
    return path.join(base, 'state', 'connected-cli-bin');
  } catch {
    return undefined;
  }
}

function withConnectedCliBin(pathValue: string): string {
  if (process.platform === 'win32') return pathValue;
  const dir = connectedCliBinDir();
  if (!dir || !existingDirectory(dir)) return pathValue;
  const rest = pathValue.split(path.delimiter).filter((part) => part && part !== dir);
  return [dir, ...rest].join(path.delimiter);
}

/** Nonsecret executable lookup shared by interactive and scrubbed children.
 * This projects only the host-maintained binary directory, never CLI env
 * declarations or the daemon's credential-bearing environment. */
export function childExecutablePath(inheritedPath: string | undefined): string {
  return withConnectedCliBin(augmentPath(inheritedPath));
}

export function mergedSpawnEnv(extra: Record<string, string> = {}, options: {
  inherited?: ChildEnvLayer; platform?: NodeJS.Platform;
} = {}): Record<string, string> {
  const platform = options.platform ?? process.platform;
  const inherited = options.inherited ?? process.env;
  const env = mergeChildEnvLayers([inherited,
    { PATH: childExecutablePath(childEnvValue(inherited, 'PATH', platform)) }], platform);
  // User declarations win over the inherited environment (that is the point of
  // declaring them) but never over an explicit per-call override. An explicit
  // per-call PATH remains verbatim, even empty; declarations cannot set PATH.
  const merged = mergeChildEnvLayers([env, userDeclaredCliEnv(), extra], platform);
  // Evaluate the effective declarations first: an explicit empty cache setting
  // is still an override, not permission to synthesize a second alias.
  const npmCache = isolatedNpmCache(merged, platform);
  return npmCache ? mergeChildEnvLayers([merged, { NPM_CONFIG_CACHE: npmCache }], platform) : merged;
}
