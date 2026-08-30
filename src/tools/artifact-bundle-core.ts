import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { BASE_DIR } from '../config.js';
import { closedCanonicalJson } from '../shared/closed-canonical-json.js';

export const ARTIFACT_BUNDLE_LIMITS = Object.freeze({
  maxFiles: 32,
  maxFileBytes: 64_000,
  maxTotalBytes: 256_000,
  maxPathBytes: 240,
  maxPathSegmentBytes: 120,
});

const MANIFEST_NAME = '.clementine-bundle.json';
const BUNDLE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/;

export type ArtifactBundleErrorCode =
  | 'invalid_bundle_id'
  | 'invalid_file_count'
  | 'invalid_path'
  | 'duplicate_path'
  | 'file_too_large'
  | 'bundle_too_large'
  | 'existing_mismatch'
  | 'filesystem_refusal';

export class ArtifactBundleError extends Error {
  constructor(
    message: string,
    readonly code: ArtifactBundleErrorCode,
  ) {
    super(message);
    this.name = 'ArtifactBundleError';
  }
}

export interface ArtifactBundleInput {
  bundleId: string;
  files: ReadonlyArray<{ path: string; content: string }>;
}

export interface ArtifactBundleFileResult {
  path: string;
  filePath: string;
  sha256: string;
  bytes: number;
}

export interface ArtifactBundleResult {
  version: 1;
  /** Stable provider-neutral artifact identity used by the shared settlement
   * and reconciliation lanes. */
  artifactId: string;
  bundleId: string;
  revisionDigest: string;
  contentDigest: string;
  handle: string;
  directory: string;
  manifestPath: string;
  files: ArtifactBundleFileResult[];
  totalBytes: number;
  created: boolean;
}

export interface ArtifactBundleOptions {
  /** Test seam; production always uses the agent-owned bundle directory. */
  rootDir?: string;
  /** Test-only crash seam immediately before the atomic directory rename. */
  beforePublish?: (stagingDirectory: string) => void;
}

interface PreparedFile {
  path: string;
  content: string;
  sha256: string;
  bytes: number;
}

interface PreparedBundle {
  bundleId: string;
  files: PreparedFile[];
  totalBytes: number;
  revisionDigest: string;
}

interface PersistedBundleManifestV1 {
  version: 1;
  bundleId: string;
  revisionDigest: string;
  totalBytes: number;
  files: Array<{ path: string; sha256: string; bytes: number }>;
}

export type ArtifactBundleInspection =
  | { status: 'absent' }
  | { status: 'mismatch'; reason: string }
  | { status: 'present_exact'; result: ArtifactBundleResult };

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function rootDirectory(options: ArtifactBundleOptions): string {
  return path.resolve(options.rootDir ?? path.join(BASE_DIR, 'files', 'bundles'));
}

function safeBundleId(raw: string): string {
  const bundleId = raw.trim();
  if (!BUNDLE_ID.test(bundleId) || bundleId === '.' || bundleId === '..' || bundleId.includes('..')) {
    throw new ArtifactBundleError(
      'bundle_id must be 1-80 lowercase ASCII letters, numbers, dots, dashes, or underscores and may not contain ".."',
      'invalid_bundle_id',
    );
  }
  return bundleId;
}

function safeRelativeFilePath(raw: string): string {
  if (raw.length === 0 || raw !== raw.trim() || raw.includes('\\') || raw.includes('\0')) {
    throw new ArtifactBundleError(`unsafe artifact path: ${JSON.stringify(raw)}`, 'invalid_path');
  }
  if (path.posix.isAbsolute(raw) || path.posix.normalize(raw) !== raw || raw === MANIFEST_NAME) {
    throw new ArtifactBundleError(`unsafe artifact path: ${JSON.stringify(raw)}`, 'invalid_path');
  }
  const segments = raw.split('/');
  if (
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..' || /[\u0000-\u001f\u007f]/.test(segment))
    || Buffer.byteLength(raw, 'utf8') > ARTIFACT_BUNDLE_LIMITS.maxPathBytes
    || segments.some((segment) => Buffer.byteLength(segment, 'utf8') > ARTIFACT_BUNDLE_LIMITS.maxPathSegmentBytes)
  ) {
    throw new ArtifactBundleError(`unsafe artifact path: ${JSON.stringify(raw)}`, 'invalid_path');
  }
  return raw;
}

function prepareBundle(input: ArtifactBundleInput): PreparedBundle {
  const bundleId = safeBundleId(input.bundleId);
  if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > ARTIFACT_BUNDLE_LIMITS.maxFiles) {
    throw new ArtifactBundleError(
      `files must contain 1-${ARTIFACT_BUNDLE_LIMITS.maxFiles} entries`,
      'invalid_file_count',
    );
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  const files = input.files.map((candidate): PreparedFile => {
    const relativePath = safeRelativeFilePath(candidate.path);
    if (seen.has(relativePath)) {
      throw new ArtifactBundleError(`duplicate artifact path: ${relativePath}`, 'duplicate_path');
    }
    seen.add(relativePath);
    const bytes = Buffer.byteLength(candidate.content, 'utf8');
    if (bytes > ARTIFACT_BUNDLE_LIMITS.maxFileBytes) {
      throw new ArtifactBundleError(
        `${relativePath} is ${bytes} bytes; the per-file limit is ${ARTIFACT_BUNDLE_LIMITS.maxFileBytes}`,
        'file_too_large',
      );
    }
    totalBytes += bytes;
    if (totalBytes > ARTIFACT_BUNDLE_LIMITS.maxTotalBytes) {
      throw new ArtifactBundleError(
        `bundle is ${totalBytes} bytes; the total limit is ${ARTIFACT_BUNDLE_LIMITS.maxTotalBytes}`,
        'bundle_too_large',
      );
    }
    return { path: relativePath, content: candidate.content, sha256: sha256(candidate.content), bytes };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const revisionDigest = sha256(closedCanonicalJson({
    version: 1,
    bundleId,
    files: files.map(({ path: filePath, sha256: digest, bytes }) => ({
      path: filePath,
      sha256: digest,
      bytes,
    })),
  }));
  return { bundleId, files, totalBytes, revisionDigest };
}

function manifestFor(bundle: PreparedBundle): PersistedBundleManifestV1 {
  return {
    version: 1,
    bundleId: bundle.bundleId,
    revisionDigest: bundle.revisionDigest,
    totalBytes: bundle.totalBytes,
    files: bundle.files.map(({ path: filePath, sha256: digest, bytes }) => ({
      path: filePath,
      sha256: digest,
      bytes,
    })),
  };
}

function resultFor(bundle: PreparedBundle, directory: string, created: boolean): ArtifactBundleResult {
  return {
    version: 1,
    artifactId: `${bundle.bundleId}/${bundle.revisionDigest}`,
    bundleId: bundle.bundleId,
    revisionDigest: bundle.revisionDigest,
    contentDigest: bundle.revisionDigest,
    handle: directory,
    directory,
    manifestPath: path.join(directory, MANIFEST_NAME),
    files: bundle.files.map(({ path: filePath, sha256: digest, bytes }) => ({
      path: filePath,
      filePath: path.join(directory, ...filePath.split('/')),
      sha256: digest,
      bytes,
    })),
    totalBytes: bundle.totalBytes,
    created,
  };
}

function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeDurableFile(filePath: string, content: string): void {
  const fd = openSync(filePath, 'wx', 0o600);
  try {
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function expectedDirectories(bundle: PreparedBundle): string[] {
  const directories = new Set<string>();
  for (const file of bundle.files) {
    const segments = file.path.split('/');
    for (let end = 1; end < segments.length; end += 1) {
      directories.add(segments.slice(0, end).join('/'));
    }
  }
  return [...directories].sort();
}

function walkRevision(directory: string): { files: string[]; directories: string[]; refusal?: string } {
  const files: string[] = [];
  const directories: string[] = [];
  const visit = (absolute: string, relative: string): string | undefined => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const childAbsolute = path.join(absolute, entry.name);
      const stat = lstatSync(childAbsolute);
      if (stat.isSymbolicLink()) return `symbolic link is forbidden: ${childRelative}`;
      if (stat.isDirectory()) {
        directories.push(childRelative);
        const refusal = visit(childAbsolute, childRelative);
        if (refusal) return refusal;
      } else if (stat.isFile()) {
        files.push(childRelative);
      } else {
        return `non-file entry is forbidden: ${childRelative}`;
      }
    }
    return undefined;
  };
  return { files, directories, refusal: visit(directory, '') };
}

function inspectPrepared(bundle: PreparedBundle, options: ArtifactBundleOptions): ArtifactBundleInspection {
  const directory = path.join(rootDirectory(options), bundle.bundleId, bundle.revisionDigest);
  if (!existsSync(directory)) return { status: 'absent' };
  let rootStat;
  try {
    rootStat = lstatSync(directory);
  } catch (error) {
    return { status: 'mismatch', reason: `revision could not be inspected: ${(error as Error).message}` };
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return { status: 'mismatch', reason: 'revision target is not a real directory' };
  }
  try {
    const walked = walkRevision(directory);
    if (walked.refusal) return { status: 'mismatch', reason: walked.refusal };
    const expectedFiles = [...bundle.files.map((file) => file.path), MANIFEST_NAME].sort();
    const actualFiles = walked.files.sort();
    if (closedCanonicalJson(actualFiles) !== closedCanonicalJson(expectedFiles)) {
      return { status: 'mismatch', reason: 'revision file set differs from the frozen manifest' };
    }
    const expectedDirs = expectedDirectories(bundle);
    if (closedCanonicalJson(walked.directories.sort()) !== closedCanonicalJson(expectedDirs)) {
      return { status: 'mismatch', reason: 'revision directory set differs from the frozen manifest' };
    }
    const persisted = JSON.parse(readFileSync(path.join(directory, MANIFEST_NAME), 'utf8')) as unknown;
    if (closedCanonicalJson(persisted) !== closedCanonicalJson(manifestFor(bundle))) {
      return { status: 'mismatch', reason: 'persisted bundle manifest differs from the requested revision' };
    }
    for (const file of bundle.files) {
      const body = readFileSync(path.join(directory, ...file.path.split('/')));
      if (body.byteLength !== file.bytes || sha256(body) !== file.sha256) {
        return { status: 'mismatch', reason: `artifact content differs: ${file.path}` };
      }
    }
    return { status: 'present_exact', result: resultFor(bundle, directory, false) };
  } catch (error) {
    return { status: 'mismatch', reason: `revision verification failed: ${(error as Error).message}` };
  }
}

export function inspectArtifactBundle(
  input: ArtifactBundleInput,
  options: ArtifactBundleOptions = {},
): ArtifactBundleInspection {
  return inspectPrepared(prepareBundle(input), options);
}

/**
 * Re-open an immutable revision from its returned artifact identity and verify
 * every persisted path and byte. This is the read-only recovery half of the
 * reviewed local carrier; it never repairs or republishes a directory.
 */
export function inspectArtifactBundleArtifactId(
  artifactId: string,
  options: ArtifactBundleOptions = {},
): ArtifactBundleInspection {
  const separator = artifactId.indexOf('/');
  if (separator <= 0 || artifactId.indexOf('/', separator + 1) !== -1) {
    return { status: 'mismatch', reason: 'artifact id is not a bundle/revision pair' };
  }
  let bundleId: string;
  try {
    bundleId = safeBundleId(artifactId.slice(0, separator));
  } catch (error) {
    return { status: 'mismatch', reason: (error as Error).message };
  }
  const revisionDigest = artifactId.slice(separator + 1);
  if (!/^[a-f0-9]{64}$/.test(revisionDigest)) {
    return { status: 'mismatch', reason: 'artifact revision digest is malformed' };
  }
  const directory = path.join(rootDirectory(options), bundleId, revisionDigest);
  if (!existsSync(directory)) return { status: 'absent' };
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { status: 'mismatch', reason: 'revision target is not a real directory' };
    }
    const raw = JSON.parse(readFileSync(path.join(directory, MANIFEST_NAME), 'utf8')) as {
      version?: unknown;
      bundleId?: unknown;
      revisionDigest?: unknown;
      files?: unknown;
    };
    if (
      !raw || typeof raw !== 'object' || Array.isArray(raw)
      || raw.version !== 1
      || raw.bundleId !== bundleId
      || raw.revisionDigest !== revisionDigest
      || !Array.isArray(raw.files)
    ) return { status: 'mismatch', reason: 'persisted bundle manifest identity is malformed' };
    const files: Array<{ path: string; content: string }> = [];
    const seen = new Set<string>();
    for (const candidate of raw.files) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        return { status: 'mismatch', reason: 'persisted bundle manifest contains a malformed file row' };
      }
      const row = candidate as { path?: unknown; sha256?: unknown; bytes?: unknown };
      if (
        typeof row.path !== 'string'
        || typeof row.sha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(row.sha256)
        || typeof row.bytes !== 'number'
        || !Number.isSafeInteger(row.bytes)
        || row.bytes < 0
      ) return { status: 'mismatch', reason: 'persisted bundle manifest contains invalid file metadata' };
      const relative = safeRelativeFilePath(row.path);
      if (seen.has(relative)) return { status: 'mismatch', reason: `duplicate artifact path: ${relative}` };
      seen.add(relative);
      files.push({ path: relative, content: readFileSync(path.join(directory, ...relative.split('/')), 'utf8') });
    }
    const prepared = prepareBundle({ bundleId, files });
    if (prepared.revisionDigest !== revisionDigest) {
      return { status: 'mismatch', reason: 'artifact bytes do not match the revision identity' };
    }
    return inspectPrepared(prepared, options);
  } catch (error) {
    return { status: 'mismatch', reason: `revision verification failed: ${(error as Error).message}` };
  }
}

export function saveArtifactBundle(
  input: ArtifactBundleInput,
  options: ArtifactBundleOptions = {},
): ArtifactBundleResult {
  const bundle = prepareBundle(input);
  const prior = inspectPrepared(bundle, options);
  if (prior.status === 'present_exact') return prior.result;
  if (prior.status === 'mismatch') {
    throw new ArtifactBundleError(
      `refusing to overwrite an existing mismatched revision: ${prior.reason}`,
      'existing_mismatch',
    );
  }

  const root = rootDirectory(options);
  const bundleRoot = path.join(root, bundle.bundleId);
  const finalDirectory = path.join(bundleRoot, bundle.revisionDigest);
  mkdirSync(bundleRoot, { recursive: true, mode: 0o700 });
  const stagingDirectory = mkdtempSync(path.join(bundleRoot, `.tmp-${process.pid}-${randomBytes(4).toString('hex')}-`));
  let published = false;
  try {
    const directories = expectedDirectories(bundle);
    for (const relative of directories) {
      mkdirSync(path.join(stagingDirectory, ...relative.split('/')), { recursive: true, mode: 0o700 });
    }
    for (const file of bundle.files) {
      writeDurableFile(path.join(stagingDirectory, ...file.path.split('/')), file.content);
    }
    writeDurableFile(
      path.join(stagingDirectory, MANIFEST_NAME),
      `${closedCanonicalJson(manifestFor(bundle))}\n`,
    );
    for (const relative of [...directories].sort((left, right) => right.split('/').length - left.split('/').length)) {
      fsyncDirectory(path.join(stagingDirectory, ...relative.split('/')));
    }
    fsyncDirectory(stagingDirectory);
    options.beforePublish?.(stagingDirectory);
    try {
      renameSync(stagingDirectory, finalDirectory);
      published = true;
      fsyncDirectory(bundleRoot);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
      const concurrent = inspectPrepared(bundle, options);
      if (concurrent.status === 'present_exact') return concurrent.result;
      throw new ArtifactBundleError(
        `concurrent revision publication did not match: ${concurrent.status === 'mismatch' ? concurrent.reason : 'target absent'}`,
        'existing_mismatch',
      );
    }
    const verified = inspectPrepared(bundle, options);
    if (verified.status !== 'present_exact') {
      throw new ArtifactBundleError(
        `published revision failed verification: ${verified.status === 'mismatch' ? verified.reason : 'target absent'}`,
        'filesystem_refusal',
      );
    }
    return { ...verified.result, created: true };
  } catch (error) {
    if (error instanceof ArtifactBundleError) throw error;
    throw new ArtifactBundleError(`artifact bundle publication failed: ${(error as Error).message}`, 'filesystem_refusal');
  } finally {
    if (!published) rmSync(stagingDirectory, { recursive: true, force: true });
  }
}
