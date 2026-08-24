import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../../config.js';

export const LEGACY_COMPOSIO_JOB_DIR = path.join(BASE_DIR, 'state', 'composio-jobs');
export const LEGACY_COMPOSIO_JOB_QUARANTINE_DIR = path.join(
  BASE_DIR,
  'state',
  'composio-jobs-quarantine',
);

const MAX_LEGACY_RECORD_BYTES = 64 * 1024;
const SAFE_RECORD_NAME = /^[A-Za-z0-9._-]+\.json$/;
const NO_FOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;

export interface LegacyComposioJobHints {
  family?: string;
  jobId?: string;
  datasetId?: string;
  actorId?: string;
  getterSlug?: string;
  getterIdArg?: string;
  toolSlug?: string;
  connectionId?: string;
  originSessionId?: string;
  taskId?: string;
}

interface SourceFingerprint {
  dev: number;
  ino: number;
  size: number;
  mode: number;
  nlink: number;
  kind: 'regular' | 'symlink' | 'other';
}

export interface LegacyComposioJobSnapshot {
  fileName: string;
  filePath: string;
  digest: string;
  hints: LegacyComposioJobHints;
  omittedHintFields: string[];
  legacyCreatedAt?: string;
  legacyDeadlineAt?: string;
  source: SourceFingerprint;
  parseError?: string;
}

const SAFE_HINT_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-=]*$/;

function safeHintToken(value: unknown, max = 500): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.trim();
  if (!clean || clean.length > max || !SAFE_HINT_TOKEN.test(clean)) return undefined;
  return clean;
}

function safeIso(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d\d-\d\dT/.test(value)) return undefined;
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

function parseHints(raw: string): {
  hints: LegacyComposioJobHints;
  omittedHintFields: string[];
  legacyCreatedAt?: string;
  legacyDeadlineAt?: string;
  parseError?: string;
} {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { hints: {}, omittedHintFields: [], parseError: 'not_json_object' };
    }
    const row = parsed as Record<string, unknown>;
    const fields = {
      family: safeHintToken(row.family, 100),
      jobId: safeHintToken(row.jobId),
      datasetId: safeHintToken(row.datasetId),
      actorId: safeHintToken(row.actorId),
      getterSlug: safeHintToken(row.getterSlug),
      getterIdArg: safeHintToken(row.getterIdArg, 100),
      toolSlug: safeHintToken(row.toolSlug),
      connectionId: safeHintToken(row.connectionId),
      originSessionId: safeHintToken(row.originSessionId),
      taskId: safeHintToken(row.taskId, 200),
    } satisfies LegacyComposioJobHints;
    const omittedHintFields = Object.entries(fields)
      .filter(([field, value]) => {
        const raw = row[field];
        const supplied = typeof raw === 'string' ? raw.trim().length > 0 : raw != null;
        return supplied && value === undefined;
      })
      .map(([field]) => field)
      .sort();
    return {
      hints: fields,
      omittedHintFields,
      ...(safeIso(row.createdAt) ? { legacyCreatedAt: safeIso(row.createdAt) } : {}),
      ...(safeIso(row.deadlineAt) ? { legacyDeadlineAt: safeIso(row.deadlineAt) } : {}),
    };
  } catch {
    return {
      hints: {},
      omittedHintFields: [],
      parseError: 'invalid_json',
    };
  }
}

function fingerprint(stat: Stats): SourceFingerprint {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mode: stat.mode,
    nlink: stat.nlink,
    kind: stat.isFile() ? 'regular' : stat.isSymbolicLink() ? 'symlink' : 'other',
  };
}

function unsafeDigest(fileName: string, source: SourceFingerprint, reason: string): string {
  return createHash('sha256').update(JSON.stringify({
    version: 1,
    fileName,
    source,
    reason,
  }), 'utf8').digest('hex');
}

function unsafeSnapshot(
  fileName: string,
  filePath: string,
  source: SourceFingerprint,
  reason: string,
): LegacyComposioJobSnapshot {
  return {
    fileName,
    filePath,
    digest: unsafeDigest(fileName, source, reason),
    hints: {},
    omittedHintFields: [],
    source,
    parseError: reason,
  };
}

function readBoundedUtf8(fd: number, maxBytes: number): string {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset <= maxBytes) {
    const read = readSync(fd, buffer, offset, buffer.length - offset, null);
    if (read === 0) break;
    offset += read;
    if (offset > maxBytes) throw new Error(`record exceeds the ${maxBytes}-byte containment limit`);
  }
  return buffer.subarray(0, offset).toString('utf8');
}

function readSnapshot(fileName: string): LegacyComposioJobSnapshot {
  const filePath = path.join(LEGACY_COMPOSIO_JOB_DIR, fileName);
  const beforeStat = lstatSync(filePath);
  const before = fingerprint(beforeStat);
  if (!SAFE_RECORD_NAME.test(fileName)) {
    return unsafeSnapshot(fileName, filePath, before, 'record filename is outside the legacy safe-name contract');
  }
  if (before.kind !== 'regular') {
    return unsafeSnapshot(fileName, filePath, before, `record is an unsafe ${before.kind}, not a regular file`);
  }
  if (before.nlink !== 1) {
    return unsafeSnapshot(fileName, filePath, before, 'record has multiple hard links');
  }
  if (before.size > MAX_LEGACY_RECORD_BYTES) {
    return unsafeSnapshot(
      fileName,
      filePath,
      before,
      `record exceeds the ${MAX_LEGACY_RECORD_BYTES}-byte containment limit`,
    );
  }

  let fd: number | undefined;
  try {
    fd = openSync(filePath, constants.O_RDONLY | NO_FOLLOW);
    const opened = fstatSync(fd);
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.size > MAX_LEGACY_RECORD_BYTES
    ) {
      throw new Error('record changed identity while it was opened');
    }
    const raw = readBoundedUtf8(fd, MAX_LEGACY_RECORD_BYTES);
    const parsed = parseHints(raw);
    return {
      fileName,
      filePath,
      digest: createHash('sha256').update(raw, 'utf8').digest('hex'),
      hints: parsed.hints,
      omittedHintFields: parsed.omittedHintFields,
      ...(parsed.legacyCreatedAt ? { legacyCreatedAt: parsed.legacyCreatedAt } : {}),
      ...(parsed.legacyDeadlineAt ? { legacyDeadlineAt: parsed.legacyDeadlineAt } : {}),
      source: before,
      ...(parsed.parseError ? { parseError: parsed.parseError } : {}),
    };
  } catch {
    return unsafeSnapshot(fileName, filePath, before, 'safe_read_failed');
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* readiness migration will still verify before deletion */ }
    }
  }
}

export function listLegacyComposioJobSnapshots(): LegacyComposioJobSnapshot[] {
  if (!existsSync(LEGACY_COMPOSIO_JOB_DIR)) return [];
  const activeDir = lstatSync(LEGACY_COMPOSIO_JOB_DIR);
  if (!activeDir.isDirectory() || activeDir.isSymbolicLink()) {
    throw new Error('legacy Composio active-record path is not a regular directory');
  }
  return readdirSync(LEGACY_COMPOSIO_JOB_DIR)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map(readSnapshot);
}

/**
 * Structural background-task fence. It knows only that an old durable owner
 * still names this task; the Composio-specific migration remains in the record
 * owner. Until that owner quarantines the record, Resume and pending->running
 * must not create a second executor.
 */
export function hasActiveLegacyComposioJobForTask(taskId: string): boolean {
  if (!taskId || !existsSync(LEGACY_COMPOSIO_JOB_DIR)) return false;
  try {
    return listLegacyComposioJobSnapshots().some((snapshot) => snapshot.hints.taskId === taskId);
  } catch {
    // An unreadable active directory is not proof that this task is unbound.
    // Boot migration treats the same read failure as a readiness failure.
    return true;
  }
}

function fsyncDir(dir: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(dir, constants.O_RDONLY | NO_FOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function ensurePrivateQuarantineDir(): void {
  mkdirSync(LEGACY_COMPOSIO_JOB_QUARANTINE_DIR, { recursive: true, mode: 0o700 });
  const before = lstatSync(LEGACY_COMPOSIO_JOB_QUARANTINE_DIR);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error('legacy Composio quarantine path is not a private regular directory');
  }
  const fd = openSync(LEGACY_COMPOSIO_JOB_QUARANTINE_DIR, constants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isDirectory()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
    ) {
      throw new Error('legacy Composio quarantine directory changed while opening');
    }
    fchmodSync(fd, 0o700);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function canonicalQuarantineBytes(snapshot: LegacyComposioJobSnapshot): string {
  return `${JSON.stringify({
    version: 1,
    disposition: 'hidden_provider_io_disabled',
    sourceFile: SAFE_RECORD_NAME.test(snapshot.fileName) ? snapshot.fileName : 'unsafe-record-name.json',
    sourceDigest: snapshot.digest,
    hints: snapshot.hints,
    ...(snapshot.omittedHintFields.length > 0
      ? { omittedHintFields: snapshot.omittedHintFields }
      : {}),
    ...(snapshot.parseError ? { parseError: snapshot.parseError } : {}),
  }, null, 2)}\n`;
}

function readExistingQuarantine(target: string, maxBytes: number): string {
  const before = lstatSync(target);
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || before.size > maxBytes
    || (before.mode & 0o777) !== 0o600
  ) {
    throw new Error(`legacy Composio quarantine target is unsafe: ${path.basename(target)}`);
  }
  let fd: number | undefined;
  try {
    fd = openSync(target, constants.O_RDONLY | NO_FOLLOW);
    const opened = fstatSync(fd);
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.size > maxBytes
    ) {
      throw new Error(`legacy Composio quarantine target changed while opening: ${path.basename(target)}`);
    }
    return readBoundedUtf8(fd, maxBytes);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function sourceStillMatches(snapshot: LegacyComposioJobSnapshot): boolean {
  try {
    const current = fingerprint(lstatSync(snapshot.filePath));
    return current.dev === snapshot.source.dev
      && current.ino === snapshot.source.ino
      && current.size === snapshot.source.size
      && current.mode === snapshot.source.mode
      && current.nlink === snapshot.source.nlink
      && current.kind === snapshot.source.kind;
  } catch {
    return false;
  }
}

/**
 * Persist only canonical bounded hints and the source digest. Arbitrary legacy
 * bytes may contain unexpected secrets and are deliberately not retained.
 */
export function quarantineLegacyComposioJobSnapshot(snapshot: LegacyComposioJobSnapshot): string {
  ensurePrivateQuarantineDir();
  const stem = snapshot.fileName.replace(/\.json$/i, '').replace(/[^A-Za-z0-9._-]/g, '_') || 'record';
  const target = path.join(
    LEGACY_COMPOSIO_JOB_QUARANTINE_DIR,
    `${stem}.${snapshot.digest.slice(0, 20)}.json`,
  );
  const canonical = canonicalQuarantineBytes(snapshot);
  let fd: number | undefined;
  try {
    fd = openSync(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    writeFileSync(fd, canonical, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve the original error */ }
      try { unlinkSync(target); } catch { /* a later boot refuses an unsafe collision */ }
    }
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = readExistingQuarantine(target, Buffer.byteLength(canonical, 'utf8') + 1);
    if (existing !== canonical) {
      throw new Error(`legacy Composio quarantine collision for ${snapshot.fileName}`);
    }
  }
  fsyncDir(LEGACY_COMPOSIO_JOB_QUARANTINE_DIR);

  if (!sourceStillMatches(snapshot)) {
    throw new Error(`legacy Composio source changed before quarantine commit: ${snapshot.fileName}`);
  }
  unlinkSync(snapshot.filePath);
  fsyncDir(LEGACY_COMPOSIO_JOB_DIR);
  return target;
}
