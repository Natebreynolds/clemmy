import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import type { Check, ProofReport } from './types.js';
import { RUNTIME_SOURCE_PATHS } from '../../src/runtime/source-fingerprint.js';

/** One canonical compilation/runtime scope; proof identity cannot omit tsconfig. */
export const PROOF_SOURCE_PATHS = RUNTIME_SOURCE_PATHS;

export interface UntrackedSourceFile {
  path: string;
  contents: Buffer;
}

const GIT_OUTPUT_MAX_BYTES = 256 * 1024 * 1024;

export interface ProofSourceStability {
  sourceFingerprintEnd?: string;
  sourceStable: boolean;
  /** Release cleanliness spans the whole run, not just its first instant. */
  sourceClean: boolean;
  check: Check;
}

/** Pure finish-time evidence decision. A missing/invalid finish fingerprint is
 * drift for proof purposes; inability to prove stability can never pass open. */
export function evaluateProofSourceStability(input: {
  sourceFingerprintStart: string;
  sourceFingerprintEnd?: string;
  sourceCleanAtStart: boolean;
  sourceCleanAtEnd: boolean;
}): ProofSourceStability {
  const startValid = /^[a-f0-9]{64}$/.test(input.sourceFingerprintStart);
  const endValid = typeof input.sourceFingerprintEnd === 'string'
    && /^[a-f0-9]{64}$/.test(input.sourceFingerprintEnd);
  const sourceStable = startValid
    && endValid
    && input.sourceFingerprintEnd === input.sourceFingerprintStart;
  return {
    ...(endValid ? { sourceFingerprintEnd: input.sourceFingerprintEnd } : {}),
    sourceStable,
    sourceClean: input.sourceCleanAtStart && input.sourceCleanAtEnd && sourceStable,
    check: {
      name: 'proof source remained byte-identical through live execution',
      pass: sourceStable,
      detail: sourceStable
        ? input.sourceFingerprintStart
        : `start=${input.sourceFingerprintStart || '(missing)'} end=${input.sourceFingerprintEnd || '(unavailable)'}`,
    },
  };
}

/**
 * Fingerprint the exact source material used by a proof. A commit SHA alone
 * cannot distinguish dirty development runs, and those are precisely the runs
 * most often compared while converging on a candidate.
 */
export function fingerprintProofSource(input: {
  gitHead: string;
  trackedDiff: Buffer;
  untrackedFiles: readonly UntrackedSourceFile[];
}): string {
  const hash = createHash('sha256');
  hash.update('clementine-proof-source-v1\0');
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

/** Collect the scoped Git diff plus untracked source bytes without mutating the checkout. */
export function fingerprintProofSourceFromGit(input: {
  repoRoot: string;
  gitHead: string;
  sourcePaths?: readonly string[];
}): string {
  const sourcePaths = input.sourcePaths ?? PROOF_SOURCE_PATHS;
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
  const untrackedPaths = untrackedRaw.toString('utf8').split('\0').filter(Boolean);
  const untrackedFiles = untrackedPaths.map((relativePath) => ({
    path: relativePath,
    contents: readFileSync(path.join(input.repoRoot, relativePath)),
  }));
  return fingerprintProofSource({ gitHead: input.gitHead, trackedDiff, untrackedFiles });
}

function archiveStem(report: ProofReport): string {
  const timestamp = report.startedAt.replace(/[:.]/g, '-');
  return `${timestamp}-${report.sourceFingerprint.slice(0, 12)}`;
}

function preserveExistingLatest(latestPath: string, archiveDir: string): void {
  if (!existsSync(latestPath)) return;
  const prior = readFileSync(latestPath);
  try {
    const parsed = JSON.parse(prior.toString('utf8')) as Partial<ProofReport>;
    if (
      typeof parsed.startedAt === 'string'
      && typeof parsed.sourceFingerprint === 'string'
      && /^[a-f0-9]{64}$/.test(parsed.sourceFingerprint)
    ) {
      const alreadyArchived = path.join(
        archiveDir,
        `${archiveStem(parsed as ProofReport)}.json`,
      );
      if (existsSync(alreadyArchived)) return;
    }
  } catch { /* preserve malformed/legacy evidence by content digest below */ }

  let priorStartedAt = 'unknown-time';
  try {
    const parsed = JSON.parse(prior.toString('utf8')) as { startedAt?: unknown };
    if (typeof parsed.startedAt === 'string') {
      priorStartedAt = parsed.startedAt.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80);
    }
  } catch { /* keep the unknown-time label */ }
  const digest = createHash('sha256').update(prior).digest('hex').slice(0, 12);
  const legacyPath = path.join(archiveDir, `previous-${priorStartedAt}-${digest}.json`);
  try {
    writeFileSync(legacyPath, prior, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

/**
 * Preserve every completed report, then update the backwards-compatible
 * proof-report.json pointer. A later proof can no longer erase comparison
 * evidence from an earlier run.
 */
export function writeProofReportFiles(input: {
  report: ProofReport;
  outputRoot: string;
}): { latestPath: string; archivePath: string } {
  const serialized = `${JSON.stringify(input.report, null, 2)}\n`;
  const archiveDir = path.join(input.outputRoot, 'proof-reports');
  mkdirSync(archiveDir, { recursive: true });
  const latestPath = path.join(input.outputRoot, 'proof-report.json');
  preserveExistingLatest(latestPath, archiveDir);
  const archivePath = path.join(archiveDir, `${archiveStem(input.report)}.json`);
  writeFileSync(archivePath, serialized, { encoding: 'utf8', flag: 'wx' });

  writeFileSync(latestPath, serialized, { encoding: 'utf8' });
  return { latestPath, archivePath };
}
