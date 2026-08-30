/**
 * Host-owned encrypted spill storage for authority payloads that are larger
 * than the single-row argument-seal envelope.
 *
 * The durable file contains only authenticated ciphertext plus value-opaque
 * digests and byte counts. In particular, provider credentials and signed
 * object-store URLs must never appear in SQLite, events, logs, errors, or the
 * plaintext filesystem. Chunks are independently sealed with their exact
 * payload/binding/index tuple so removing, reordering, or transplanting one is
 * detected before any plaintext is returned.
 */
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../../config.js';
import { openCanonicalArguments, sealCanonicalArguments } from './authority-argument-seal.js';

export const AUTHORITY_ENCRYPTED_PAYLOAD_VERSION = 1 as const;
export const AUTHORITY_ENCRYPTED_PAYLOAD_CHUNK_BYTES = 12_000;
export const AUTHORITY_ENCRYPTED_PAYLOAD_MAX_PLAINTEXT_BYTES = 32 * 1024 * 1024;
export const AUTHORITY_ENCRYPTED_PAYLOAD_ORPHAN_HORIZON_MS = 7 * 24 * 60 * 60 * 1_000;
export const AUTHORITY_ENCRYPTED_PAYLOAD_MIN_ORPHAN_HORIZON_MS = 60 * 60 * 1_000;
export const AUTHORITY_ENCRYPTED_PAYLOAD_MAX_ORPHAN_HORIZON_MS = 90 * 24 * 60 * 60 * 1_000;
export const AUTHORITY_ENCRYPTED_PAYLOAD_RECLAIM_SCAN_LIMIT = 256;
export const AUTHORITY_ENCRYPTED_PAYLOAD_RECLAIM_MAX_SCAN_LIMIT = 2_048;
const AUTHORITY_ENCRYPTED_PAYLOAD_MAX_FILE_BYTES = 96 * 1024 * 1024;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const PAYLOAD_ID_RE = /^authority-payload:[a-f0-9]{64}$/;
const SEALED_FILE_RE = /^([a-f0-9]{64})\.sealed\.json$/;
const TEMP_FILE_RE = /^\.[a-f0-9]{64}\.[1-9][0-9]*\.[a-f0-9-]{36}\.tmp$/;
const FIXED_BASE_DIRECTORY = path.resolve(BASE_DIR);
const PUBLICATION_LINK_RETRY_WAIT = new Int32Array(new SharedArrayBuffer(4));
const PUBLICATION_LINK_RETRY_ATTEMPTS = 400;
const PUBLICATION_LINK_RETRY_INTERVAL_MS = 5;
export const AUTHORITY_ENCRYPTED_PAYLOAD_DIRECTORY = path.join(
  FIXED_BASE_DIRECTORY,
  'state',
  'authority-payloads',
  'v1',
);

export type AuthorityEncryptedPayloadKind =
  | 'physical_return'
  | 'staged_transfer_manifest'
  | 'staged_signed_url'
  | 'model_request_snapshot';

export interface AuthorityEncryptedPayloadReference {
  version: typeof AUTHORITY_ENCRYPTED_PAYLOAD_VERSION;
  payloadId: string;
  payloadKind: AuthorityEncryptedPayloadKind;
  bindingDigest: string;
  plaintextSha256: string;
  plaintextBytes: number;
  chunkCount: number;
  sealedFileSha256: string;
  sealedFileBytes: number;
}

interface StoredEncryptedPayload {
  version: typeof AUTHORITY_ENCRYPTED_PAYLOAD_VERSION;
  payloadId: string;
  payloadKind: AuthorityEncryptedPayloadKind;
  bindingDigest: string;
  plaintextSha256: string;
  plaintextBytes: number;
  chunkCount: number;
  sealedChunks: string[];
}

export type AuthorityEncryptedPayloadRead =
  | { status: 'ok'; bytes: Buffer }
  | { status: 'missing' | 'corrupt' | 'binding_mismatch' | 'storage_error'; reason: string };

export interface AuthorityEncryptedPayloadReclamationResult {
  scannedEntries: number;
  deletedPayloadFiles: number;
  deletedTempFiles: number;
  retainedReferenced: number;
  retainedFresh: number;
  ignoredUnsafe: number;
  ignoredUnknown: number;
  lostRaces: number;
  storageErrors: number;
  referenceSchemaAvailable: boolean;
}

export class AuthorityEncryptedPayloadError extends Error {
  constructor(
    readonly code:
      | 'invalid_authority_payload'
      | 'authority_payload_too_large'
      | 'authority_payload_storage_failed',
  ) {
    super(
      code === 'authority_payload_too_large'
        ? 'authority payload exceeds the encrypted spill limit'
        : code === 'authority_payload_storage_failed'
          ? 'authority payload could not be durably encrypted'
          : 'authority payload identity is invalid',
    );
    this.name = 'AuthorityEncryptedPayloadError';
  }
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function validKind(value: unknown): value is AuthorityEncryptedPayloadKind {
  return value === 'physical_return'
    || value === 'staged_transfer_manifest'
    || value === 'staged_signed_url'
    || value === 'model_request_snapshot';
}

function validNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function assertDigest(value: string): void {
  if (!DIGEST_RE.test(value)) throw new AuthorityEncryptedPayloadError('invalid_authority_payload');
}

function lstatOrMissing(filePath: string): Stats | null {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function requireRealDirectory(directory: string, create: boolean): void {
  let stat = lstatOrMissing(directory);
  if (stat === null && create) {
    try {
      mkdirSync(directory, { mode: DIRECTORY_MODE });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    stat = lstatOrMissing(directory);
  }
  if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new AuthorityEncryptedPayloadError('authority_payload_storage_failed');
  }
}

function ensurePayloadDirectory(): void {
  requireRealDirectory(FIXED_BASE_DIRECTORY, false);
  const state = path.join(FIXED_BASE_DIRECTORY, 'state');
  requireRealDirectory(state, true);
  const root = path.join(state, 'authority-payloads');
  requireRealDirectory(root, true);
  requireRealDirectory(AUTHORITY_ENCRYPTED_PAYLOAD_DIRECTORY, true);
}

function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function authorityEncryptedPayloadFilePath(payloadId: string): string {
  if (!PAYLOAD_ID_RE.test(payloadId)) {
    throw new AuthorityEncryptedPayloadError('invalid_authority_payload');
  }
  const digest = payloadId.slice('authority-payload:'.length);
  const target = path.join(AUTHORITY_ENCRYPTED_PAYLOAD_DIRECTORY, `${digest}.sealed.json`);
  if (path.dirname(target) !== AUTHORITY_ENCRYPTED_PAYLOAD_DIRECTORY) {
    throw new AuthorityEncryptedPayloadError('invalid_authority_payload');
  }
  return target;
}

function readSealedFile(input: {
  payloadId: string;
  expectedBytes?: number;
  expectedDigest?: string;
}): { status: 'ok'; bytes: Buffer } | Exclude<AuthorityEncryptedPayloadRead, { status: 'ok' }> {
  try {
    const target = authorityEncryptedPayloadFilePath(input.payloadId);
    ensurePayloadDirectory();
    const entry = lstatOrMissing(target);
    if (entry === null) return { status: 'missing', reason: 'encrypted authority payload is missing' };
    if (
      entry.isSymbolicLink()
      || !entry.isFile()
      || entry.nlink !== 1
      || (entry.mode & 0o777) !== FILE_MODE
      || entry.size > AUTHORITY_ENCRYPTED_PAYLOAD_MAX_FILE_BYTES
      || (input.expectedBytes !== undefined && entry.size !== input.expectedBytes)
    ) {
      return { status: 'corrupt', reason: 'encrypted authority payload metadata is invalid' };
    }
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const opened = fstatSync(fd);
      if (
        !opened.isFile()
        || opened.nlink !== 1
        || opened.size !== entry.size
        || (opened.mode & 0o777) !== FILE_MODE
      ) {
        return { status: 'corrupt', reason: 'encrypted authority payload file changed while opening' };
      }
      bytes = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
    if (bytes.byteLength !== entry.size) {
      return { status: 'corrupt', reason: 'encrypted authority payload size is invalid' };
    }
    if (input.expectedDigest !== undefined && sha256(bytes) !== input.expectedDigest) {
      return { status: 'corrupt', reason: 'encrypted authority payload digest is invalid' };
    }
    return { status: 'ok', bytes };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { status: 'missing', reason: 'encrypted authority payload is missing' };
    if (code === 'ELOOP') return { status: 'corrupt', reason: 'encrypted authority payload path is unsafe' };
    return { status: 'storage_error', reason: 'encrypted authority payload could not be read' };
  }
}

type PublicationReadResult = ReturnType<typeof readSealedFile>;
let publicationReadObserverForTests:
  | ((input: { target: string; read: PublicationReadResult }) => void)
  | null = null;

export function setAuthorityEncryptedPayloadPublicationReadObserverForTests(
  observer: ((input: { target: string; read: PublicationReadResult }) => void) | null,
): void {
  publicationReadObserverForTests = observer;
}

/** A hard-link publication is visible with two names for the few instructions
 * between link(temp, target) and unlink(temp). Ordinary readers keep requiring
 * one link; only a competing publisher may wait briefly for that exact 0600
 * regular-file transition to finish. A crashed/stuck publisher remains corrupt
 * after the bounded wait and can never be adopted as authority. */
function readSealedFileForPublication(input: {
  payloadId: string;
  expectedBytes?: number;
  expectedDigest?: string;
}): ReturnType<typeof readSealedFile> {
  const target = authorityEncryptedPayloadFilePath(input.payloadId);
  for (let attempt = 0; attempt <= PUBLICATION_LINK_RETRY_ATTEMPTS; attempt += 1) {
    const read = readSealedFile(input);
    if (read.status !== 'corrupt') return read;
    publicationReadObserverForTests?.({ target, read });
    const entry = lstatOrMissing(target);
    const safeRegularFile = entry !== null
      && !entry.isSymbolicLink()
      && entry.isFile()
      && (entry.mode & 0o777) === FILE_MODE
      && entry.size <= AUTHORITY_ENCRYPTED_PAYLOAD_MAX_FILE_BYTES;
    const transitional = safeRegularFile && entry.nlink === 2;
    const settledAfterRead = safeRegularFile
      && entry.nlink === 1
      && (
        read.reason === 'encrypted authority payload metadata is invalid'
        || read.reason === 'encrypted authority payload file changed while opening'
      );
    if ((!transitional && !settledAfterRead) || attempt === PUBLICATION_LINK_RETRY_ATTEMPTS) {
      return read;
    }
    if (transitional) {
      Atomics.wait(
        PUBLICATION_LINK_RETRY_WAIT,
        0,
        0,
        PUBLICATION_LINK_RETRY_INTERVAL_MS,
      );
    }
  }
  throw new AuthorityEncryptedPayloadError('authority_payload_storage_failed');
}

function parseStored(bytes: Buffer): StoredEncryptedPayload | null {
  if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) return null;
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as Partial<StoredEncryptedPayload>;
    if (
      parsed.version !== AUTHORITY_ENCRYPTED_PAYLOAD_VERSION
      || typeof parsed.payloadId !== 'string'
      || !PAYLOAD_ID_RE.test(parsed.payloadId)
      || !validKind(parsed.payloadKind)
      || typeof parsed.bindingDigest !== 'string'
      || !DIGEST_RE.test(parsed.bindingDigest)
      || typeof parsed.plaintextSha256 !== 'string'
      || !DIGEST_RE.test(parsed.plaintextSha256)
      || !validNonNegativeSafeInteger(parsed.plaintextBytes)
      || parsed.plaintextBytes > AUTHORITY_ENCRYPTED_PAYLOAD_MAX_PLAINTEXT_BYTES
      || !validNonNegativeSafeInteger(parsed.chunkCount)
      || !Array.isArray(parsed.sealedChunks)
      || parsed.sealedChunks.length !== parsed.chunkCount
      || parsed.sealedChunks.some((chunk) => typeof chunk !== 'string')
    ) return null;
    return parsed as StoredEncryptedPayload;
  } catch {
    return null;
  }
}

function referenceFor(stored: StoredEncryptedPayload, sealedFile: Buffer): AuthorityEncryptedPayloadReference {
  return {
    version: AUTHORITY_ENCRYPTED_PAYLOAD_VERSION,
    payloadId: stored.payloadId,
    payloadKind: stored.payloadKind,
    bindingDigest: stored.bindingDigest,
    plaintextSha256: stored.plaintextSha256,
    plaintextBytes: stored.plaintextBytes,
    chunkCount: stored.chunkCount,
    sealedFileSha256: sha256(sealedFile),
    sealedFileBytes: sealedFile.byteLength,
  };
}

function exactReference(
  left: AuthorityEncryptedPayloadReference,
  right: AuthorityEncryptedPayloadReference,
): boolean {
  return left.version === right.version
    && left.payloadId === right.payloadId
    && left.payloadKind === right.payloadKind
    && left.bindingDigest === right.bindingDigest
    && left.plaintextSha256 === right.plaintextSha256
    && left.plaintextBytes === right.plaintextBytes
    && left.chunkCount === right.chunkCount
    && left.sealedFileSha256 === right.sealedFileSha256
    && left.sealedFileBytes === right.sealedFileBytes;
}

/** Encrypt and atomically publish one bounded payload. Replays with identical
 * binding and bytes adopt the already-published ciphertext after revalidating
 * it; no writer overwrites an existing authority object. */
export function persistAuthorityEncryptedPayload(input: {
  payloadKind: AuthorityEncryptedPayloadKind;
  bindingDigest: string;
  bytes: Buffer | Uint8Array;
}): AuthorityEncryptedPayloadReference {
  if (!validKind(input.payloadKind)) {
    throw new AuthorityEncryptedPayloadError('invalid_authority_payload');
  }
  assertDigest(input.bindingDigest);
  const plain = Buffer.from(input.bytes);
  if (plain.byteLength > AUTHORITY_ENCRYPTED_PAYLOAD_MAX_PLAINTEXT_BYTES) {
    throw new AuthorityEncryptedPayloadError('authority_payload_too_large');
  }
  const plaintextSha256 = sha256(plain);
  const payloadId = `authority-payload:${sha256(JSON.stringify({
    protocol: 'authority_encrypted_payload_v1',
    payloadKind: input.payloadKind,
    bindingDigest: input.bindingDigest,
    plaintextSha256,
    plaintextBytes: plain.byteLength,
  }))}`;
  const chunkCount = Math.ceil(plain.byteLength / AUTHORITY_ENCRYPTED_PAYLOAD_CHUNK_BYTES);
  const sealedChunks: string[] = [];
  try {
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const offset = chunkIndex * AUTHORITY_ENCRYPTED_PAYLOAD_CHUNK_BYTES;
      const chunk = plain.subarray(offset, offset + AUTHORITY_ENCRYPTED_PAYLOAD_CHUNK_BYTES);
      sealedChunks.push(sealCanonicalArguments({
        protocol: 'authority_encrypted_payload_chunk_v1',
        payloadId,
        payloadKind: input.payloadKind,
        bindingDigest: input.bindingDigest,
        plaintextSha256,
        plaintextBytes: plain.byteLength,
        chunkIndex,
        chunkCount,
        chunkSha256: sha256(chunk),
        chunkBase64: chunk.toString('base64'),
      }));
    }
    const stored: StoredEncryptedPayload = {
      version: AUTHORITY_ENCRYPTED_PAYLOAD_VERSION,
      payloadId,
      payloadKind: input.payloadKind,
      bindingDigest: input.bindingDigest,
      plaintextSha256,
      plaintextBytes: plain.byteLength,
      chunkCount,
      sealedChunks,
    };
    const sealedFile = Buffer.from(JSON.stringify(stored), 'utf8');
    if (sealedFile.byteLength > AUTHORITY_ENCRYPTED_PAYLOAD_MAX_FILE_BYTES) {
      throw new AuthorityEncryptedPayloadError('authority_payload_too_large');
    }
    ensurePayloadDirectory();
    const target = authorityEncryptedPayloadFilePath(payloadId);
    const existing = readSealedFileForPublication({ payloadId });
    if (existing.status === 'ok') {
      const parsed = parseStored(existing.bytes);
      if (!parsed) throw new AuthorityEncryptedPayloadError('authority_payload_storage_failed');
      const existingRef = referenceFor(parsed, existing.bytes);
      const proposedRef = referenceFor(stored, sealedFile);
      if (
        existingRef.payloadId !== proposedRef.payloadId
        || existingRef.payloadKind !== proposedRef.payloadKind
        || existingRef.bindingDigest !== proposedRef.bindingDigest
        || existingRef.plaintextSha256 !== proposedRef.plaintextSha256
        || existingRef.plaintextBytes !== proposedRef.plaintextBytes
        || existingRef.chunkCount !== proposedRef.chunkCount
      ) {
        throw new AuthorityEncryptedPayloadError('authority_payload_storage_failed');
      }
      return existingRef;
    }
    if (existing.status !== 'missing') {
      throw new AuthorityEncryptedPayloadError('authority_payload_storage_failed');
    }

    const temp = path.join(
      AUTHORITY_ENCRYPTED_PAYLOAD_DIRECTORY,
      `.${payloadId.slice('authority-payload:'.length)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let fd: number | null = null;
    try {
      fd = openSync(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        FILE_MODE,
      );
      fchmodSync(fd, FILE_MODE);
      let offset = 0;
      while (offset < sealedFile.byteLength) {
        offset += writeSync(fd, sealedFile, offset, sealedFile.byteLength - offset);
      }
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      requireRealDirectory(AUTHORITY_ENCRYPTED_PAYLOAD_DIRECTORY, false);
      const raced = readSealedFileForPublication({ payloadId });
      if (raced.status === 'ok') {
        const parsed = parseStored(raced.bytes);
        if (!parsed) throw new AuthorityEncryptedPayloadError('authority_payload_storage_failed');
        return referenceFor(parsed, raced.bytes);
      }
      if (raced.status !== 'missing') {
        throw new AuthorityEncryptedPayloadError('authority_payload_storage_failed');
      }
      try {
        // Hard-link publication is an atomic no-replace operation on the same
        // filesystem. Unlike rename(2), it cannot overwrite a concurrent
        // winner whose random-IV ciphertext another caller already referenced.
        linkSync(temp, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const winner = readSealedFileForPublication({ payloadId });
        if (winner.status !== 'ok') {
          throw new AuthorityEncryptedPayloadError('authority_payload_storage_failed');
        }
        const parsed = parseStored(winner.bytes);
        if (!parsed) throw new AuthorityEncryptedPayloadError('authority_payload_storage_failed');
        return referenceFor(parsed, winner.bytes);
      }
      try { unlinkSync(temp); } catch { /* final cleanup retries below */ }
      fsyncDirectory(AUTHORITY_ENCRYPTED_PAYLOAD_DIRECTORY);
      return referenceFor(stored, sealedFile);
    } finally {
      if (fd !== null) closeSync(fd);
      try { unlinkSync(temp); } catch { /* never mask the authority result */ }
    }
  } catch (error) {
    if (error instanceof AuthorityEncryptedPayloadError) throw error;
    throw new AuthorityEncryptedPayloadError('authority_payload_storage_failed');
  }
}

/** Authenticate, decrypt, and reassemble one exact bound payload. */
export function readAuthorityEncryptedPayload(input: {
  reference: AuthorityEncryptedPayloadReference;
  payloadKind: AuthorityEncryptedPayloadKind;
  bindingDigest: string;
}): AuthorityEncryptedPayloadRead {
  if (
    input.reference.version !== AUTHORITY_ENCRYPTED_PAYLOAD_VERSION
    || !validKind(input.payloadKind)
    || !DIGEST_RE.test(input.bindingDigest)
    || input.reference.payloadKind !== input.payloadKind
    || input.reference.bindingDigest !== input.bindingDigest
  ) {
    return { status: 'binding_mismatch', reason: 'encrypted authority payload binding does not match' };
  }
  const file = readSealedFile({
    payloadId: input.reference.payloadId,
    expectedBytes: input.reference.sealedFileBytes,
    expectedDigest: input.reference.sealedFileSha256,
  });
  if (file.status !== 'ok') return file;
  const stored = parseStored(file.bytes);
  if (!stored) return { status: 'corrupt', reason: 'encrypted authority payload envelope is invalid' };
  if (!exactReference(referenceFor(stored, file.bytes), input.reference)) {
    return { status: 'binding_mismatch', reason: 'encrypted authority payload reference does not match' };
  }
  const chunks: Buffer[] = [];
  for (let chunkIndex = 0; chunkIndex < stored.chunkCount; chunkIndex += 1) {
    const opened = openCanonicalArguments(stored.sealedChunks[chunkIndex]!);
    if (
      !opened
      || opened.protocol !== 'authority_encrypted_payload_chunk_v1'
      || opened.payloadId !== stored.payloadId
      || opened.payloadKind !== stored.payloadKind
      || opened.bindingDigest !== stored.bindingDigest
      || opened.plaintextSha256 !== stored.plaintextSha256
      || opened.plaintextBytes !== stored.plaintextBytes
      || opened.chunkIndex !== chunkIndex
      || opened.chunkCount !== stored.chunkCount
      || typeof opened.chunkSha256 !== 'string'
      || typeof opened.chunkBase64 !== 'string'
    ) {
      return { status: 'corrupt', reason: 'encrypted authority payload chunk authority is invalid' };
    }
    let chunk: Buffer;
    try {
      chunk = Buffer.from(opened.chunkBase64, 'base64');
    } catch {
      return { status: 'corrupt', reason: 'encrypted authority payload chunk is invalid' };
    }
    if (
      chunk.toString('base64') !== opened.chunkBase64
      || sha256(chunk) !== opened.chunkSha256
      || chunk.byteLength > AUTHORITY_ENCRYPTED_PAYLOAD_CHUNK_BYTES
      || (chunkIndex < stored.chunkCount - 1 && chunk.byteLength !== AUTHORITY_ENCRYPTED_PAYLOAD_CHUNK_BYTES)
    ) {
      return { status: 'corrupt', reason: 'encrypted authority payload chunk digest is invalid' };
    }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.byteLength !== stored.plaintextBytes || sha256(bytes) !== stored.plaintextSha256) {
    return { status: 'corrupt', reason: 'encrypted authority payload bytes are invalid' };
  }
  return { status: 'ok', bytes };
}

interface ReclaimableFile {
  target: string;
  stat: Stats;
}

type ReclaimAttempt = 'deleted' | 'referenced' | 'race' | 'unsafe';

function boundedReclamationInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new AuthorityEncryptedPayloadError('invalid_authority_payload');
  }
  return resolved;
}

function reclaimableAgedFile(target: string, cutoffMs: number):
  | { status: 'ok'; file: ReclaimableFile }
  | { status: 'fresh' }
  | { status: 'unsafe' }
  | { status: 'missing' } {
  try {
    const stat = lstatSync(target);
    if (
      stat.isSymbolicLink()
      || !stat.isFile()
      || stat.nlink !== 1
      || (stat.mode & 0o777) !== FILE_MODE
      || stat.size > AUTHORITY_ENCRYPTED_PAYLOAD_MAX_FILE_BYTES
      || !Number.isFinite(stat.mtimeMs)
    ) {
      return { status: 'unsafe' };
    }
    if (stat.mtimeMs >= cutoffMs) return { status: 'fresh' };
    return { status: 'ok', file: { target, stat } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    return { status: 'unsafe' };
  }
}

function sameReclamationFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function openExactReclamationFile(file: ReclaimableFile): number | null {
  let fd: number | null = null;
  try {
    const current = lstatSync(file.target);
    if (
      current.isSymbolicLink()
      || !current.isFile()
      || current.nlink !== 1
      || (current.mode & 0o777) !== FILE_MODE
      || !sameReclamationFile(file.stat, current)
    ) return null;
    fd = openSync(file.target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || (opened.mode & 0o777) !== FILE_MODE
      || !sameReclamationFile(current, opened)
    ) {
      closeSync(fd);
      return null;
    }
    return fd;
  } catch {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    return null;
  }
}

function hasReclamationReferenceSchema(db: Database.Database): boolean {
  try {
    const planColumns = new Set(
      (db.prepare('PRAGMA table_info(staged_transfer_plans)').all() as Array<{ name: string }>)
        .map((row) => row.name),
    );
    const checkpointColumns = new Set(
      (db.prepare('PRAGMA table_info(physical_dispatch_return_checkpoints)').all() as Array<{ name: string }>)
        .map((row) => row.name),
    );
    const secretColumns = new Set(
      (db.prepare('PRAGMA table_info(staged_transfer_secret_payloads)').all() as Array<{ name: string }>)
        .map((row) => row.name),
    );
    const modelRequestColumns = new Set(
      (db.prepare('PRAGMA table_info(model_request_provenance)').all() as Array<{ name: string }>)
        .map((row) => row.name),
    );
    return planColumns.has('manifest_payload_id')
      && checkpointColumns.has('payload_id')
      && secretColumns.has('payload_id')
      && modelRequestColumns.has('payload_id');
  } catch {
    return false;
  }
}

/**
 * Reclaim aged encrypted payloads without ever reading, decrypting, or logging
 * their bytes. Canonical payload files are eligible only when every v62 owner
 * tables exist and the exact payload id is unreferenced. A second lookup runs
 * under an IMMEDIATE SQLite transaction directly before unlink, preventing a
 * concurrent owner insert from racing the filesystem deletion.
 */
export function reclaimOrphanedAuthorityEncryptedPayloads(input: {
  db: Database.Database;
  nowMs?: number;
  orphanHorizonMs?: number;
  scanLimit?: number;
}): AuthorityEncryptedPayloadReclamationResult {
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new AuthorityEncryptedPayloadError('invalid_authority_payload');
  }
  const orphanHorizonMs = boundedReclamationInteger(
    input.orphanHorizonMs,
    AUTHORITY_ENCRYPTED_PAYLOAD_ORPHAN_HORIZON_MS,
    AUTHORITY_ENCRYPTED_PAYLOAD_MIN_ORPHAN_HORIZON_MS,
    AUTHORITY_ENCRYPTED_PAYLOAD_MAX_ORPHAN_HORIZON_MS,
  );
  const scanLimit = boundedReclamationInteger(
    input.scanLimit,
    AUTHORITY_ENCRYPTED_PAYLOAD_RECLAIM_SCAN_LIMIT,
    1,
    AUTHORITY_ENCRYPTED_PAYLOAD_RECLAIM_MAX_SCAN_LIMIT,
  );
  const cutoffMs = nowMs - orphanHorizonMs;
  const result: AuthorityEncryptedPayloadReclamationResult = {
    scannedEntries: 0,
    deletedPayloadFiles: 0,
    deletedTempFiles: 0,
    retainedReferenced: 0,
    retainedFresh: 0,
    ignoredUnsafe: 0,
    ignoredUnknown: 0,
    lostRaces: 0,
    storageErrors: 0,
    referenceSchemaAvailable: hasReclamationReferenceSchema(input.db) && !input.db.inTransaction,
  };

  ensurePayloadDirectory();
  let referenceStatement: Database.Statement<[string, string, string, string]> | null = null;
  let deleteOrphanUnderLock:
    | ((payloadId: string, file: ReclaimableFile) => ReclaimAttempt)
    | null = null;
  if (result.referenceSchemaAvailable) {
    try {
      referenceStatement = input.db.prepare(`
        SELECT 1 AS referenced
        FROM staged_transfer_plans
        WHERE manifest_payload_id = ?
        UNION ALL
        SELECT 1 AS referenced
        FROM physical_dispatch_return_checkpoints
        WHERE payload_id = ?
        UNION ALL
        SELECT 1 AS referenced
        FROM staged_transfer_secret_payloads
        WHERE payload_id = ?
        UNION ALL
        SELECT 1 AS referenced
        FROM model_request_provenance
        WHERE payload_id = ?
        LIMIT 1
      `);
      const transaction = input.db.transaction((payloadId: string, file: ReclaimableFile): ReclaimAttempt => {
        const fd = openExactReclamationFile(file);
        if (fd === null) return 'race';
        try {
          // This is deliberately the final operation before unlink. BEGIN
          // IMMEDIATE prevents another connection from inserting an owner row
          // until this transaction commits.
          if (referenceStatement!.get(payloadId, payloadId, payloadId, payloadId) !== undefined) return 'referenced';
          unlinkSync(file.target);
          return 'deleted';
        } finally {
          closeSync(fd);
        }
      });
      deleteOrphanUnderLock = transaction.immediate.bind(transaction);
    } catch {
      result.referenceSchemaAvailable = false;
      referenceStatement = null;
      deleteOrphanUnderLock = null;
      result.storageErrors += 1;
    }
  }

  let directory: ReturnType<typeof opendirSync> | null = null;
  let deletedAnything = false;
  try {
    directory = opendirSync(AUTHORITY_ENCRYPTED_PAYLOAD_DIRECTORY);
    while (result.scannedEntries < scanLimit) {
      const entry = directory.readSync();
      if (entry === null) break;
      result.scannedEntries += 1;
      const sealedMatch = SEALED_FILE_RE.exec(entry.name);
      const isTemp = TEMP_FILE_RE.test(entry.name);
      if (!sealedMatch && !isTemp) {
        result.ignoredUnknown += 1;
        continue;
      }
      const candidate = reclaimableAgedFile(
        path.join(AUTHORITY_ENCRYPTED_PAYLOAD_DIRECTORY, entry.name),
        cutoffMs,
      );
      if (candidate.status === 'fresh') {
        result.retainedFresh += 1;
        continue;
      }
      if (candidate.status === 'missing') {
        result.lostRaces += 1;
        continue;
      }
      if (candidate.status === 'unsafe') {
        result.ignoredUnsafe += 1;
        continue;
      }

      if (isTemp) {
        const fd = openExactReclamationFile(candidate.file);
        if (fd === null) {
          result.lostRaces += 1;
          continue;
        }
        try {
          unlinkSync(candidate.file.target);
          result.deletedTempFiles += 1;
          deletedAnything = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') result.lostRaces += 1;
          else result.storageErrors += 1;
        } finally {
          closeSync(fd);
        }
        continue;
      }

      if (
        sealedMatch === null
        || !result.referenceSchemaAvailable
        || referenceStatement === null
        || deleteOrphanUnderLock === null
      ) {
        // Absence of the exact owner schema is not proof of orphanhood.
        continue;
      }
      const payloadId = `authority-payload:${sealedMatch[1]}`;
      try {
        if (referenceStatement.get(payloadId, payloadId, payloadId, payloadId) !== undefined) {
          result.retainedReferenced += 1;
          continue;
        }
        const attempt = deleteOrphanUnderLock(payloadId, candidate.file);
        if (attempt === 'deleted') {
          result.deletedPayloadFiles += 1;
          deletedAnything = true;
        } else if (attempt === 'referenced') {
          result.retainedReferenced += 1;
        } else if (attempt === 'race') {
          result.lostRaces += 1;
        } else {
          result.ignoredUnsafe += 1;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') result.lostRaces += 1;
        else result.storageErrors += 1;
      }
    }
  } catch {
    result.storageErrors += 1;
  } finally {
    try { directory?.closeSync(); } catch { result.storageErrors += 1; }
  }
  if (deletedAnything) {
    try { fsyncDirectory(AUTHORITY_ENCRYPTED_PAYLOAD_DIRECTORY); }
    catch { result.storageErrors += 1; }
  }
  return result;
}
