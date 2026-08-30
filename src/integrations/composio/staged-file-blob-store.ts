import { createHash, randomUUID, type Hash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from 'node:fs';
import path from 'node:path';

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const MD5_RE = /^[a-f0-9]{32}$/;
const TEMP_BASENAME_RE = /^\.staged-[a-f0-9-]+\.part$/;
const MATERIALIZE_TEMP_BASENAME_RE = /^\.materialize-[a-f0-9-]+\.part$/;
const READ_BUFFER_BYTES = 128 * 1024;
const PUBLICATION_LINK_RETRY_WAIT = new Int32Array(new SharedArrayBuffer(4));
const PUBLICATION_LINK_RETRY_ATTEMPTS = 400;
const PUBLICATION_LINK_RETRY_INTERVAL_MS = 5;

export const DEFAULT_STAGED_FILE_MAX_BYTES = 512 * 1024 * 1024;

export const BUILTIN_STAGED_FILE_DENY_SEGMENTS = Object.freeze([
  '.ssh',
  '.aws',
  '.azure',
  '.gnupg',
  '.kube',
  '.docker',
  '.claude',
  '.password-store',
  'keychains',
]);

const SECRET_BASENAME_RE = /^(?:\.env(?:\..*)?|\.netrc|\.pgpass|\.git-credentials|\.npmrc|\.pypirc|credentials(?:\.json)?|id_(?:rsa|ed25519|ecdsa|dsa|ecdsa_sk)(?:\.old)?)$/i;

export type StagedFileBlobErrorCode =
  | 'invalid_configuration'
  | 'source_missing'
  | 'source_not_allowed'
  | 'sensitive_source'
  | 'source_not_regular'
  | 'source_changed'
  | 'blob_too_large'
  | 'invalid_staged_blob'
  | 'digest_mismatch'
  | 'unsafe_store'
  | 'storage_error';

export class StagedFileBlobError extends Error {
  constructor(
    readonly code: StagedFileBlobErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'StagedFileBlobError';
  }
}

export interface SealedStagedFileBlob {
  /** Host-owned recovery locator. Never derived from a provider value. */
  temporaryPath: string;
  sha256: string;
  md5: string;
  byteCount: number;
}

export interface PublishedStagedFileBlob {
  /** Content-addressed host path: `<store>/sha256-<digest>`. */
  blobPath: string;
  sha256: string;
  md5: string;
  byteCount: number;
}

export interface LocalFileSnapshot extends PublishedStagedFileBlob {
  /** A basename is sufficient for presign metadata without persisting a local path. */
  sourceBasename: string;
}

export interface StagedFileMaterializationReceipt {
  sha256: string;
  md5: string;
  byteCount: number;
  disposition: 'published' | 'adopted';
}

function storageError(message: string, error: unknown): StagedFileBlobError {
  if (error instanceof StagedFileBlobError) return error;
  return new StagedFileBlobError('storage_error', message, error);
}

function validatePositiveByteLimit(value: number | undefined): number {
  const resolved = value ?? DEFAULT_STAGED_FILE_MAX_BYTES;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new StagedFileBlobError(
      'invalid_configuration',
      'staged-file byte limit must be a positive safe integer',
    );
  }
  return resolved;
}

function validateAbsolutePath(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) {
    throw new StagedFileBlobError(
      'invalid_configuration',
      `${label} must be an explicit absolute path`,
    );
  }
  return path.resolve(value);
}

function fsyncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function ensureStoreDirectory(configuredDirectory: string): string {
  const requested = validateAbsolutePath(configuredDirectory, 'blob store directory');
  try {
    mkdirSync(requested, { recursive: true, mode: DIRECTORY_MODE });
    const requestedStat = lstatSync(requested);
    if (requestedStat.isSymbolicLink() || !requestedStat.isDirectory()) {
      throw new StagedFileBlobError(
        'unsafe_store',
        'staged-file blob store must be a real directory, not a link',
      );
    }
    // This is a dedicated staging directory. Tightening an existing mode is
    // intentional: provider-return bytes must never inherit a permissive umask.
    if ((requestedStat.mode & 0o777) !== DIRECTORY_MODE) chmodSync(requested, DIRECTORY_MODE);
    const canonical = realpathSync(requested);
    const canonicalStat = lstatSync(canonical);
    if (
      canonicalStat.isSymbolicLink()
      || !canonicalStat.isDirectory()
      || (canonicalStat.mode & 0o777) !== DIRECTORY_MODE
    ) {
      throw new StagedFileBlobError('unsafe_store', 'staged-file blob store is not a 0700 directory');
    }
    return canonical;
  } catch (error) {
    throw storageError('could not prepare the staged-file blob store', error);
  }
}

function exactExistingStoreDirectory(configuredDirectory: string): string {
  const requested = validateAbsolutePath(configuredDirectory, 'managed destination directory');
  try {
    const requestedStat = lstatSync(requested);
    if (
      requestedStat.isSymbolicLink()
      || !requestedStat.isDirectory()
      || (requestedStat.mode & 0o777) !== DIRECTORY_MODE
    ) {
      throw new StagedFileBlobError(
        'unsafe_store',
        'managed destination is not one exact 0700 directory',
      );
    }
    const canonical = realpathSync(requested);
    const canonicalStat = lstatSync(canonical);
    if (
      canonicalStat.isSymbolicLink()
      || !canonicalStat.isDirectory()
      || (canonicalStat.mode & 0o777) !== DIRECTORY_MODE
    ) {
      throw new StagedFileBlobError(
        'unsafe_store',
        'managed destination canonical owner is not exact',
      );
    }
    return canonical;
  } catch (error) {
    throw storageError('could not reopen the managed destination', error);
  }
}

function normalizedForComparison(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function isInsidePath(candidate: string, root: string): boolean {
  const relative = path.relative(
    normalizedForComparison(root),
    normalizedForComparison(candidate),
  );
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function pathSegments(value: string): string[] {
  return path.resolve(value).split(/[\\/]+/).filter(Boolean).map((segment) => segment.toLowerCase());
}

function validateDenySegments(extra: readonly string[] | undefined): Set<string> {
  const segments = [...BUILTIN_STAGED_FILE_DENY_SEGMENTS];
  for (const raw of extra ?? []) {
    const segment = raw.trim();
    if (
      segment.length === 0
      || segment === '.'
      || segment === '..'
      || segment.includes('/')
      || segment.includes('\\')
    ) {
      throw new StagedFileBlobError(
        'invalid_configuration',
        'credential deny entries must be individual path segments',
      );
    }
    segments.push(segment);
  }
  return new Set(segments.map((segment) => segment.toLowerCase()));
}

function assertNotCredentialPath(
  requested: string,
  canonical: string,
  extraDenySegments?: readonly string[],
): void {
  const deny = validateDenySegments(extraDenySegments);
  for (const segment of [...pathSegments(requested), ...pathSegments(canonical)]) {
    if (deny.has(segment)) {
      throw new StagedFileBlobError(
        'sensitive_source',
        'local file source is inside a credential-bearing directory',
      );
    }
  }
  if (SECRET_BASENAME_RE.test(path.basename(requested)) || SECRET_BASENAME_RE.test(path.basename(canonical))) {
    throw new StagedFileBlobError(
      'sensitive_source',
      'local file source has a credential-bearing filename',
    );
  }
}

function sameStableFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function assertRegularSingleLink(stat: BigIntStats, code: StagedFileBlobErrorCode): void {
  if (!stat.isFile() || stat.nlink !== 1n) {
    throw new StagedFileBlobError(
      code,
      'staged-file source must be one regular file with no hard-link aliases',
    );
  }
}

function digestOpenFile(input: {
  fd: number;
  maxBytes: number;
  expectedByteCount?: number;
}): { sha256: string; md5: string; byteCount: number; before: BigIntStats; after: BigIntStats } {
  const before = fstatSync(input.fd, { bigint: true });
  assertRegularSingleLink(before, 'invalid_staged_blob');
  if (before.size > BigInt(input.maxBytes)) {
    throw new StagedFileBlobError('blob_too_large', 'staged-file blob exceeds its byte limit');
  }
  if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new StagedFileBlobError('blob_too_large', 'staged-file blob cannot be represented safely');
  }
  const sha256 = createHash('sha256');
  const md5 = createHash('md5');
  const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  let byteCount = 0;
  for (;;) {
    const read = readSync(input.fd, buffer, 0, buffer.byteLength, null);
    if (read === 0) break;
    byteCount += read;
    if (byteCount > input.maxBytes) {
      throw new StagedFileBlobError('blob_too_large', 'staged-file blob exceeds its byte limit');
    }
    const chunk = buffer.subarray(0, read);
    sha256.update(chunk);
    md5.update(chunk);
  }
  const after = fstatSync(input.fd, { bigint: true });
  if (!sameStableFile(before, after) || BigInt(byteCount) !== after.size) {
    throw new StagedFileBlobError('source_changed', 'staged-file bytes changed while they were read');
  }
  if (input.expectedByteCount !== undefined && byteCount !== input.expectedByteCount) {
    throw new StagedFileBlobError('digest_mismatch', 'staged-file byte count does not match its checkpoint');
  }
  return {
    sha256: sha256.digest('hex'),
    md5: md5.digest('hex'),
    byteCount,
    before,
    after,
  };
}

function assertDigestMetadata(input: Pick<SealedStagedFileBlob, 'sha256' | 'md5' | 'byteCount'>): void {
  if (
    !DIGEST_RE.test(input.sha256)
    || !MD5_RE.test(input.md5)
    || !Number.isSafeInteger(input.byteCount)
    || input.byteCount < 0
  ) {
    throw new StagedFileBlobError('invalid_staged_blob', 'staged-file checkpoint metadata is malformed');
  }
}

function validateMaterializedBasename(value: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value === '.'
    || value === '..'
    || path.basename(value) !== value
    || value.includes('/')
    || value.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(value)
    || Buffer.byteLength(value, 'utf8') > 255
  ) {
    throw new StagedFileBlobError(
      'invalid_configuration',
      'managed materialization name must be one safe basename',
    );
  }
  return value;
}

function publishedPath(storeDirectory: string, sha256: string): string {
  if (!DIGEST_RE.test(sha256)) {
    throw new StagedFileBlobError('invalid_staged_blob', 'staged-file SHA-256 digest is malformed');
  }
  return path.join(storeDirectory, `sha256-${sha256}`);
}

function verifyPublishedBlob(input: PublishedStagedFileBlob, maxBytes: number): void {
  let fd: number | null = null;
  try {
    const entry = lstatSync(input.blobPath);
    if (
      entry.isSymbolicLink()
      || !entry.isFile()
      || entry.nlink !== 1
      || (entry.mode & 0o777) !== FILE_MODE
      || entry.size !== input.byteCount
    ) {
      throw new StagedFileBlobError('invalid_staged_blob', 'published blob is not one exact 0600 regular file');
    }
    fd = openSync(input.blobPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const digest = digestOpenFile({ fd, maxBytes, expectedByteCount: input.byteCount });
    if (digest.sha256 !== input.sha256 || digest.md5 !== input.md5) {
      throw new StagedFileBlobError('digest_mismatch', 'published blob bytes do not match their digest');
    }
  } catch (error) {
    throw storageError('could not verify the published staged-file blob', error);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Hard-link publication briefly exposes the winning inode under both its
 * temp and final names. Ordinary consumers keep requiring exactly one link;
 * only a competing publisher may wait for that exact 0600 regular-file
 * transition to finish, after which the full size and digest verification
 * still runs. A crashed or hostile extra link remains invalid after the
 * bounded wait. */
function verifyPublishedBlobForPublisher(
  input: PublishedStagedFileBlob,
  maxBytes: number,
): void {
  for (let attempt = 0; attempt <= PUBLICATION_LINK_RETRY_ATTEMPTS; attempt += 1) {
    let transitional = false;
    try {
      const entry = lstatSync(input.blobPath);
      transitional = !entry.isSymbolicLink()
        && entry.isFile()
        && entry.nlink === 2
        && (entry.mode & 0o777) === FILE_MODE
        && entry.size === input.byteCount;
    } catch {
      // Missing/unreadable winners flow through strict verification below.
    }
    if (!transitional) return verifyPublishedBlob(input, maxBytes);
    if (attempt === PUBLICATION_LINK_RETRY_ATTEMPTS) {
      return verifyPublishedBlob(input, maxBytes);
    }
    Atomics.wait(
      PUBLICATION_LINK_RETRY_WAIT,
      0,
      0,
      PUBLICATION_LINK_RETRY_INTERVAL_MS,
    );
  }
}

/**
 * Incremental, network-agnostic writer. `seal()` fsyncs and closes the hidden
 * temp file; the returned metadata can be checkpointed before `publish()`.
 */
export class StagedFileBlobWriter {
  readonly temporaryPath: string;
  readonly storeDirectory: string;

  private fd: number | null;
  private readonly sha256Hash: Hash = createHash('sha256');
  private readonly md5Hash: Hash = createHash('md5');
  private readonly maxBytes: number;
  private byteCount = 0;
  private sealed = false;

  constructor(input: { storeDirectory: string; maxBytes?: number }) {
    this.storeDirectory = ensureStoreDirectory(input.storeDirectory);
    this.maxBytes = validatePositiveByteLimit(input.maxBytes);
    this.temporaryPath = path.join(this.storeDirectory, `.staged-${randomUUID()}.part`);
    try {
      this.fd = openSync(
        this.temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        FILE_MODE,
      );
      fchmodSync(this.fd, FILE_MODE);
    } catch (error) {
      throw storageError('could not create a staged-file temp file', error);
    }
  }

  write(chunk: Uint8Array): void {
    if (this.fd === null || this.sealed) {
      throw new StagedFileBlobError('invalid_staged_blob', 'staged-file writer is already closed');
    }
    if (!(chunk instanceof Uint8Array)) {
      throw new StagedFileBlobError('invalid_staged_blob', 'staged-file chunks must be byte arrays');
    }
    if (this.byteCount + chunk.byteLength > this.maxBytes) {
      this.abort();
      throw new StagedFileBlobError('blob_too_large', 'staged-file blob exceeds its byte limit');
    }
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    try {
      let offset = 0;
      while (offset < bytes.byteLength) {
        offset += writeSync(this.fd, bytes, offset, bytes.byteLength - offset);
      }
      this.sha256Hash.update(bytes);
      this.md5Hash.update(bytes);
      this.byteCount += bytes.byteLength;
    } catch (error) {
      this.abort();
      throw storageError('could not write staged-file bytes', error);
    }
  }

  seal(expected: { sha256?: string; byteCount?: number } = {}): SealedStagedFileBlob {
    if (this.fd === null || this.sealed) {
      throw new StagedFileBlobError('invalid_staged_blob', 'staged-file writer is already closed');
    }
    let sealed: SealedStagedFileBlob;
    try {
      fsyncSync(this.fd);
      const stat = fstatSync(this.fd, { bigint: true });
      assertRegularSingleLink(stat, 'invalid_staged_blob');
      if (stat.size !== BigInt(this.byteCount)) {
        throw new StagedFileBlobError('source_changed', 'staged-file temp bytes changed before sealing');
      }
      closeSync(this.fd);
      this.fd = null;
      this.sealed = true;
      sealed = {
        temporaryPath: this.temporaryPath,
        sha256: this.sha256Hash.digest('hex'),
        md5: this.md5Hash.digest('hex'),
        byteCount: this.byteCount,
      };
      if (expected.sha256 !== undefined && sealed.sha256 !== expected.sha256.toLowerCase()) {
        throw new StagedFileBlobError('digest_mismatch', 'staged-file SHA-256 does not match the expected digest');
      }
      if (expected.byteCount !== undefined && sealed.byteCount !== expected.byteCount) {
        throw new StagedFileBlobError('digest_mismatch', 'staged-file byte count does not match the expected size');
      }
      return sealed;
    } catch (error) {
      this.abort();
      throw storageError('could not seal staged-file bytes', error);
    }
  }

  abort(): void {
    if (this.fd !== null) {
      try { closeSync(this.fd); } catch { /* best effort */ }
      this.fd = null;
    }
    try {
      unlinkSync(this.temporaryPath);
      fsyncDirectory(this.storeDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Abort is intentionally best-effort and must not hide the original error.
      }
    }
    this.sealed = true;
  }
}

export function createStagedFileBlobWriter(input: {
  storeDirectory: string;
  maxBytes?: number;
}): StagedFileBlobWriter {
  return new StagedFileBlobWriter(input);
}

/**
 * Verify a sealed temp checkpoint, atomically publish it without replacement
 * at its digest-derived final name, fsync the directory entry, and verify the
 * published bytes again.
 */
export function publishStagedFileBlob(input: {
  storeDirectory: string;
  sealed: SealedStagedFileBlob;
  maxBytes?: number;
}): PublishedStagedFileBlob {
  assertDigestMetadata(input.sealed);
  const maxBytes = validatePositiveByteLimit(input.maxBytes);
  if (input.sealed.byteCount > maxBytes) {
    throw new StagedFileBlobError('blob_too_large', 'staged-file blob exceeds its byte limit');
  }
  const storeDirectory = ensureStoreDirectory(input.storeDirectory);
  const temporaryPath = path.resolve(input.sealed.temporaryPath);
  if (
    path.dirname(temporaryPath) !== storeDirectory
    || !TEMP_BASENAME_RE.test(path.basename(temporaryPath))
  ) {
    throw new StagedFileBlobError(
      'invalid_staged_blob',
      'staged-file temp path is not an exact host-owned store child',
    );
  }
  const finalPath = publishedPath(storeDirectory, input.sealed.sha256);
  const published: PublishedStagedFileBlob = {
    blobPath: finalPath,
    sha256: input.sealed.sha256,
    md5: input.sealed.md5,
    byteCount: input.sealed.byteCount,
  };

  let fd: number | null = null;
  try {
    const entry = lstatSync(temporaryPath);
    if (
      entry.isSymbolicLink()
      || !entry.isFile()
      || entry.nlink !== 1
      || (entry.mode & 0o777) !== FILE_MODE
      || entry.size !== input.sealed.byteCount
    ) {
      throw new StagedFileBlobError('invalid_staged_blob', 'sealed temp is not one exact 0600 regular file');
    }
    fd = openSync(temporaryPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const verifiedTemp = digestOpenFile({
      fd,
      maxBytes,
      expectedByteCount: input.sealed.byteCount,
    });
    if (verifiedTemp.sha256 !== input.sealed.sha256 || verifiedTemp.md5 !== input.sealed.md5) {
      throw new StagedFileBlobError('digest_mismatch', 'sealed temp bytes do not match their checkpoint');
    }

    try {
      const existing = lstatSync(finalPath);
      if (existing) {
        verifyPublishedBlobForPublisher(published, maxBytes);
        closeSync(fd);
        fd = null;
        unlinkSync(temporaryPath);
        fsyncDirectory(storeDirectory);
        return published;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    // Keep the verified descriptor open across no-replace publication. POSIX
    // rename would let two processes overwrite the same digest pathname with
    // different random-IV file bytes after both observed ENOENT. A hard-link
    // publish is atomic/no-replace; EEXIST adopts only an exactly verified
    // winner, and unlinking the temp restores the required single-link inode.
    // The temp was already descriptor/path-validated as 0600 above, and the
    // hard link preserves that same inode and mode. Do not chmod after the
    // final name becomes visible: even a same-mode chmod advances ctime while
    // a competing publisher may be hashing the canonical inode.
    if (fd === null) {
      throw new StagedFileBlobError('invalid_staged_blob', 'verified staged-file descriptor was lost');
    }
    const verifiedFd: number = fd;
    try {
      linkSync(temporaryPath, finalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      verifyPublishedBlobForPublisher(published, maxBytes);
      closeSync(verifiedFd);
      fd = null;
      unlinkSync(temporaryPath);
      fsyncDirectory(storeDirectory);
      return published;
    }
    unlinkSync(temporaryPath);
    fsyncDirectory(storeDirectory);
    closeSync(verifiedFd);
    fd = null;
    verifyPublishedBlob(published, maxBytes);
    return published;
  } catch (error) {
    throw storageError('could not publish the staged-file blob', error);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function reconcileMaterializedPublishAlias(input: {
  destinationDirectory: string;
  materializedPath: string;
}): void {
  if (process.platform === 'win32') return;
  const final = lstatSync(input.materializedPath, { bigint: true });
  if (final.nlink === 1n) return;
  for (const entry of readdirSync(input.destinationDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !MATERIALIZE_TEMP_BASENAME_RE.test(entry.name)) continue;
    const candidate = path.join(input.destinationDirectory, entry.name);
    const stat = lstatSync(candidate, { bigint: true });
    if (stat.dev === final.dev && stat.ino === final.ino) {
      unlinkSync(candidate);
    }
  }
  fsyncDirectory(input.destinationDirectory);
  const reconciled = lstatSync(input.materializedPath, { bigint: true });
  if (reconciled.nlink !== 1n) {
    throw new StagedFileBlobError(
      'invalid_staged_blob',
      'managed materialization has an unowned hard-link alias',
    );
  }
}

function verifyMaterializedFile(input: {
  destinationDirectory: string;
  destinationName: string;
  blob: Pick<PublishedStagedFileBlob, 'sha256' | 'md5' | 'byteCount'>;
  maxBytes: number;
}): void {
  const materializedPath = path.join(input.destinationDirectory, input.destinationName);
  reconcileMaterializedPublishAlias({
    destinationDirectory: input.destinationDirectory,
    materializedPath,
  });
  try {
    verifyPublishedBlob({
      blobPath: materializedPath,
      sha256: input.blob.sha256,
      md5: input.blob.md5,
      byteCount: input.blob.byteCount,
    }, input.maxBytes);
  } catch (error) {
    if (error instanceof StagedFileBlobError) {
      throw new StagedFileBlobError(
        'storage_error',
        'managed materialization conflicts with its exact destination',
        error,
      );
    }
    throw error;
  }
}

/**
 * Copy one verified content-addressed blob to a host-owned deterministic
 * destination. Publication is atomic/no-replace. The source inode is never
 * linked into the destination, preserving the blob store's single-link
 * invariant, and the returned receipt deliberately omits the destination.
 */
export function materializeStagedFileBlob(input: {
  blob: PublishedStagedFileBlob;
  destinationDirectory: string;
  destinationName: string;
  maxBytes?: number;
}): StagedFileMaterializationReceipt {
  assertDigestMetadata(input.blob);
  const maxBytes = validatePositiveByteLimit(input.maxBytes);
  if (input.blob.byteCount > maxBytes) {
    throw new StagedFileBlobError('blob_too_large', 'staged-file blob exceeds its byte limit');
  }
  const requestedSource = validateAbsolutePath(input.blob.blobPath, 'staged blob source');
  let sourcePath: string;
  try {
    sourcePath = realpathSync(requestedSource);
  } catch (error) {
    throw new StagedFileBlobError('source_missing', 'staged blob source does not exist', error);
  }
  if (
    sourcePath !== requestedSource
    || path.basename(sourcePath) !== `sha256-${input.blob.sha256}`
  ) {
    throw new StagedFileBlobError(
      'invalid_staged_blob',
      'staged blob source is not its exact content-addressed child',
    );
  }
  verifyPublishedBlob({ ...input.blob, blobPath: sourcePath }, maxBytes);

  const destinationDirectory = ensureStoreDirectory(input.destinationDirectory);
  const destinationName = validateMaterializedBasename(input.destinationName);
  const materializedPath = path.join(destinationDirectory, destinationName);
  const temporaryPath = path.join(destinationDirectory, `.materialize-${randomUUID()}.part`);
  let sourceFd: number | null = null;
  let temporaryFd: number | null = null;
  let linked = false;
  try {
    sourceFd = openSync(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const sourceBefore = fstatSync(sourceFd, { bigint: true });
    assertRegularSingleLink(sourceBefore, 'invalid_staged_blob');
    if (
      (sourceBefore.mode & 0o777n) !== BigInt(FILE_MODE)
      || sourceBefore.size !== BigInt(input.blob.byteCount)
    ) {
      throw new StagedFileBlobError('invalid_staged_blob', 'staged blob source changed before materialization');
    }
    temporaryFd = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      FILE_MODE,
    );
    fchmodSync(temporaryFd, FILE_MODE);
    const sha256 = createHash('sha256');
    const md5 = createHash('md5');
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    let byteCount = 0;
    for (;;) {
      const read = readSync(sourceFd, buffer, 0, buffer.byteLength, null);
      if (read === 0) break;
      byteCount += read;
      if (byteCount > maxBytes) {
        throw new StagedFileBlobError('blob_too_large', 'staged-file blob exceeds its byte limit');
      }
      const chunk = buffer.subarray(0, read);
      sha256.update(chunk);
      md5.update(chunk);
      let written = 0;
      while (written < chunk.byteLength) {
        written += writeSync(temporaryFd, chunk, written, chunk.byteLength - written);
      }
    }
    const sourceAfter = fstatSync(sourceFd, { bigint: true });
    if (!sameStableFile(sourceBefore, sourceAfter) || BigInt(byteCount) !== sourceAfter.size) {
      throw new StagedFileBlobError('source_changed', 'staged blob changed during materialization');
    }
    if (
      byteCount !== input.blob.byteCount
      || sha256.digest('hex') !== input.blob.sha256
      || md5.digest('hex') !== input.blob.md5
    ) {
      throw new StagedFileBlobError('digest_mismatch', 'materialized bytes differ from their staged blob owner');
    }
    fsyncSync(temporaryFd);
    const temporaryStat = fstatSync(temporaryFd, { bigint: true });
    assertRegularSingleLink(temporaryStat, 'invalid_staged_blob');
    if (
      (temporaryStat.mode & 0o777n) !== BigInt(FILE_MODE)
      || temporaryStat.size !== BigInt(byteCount)
    ) {
      throw new StagedFileBlobError('invalid_staged_blob', 'managed materialization temp is not exact');
    }
    closeSync(sourceFd);
    sourceFd = null;
    closeSync(temporaryFd);
    temporaryFd = null;

    try {
      linkSync(temporaryPath, materializedPath);
      linked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      verifyMaterializedFile({
        destinationDirectory,
        destinationName,
        blob: input.blob,
        maxBytes,
      });
    }
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      // A concurrent exact adopter can reconcile the winner's post-link temp.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    fsyncDirectory(destinationDirectory);
    verifyMaterializedFile({
      destinationDirectory,
      destinationName,
      blob: input.blob,
      maxBytes,
    });
    return {
      sha256: input.blob.sha256,
      md5: input.blob.md5,
      byteCount: input.blob.byteCount,
      disposition: linked ? 'published' : 'adopted',
    };
  } catch (error) {
    if (sourceFd !== null) closeSync(sourceFd);
    if (temporaryFd !== null) closeSync(temporaryFd);
    try {
      unlinkSync(temporaryPath);
      fsyncDirectory(destinationDirectory);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Preserve the original failure; a crash-safe retry reconciles an
        // exact post-link temp by inode before adopting the final name.
      }
    }
    throw storageError('could not materialize the staged-file blob', error);
  }
}

/** Verify an already materialized deterministic destination without exposing
 * its path. Used by restart authority reconstruction after a returned commit. */
export function verifyStagedFileMaterialization(input: {
  blob: Pick<PublishedStagedFileBlob, 'sha256' | 'md5' | 'byteCount'>;
  destinationDirectory: string;
  destinationName: string;
  maxBytes?: number;
}): StagedFileMaterializationReceipt {
  assertDigestMetadata(input.blob);
  const maxBytes = validatePositiveByteLimit(input.maxBytes);
  const destinationDirectory = exactExistingStoreDirectory(input.destinationDirectory);
  const destinationName = validateMaterializedBasename(input.destinationName);
  verifyMaterializedFile({
    destinationDirectory,
    destinationName,
    blob: input.blob,
    maxBytes,
  });
  return {
    sha256: input.blob.sha256,
    md5: input.blob.md5,
    byteCount: input.blob.byteCount,
    disposition: 'adopted',
  };
}

/**
 * Authorize, snapshot, and content-address a local upload source. The returned
 * value deliberately omits the original path.
 */
export function snapshotAllowedLocalFile(input: {
  sourcePath: string;
  allowRoots: readonly string[];
  storeDirectory: string;
  denySegments?: readonly string[];
  maxBytes?: number;
}): LocalFileSnapshot {
  const requested = validateAbsolutePath(input.sourcePath, 'local file source');
  if (!Array.isArray(input.allowRoots) || input.allowRoots.length === 0) {
    throw new StagedFileBlobError(
      'invalid_configuration',
      'at least one explicit local-file allow root is required',
    );
  }
  const maxBytes = validatePositiveByteLimit(input.maxBytes);
  let canonical: string;
  try {
    canonical = realpathSync(requested);
  } catch (error) {
    throw new StagedFileBlobError('source_missing', 'local file source does not exist', error);
  }
  assertNotCredentialPath(requested, canonical, input.denySegments);

  const allowed = input.allowRoots.some((configuredRoot) => {
    const root = validateAbsolutePath(configuredRoot, 'local file allow root');
    try {
      const canonicalRoot = realpathSync(root);
      const rootStat = statSync(canonicalRoot);
      return rootStat.isDirectory() && isInsidePath(canonical, canonicalRoot);
    } catch {
      return false;
    }
  });
  if (!allowed) {
    throw new StagedFileBlobError(
      'source_not_allowed',
      'local file source is outside every configured allow root',
    );
  }

  let sourceFd: number | null = null;
  let writer: StagedFileBlobWriter | null = null;
  try {
    sourceFd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(sourceFd, { bigint: true });
    assertRegularSingleLink(before, 'source_not_regular');
    if (before.size > BigInt(maxBytes) || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new StagedFileBlobError('blob_too_large', 'local file source exceeds its byte limit');
    }

    writer = createStagedFileBlobWriter({ storeDirectory: input.storeDirectory, maxBytes });
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    let readBytes = 0;
    for (;;) {
      const count = readSync(sourceFd, buffer, 0, buffer.byteLength, null);
      if (count === 0) break;
      readBytes += count;
      writer.write(buffer.subarray(0, count));
    }
    const after = fstatSync(sourceFd, { bigint: true });
    if (!sameStableFile(before, after) || BigInt(readBytes) !== after.size) {
      throw new StagedFileBlobError('source_changed', 'local file source changed while it was snapshotted');
    }
    if (realpathSync(requested) !== canonical) {
      throw new StagedFileBlobError('source_changed', 'local file source was replaced while it was snapshotted');
    }
    const sealed = writer.seal({ byteCount: readBytes });
    writer = null;
    const published = publishStagedFileBlob({
      storeDirectory: input.storeDirectory,
      sealed,
      maxBytes,
    });
    return {
      ...published,
      sourceBasename: path.basename(canonical),
    };
  } catch (error) {
    writer?.abort();
    if (error instanceof StagedFileBlobError) throw error;
    throw storageError('could not snapshot the local file source', error);
  } finally {
    if (sourceFd !== null) closeSync(sourceFd);
  }
}
