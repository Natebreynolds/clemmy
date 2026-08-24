/**
 * Lossless storage for result payloads which cannot live in one SQLite row.
 *
 * Inline payloads retain their historical representation. Oversized payloads
 * use an impossible inline JSON value (the empty string) as a DB sentinel and
 * live in a host-owned content-addressed file. The filesystem path is derived
 * only from a validated SHA-256 digest; neither a provider nor a caller can
 * contribute a path component.
 */
import { randomUUID, createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../../config.js';

export const RESULT_PAYLOAD_INLINE_MAX_BYTES = 8_000_000;
export const RESULT_PAYLOAD_SPILL_SENTINEL = '';
const FIXED_BASE_DIRECTORY = path.resolve(BASE_DIR);
export const RESULT_PAYLOAD_SPILL_DIRECTORY = path.join(
  FIXED_BASE_DIRECTORY,
  'state',
  'result-payloads',
  'sha256',
);

const DIGEST_RE = /^[a-f0-9]{64}$/;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

export interface DurableResultPayloadMetadata {
  rawLocation: string | null;
  rawPayloadJson: string | null;
  rawPayloadSha256: string | null;
  rawByteCount: number;
  rejectionReason: string | null;
}

export type DurableResultPayloadRead =
  | { status: 'ok'; rawJson: string; value: unknown; storage: 'inline' | 'spill' }
  | { status: 'missing' | 'corrupt' | 'storage_error'; reason: string };

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function boundedReason(error: unknown): string {
  return String(error instanceof Error ? error.message : error).slice(0, 240);
}

function assertDigest(digest: string): void {
  if (!DIGEST_RE.test(digest)) {
    throw new Error('result payload digest is not a canonical SHA-256');
  }
}

/** Fixed, content-addressed path. The digest is the only variable component. */
export function resultPayloadFilePath(digest: string): string {
  assertDigest(digest);
  const target = path.join(RESULT_PAYLOAD_SPILL_DIRECTORY, `${digest}.json`);
  if (path.dirname(target) !== RESULT_PAYLOAD_SPILL_DIRECTORY) {
    throw new Error('result payload path escaped its fixed storage directory');
  }
  return target;
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
      // Another writer may have won the first-use directory creation race.
      // The lstat/type check below still refuses a symlink or non-directory.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    stat = lstatOrMissing(directory);
  }
  if (stat === null) throw new Error('result payload storage directory is missing');
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('result payload storage directory is not a real directory');
  }
}

function ensureSpillDirectory(): void {
  // BASE_DIR is fixed by host configuration before this module loads. Every
  // payload-store component beneath it is checked independently so a symlink
  // cannot redirect authoritative bytes outside CLEMENTINE_HOME/state.
  requireRealDirectory(FIXED_BASE_DIRECTORY, false);
  const state = path.join(FIXED_BASE_DIRECTORY, 'state');
  requireRealDirectory(state, true);
  const payloads = path.join(state, 'result-payloads');
  requireRealDirectory(payloads, true);
  requireRealDirectory(RESULT_PAYLOAD_SPILL_DIRECTORY, true);
}

function fsyncDirectory(directory: string): void {
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

type VerifiedFileRead =
  | { status: 'ok'; rawJson: string }
  | { status: 'missing' | 'corrupt' | 'storage_error'; reason: string };

function readAndVerifySpill(input: {
  digest: string;
  byteCount: number;
}): VerifiedFileRead {
  let target: string;
  try {
    target = resultPayloadFilePath(input.digest);
    ensureSpillDirectory();
    const entry = lstatOrMissing(target);
    if (entry === null) return { status: 'missing', reason: 'spilled result payload file is missing' };
    if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) {
      return { status: 'corrupt', reason: 'spilled result payload is not one regular host-owned file' };
    }
    if (entry.size !== input.byteCount) {
      return { status: 'corrupt', reason: 'spilled result payload size does not match durable metadata' };
    }
    if ((entry.mode & 0o777) !== FILE_MODE) {
      return { status: 'corrupt', reason: 'spilled result payload permissions are not 0600' };
    }

    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const opened = fstatSync(fd);
      if (
        !opened.isFile()
        || opened.nlink !== 1
        || opened.size !== input.byteCount
        || (opened.mode & 0o777) !== FILE_MODE
      ) {
        return { status: 'corrupt', reason: 'opened result payload is not one 0600 regular file' };
      }
      bytes = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
    if (bytes.byteLength !== input.byteCount || sha256(bytes) !== input.digest) {
      return { status: 'corrupt', reason: 'spilled result payload bytes do not match durable metadata' };
    }
    const rawJson = bytes.toString('utf8');
    // Round-tripping through UTF-8 must preserve the exact content-addressed
    // bytes. Invalid byte sequences would otherwise be replaced on decode.
    if (!Buffer.from(rawJson, 'utf8').equals(bytes)) {
      return { status: 'corrupt', reason: 'spilled result payload is not canonical UTF-8 JSON bytes' };
    }
    return { status: 'ok', rawJson };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { status: 'missing', reason: 'spilled result payload file is missing' };
    if (code === 'ELOOP') return { status: 'corrupt', reason: 'spilled result payload path is a symlink' };
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

/**
 * Atomically retain canonical oversized JSON. Existing bytes are verified and
 * reused; a wrong, damaged, linked, or weakly-permissioned file is never
 * overwritten and therefore fails closed.
 */
export function persistSpilledResultPayload(input: {
  rawJson: string;
  digest: string;
  byteCount: number;
}): void {
  assertDigest(input.digest);
  const bytes = Buffer.from(input.rawJson, 'utf8');
  let canonical = false;
  try {
    canonical = JSON.stringify(JSON.parse(input.rawJson) as unknown) === input.rawJson;
  } catch {
    canonical = false;
  }
  if (
    !canonical
    || input.rawJson === RESULT_PAYLOAD_SPILL_SENTINEL
    || input.byteCount <= RESULT_PAYLOAD_INLINE_MAX_BYTES
    || bytes.byteLength !== input.byteCount
    || sha256(bytes) !== input.digest
  ) {
    throw new Error('result payload spill metadata does not match canonical oversized JSON bytes');
  }
  ensureSpillDirectory();
  const target = resultPayloadFilePath(input.digest);
  const existing = lstatOrMissing(target);
  if (existing !== null) {
    const verified = readAndVerifySpill({ digest: input.digest, byteCount: input.byteCount });
    if (verified.status !== 'ok') {
      throw new Error(`refusing unsafe existing result payload (${verified.reason})`);
    }
    return;
  }

  const temp = path.join(
    RESULT_PAYLOAD_SPILL_DIRECTORY,
    `.${input.digest}.${process.pid}.${randomUUID()}.tmp`,
  );
  let fd: number | null = null;
  let renamed = false;
  try {
    fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      FILE_MODE,
    );
    fchmodSync(fd, FILE_MODE);
    let offset = 0;
    while (offset < bytes.byteLength) {
      offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = null;

    // Re-check the fixed parent immediately before publish. A symlinked
    // directory or pre-existing final entry is authority failure, not a cue
    // to follow or replace it.
    requireRealDirectory(RESULT_PAYLOAD_SPILL_DIRECTORY, false);
    const raced = lstatOrMissing(target);
    if (raced !== null) {
      const verified = readAndVerifySpill({ digest: input.digest, byteCount: input.byteCount });
      if (verified.status !== 'ok') {
        throw new Error(`refusing raced result payload (${verified.reason})`);
      }
      return;
    }
    renameSync(temp, target);
    renamed = true;
    fsyncDirectory(RESULT_PAYLOAD_SPILL_DIRECTORY);
    const verified = readAndVerifySpill({ digest: input.digest, byteCount: input.byteCount });
    if (verified.status !== 'ok') {
      throw new Error(`published result payload did not verify (${verified.reason})`);
    }
  } finally {
    if (fd !== null) closeSync(fd);
    if (!renamed) {
      try { unlinkSync(temp); } catch { /* the temp may already be absent */ }
    }
  }
}

/** Verify and decode either the historical inline form or an oversized spill. */
export function readDurableResultPayload(
  metadata: DurableResultPayloadMetadata,
): DurableResultPayloadRead {
  if (metadata.rawLocation === null || metadata.rawPayloadSha256 === null) {
    return { status: 'missing', reason: 'durable result payload metadata is missing' };
  }
  if (metadata.rejectionReason !== null) {
    return { status: 'missing', reason: `raw payload was not stored (${metadata.rejectionReason})` };
  }
  if (!DIGEST_RE.test(metadata.rawPayloadSha256) || !Number.isSafeInteger(metadata.rawByteCount)) {
    return { status: 'corrupt', reason: 'durable result payload metadata is malformed' };
  }

  let rawJson: string;
  let storage: 'inline' | 'spill';
  if (metadata.rawPayloadJson === null) {
    return { status: 'missing', reason: 'durable result payload bytes are missing' };
  }
  if (metadata.rawPayloadJson === RESULT_PAYLOAD_SPILL_SENTINEL) {
    if (metadata.rawByteCount <= RESULT_PAYLOAD_INLINE_MAX_BYTES) {
      return { status: 'corrupt', reason: 'result payload spill sentinel has an inline byte count' };
    }
    const spilled = readAndVerifySpill({
      digest: metadata.rawPayloadSha256,
      byteCount: metadata.rawByteCount,
    });
    if (spilled.status !== 'ok') return spilled;
    rawJson = spilled.rawJson;
    storage = 'spill';
  } else {
    if (
      Buffer.byteLength(metadata.rawPayloadJson, 'utf8') !== metadata.rawByteCount
      || sha256(metadata.rawPayloadJson) !== metadata.rawPayloadSha256
    ) {
      return { status: 'corrupt', reason: 'inline result payload bytes do not match durable metadata' };
    }
    rawJson = metadata.rawPayloadJson;
    storage = 'inline';
  }

  try {
    const value = JSON.parse(rawJson) as unknown;
    if (storage === 'spill' && JSON.stringify(value) !== rawJson) {
      return { status: 'corrupt', reason: 'spilled result payload is not canonical JSON bytes' };
    }
    return { status: 'ok', rawJson, value, storage };
  } catch {
    return { status: 'corrupt', reason: 'durable result payload is not valid JSON' };
  }
}
