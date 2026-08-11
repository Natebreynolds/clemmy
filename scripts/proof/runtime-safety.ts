/**
 * Small fail-closed guards for the isolated live-proof runtime.
 *
 * A proof that runs a provider while its temp volume is nearly full is not
 * release evidence: SQLite/event writes can fail after the provider has
 * already been paid. Failed proof homes also need a bounded daemon log for
 * diagnosis, but must never retain the access-only credentials used by the
 * isolated process.
 */
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmdirSync,
  statfsSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

import type { Check, DaemonStopResult, ProofLogCaptureEvidence } from './types.js';

export const PROOF_MIN_TEMP_FREE_BYTES = 2 * 1024 * 1024 * 1024;
export const PROOF_DAEMON_LOG_BASENAME = 'proof-daemon.log';
export const PROOF_DAEMON_LOG_MAX_BYTES = 2 * 1024 * 1024;
export const PROOF_SCENARIO_LOG_MAX_BYTES = 8 * 1024 * 1024;
export const PROOF_FORENSIC_RESERVE_BASENAME = '.proof-forensic-reserve';
// Keep a full extra MiB for directory metadata, the truncation marker, and
// filesystem allocation granularity. The reserve must always be physically
// larger than the largest retained log it is meant to rescue.
export const PROOF_FORENSIC_RESERVE_BYTES = PROOF_DAEMON_LOG_MAX_BYTES + 1024 * 1024;
export const PROOF_CHILD_OUTPUT_DRAIN_TIMEOUT_MS = 5_000;
export const PROOF_CREDENTIAL_FILE_MAX_BYTES = 1024 * 1024;
// The raw forensic ring carries one extra maximum-credential window. That
// overlap lets snapshots redact a complete secret before selecting the final
// 2 MiB tail, even when the ring's left edge bisects the secret.
export const PROOF_FORENSIC_REDACTION_OVERLAP_BYTES = PROOF_CREDENTIAL_FILE_MAX_BYTES;

class FixedByteRing {
  readonly capacity: number;
  private readonly storage: Buffer;
  private start = 0;
  private stored = 0;

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new Error('proof log ring capacity must be a positive safe integer');
    }
    this.capacity = capacity;
    this.storage = Buffer.alloc(capacity);
  }

  get size(): number { return this.stored; }

  /** Append without ever applying stream backpressure. Returns bytes evicted
   * from this ring, including an oversized chunk's discarded prefix. */
  append(chunk: Buffer): number {
    if (chunk.length === 0) return 0;
    if (chunk.length >= this.capacity) {
      const dropped = this.stored + chunk.length - this.capacity;
      chunk.copy(this.storage, 0, chunk.length - this.capacity);
      this.start = 0;
      this.stored = this.capacity;
      return dropped;
    }

    const dropped = Math.max(0, this.stored + chunk.length - this.capacity);
    if (dropped > 0) {
      this.start = (this.start + dropped) % this.capacity;
      this.stored -= dropped;
    }
    const destination = (this.start + this.stored) % this.capacity;
    const first = Math.min(chunk.length, this.capacity - destination);
    chunk.copy(this.storage, destination, 0, first);
    if (first < chunk.length) chunk.copy(this.storage, 0, first);
    this.stored += chunk.length;
    return dropped;
  }

  snapshot(): Buffer {
    const out = Buffer.allocUnsafe(this.stored);
    if (this.stored === 0) return out;
    const first = Math.min(this.stored, this.capacity - this.start);
    this.storage.copy(out, 0, this.start, this.start + first);
    if (first < this.stored) this.storage.copy(out, first, 0, this.stored - first);
    return out;
  }

  clear(): void {
    // Daemon logs can contain provider-supplied error text. Zero the bounded
    // buffers rather than merely releasing their logical window after stop().
    this.storage.fill(0);
    this.start = 0;
    this.stored = 0;
  }
}

function isUtf8Continuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function utf8SequenceLength(byte: number): number {
  if ((byte & 0x80) === 0) return 1;
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return 0;
}

/** Remove only partial code points introduced by a byte-tail boundary. Valid
 * UTF-8 split across arbitrary stdout chunks is preserved because capture
 * stores the raw bytes rather than String(chunk) conversions. */
function utf8SafeTail(bytes: Buffer): Buffer {
  let start = 0;
  while (start < bytes.length && isUtf8Continuation(bytes[start]!)) start += 1;
  if (start >= bytes.length) return Buffer.alloc(0);

  let lead = bytes.length - 1;
  while (lead >= start && isUtf8Continuation(bytes[lead]!)) lead -= 1;
  if (lead < start) return Buffer.alloc(0);
  const expected = utf8SequenceLength(bytes[lead]!);
  const actual = bytes.length - lead;
  const end = expected > 1 && actual < expected ? lead : bytes.length;
  return bytes.subarray(start, end);
}

function boundedCaptureText(
  bytes: Buffer,
  maxBytes: number,
  droppedBytes: number,
): string {
  if (droppedBytes <= 0 && bytes.length <= maxBytes) {
    return utf8SafeTail(bytes).toString('utf8');
  }
  const reportedDroppedBytes = Math.max(droppedBytes, bytes.length - maxBytes);
  const marker = Buffer.from(
    `[proof] daemon log capture retained a bounded tail after dropping ${reportedDroppedBytes} bytes\n`,
    'utf8',
  );
  if (marker.length >= maxBytes) return marker.subarray(0, maxBytes).toString('utf8');
  const tailBudget = maxBytes - marker.length;
  const tail = bytes.subarray(Math.max(0, bytes.length - tailBudget));
  return `${marker.toString('utf8')}${utf8SafeTail(tail).toString('utf8')}`;
}

/** Enforce an already-declared byte cap without adding any new diagnostic
 * prose. This is intentionally a tail operation: callers use it only after
 * the final redaction pass, where a multi-byte sentinel may have expanded an
 * ASCII truncation marker beyond its pre-redaction bound. Removing a prefix
 * cannot reintroduce an exact secret, and utf8SafeTail drops any split leading
 * code point instead of emitting U+FFFD. */
function recappedRedactedTail(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  return utf8SafeTail(bytes.subarray(bytes.length - maxBytes)).toString('utf8');
}

/** Return the longest byte prefix of a log that is also a suffix of one exact
 * secret. The raw overlap guard can itself land inside a later, adjacent
 * credential; this linear KMP overlap check identifies the newly exposed
 * fragment without constructing every possible suffix of a large token. */
function leadingExactSecretSuffixBytes(
  log: Buffer,
  exactSecrets: readonly string[],
): number {
  let longest = 0;
  for (const value of new Set(exactSecrets.filter((secret) => secret.length > 0))) {
    const secret = Buffer.from(value, 'utf8');
    const patternLength = Math.min(log.length, secret.length);
    if (patternLength <= longest) continue;
    const pattern = log.subarray(0, patternLength);
    const failure = new Uint32Array(patternLength);
    for (let index = 1, matched = 0; index < patternLength; index += 1) {
      while (matched > 0 && pattern[index] !== pattern[matched]) {
        matched = failure[matched - 1]!;
      }
      if (pattern[index] === pattern[matched]) matched += 1;
      failure[index] = matched;
    }
    let matched = 0;
    for (let index = 0; index < secret.length; index += 1) {
      while (matched > 0 && secret[index] !== pattern[matched]) {
        matched = failure[matched - 1]!;
      }
      if (secret[index] === pattern[matched]) matched += 1;
      if (matched === patternLength && index < secret.length - 1) {
        matched = failure[matched - 1]!;
      }
    }
    longest = Math.max(longest, matched);
  }
  return longest;
}

/** Close over boundary fragments exposed by conservative deletion. The
 * longest match can deliberately consume bytes from an adjacent credential;
 * another pass then removes the suffix that operation exposed. Keep the work
 * bounded, and discard the uncertain tail if an adversarial overlap chain is
 * still active after the fixed budget. */
function stripLeadingExactSecretSuffixes(
  log: Buffer,
  exactSecrets: readonly string[],
): Buffer {
  let remaining = log;
  const maxPasses = 8;
  for (let pass = 0; pass < maxPasses && remaining.length > 0; pass += 1) {
    const matched = leadingExactSecretSuffixBytes(remaining, exactSecrets);
    if (matched === 0) return remaining;
    remaining = remaining.subarray(matched);
  }
  // An eighth consecutive overlap is hostile or pathologically ambiguous.
  // Returning no untrusted tail is safer than making the redactor unbounded.
  return Buffer.alloc(0);
}

/** Fixed-memory daemon output capture. The forensic ring is a cross-restart
 * diagnostic tail. The larger scenario ring is exact until its explicit bound;
 * overflow stays sticky and makes the proof red instead of silently hiding an
 * early storm/fallback marker. */
export class BoundedProofLogCapture {
  private readonly forensic: FixedByteRing;
  private readonly forensicMaxBytes: number;
  private readonly forensicRedactionOverlapBytes: number;
  private readonly scenario: FixedByteRing;
  private totalBytes = 0;
  private currentScenarioBytes = 0;
  private currentScenarioDroppedBytes = 0;
  private scenarioDroppedBytes = 0;
  private overflowPeriods = 0;

  constructor(options: {
    forensicMaxBytes?: number;
    forensicRedactionOverlapBytes?: number;
    scenarioMaxBytes?: number;
  } = {}) {
    this.forensicMaxBytes = options.forensicMaxBytes ?? PROOF_DAEMON_LOG_MAX_BYTES;
    this.forensicRedactionOverlapBytes = options.forensicRedactionOverlapBytes
      ?? PROOF_FORENSIC_REDACTION_OVERLAP_BYTES;
    if (!Number.isSafeInteger(this.forensicMaxBytes) || this.forensicMaxBytes <= 0) {
      throw new Error('proof forensic log bound must be a positive safe integer');
    }
    if (!Number.isSafeInteger(this.forensicRedactionOverlapBytes)
      || this.forensicRedactionOverlapBytes <= 0) {
      throw new Error('proof forensic redaction overlap must be a positive safe integer');
    }
    const forensicRawMaxBytes = this.forensicMaxBytes + this.forensicRedactionOverlapBytes;
    if (!Number.isSafeInteger(forensicRawMaxBytes)) {
      throw new Error('proof forensic raw log bound exceeds the safe integer range');
    }
    this.forensic = new FixedByteRing(forensicRawMaxBytes);
    this.scenario = new FixedByteRing(options.scenarioMaxBytes ?? PROOF_SCENARIO_LOG_MAX_BYTES);
  }

  assertForensicRedactionCoverage(exactSecrets: readonly string[]): void {
    const oversized = exactSecrets
      .map((value) => ({ value, bytes: Buffer.byteLength(value, 'utf8') }))
      .filter(({ value, bytes }) => value.length > 0 && bytes > this.forensicRedactionOverlapBytes)
      .sort((a, b) => b.bytes - a.bytes)[0];
    if (oversized) {
      throw new Error(
        `proof forensic redaction overlap ${this.forensicRedactionOverlapBytes} bytes cannot cover an exact ${oversized.bytes}-byte secret`,
      );
    }
    // Also prove a separator exists that cannot be part of any admitted exact
    // secret. Replacement with that one code point is idempotent and prevents
    // surrounding log text from re-forming a secret across the redaction seam.
    proofLogRedactionSentinel(exactSecrets);
  }

  append(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    if (bytes.length === 0) return;
    this.totalBytes = Math.min(Number.MAX_SAFE_INTEGER, this.totalBytes + bytes.length);
    this.currentScenarioBytes = Math.min(
      Number.MAX_SAFE_INTEGER,
      this.currentScenarioBytes + bytes.length,
    );
    this.forensic.append(bytes);
    const alreadyOverflowed = this.currentScenarioDroppedBytes > 0;
    const dropped = this.scenario.append(bytes);
    this.currentScenarioDroppedBytes = Math.min(
      Number.MAX_SAFE_INTEGER,
      this.currentScenarioDroppedBytes + dropped,
    );
    this.scenarioDroppedBytes = Math.min(
      Number.MAX_SAFE_INTEGER,
      this.scenarioDroppedBytes + dropped,
    );
    if (!alreadyOverflowed && dropped > 0) this.overflowPeriods += 1;
  }

  /** Runner boundary only. Daemon restarts deliberately do not call this, so a
   * scenario sees its complete pre/post-restart transcript under one bound. */
  markScenario(): void {
    this.scenario.clear();
    this.currentScenarioBytes = 0;
    this.currentScenarioDroppedBytes = 0;
  }

  scenarioLog(): string {
    if (this.currentScenarioDroppedBytes > 0) {
      throw new Error(this.overflowError() ?? 'proof daemon scenario log capture overflowed');
    }
    return utf8SafeTail(this.scenario.snapshot()).toString('utf8');
  }

  forensicLog(exactSecrets: readonly string[] = []): string {
    this.assertForensicRedactionCoverage(exactSecrets);
    const evidence = this.stats();
    let rawBytes = this.forensic.snapshot();
    if (evidence.forensicRawDroppedBytes > 0) {
      // The raw ring can begin inside one exact secret. Remove a full
      // maximum-secret overlap while it is still measured in the original
      // bytes; redaction can expand or shrink different values, so applying
      // this guard afterward would not reliably remove the unmatched suffix.
      rawBytes = rawBytes.subarray(
        Math.min(this.forensicRedactionOverlapBytes, rawBytes.length),
      );
    }
    rawBytes = utf8SafeTail(rawBytes);
    if (evidence.forensicRawDroppedBytes > 0) {
      // Cutting away the guard can expose a suffix of an immediately adjacent
      // secret at the new left edge. Remove that exact boundary fragment too;
      // deletion at byte zero cannot join surrounding text into a credential.
      rawBytes = stripLeadingExactSecretSuffixes(rawBytes, exactSecrets);
    }
    const raw = rawBytes.toString('utf8');
    const redacted = redactProofDaemonLog(raw, exactSecrets);
    const safeBytes = Buffer.from(redacted, 'utf8');
    const bounded = boundedCaptureText(
      safeBytes,
      evidence.forensicMaxBytes,
      evidence.forensicDroppedBytes,
    );
    // boundedCaptureText adds diagnostic prose after the first redaction pass.
    // Scrub once more so an unusual credential equal to marker text cannot be
    // reintroduced by the truncation marker itself.
    return recappedRedactedTail(
      redactProofDaemonLog(bounded, exactSecrets),
      evidence.forensicMaxBytes,
    );
  }

  stats(): ProofLogCaptureEvidence {
    return {
      totalBytes: this.totalBytes,
      forensicMaxBytes: this.forensicMaxBytes,
      forensicStoredBytes: Math.min(this.forensicMaxBytes, this.forensic.size),
      forensicDroppedBytes: Math.max(0, this.totalBytes - this.forensicMaxBytes),
      forensicRawMaxBytes: this.forensic.capacity,
      forensicRawStoredBytes: this.forensic.size,
      forensicRawDroppedBytes: Math.max(0, this.totalBytes - this.forensic.size),
      forensicRedactionOverlapBytes: this.forensicRedactionOverlapBytes,
      scenarioMaxBytes: this.scenario.capacity,
      currentScenarioBytes: this.currentScenarioBytes,
      currentScenarioStoredBytes: this.scenario.size,
      currentScenarioDroppedBytes: this.currentScenarioDroppedBytes,
      scenarioDroppedBytes: this.scenarioDroppedBytes,
      overflowPeriods: this.overflowPeriods,
      overflowed: this.scenarioDroppedBytes > 0,
    };
  }

  overflowError(): string | undefined {
    const evidence = this.stats();
    if (!evidence.overflowed) return undefined;
    return [
      `daemon stdout/stderr exceeded the ${evidence.scenarioMaxBytes}-byte per-scenario capture bound`,
      `in ${evidence.overflowPeriods} boot/scenario period(s)`,
      `(${evidence.scenarioDroppedBytes} semantic bytes dropped; ${evidence.totalBytes} total bytes observed)`,
      'proof log evidence is incomplete',
    ].join(' ');
  }

  clear(): void {
    this.forensic.clear();
    this.scenario.clear();
    this.totalBytes = 0;
    this.currentScenarioBytes = 0;
    this.currentScenarioDroppedBytes = 0;
    this.scenarioDroppedBytes = 0;
    this.overflowPeriods = 0;
  }
}

const PROOF_HOME_BASENAME_RE = /^clemmy-proof-[A-Za-z0-9._-]+$/;
const PROOF_CREDENTIAL_PATHS = [
  path.join('state', 'auth.json'),
  path.join('state', 'codex-access-only.json'),
  path.join('state', 'claude-auth.json'),
  path.join('state', 'secrets-vault.json'),
  '.env',
] as const;

export interface ProofHomeIdentity {
  home: string;
  homeDevice: number;
  homeInode: number;
  state?: {
    path: string;
    device: number;
    inode: number;
  };
}

export interface ProofHomeCleanupResult {
  intent: 'sanitize-and-retain' | 'remove';
  status: 'succeeded' | 'failed';
  homeExists: boolean;
  errors?: string[];
}

export interface ProofHomeCleanupOperations {
  /** Test-only race/failure seam. It runs before the descriptor-anchored native
   * operation and is never entrusted with a pathname to delete. */
  beforeNativeCleanup?: (
    home: string,
    intent: 'sanitize-and-retain' | 'remove',
  ) => void;
  /** Production passes a synchronous lifecycle assertion proving the provider
   * process has fully exited. A helper is never built while that proof fails. */
  assertProviderTerminated?: () => void;
  /** Test-only integrity seams. The first runs before the final open-fd hash
   * and mode check; the second runs after a successful native dispatch but
   * before independent result verification. */
  beforeNativeHelperDispatch?: (executable: string, operation: NativeProofFsOperation) => void;
  afterNativeHelperDispatch?: (executable: string, operation: NativeProofFsOperation) => void;
}

const NATIVE_PROOF_HELPER_SOURCE_PATH = fileURLToPath(
  new URL('./runtime-safety-native.c', import.meta.url),
);
const NATIVE_PROOF_HELPER_SOURCE_MAX_BYTES = 1024 * 1024;
const NATIVE_PROOF_HELPER_COMPILERS = ['/usr/bin/cc', '/usr/bin/clang'] as const;

interface TrustedNativeProofHelperSource {
  bytes: Buffer;
  sha256: string;
}

interface NativeProofHelperExecutionOperations {
  assertProviderTerminated?: () => void;
  beforeNativeHelperDispatch?: (executable: string, operation: NativeProofFsOperation) => void;
  afterNativeHelperDispatch?: (executable: string, operation: NativeProofFsOperation) => void;
}

/** Read the reviewed helper exactly once during module initialization. The
 * proof runner imports this module before it can spawn a provider-capable
 * daemon, so later repository writes can never change the bytes we compile. */
function captureTrustedNativeProofHelperSource(): TrustedNativeProofHelperSource {
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  let fd: number | undefined;
  try {
    fd = openSync(NATIVE_PROOF_HELPER_SOURCE_PATH, fsConstants.O_RDONLY | noFollow);
    const before = fstatSync(fd);
    if (!before.isFile() || before.size <= 0 || before.size > NATIVE_PROOF_HELPER_SOURCE_MAX_BYTES) {
      throw new Error('reviewed native helper source is not a bounded regular file');
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new Error('reviewed native helper source changed while being captured');
      offset += count;
    }
    const after = fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
      throw new Error('reviewed native helper source identity changed while being captured');
    }
    return {
      bytes: Buffer.from(bytes),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch (error) {
    throw new Error(
      `could not capture reviewed live-proof native helper source before provider spawn: ${errorText(error)}`,
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const TRUSTED_NATIVE_PROOF_HELPER_SOURCE = captureTrustedNativeProofHelperSource();

function errnoCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    && typeof (error as NodeJS.ErrnoException).code === 'string'
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = errnoCode(error);
  return code && !message.includes(code) ? `${code}: ${message}` : message;
}

function lstatOrNull(target: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(target);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return null;
    throw error;
  }
}

/** Accept only the exact direct child that provisionDaemon created under the
 * process temp root. Cleanup must never become a general recursive-delete API. */
export function assertExplicitProofHome(home: string): string {
  if (!path.isAbsolute(home) || path.resolve(home) !== home) {
    throw new Error(`proof home must be one normalized absolute path: ${home}`);
  }
  const tempRoot = path.resolve(os.tmpdir());
  if (path.dirname(home) !== tempRoot || !PROOF_HOME_BASENAME_RE.test(path.basename(home))) {
    throw new Error(`refusing cleanup outside an explicit ${tempRoot}/clemmy-proof-* home: ${home}`);
  }
  return home;
}

function requireRegularDirectory(target: string, label: string): ReturnType<typeof lstatSync> {
  const stats = lstatOrNull(target);
  if (!stats) throw new Error(`${label} is missing: ${target}`);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} is not the pinned regular directory: ${target}`);
  }
  return stats;
}

/** Pin the directory inode before any provider-capable child is spawned. */
export function captureProofHomeIdentity(home: string): ProofHomeIdentity {
  const exactHome = assertExplicitProofHome(home);
  const stats = requireRegularDirectory(exactHome, 'proof home');
  return {
    home: exactHome,
    homeDevice: stats.dev,
    homeInode: stats.ino,
  };
}

/** Pin state only after provisioning has created it. */
export function captureProofStateIdentity(identity: ProofHomeIdentity): ProofHomeIdentity {
  assertProofHomeIdentity(identity);
  const statePath = path.join(identity.home, 'state');
  const stats = requireRegularDirectory(statePath, 'proof state directory');
  return {
    ...identity,
    state: { path: statePath, device: stats.dev, inode: stats.ino },
  };
}

/** Detect replacement of either the proof home or its state parent before a
 * paid/request-capable boundary can follow a swapped directory symlink. */
export function assertProofHomeIdentity(identity: ProofHomeIdentity): void {
  assertExplicitProofHome(identity.home);
  const home = requireRegularDirectory(identity.home, 'proof home');
  if (home.dev !== identity.homeDevice || home.ino !== identity.homeInode) {
    throw new Error(`proof home identity changed after provisioning: ${identity.home}`);
  }
  if (!identity.state) return;
  if (identity.state.path !== path.join(identity.home, 'state')) {
    throw new Error(`proof state identity escaped its home: ${identity.state.path}`);
  }
  const state = requireRegularDirectory(identity.state.path, 'proof state directory');
  if (state.dev !== identity.state.device || state.ino !== identity.state.inode) {
    throw new Error(`proof state directory identity changed after provisioning: ${identity.state.path}`);
  }
}

function proofMutationIdentity(
  home: string,
  identity: ProofHomeIdentity | undefined,
): ProofHomeIdentity {
  const exactHome = assertExplicitProofHome(home);
  if (identity) {
    if (identity.home !== exactHome) {
      throw new Error(`proof mutation identity does not own requested home: ${identity.home} != ${exactHome}`);
    }
    return identity;
  }
  const stats = lstatOrNull(exactHome);
  if (!stats) throw new Error(`proof home is missing: ${exactHome}`);
  return {
    home: exactHome,
    homeDevice: stats.dev,
    homeInode: stats.ino,
  };
}

export type NativeProofFsOperation = 'release' | 'sanitize' | 'remove' | 'write-log';
type BoundNativeProofFsOperation = NativeProofFsOperation | 'selftest';

interface NativeProofHelperTarget {
  operation: BoundNativeProofFsOperation;
  tempRoot: string;
  tempDevice: number;
  tempInode: number;
  homeName: string;
  homeDevice: number;
  homeInode: number;
  stateDevice: number;
  stateInode: number;
  enforceState: boolean;
}

interface NativeProofHelperPreflightOptions {
  platform?: NodeJS.Platform;
  compilerCandidates?: readonly string[];
}

interface NativeArtifactIdentity {
  path: string;
  device: number;
  inode: number;
}

function exactIdentityValue(value: number, label: string): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`live-proof native helper cannot bind unsafe ${label}: ${value}`);
  }
  return `${value}ULL`;
}

function cString(value: string): string {
  return JSON.stringify(value);
}

function nativeProofHelperHeader(target: NativeProofHelperTarget): Buffer {
  return Buffer.from([
    `#define PROOF_BOUND_OPERATION ${cString(target.operation)}`,
    `#define PROOF_BOUND_TEMP_ROOT ${cString(target.tempRoot)}`,
    `#define PROOF_BOUND_TEMP_DEVICE ${exactIdentityValue(target.tempDevice, 'temp device')}`,
    `#define PROOF_BOUND_TEMP_INODE ${exactIdentityValue(target.tempInode, 'temp inode')}`,
    `#define PROOF_BOUND_HOME_NAME ${cString(target.homeName)}`,
    `#define PROOF_BOUND_HOME_DEVICE ${exactIdentityValue(target.homeDevice, 'home device')}`,
    `#define PROOF_BOUND_HOME_INODE ${exactIdentityValue(target.homeInode, 'home inode')}`,
    `#define PROOF_BOUND_ENFORCE_STATE ${target.enforceState ? 1 : 0}`,
    `#define PROOF_BOUND_STATE_DEVICE ${exactIdentityValue(target.stateDevice, 'state device')}`,
    `#define PROOF_BOUND_STATE_INODE ${exactIdentityValue(target.stateInode, 'state inode')}`,
    '',
  ].join('\n'), 'utf8');
}

function writePrivateNativeArtifact(file: string, bytes: Buffer): NativeArtifactIdentity {
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const fd = openSync(
    file,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
    0o400,
  );
  try {
    fchmodSync(fd, 0o400);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (written <= 0) throw new Error(`native helper artifact write made no progress: ${file}`);
      offset += written;
    }
    fsyncSync(fd);
    const stats = fstatSync(fd);
    return { path: file, device: stats.dev, inode: stats.ino };
  } finally {
    closeSync(fd);
  }
}

function sha256OpenFile(fd: number, size: number): string {
  if (!Number.isSafeInteger(size) || size <= 0 || size > 32 * 1024 * 1024) {
    throw new Error(`compiled live-proof native helper has unsafe size: ${size}`);
  }
  const digest = createHash('sha256');
  const buffer = Buffer.alloc(Math.min(64 * 1024, size));
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (count <= 0) throw new Error('compiled live-proof native helper changed while hashing');
    digest.update(buffer.subarray(0, count));
    offset += count;
  }
  return digest.digest('hex');
}

function assertNativeExecutableBoundToOpenFile(input: {
  directory: string;
  directoryIdentity: NativeArtifactIdentity;
  executable: string;
  executableFd: number;
  executableIdentity: NativeArtifactIdentity;
  expectedSha256: string;
}): void {
  const directory = lstatSync(input.directory);
  const pathname = lstatSync(input.executable);
  const opened = fstatSync(input.executableFd);
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (!directory.isDirectory() || directory.isSymbolicLink()
    || directory.dev !== input.directoryIdentity.device
    || directory.ino !== input.directoryIdentity.inode
    || (directory.mode & 0o777) !== 0o500
    || (uid !== undefined && directory.uid !== uid)) {
    throw new Error('live-proof native helper directory identity or mode changed before dispatch');
  }
  if (!pathname.isFile() || pathname.isSymbolicLink()
    || pathname.dev !== input.executableIdentity.device
    || pathname.ino !== input.executableIdentity.inode
    || opened.dev !== input.executableIdentity.device
    || opened.ino !== input.executableIdentity.inode
    || pathname.size !== opened.size
    || pathname.nlink !== 1
    || (pathname.mode & 0o777) !== 0o500
    || (opened.mode & 0o777) !== 0o500
    || (uid !== undefined && (pathname.uid !== uid || opened.uid !== uid))) {
    throw new Error('live-proof native helper pathname is not the verified open executable');
  }
  const actualSha256 = sha256OpenFile(input.executableFd, opened.size);
  if (actualSha256 !== input.expectedSha256) {
    throw new Error('live-proof native helper bytes changed before or during dispatch');
  }
}

function unlinkExactNativeArtifact(identity: NativeArtifactIdentity): void {
  const current = lstatOrNull(identity.path);
  if (!current) return;
  if (current.dev !== identity.device || current.ino !== identity.inode) {
    throw new Error(`refusing to unlink replaced native helper artifact: ${identity.path}`);
  }
  unlinkSync(identity.path);
  if (lstatOrNull(identity.path)) {
    throw new Error(`native helper artifact still exists after unlink: ${identity.path}`);
  }
}

function nativeProofHelperCompiler(candidates: readonly string[]): string {
  const compiler = candidates.find((candidate) => existsSync(candidate));
  if (!compiler) {
    throw new Error(
      `live-proof filesystem safety requires a system C compiler (${candidates.join(' or ')})`,
    );
  }
  return compiler;
}

function boundNativeProofHelperTarget(
  operation: BoundNativeProofFsOperation,
  identity?: ProofHomeIdentity,
): NativeProofHelperTarget {
  const tempRoot = realpathSync(os.tmpdir());
  const tempStats = lstatSync(tempRoot);
  if (!tempStats.isDirectory() || tempStats.isSymbolicLink()) {
    throw new Error(`live-proof real temp root is not a regular directory: ${tempRoot}`);
  }
  if (operation !== 'selftest' && !identity) {
    throw new Error(`live-proof native ${operation} requires an exact proof-home identity`);
  }
  const state = identity?.state;
  return {
    operation,
    tempRoot,
    tempDevice: tempStats.dev,
    tempInode: tempStats.ino,
    homeName: identity ? path.basename(identity.home) : 'clemmy-proof-preflight',
    homeDevice: identity?.homeDevice ?? 0,
    homeInode: identity?.homeInode ?? 0,
    stateDevice: state?.device ?? 0,
    stateInode: state?.inode ?? 0,
    enforceState: Boolean(
      operation === 'sanitize'
      && state
      && identity
      && state.path === path.join(identity.home, 'state')
    ),
  };
}

/** Compile and synchronously execute one operation-bound helper. No binary is
 * cached: source/header paths are removed before dispatch, the containing
 * directory is read/execute-only, and the executable is verified through one
 * continuously-open descriptor immediately before and after spawn. */
function executeBoundNativeProofHelper(input: {
  target: NativeProofHelperTarget;
  stdin?: string;
  operations?: NativeProofHelperExecutionOperations;
  compilerCandidates?: readonly string[];
}): void {
  input.operations?.assertProviderTerminated?.();
  const sourceDigest = createHash('sha256')
    .update(TRUSTED_NATIVE_PROOF_HELPER_SOURCE.bytes)
    .digest('hex');
  if (sourceDigest !== TRUSTED_NATIVE_PROOF_HELPER_SOURCE.sha256) {
    throw new Error('captured live-proof native helper source changed in parent memory');
  }
  const compiler = nativeProofHelperCompiler(
    input.compilerCandidates ?? NATIVE_PROOF_HELPER_COMPILERS,
  );
  const directory = mkdtempSync(path.join(input.target.tempRoot, 'clemmy-native-proof-fs-'));
  chmodSync(directory, 0o700);
  const directoryStats = lstatSync(directory);
  const directoryIdentity: NativeArtifactIdentity = {
    path: directory,
    device: directoryStats.dev,
    inode: directoryStats.ino,
  };
  const source = path.join(directory, 'proof-fs.c');
  const header = path.join(directory, 'proof-bound.h');
  const executable = path.join(directory, 'proof-fs');
  let sourceIdentity: NativeArtifactIdentity | undefined;
  let headerIdentity: NativeArtifactIdentity | undefined;
  let executableIdentity: NativeArtifactIdentity | undefined;
  let executableFd: number | undefined;
  let executionError: unknown;
  try {
    sourceIdentity = writePrivateNativeArtifact(
      source,
      TRUSTED_NATIVE_PROOF_HELPER_SOURCE.bytes,
    );
    headerIdentity = writePrivateNativeArtifact(header, nativeProofHelperHeader(input.target));
    const compiled = spawnSync(compiler, [
      '-std=c11',
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-include',
      header,
      source,
      '-o',
      executable,
    ], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    if (compiled.error || compiled.status !== 0) {
      const detail = compiled.error?.message
        || compiled.stderr.trim()
        || `compiler exited ${compiled.status}`;
      throw new Error(`could not build live-proof native filesystem helper: ${detail}`);
    }
    chmodSync(executable, 0o500);
    const executableStats = lstatSync(executable);
    if (!executableStats.isFile() || executableStats.isSymbolicLink()) {
      throw new Error(`compiled live-proof filesystem helper is not a regular file: ${executable}`);
    }
    executableIdentity = {
      path: executable,
      device: executableStats.dev,
      inode: executableStats.ino,
    };
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    executableFd = openSync(executable, fsConstants.O_RDONLY | noFollow);
    const opened = fstatSync(executableFd);
    const executableSha256 = sha256OpenFile(executableFd, opened.size);

    // The compiler inputs must not remain available to a later provider leg.
    unlinkExactNativeArtifact(sourceIdentity);
    unlinkExactNativeArtifact(headerIdentity);
    sourceIdentity = undefined;
    headerIdentity = undefined;
    chmodSync(directory, 0o500);

    input.operations?.assertProviderTerminated?.();
    input.operations?.beforeNativeHelperDispatch?.(
      executable,
      input.target.operation as NativeProofFsOperation,
    );
    input.operations?.assertProviderTerminated?.();
    assertNativeExecutableBoundToOpenFile({
      directory,
      directoryIdentity,
      executable,
      executableFd,
      executableIdentity,
      expectedSha256: executableSha256,
    });
    const result = spawnSync(executable, [], {
      ...(input.stdin === undefined ? {} : { input: input.stdin }),
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    input.operations?.afterNativeHelperDispatch?.(
      executable,
      input.target.operation as NativeProofFsOperation,
    );
    assertNativeExecutableBoundToOpenFile({
      directory,
      directoryIdentity,
      executable,
      executableFd,
      executableIdentity,
      expectedSha256: executableSha256,
    });
    if (result.error || result.status !== 0) {
      const detail = result.error?.message
        || result.stderr.trim()
        || result.stdout.trim()
        || `native helper exited ${result.status ?? `via ${result.signal ?? 'unknown signal'}`}`;
      throw new Error(`descriptor-anchored proof ${input.target.operation} failed: ${detail}`);
    }
  } catch (error) {
    executionError = error;
  }

  const artifactCleanupErrors: string[] = [];
  if (executableFd !== undefined) {
    try { closeSync(executableFd); } catch (error) { artifactCleanupErrors.push(errorText(error)); }
  }
  try {
    const current = lstatOrNull(directory);
    if (!current?.isDirectory() || current.isSymbolicLink()
      || current.dev !== directoryIdentity.device
      || current.ino !== directoryIdentity.inode) {
      throw new Error(`native helper private directory identity changed before disposal: ${directory}`);
    }
    chmodSync(directory, 0o700);
    if (executableIdentity) unlinkExactNativeArtifact(executableIdentity);
    if (sourceIdentity) unlinkExactNativeArtifact(sourceIdentity);
    if (headerIdentity) unlinkExactNativeArtifact(headerIdentity);
    rmdirSync(directory);
    if (lstatOrNull(directory)) {
      throw new Error(`native helper private directory still exists after disposal: ${directory}`);
    }
  } catch (error) {
    artifactCleanupErrors.push(errorText(error));
  }
  if (executionError || artifactCleanupErrors.length > 0) {
    const details = [
      ...(executionError ? [errorText(executionError)] : []),
      ...artifactCleanupErrors.map((error) => `native helper artifact disposal failed: ${error}`),
    ];
    throw new Error(details.join('; '));
  }
}

/** POSIX/macOS/Linux runtime gate. It runs before proof-home creation and
 * compiles+executes a mutation-free bound selftest, so unsupported platforms,
 * missing compilers, or unusable executable mounts fail before credentials or
 * a provider-capable child exist. */
export function preflightProofRuntimeSafety(
  options: NativeProofHelperPreflightOptions = {},
): void {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new Error(
      `live-proof filesystem safety supports only macOS/Linux POSIX runtimes; ${platform} is unsupported`,
    );
  }
  try {
    executeBoundNativeProofHelper({
      target: boundNativeProofHelperTarget('selftest'),
      compilerCandidates: options.compilerCandidates,
    });
  } catch (error) {
    throw new Error(`live-proof filesystem safety preflight failed: ${errorText(error)}`);
  }
}

/** Execute one closed native operation. The compiled executable has no CLI
 * authority: target path, identities, and the sole allowed operation are all
 * bound into verified bytes after the provider has terminated. */
function runNativeProofFs(
  operation: NativeProofFsOperation,
  identity: ProofHomeIdentity,
  input?: string,
  operations?: NativeProofHelperExecutionOperations,
): void {
  assertExplicitProofHome(identity.home);
  executeBoundNativeProofHelper({
    target: boundNativeProofHelperTarget(operation, identity),
    ...(input === undefined ? {} : { stdin: input }),
    operations,
  });
}

interface ProofStatFs {
  bavail: number | bigint;
  bsize: number | bigint;
}

interface ProofTempCapacityOptions {
  requiredBytes?: number;
  statfs?: (target: string) => ProofStatFs;
}

function formatCapacity(bytes: number): string {
  if (!Number.isFinite(bytes)) return 'an unknown amount of space';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`;
  return `${Math.max(0, Math.floor(bytes / 1024 / 1024))} MiB`;
}

export function proofTempCapacityError(input: {
  tempRoot: string;
  availableBytes: number;
  requiredBytes?: number;
}): string | null {
  const requiredBytes = input.requiredBytes ?? PROOF_MIN_TEMP_FREE_BYTES;
  if (Number.isFinite(input.availableBytes) && input.availableBytes >= requiredBytes) return null;
  return [
    `Live proof refused to start or continue: temporary volume "${input.tempRoot}" has`,
    `${formatCapacity(input.availableBytes)} available; at least ${formatCapacity(requiredBytes)} is required`,
    'for isolated state and retained failure logs.',
    'Free disk space (including stale clemmy-proof-* homes) and rerun.',
  ].join(' ');
}

/** Fail closed at every provider-capable live-proof boundary. */
export function assertProofTempCapacity(
  tempRoot: string,
  options: ProofTempCapacityOptions = {},
): number {
  const inspect = options.statfs ?? ((target: string) => statfsSync(target));
  let stats: ProofStatFs;
  try {
    stats = inspect(tempRoot);
  } catch (error) {
    throw new Error(
      `Live proof refused to start or continue because temp-disk capacity could not be verified for "${tempRoot}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const availableBytes = Number(stats.bavail) * Number(stats.bsize);
  const capacityError = proofTempCapacityError({
    tempRoot,
    availableBytes,
    requiredBytes: options.requiredBytes,
  });
  if (capacityError) throw new Error(capacityError);
  return availableBytes;
}

export function proofForensicReservePath(home: string): string {
  return path.join(home, PROOF_FORENSIC_RESERVE_BASENAME);
}

/** Allocate actual blocks rather than creating a sparse file. The file is
 * closed only after fsync, so unlinking it later creates dependable headroom
 * even when the proof volume has become genuinely full. */
export function createProofForensicReserve(
  home: string,
  sizeBytes = PROOF_FORENSIC_RESERVE_BYTES,
): string {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= PROOF_DAEMON_LOG_MAX_BYTES) {
    throw new Error(`proof forensic reserve must exceed ${PROOF_DAEMON_LOG_MAX_BYTES} bytes`);
  }
  const file = proofForensicReservePath(home);
  const fd = openSync(file, 'wx', 0o600);
  let completed = false;
  try {
    if (process.platform !== 'win32') fchmodSync(fd, 0o600);
    const chunk = Buffer.alloc(Math.min(64 * 1024, sizeBytes), 0xa5);
    let remaining = sizeBytes;
    while (remaining > 0) {
      const length = Math.min(chunk.length, remaining);
      let offset = 0;
      while (offset < length) {
        const written = writeSync(fd, chunk, offset, length - offset);
        if (written <= 0) throw new Error('proof forensic reserve allocation made no progress');
        offset += written;
      }
      remaining -= length;
    }
    fsyncSync(fd);
    completed = true;
  } finally {
    closeSync(fd);
    if (!completed) {
      try { unlinkSync(file); } catch { /* best effort after partial allocation */ }
    }
  }
  return file;
}

/** Release the preallocated blocks before attempting the bounded log write.
 * A missing reserve is a broken safety invariant, not an invitation to try a
 * potentially impossible write and claim retained evidence. */
export function releaseProofForensicReserve(
  home: string,
  identity?: ProofHomeIdentity,
  operations?: NativeProofHelperExecutionOperations,
): string {
  const file = proofForensicReservePath(home);
  const mutationIdentity = proofMutationIdentity(home, identity);
  runNativeProofFs('release', mutationIdentity, undefined, operations);
  operations?.assertProviderTerminated?.();
  assertProofHomeIdentity(mutationIdentity);
  if (lstatOrNull(file)) {
    throw new Error(`proof forensic reserve still exists after successful native release: ${file}`);
  }
  return file;
}

function observedHomeExists(home: string, errors: string[]): boolean {
  try {
    return Boolean(lstatOrNull(home));
  } catch (error) {
    errors.push(`could not verify proof-home disposition for ${home}: ${errorText(error)}`);
    return true;
  }
}

function recordIdentityFailure(identity: ProofHomeIdentity | undefined, errors: string[]): void {
  if (!identity) return;
  try {
    assertProofHomeIdentity(identity);
  } catch (error) {
    errors.push(errorText(error));
  }
}

/** A native exit code is never sufficient cleanup evidence. Once the provider
 * is proven gone, independently inspect every fixed credential node under the
 * still-pinned home/state parents. This makes a no-op or substituted helper a
 * failed sanitation, never a false green. */
function verifySanitizedProofCredentialNodes(
  identity: ProofHomeIdentity,
  operations?: NativeProofHelperExecutionOperations,
): void {
  operations?.assertProviderTerminated?.();
  assertProofHomeIdentity(identity);
  const envPath = path.join(identity.home, '.env');
  if (lstatOrNull(envPath)) {
    throw new Error(`cleanup verification found credential path still present: ${envPath}`);
  }

  const statePath = path.join(identity.home, 'state');
  const state = lstatOrNull(statePath);
  if (!state) return;
  if (state.isSymbolicLink() || !state.isDirectory()) {
    throw new Error(`cleanup verification cannot prove credential absence below unsafe state entry: ${statePath}`);
  }
  if (identity.state
    && (state.dev !== identity.state.device || state.ino !== identity.state.inode)) {
    throw new Error(`cleanup verification found replaced proof state directory: ${statePath}`);
  }
  for (const relative of PROOF_CREDENTIAL_PATHS) {
    if (!relative.startsWith(`state${path.sep}`)) continue;
    const credential = path.join(identity.home, relative);
    if (lstatOrNull(credential)) {
      throw new Error(`cleanup verification found credential path still present: ${credential}`);
    }
  }
  operations?.assertProviderTerminated?.();
}

/** Remove fixed credential nodes from a retained home. The native helper pins
 * temp/home/state descriptors and uses unlinkat, so neither a final symlink nor
 * a swapped intermediate `state` path can redirect a mutation outside home. */
export function sanitizeProofHomeForForensics(
  home: string,
  options: {
    identity?: ProofHomeIdentity;
    operations?: ProofHomeCleanupOperations;
  } = {},
): ProofHomeCleanupResult {
  const errors: string[] = [];
  try {
    assertExplicitProofHome(home);
  } catch (error) {
    return {
      intent: 'sanitize-and-retain',
      status: 'failed',
      homeExists: true,
      errors: [errorText(error)],
    };
  }
  recordIdentityFailure(options.identity, errors);
  let mutationIdentity: ProofHomeIdentity | undefined;
  try {
    mutationIdentity = proofMutationIdentity(home, options.identity);
  } catch (error) {
    errors.push(errorText(error));
  }
  if (mutationIdentity) {
    try {
      options.operations?.beforeNativeCleanup?.(home, 'sanitize-and-retain');
      runNativeProofFs('sanitize', mutationIdentity, undefined, options.operations);
      verifySanitizedProofCredentialNodes(mutationIdentity, options.operations);
    } catch (error) {
      errors.push(`could not sanitize descriptor-anchored proof home ${home}: ${errorText(error)}`);
      errors.push(`cleanup verification found credential paths still present or unverified in ${home}`);
    }
  }
  const homeExists = observedHomeExists(home, errors);
  return {
    intent: 'sanitize-and-retain',
    status: errors.length === 0 ? 'succeeded' : 'failed',
    homeExists,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

/** Remove the exact pinned mkdtemp entry through an open temp-root descriptor.
 * A replacement symlink is unlinked as an entry; recursive traversal is only
 * permitted through directories whose open descriptor matches the pinned inode. */
export function removeProofHome(
  home: string,
  options: {
    identity?: ProofHomeIdentity;
    operations?: ProofHomeCleanupOperations;
  } = {},
): ProofHomeCleanupResult {
  const errors: string[] = [];
  try {
    assertExplicitProofHome(home);
  } catch (error) {
    return { intent: 'remove', status: 'failed', homeExists: true, errors: [errorText(error)] };
  }
  recordIdentityFailure(options.identity, errors);
  let mutationIdentity: ProofHomeIdentity | undefined;
  try {
    mutationIdentity = proofMutationIdentity(home, options.identity);
    options.operations?.beforeNativeCleanup?.(home, 'remove');
    runNativeProofFs('remove', mutationIdentity, undefined, options.operations);
  } catch (error) {
    errors.push(`could not remove descriptor-anchored proof home ${home}: ${errorText(error)}`);
  }
  const homeExists = observedHomeExists(home, errors);
  if (homeExists && !errors.some((error) => error.includes('still present'))) {
    errors.push(`proof home still present after recursive cleanup: ${home}`);
  }
  return {
    intent: 'remove',
    status: errors.length === 0 && !homeExists ? 'succeeded' : 'failed',
    homeExists,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

/** Green/fatal teardown first strips credentials, then removes the exact home.
 * A failed intermediate operation remains visible even if the later removal
 * happened to make the final filesystem state safe. */
export function sanitizeAndRemoveProofHome(
  home: string,
  options: {
    identity?: ProofHomeIdentity;
    operations?: ProofHomeCleanupOperations;
  } = {},
): ProofHomeCleanupResult {
  const sanitized = sanitizeProofHomeForForensics(home, options);
  const removed = removeProofHome(home, options);
  const errors = [...(sanitized.errors ?? []), ...(removed.errors ?? [])];
  return {
    intent: 'remove',
    status: errors.length === 0 && !removed.homeExists ? 'succeeded' : 'failed',
    homeExists: removed.homeExists,
    ...(errors.length > 0 ? { errors: [...new Set(errors)] } : {}),
  };
}

export function proofCleanupFailure(stage: string, result: ProofHomeCleanupResult): string | null {
  if (result.status === 'succeeded') return null;
  return `${stage} cleanup failed (${result.intent}, homeExists=${result.homeExists}): ${(result.errors ?? ['unknown cleanup failure']).join('; ')}`;
}

interface ProofChildPipeState {
  present: boolean;
  eof: boolean;
  closed: boolean;
  error?: string;
}

export interface ProofChildOutputTracker {
  drained: Promise<void>;
  pending(): string[];
  errors(): string[];
}

/** Begin consuming stdout/stderr immediately after spawn and resolve only once
 * the ChildProcess close event and both pipe EOFs have been observed. */
export function trackProofChildOutput(
  child: ChildProcess,
  onChunk: (chunk: Buffer | string) => void,
): ProofChildOutputTracker {
  let childClosed = false;
  const stdout: ProofChildPipeState = {
    present: Boolean(child.stdout),
    eof: !child.stdout,
    closed: !child.stdout,
  };
  const stderr: ProofChildPipeState = {
    present: Boolean(child.stderr),
    eof: !child.stderr,
    closed: !child.stderr,
  };
  let resolveDrained!: () => void;
  const drained = new Promise<void>((resolve) => { resolveDrained = resolve; });
  const maybeResolve = (): void => {
    const stdoutDone = !stdout.present || stdout.eof || stdout.closed;
    const stderrDone = !stderr.present || stderr.eof || stderr.closed;
    if (childClosed && stdoutDone && stderrDone) resolveDrained();
  };
  const wirePipe = (
    stream: NonNullable<ChildProcess['stdout']>,
    state: ProofChildPipeState,
    label: 'stdout' | 'stderr',
  ): void => {
    stream.on('data', onChunk);
    stream.once('end', () => {
      state.eof = true;
      maybeResolve();
    });
    stream.once('close', () => {
      state.closed = true;
      if (!state.eof && !state.error) state.error = `${label} closed before EOF`;
      maybeResolve();
    });
    stream.once('error', (error) => {
      state.error = `${label} read failed: ${error.message}`;
    });
  };
  if (child.stdout) wirePipe(child.stdout, stdout, 'stdout');
  if (child.stderr) wirePipe(child.stderr, stderr, 'stderr');
  child.once('close', () => {
    childClosed = true;
    maybeResolve();
  });
  child.once('error', (error) => {
    if (!childClosed) {
      stdout.error ??= `child process failed: ${error.message}`;
    }
  });
  return {
    drained,
    pending: () => [
      ...(!childClosed ? ['child close'] : []),
      ...(stdout.present && !stdout.eof && !stdout.closed ? ['stdout EOF'] : []),
      ...(stderr.present && !stderr.eof && !stderr.closed ? ['stderr EOF'] : []),
    ],
    errors: () => [stdout.error, stderr.error].filter((value): value is string => Boolean(value)),
  };
}

export async function awaitProofChildOutputDrain(
  tracker: ProofChildOutputTracker,
  timeoutMs = PROOF_CHILD_OUTPUT_DRAIN_TIMEOUT_MS,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const result = await Promise.race([
    tracker.drained.then(() => 'drained' as const),
    timedOut,
  ]);
  if (timer) clearTimeout(timer);
  if (result === 'timeout') {
    throw new Error(
      `daemon output did not close within ${timeoutMs}ms (waiting for ${tracker.pending().join(', ') || 'unknown stream state'})`,
    );
  }
  const errors = tracker.errors();
  if (errors.length > 0) throw new Error(`daemon output was not fully drained: ${errors.join('; ')}`);
}

function collectStrings(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    if (value.length > 0) out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const child of Object.values(value as Record<string, unknown>)) collectStrings(child, out);
}

/** Capture file-backed access material while the isolated credential snapshot
 * still exists. A failed daemon restart sanitizes those files immediately, so
 * the provisioner retains these values in memory for the later log rewrite. */
export function proofCredentialFileRedactions(home: string): string[] {
  const values = new Set<string>();
  try {
    assertExplicitProofHome(home);
    requireRegularDirectory(home, 'proof home');
  } catch {
    return [];
  }

  const safeRegularFileText = (file: string): string | null => {
    let before: ReturnType<typeof lstatSync> | null;
    try {
      before = lstatOrNull(file);
    } catch {
      return null;
    }
    if (!before || before.isSymbolicLink() || !before.isFile()
      || before.size < 0 || before.size > PROOF_CREDENTIAL_FILE_MAX_BYTES) return null;
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    let fd: number | undefined;
    try {
      fd = openSync(file, fsConstants.O_RDONLY | noFollow);
      const opened = fstatSync(fd);
      if (!opened.isFile()
        || opened.dev !== before.dev
        || opened.ino !== before.ino
        || opened.size < 0
        || opened.size > PROOF_CREDENTIAL_FILE_MAX_BYTES) return null;
      const bytes = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (count <= 0) return null;
        offset += count;
      }
      return bytes.toString('utf8');
    } catch {
      return null;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };

  // Refuse a replaced state parent before inspecting any nested path. lstat on
  // only the final filename would still follow an intermediate state symlink.
  const statePath = path.join(home, 'state');
  let stateIsSafe = false;
  try {
    const state = lstatOrNull(statePath);
    stateIsSafe = Boolean(state?.isDirectory() && !state.isSymbolicLink());
  } catch { stateIsSafe = false; }
  if (stateIsSafe) {
    for (const relative of PROOF_CREDENTIAL_PATHS.filter((entry) => entry.startsWith(`state${path.sep}`))) {
      const raw = safeRegularFileText(path.join(home, relative));
      if (!raw) continue;
      try { collectStrings(JSON.parse(raw), values); } catch { /* malformed credential file is never retained */ }
    }
  }

  const envRaw = safeRegularFileText(path.join(home, '.env'));
  if (envRaw) {
    for (const line of envRaw.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*?)\s*$/.exec(line);
      if (!match) continue;
      const raw = match[1] ?? '';
      const value = ((raw.startsWith('"') && raw.endsWith('"'))
        || (raw.startsWith("'") && raw.endsWith("'")))
        ? raw.slice(1, -1)
        : raw;
      if (value.length > 0) values.add(value);
    }
  }
  return [...values];
}

function proofLogRedactionSentinel(exactSecrets: readonly string[]): string {
  const used = new Set<string>();
  for (const secret of exactSecrets.filter((value) => value.length > 0)) {
    for (const character of secret) used.add(character);
  }
  for (const candidate of ['█', '▓', '▒', '░']) {
    if (!used.has(candidate)) return candidate;
  }
  for (let codePoint = 0xe000; codePoint <= 0x10fffd; codePoint += 1) {
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
    const candidate = String.fromCodePoint(codePoint);
    if (!used.has(candidate)) return candidate;
  }
  throw new Error('proof daemon log redaction could not choose a secret-disjoint sentinel');
}

function redactCompleteProofDaemonLog(log: string, exactSecrets: readonly string[]): string {
  const sentinel = proofLogRedactionSentinel(exactSecrets);
  let redacted = log;
  const values = [...new Set(exactSecrets.filter((value) => value.length > 0))]
    .sort((a, b) => b.length - a.length);
  for (const value of values) redacted = redacted.split(value).join(sentinel);
  for (const value of values) {
    redacted = redactObservedSecretPrefixes(redacted, value, sentinel);
  }
  return redacted
    // Match partial token suffixes too. A process can exit while a final log
    // write is in flight; retaining "Bearer abc" or "sk-ant-oat" is still an
    // avoidable credential fragment even though it is shorter than a token.
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, sentinel)
    .replace(/\bsk-ant-[A-Za-z0-9_-]+/g, sentinel);
}

/** Mask every observed prefix of one exact secret, not only an EOF suffix. A
 * process can exit halfway through logging a credential and a restart marker
 * can later internalize those bytes in the cross-restart forensic ring. The
 * first code point may be common, so this intentionally over-redacts: retained
 * proof diagnostics lose readability before they retain credential fragments. */
function redactObservedSecretPrefixes(
  log: string,
  secret: string,
  sentinel: string,
): string {
  const characters = [...secret];
  const first = characters[0];
  if (!first) return log;
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < log.length) {
    const start = log.indexOf(first, cursor);
    if (start < 0) break;
    parts.push(log.slice(cursor, start), sentinel);
    let end = start + first.length;
    for (let index = 1; index < characters.length; index += 1) {
      const character = characters[index]!;
      if (!log.startsWith(character, end)) break;
      end += character.length;
    }
    cursor = end;
  }
  if (cursor === 0) return log;
  parts.push(log.slice(cursor));
  return parts.join('');
}

export function redactProofDaemonLog(log: string, exactSecrets: readonly string[]): string {
  return redactCompleteProofDaemonLog(log, exactSecrets);
}

function boundedLogTail(log: string, maxBytes: number): string {
  const bytes = Buffer.from(log, 'utf8');
  if (bytes.length <= maxBytes) return log;
  const marker = Buffer.from(`[proof] daemon log truncated to final ${maxBytes} bytes\n`, 'utf8');
  const tailBytes = Math.max(0, maxBytes - marker.length);
  let tailOffset = bytes.length - tailBytes;
  while (tailOffset <= bytes.length) {
    const bounded = `${marker.toString('utf8')}${bytes.subarray(tailOffset).toString('utf8')}`;
    const overflow = Buffer.byteLength(bounded, 'utf8') - maxBytes;
    if (overflow <= 0) return bounded;
    // A byte tail can begin inside a multi-byte code point. Drop only the
    // leading malformed bytes rather than letting U+FFFD push the file beyond
    // its promised bound.
    tailOffset += Math.max(1, overflow);
  }
  return marker.subarray(0, maxBytes).toString('utf8');
}

function verifyProofDaemonLogFile(
  home: string,
  file: string,
  expected?: { device: number; inode: number },
): void {
  assertExplicitProofHome(home);
  if (path.dirname(file) !== home || path.basename(file) !== PROOF_DAEMON_LOG_BASENAME) {
    throw new Error(`proof daemon log escaped its exact in-home destination: ${file}`);
  }
  const stats = lstatOrNull(file);
  if (!stats || stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`proof daemon log is not an in-home regular file: ${file}`);
  }
  if (expected && (stats.dev !== expected.device || stats.ino !== expected.inode)) {
    throw new Error(`proof daemon log identity changed during persistence: ${file}`);
  }
}

export interface ProofDaemonLogPersistenceOperations {
  /** Hooks may trigger deterministic races or injected failures, but all
   * release/write authority remains inside the descriptor-anchored helper. */
  beforeReleaseReserve?: (home: string) => void;
  beforeWriteLog?: (file: string) => void;
  assertProviderTerminated?: () => void;
  beforeNativeHelperDispatch?: (executable: string, operation: NativeProofFsOperation) => void;
  afterNativeHelperDispatch?: (executable: string, operation: NativeProofFsOperation) => void;
}

/** Persist a bounded, credential-redacted stdout/stderr transcript in a home
 * that the runner has already decided to retain for forensics. */
export function persistProofDaemonLogForForensics(input: {
  home: string;
  log: string;
  exactSecrets?: readonly string[];
  maxBytes?: number;
  operations?: ProofDaemonLogPersistenceOperations;
  identity?: ProofHomeIdentity;
}): string {
  const maxBytes = input.maxBytes ?? PROOF_DAEMON_LOG_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > PROOF_DAEMON_LOG_MAX_BYTES) {
    throw new Error(`proof daemon log bound must be between 1 and ${PROOF_DAEMON_LOG_MAX_BYTES} bytes`);
  }
  assertExplicitProofHome(input.home);
  const identity = input.identity ?? captureProofHomeIdentity(input.home);
  assertProofHomeIdentity(identity);
  // This ordering is the ENOSPC recovery mechanism: reclaim already-fsynced
  // blocks before allocating even one byte for the retained transcript.
  input.operations?.beforeReleaseReserve?.(input.home);
  releaseProofForensicReserve(input.home, identity, input.operations);
  assertProofHomeIdentity(identity);
  // Credential values are captured before the first spawn. Never read a
  // workload-mutated credential path during stop/log persistence.
  const exactSecrets = input.exactSecrets ?? [];
  const safeLog = redactProofDaemonLog(input.log, exactSecrets);
  const bounded = boundedLogTail(safeLog, maxBytes);
  // boundedLogTail adds a human-readable marker after redaction. Re-scrub the
  // final bounded bytes so even a credential equal to marker prose is absent.
  // A collision-resistant sentinel can occupy more UTF-8 bytes than the text
  // it replaces, so enforce the exact byte cap once more without adding prose.
  const safeBounded = recappedRedactedTail(
    redactProofDaemonLog(bounded, exactSecrets),
    maxBytes,
  );
  const file = path.join(input.home, PROOF_DAEMON_LOG_BASENAME);
  input.operations?.beforeWriteLog?.(file);
  runNativeProofFs('write-log', identity, safeBounded, input.operations);
  verifyProofDaemonLogFile(input.home, file);
  return file;
}

/** Convert shutdown/log persistence into report-wide evidence without making
 * the runner throw away scenario results it already collected. */
export function proofDaemonStopChecks(brain: string, result: DaemonStopResult): Check[] {
  const checks: Check[] = [];
  if (result.shutdownError) {
    checks.push({
      name: `${brain} daemon output closed before proof teardown`,
      pass: false,
      detail: result.shutdownError,
    });
  }
  if (result.logCapture || result.logCaptureError) {
    const evidence = result.logCapture;
    const bounded = Boolean(evidence && !evidence.overflowed && !result.logCaptureError);
    checks.push({
      name: `${brain} daemon output capture stayed inside its semantic memory bound`,
      pass: bounded,
      detail: evidence
        ? [
            `total=${evidence.totalBytes}`,
            `forensic=${evidence.forensicStoredBytes}/${evidence.forensicMaxBytes}`,
            `forensicDropped=${evidence.forensicDroppedBytes}`,
            `forensicRaw=${evidence.forensicRawStoredBytes}/${evidence.forensicRawMaxBytes}`,
            `forensicRawDropped=${evidence.forensicRawDroppedBytes}`,
            `redactionOverlap=${evidence.forensicRedactionOverlapBytes}`,
            `scenario=${evidence.currentScenarioStoredBytes}/${evidence.scenarioMaxBytes}`,
            `currentScenarioBytes=${evidence.currentScenarioBytes}`,
            `scenarioDropped=${evidence.scenarioDroppedBytes}`,
            `overflowPeriods=${evidence.overflowPeriods}`,
            ...(result.logCaptureError ? [result.logCaptureError] : []),
          ].join(', ')
        : result.logCaptureError ?? 'bounded daemon log capture evidence is missing',
    });
  }
  if (result.retainedHome) {
    checks.push({
      name: `${brain} retained daemon log persisted`,
      pass: result.forensicLog.status === 'persisted',
      detail: result.forensicLog.status === 'persisted'
        ? result.forensicLog.path
        : result.forensicLog.error ?? 'retained log persistence did not complete',
    });
  }
  const cleanupDispositionMatchesIntent = result.cleanup.intent === 'remove'
    ? !result.cleanup.homeExists
    : result.cleanup.homeExists;
  const cleanupIntentMatchesStop = result.retainedHome
    ? result.cleanup.intent === 'sanitize-and-retain'
    : result.cleanup.intent === 'remove';
  if (result.cleanup.status !== 'succeeded'
    || !cleanupDispositionMatchesIntent
    || !cleanupIntentMatchesStop) {
    checks.push({
      name: `${brain} proof-home cleanup completed and was verified`,
      pass: false,
      detail: [
        `intent=${result.cleanup.intent}`,
        `homeExists=${result.cleanup.homeExists}`,
        ...(result.cleanup.errors ?? []),
      ].join('; '),
    });
  }
  return checks;
}
