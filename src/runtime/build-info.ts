import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Build / version self-report (operational clarity).
 *
 * The trap this closes: the running daemon can be a packaged bundle
 * (e.g. `…/release-workflowux/…/daemon/dist/index.js`) while you're
 * editing `src/`. You fix a bug ten times in src and the installed app
 * keeps failing because it's running stale compiled code. Surfacing
 * WHAT build is actually running — at startup and via the health
 * endpoint — makes that divergence visible instead of silent.
 */

export interface BuildInfo {
  /** Version from the nearest package.json, or 'unknown'. */
  version: string;
  /** The daemon entry actually executing (process.argv[1]). */
  entry: string;
  /** True when running from a packaged .app / release-* bundle. */
  packaged: boolean;
  /** Short git sha if a working tree is reachable (dev only). */
  gitSha?: string;
  /** Whether that working tree has uncommitted changes (dev only). */
  gitDirty?: boolean;
}

function findNearestPackageVersion(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf-8')) as { name?: string; version?: string };
        if (pkg.version) return pkg.version;
      } catch {
        // keep walking up
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'unknown';
}

function looksPackaged(entry: string): boolean {
  return /\.app\/Contents\/Resources\b/.test(entry)
    || /\/release-[A-Za-z0-9._-]+\//.test(entry)
    || entry.startsWith('/Applications/');
}

/** Best-effort git state of the SOURCE tree (cwd). Skipped when
 *  packaged (no .git, and we avoid spawning under the app sandbox). */
function readGitState(packaged: boolean): { gitSha?: string; gitDirty?: boolean } {
  if (packaged) return {};
  try {
    const opts = {
      cwd: process.cwd(),
      encoding: 'utf-8' as const,
      stdio: ['ignore', 'pipe', 'ignore'] as Array<'ignore' | 'pipe'>,
    };
    const gitSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], opts).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], opts).trim().length > 0;
    return { gitSha: gitSha || undefined, gitDirty: dirty };
  } catch {
    return {};
  }
}

let cached: BuildInfo | null = null;

export function getBuildInfo(): BuildInfo {
  if (cached) return cached;
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const entry = process.argv[1] ?? moduleDir;
  const packaged = looksPackaged(entry);
  cached = {
    version: findNearestPackageVersion(moduleDir),
    entry,
    packaged,
    ...readGitState(packaged),
  };
  return cached;
}

/** One-line human summary for the startup banner. */
export function describeBuild(info: BuildInfo = getBuildInfo()): string {
  const where = info.packaged ? 'packaged bundle' : 'dev tree';
  const git = info.gitSha ? ` · git ${info.gitSha}${info.gitDirty ? '-dirty' : ''}` : '';
  return `v${info.version} (${where})${git} · ${info.entry}`;
}
