import path from 'node:path';

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
  const sep = ':';
  const candidates: string[] = [];
  try {
    const dir = path.dirname(process.execPath);
    if (dir) candidates.push(dir);
  } catch {
    /* execPath unset is fine */
  }
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
  const existingParts = (existing ?? '').split(sep).filter(Boolean);
  const seen = new Set(existingParts);
  const prepend: string[] = [];
  for (const dir of candidates) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    prepend.push(dir);
  }
  return [...prepend, ...existingParts].join(sep);
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
  env.PATH = augmentPath(env.PATH);
  return { ...env, ...extra };
}
