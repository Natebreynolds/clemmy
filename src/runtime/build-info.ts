import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { fingerprintRuntimeSourceFromGit } from './source-fingerprint.js';
import { HARNESS_SCHEMA_VERSION } from './harness/schema-version.js';

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
  /** Exact commit stamped into a build, or resolved from the module's dev tree. */
  gitSha?: string;
  /** Whether the source tree used for this build carried uncommitted changes. */
  gitDirty?: boolean;
  /** Exact scoped source bytes, including tracked diffs and untracked files. */
  sourceFingerprint?: string;
  /** Migration level this daemon build requires before it is ready. */
  expectedSchemaVersion: number;
  /** Actual harness.db migration level observed by this daemon. */
  schemaVersion: number;
}

interface StaticBuildStamp {
  gitSha: string;
  gitDirty: boolean;
  sourceFingerprint: string;
  expectedSchemaVersion: number;
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

function validStamp(value: unknown): StaticBuildStamp | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as {
    gitSha?: unknown;
    gitDirty?: unknown;
    sourceFingerprint?: unknown;
    expectedSchemaVersion?: unknown;
  };
  if (typeof candidate.gitSha !== 'string' || !/^[0-9a-f]{40}$/.test(candidate.gitSha)) return null;
  if (typeof candidate.gitDirty !== 'boolean') return null;
  if (typeof candidate.sourceFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(candidate.sourceFingerprint)) return null;
  if (!Number.isInteger(candidate.expectedSchemaVersion) || candidate.expectedSchemaVersion !== HARNESS_SCHEMA_VERSION) return null;
  return {
    gitSha: candidate.gitSha,
    gitDirty: candidate.gitDirty,
    sourceFingerprint: candidate.sourceFingerprint,
    expectedSchemaVersion: candidate.expectedSchemaVersion as number,
  };
}

/** A production build writes this next to dist/runtime/build-info.js. */
function readBuildTimeStamp(moduleDir: string): StaticBuildStamp | null {
  const file = path.join(moduleDir, 'build-stamp.json');
  if (!existsSync(file)) return null;
  try {
    return validStamp(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

/** Dev-only fallback anchored to this module, never process.cwd(). A CLI may
 * be launched from any project directory; that directory is not Clementine's
 * source identity. Packaged builds fail closed if their stamp is absent. */
function readDevGitState(moduleDir: string, packaged: boolean): StaticBuildStamp | null {
  if (packaged) return null;
  let sourceRoot = moduleDir;
  for (let i = 0; i < 10 && path.dirname(sourceRoot) !== sourceRoot; i += 1) {
    if (existsSync(path.join(sourceRoot, '.git'))) break;
    sourceRoot = path.dirname(sourceRoot);
  }
  if (!existsSync(path.join(sourceRoot, '.git'))) return null;
  try {
    const opts = {
      cwd: sourceRoot,
      encoding: 'utf-8' as const,
      stdio: ['ignore', 'pipe', 'ignore'] as Array<'ignore' | 'pipe'>,
    };
    const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], opts).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], opts).trim().length > 0;
    const sourceFingerprint = fingerprintRuntimeSourceFromGit({ repoRoot: sourceRoot, gitHead: gitSha });
    return validStamp({
      gitSha,
      gitDirty: dirty,
      sourceFingerprint,
      expectedSchemaVersion: HARNESS_SCHEMA_VERSION,
    });
  } catch {
    return null;
  }
}

function observedHarnessSchemaVersion(): number {
  const baseDir = process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine-next');
  const dbPath = path.join(baseDir, 'state', 'harness.db');
  if (!existsSync(dbPath)) return 0;
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const hasTable = db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'`,
    ).get();
    if (!hasTable) return 0;
    const row = db.prepare(
      'SELECT MIN(version) AS minVersion, MAX(version) AS maxVersion, COUNT(*) AS versionCount FROM schema_version',
    ).get() as {
      minVersion: number | null;
      maxVersion: number | null;
      versionCount: number;
    };
    // MAX alone lies when an intermediate migration row is missing. Since the
    // runner advances from MAX, that corruption would never self-repair.
    const contiguous = harnessSchemaRowsAreContiguous(row, HARNESS_SCHEMA_VERSION);
    return contiguous ? HARNESS_SCHEMA_VERSION : 0;
  } catch {
    return 0;
  } finally {
    db?.close();
  }
}

export function harnessSchemaRowsAreContiguous(
  row: { minVersion: number | null; maxVersion: number | null; versionCount: number },
  expectedVersion: number,
): boolean {
  return Number.isInteger(expectedVersion)
    && expectedVersion > 0
    && row.minVersion === 1
    && row.maxVersion === expectedVersion
    && row.versionCount === expectedVersion;
}

let cachedStatic: Omit<BuildInfo, 'schemaVersion'> | null = null;

export function getBuildInfo(): BuildInfo {
  if (!cachedStatic) {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const entry = process.argv[1] ?? moduleDir;
    const packaged = looksPackaged(entry);
    const stamp = readBuildTimeStamp(moduleDir) ?? readDevGitState(moduleDir, packaged);
    cachedStatic = {
      version: findNearestPackageVersion(moduleDir),
      entry,
      packaged,
      expectedSchemaVersion: HARNESS_SCHEMA_VERSION,
      ...(stamp ?? {}),
    };
  }
  // The source identity is immutable for a process; migration state is not.
  // Re-read the latter so an early startup banner cannot freeze schemaVersion
  // at zero before harness.db is opened and migrated.
  return { ...cachedStatic, schemaVersion: observedHarnessSchemaVersion() };
}

/** One-line human summary for the startup banner. */
export function describeBuild(info: BuildInfo = getBuildInfo()): string {
  const where = info.packaged ? 'packaged bundle' : 'dev tree';
  const git = info.gitSha ? ` · git ${info.gitSha}${info.gitDirty ? '-dirty' : ''}` : '';
  const fingerprint = info.sourceFingerprint ? ` · source ${info.sourceFingerprint.slice(0, 12)}` : '';
  return `v${info.version} (${where})${git}${fingerprint} · schema ${info.schemaVersion}/${info.expectedSchemaVersion} · ${info.entry}`;
}
