import path from 'node:path';
import os from 'node:os';

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
  return { ...env, ...extra };
}
