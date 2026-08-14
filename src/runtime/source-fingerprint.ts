import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Source material that can change the built daemon or its release proof. */
export const RUNTIME_SOURCE_PATHS = [
  'src',
  'apps',
  'scripts',
  'docs',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
] as const;

const GIT_OUTPUT_MAX_BYTES = 256 * 1024 * 1024;

export interface RuntimeUntrackedSourceFile {
  path: string;
  contents: Buffer;
}

/** Pure byte identity shared by build stamps and live dev-tree attestation. */
export function fingerprintRuntimeSource(input: {
  gitHead: string;
  trackedDiff: Buffer;
  untrackedFiles: readonly RuntimeUntrackedSourceFile[];
}): string {
  const hash = createHash('sha256');
  hash.update('clementine-runtime-source-v1\0');
  hash.update(input.gitHead);
  hash.update('\0tracked-diff\0');
  hash.update(input.trackedDiff);
  for (const file of [...input.untrackedFiles].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update('\0untracked-path\0');
    hash.update(file.path);
    hash.update('\0untracked-contents\0');
    hash.update(file.contents);
  }
  return hash.digest('hex');
}

/** Read-only exact identity for the scoped candidate source in a Git checkout. */
export function fingerprintRuntimeSourceFromGit(input: {
  repoRoot: string;
  gitHead?: string;
  sourcePaths?: readonly string[];
}): string {
  const sourcePaths = input.sourcePaths ?? RUNTIME_SOURCE_PATHS;
  const gitHead = input.gitHead ?? execFileSync(
    'git',
    ['rev-parse', 'HEAD'],
    { cwd: input.repoRoot, encoding: 'utf8', maxBuffer: GIT_OUTPUT_MAX_BYTES },
  ).trim();
  if (!/^[0-9a-f]{40}$/.test(gitHead)) {
    throw new Error(`runtime source fingerprint requires a full git sha (got ${JSON.stringify(gitHead)})`);
  }
  const trackedDiff = execFileSync(
    'git',
    ['diff', '--binary', 'HEAD', '--', ...sourcePaths],
    { cwd: input.repoRoot, maxBuffer: GIT_OUTPUT_MAX_BYTES },
  );
  const untrackedRaw = execFileSync(
    'git',
    ['ls-files', '--others', '--exclude-standard', '-z', '--', ...sourcePaths],
    { cwd: input.repoRoot, maxBuffer: GIT_OUTPUT_MAX_BYTES },
  );
  const untrackedFiles = untrackedRaw.toString('utf8').split('\0').filter(Boolean).map((relativePath) => ({
    path: relativePath,
    contents: readFileSync(path.join(input.repoRoot, relativePath)),
  }));
  return fingerprintRuntimeSource({ gitHead, trackedDiff, untrackedFiles });
}
