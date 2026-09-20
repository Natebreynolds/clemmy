import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync,
  mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../../config.js';
import { withFileLockSyncStrict } from '../atomic-json.js';
import { LocalFileCreateConflict } from './local-file-create-conflict.js';
import type { CommittedArtifactContent, HostLocalWriteCommitFacts } from './host-local-write-commit.js';

const PREFIX = 'state/local-file-revisions/';
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export class LocalFileRevisionConflict extends Error {}

/** Resolve existing parent aliases without creating anything. The caller must
 * check this canonical target against its existing path policy before writing. */
export function canonicalLocalFileTarget(input: string): string {
  const resolved = path.resolve(input);
  let parent = path.dirname(resolved);
  const missing: string[] = [path.basename(resolved)];
  while (!existsSync(parent)) {
    missing.unshift(path.basename(parent));
    const next = path.dirname(parent);
    if (next === parent) throw new Error('No existing parent for local file.');
    parent = next;
  }
  return path.join(realpathSync(parent), ...missing);
}

function readDirectFile(target: string): { bytes: Buffer; mode: number } {
  const before = lstatSync(target);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Local file target must be a direct regular file.');
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    const bytes = readFileSync(fd);
    const after = lstatSync(target);
    const afterFd = fstatSync(fd);
    if (realpathSync(target) !== target || !opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || after.dev !== opened.dev || after.ino !== opened.ino || after.isSymbolicLink()
      || afterFd.size !== bytes.length || opened.size !== afterFd.size
      || opened.mtimeMs !== afterFd.mtimeMs || opened.ctimeMs !== afterFd.ctimeMs) {
      throw new Error('Local file changed during read.');
    }
    return { bytes, mode: opened.mode & 0o777 };
  } finally { closeSync(fd); }
}

function syncDirectory(dir: string): void {
  // Node cannot open directory handles for fsync on Windows. File data is
  // still flushed before publication; directory-entry flushing is POSIX-only.
  if (process.platform === 'win32') return;
  const fd = openSync(dir, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeDurable(file: string, bytes: Buffer, mode: number, exclusive = false): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, 'wx', mode);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    // create must never race into overwriting another writer's new file.
    if (exclusive) { linkSync(temp, file); unlinkSync(temp); }
    else renameSync(temp, file);
    syncDirectory(path.dirname(file));
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}

type Revision = {
  version: 1;
  kind: 'local_file_revision_v1';
  createdId: string;
  revisionId: string;
  target: string;
  contentDigest: string;
  bytes: number;
  previous: { handle: string; contentDigest: string; bytes: number; mode: number } | null;
  operation?: { key: string; requestDigest: string; previousRevisionDigest: string | null };
};

/** One registered file-tool execution: retain the exact previous bytes before
 * touching the target, replace atomically, then publish a stable receipt handle.
 * The prepared journal and prior bytes remain recoverable if publication fails
 * after the target changed. Errors propagate; they never claim no effect. */
type LocalFileRevisionInput = {
  target: string;
  content: string;
  mode: 'create' | 'append' | 'overwrite';
  expectedContentDigest?: string;
  /** Host-owned occurrence identity, never a model-supplied write argument. */
  operationKey?: string;
};
type LocalFileRevisionResult = { createdId: string; committedPath: string; previousPath: string | null; unchanged: boolean };

export function commitLocalFileRevision(input: LocalFileRevisionInput): LocalFileRevisionResult {
  return applyLocalFileRevision(input, false);
}

/** Recover only an already-recorded host occurrence. Missing or inconclusive
 * evidence refuses before any target mutation; this is never a write retry. */
export function recoverLocalFileRevision(
  input: LocalFileRevisionInput & { operationKey: string },
): LocalFileRevisionResult {
  if (!input.operationKey) throw new LocalFileRevisionConflict('File recovery requires an operation identity.');
  return applyLocalFileRevision(input, true);
}

function applyLocalFileRevision(input: LocalFileRevisionInput, recoveryOnly: boolean): LocalFileRevisionResult {
  const target = canonicalLocalFileTarget(input.target);
  const key = digest(target);
  const createdId = `file-${key}`;
  const root = realpathSync(BASE_DIR);
  const dir = path.join(root, PREFIX, key);
  if (recoveryOnly && !existsSync(dir)) {
    throw new LocalFileRevisionConflict('No recorded file operation exists for recovery.');
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Never follow a replaced receipt directory outside the protected store.
  if (realpathSync(dir) !== dir) throw new Error('Local file revision directory changed.');
  const current = path.join(dir, 'current.json');
  return withFileLockSyncStrict(current, () => {
    const requestDigest = digest(JSON.stringify({ target, content: input.content,
      mode: input.mode, expectedContentDigest: input.expectedContentDigest ?? null }));
    const operationFile = input.operationKey
      ? path.join(dir, `operation-${digest(input.operationKey)}.json`) : null;
    if (operationFile && existsSync(operationFile)) {
      const encoded = readDirectFile(operationFile).bytes;
      const saved = JSON.parse(encoded.toString('utf8')) as Revision;
      if (saved.version !== 1 || saved.kind !== 'local_file_revision_v1'
        || saved.target !== target || saved.createdId !== createdId
        || !/^[a-f0-9-]{36}$/.test(saved.revisionId)
        || !saved.operation || saved.operation.key !== input.operationKey
        || saved.operation.requestDigest !== requestDigest
        || !readDirectFile(path.join(dir, `${saved.revisionId}.prepared.json`)).bytes.equals(encoded)) {
        throw new LocalFileRevisionConflict('The recorded file operation does not match this request. No file content was changed.');
      }
      const currentBytes = existsSync(current) ? readDirectFile(current).bytes : null;
      const priorDescriptorMatches = (currentBytes ? digest(currentBytes) : null)
        === saved.operation.previousRevisionDigest;
      if ((!currentBytes?.equals(encoded) && !priorDescriptorMatches)
        || !existsSync(target) || digest(readDirectFile(target).bytes) !== saved.contentDigest) {
        throw new LocalFileRevisionConflict('The recorded file operation cannot be recovered from the current bytes. No file content was changed.');
      }
      // The mutation landed but current.json may not have been published.
      // Recover only its receipt; never append or replace target bytes again.
      if (!currentBytes?.equals(encoded)) writeDurable(current, encoded, 0o600);
      return { createdId, committedPath: current,
        previousPath: saved.previous ? path.join(dir, `${saved.revisionId}.before`) : null,
        unchanged: true };
    }
    if (recoveryOnly) {
      throw new LocalFileRevisionConflict('No matching recorded file operation exists for recovery.');
    }
    const prior = existsSync(target) ? readDirectFile(target) : null;
    if (input.expectedContentDigest !== undefined
      && (!prior || digest(prior.bytes) !== input.expectedContentDigest)) {
      throw new LocalFileRevisionConflict('The local file changed since this request wrote it. Re-read it and reconcile the intervening edit before replacing it. No file content was changed.');
    }
    if (input.mode === 'create' && prior) throw new LocalFileCreateConflict(`Refused to overwrite existing file: ${target}. Use mode="append" or mode="overwrite" for a requested revision.`);
    const content = input.content.endsWith('\n') ? input.content : `${input.content}\n`;
    const bytes = input.mode === 'append' && prior
      ? Buffer.concat([prior.bytes, Buffer.from(prior.bytes.length && prior.bytes.at(-1) !== 10 ? '\n' : ''), Buffer.from(content)])
      : Buffer.from(content);
    const revisionId = randomUUID();
    const previousPath = prior ? path.join(dir, `${revisionId}.before`) : null;
    if (prior && previousPath) writeDurable(previousPath, prior.bytes, 0o600, true);
    const revision: Revision = { version: 1, kind: 'local_file_revision_v1', createdId, revisionId, target,
      contentDigest: digest(bytes), bytes: bytes.length,
      ...(input.operationKey ? { operation: { key: input.operationKey, requestDigest,
        previousRevisionDigest: existsSync(current) ? digest(readDirectFile(current).bytes) : null } } : {}),
      previous: prior && previousPath ? { handle: path.relative(root, previousPath).split(path.sep).join('/'),
        contentDigest: digest(prior.bytes), bytes: prior.bytes.length, mode: prior.mode } : null };
    const encoded = Buffer.from(JSON.stringify(revision));
    writeDurable(path.join(dir, `${revisionId}.prepared.json`), encoded, 0o600, true);
    if (operationFile) writeDurable(operationFile, encoded, 0o600, true);
    mkdirSync(path.dirname(target), { recursive: true });
    if (canonicalLocalFileTarget(target) !== target) throw new Error('Local file parent changed before write.');
    // Detect an intervening editor instead of replacing unobserved bytes.
    const now = existsSync(target) ? readDirectFile(target) : null;
    if (Boolean(now) !== Boolean(prior) || (now && prior && !now.bytes.equals(prior.bytes))) {
      throw new Error('Local file changed before write; re-read it before applying the revision.');
    }
    const unchanged = Boolean(prior?.bytes.equals(bytes));
    if (!unchanged) writeDurable(target, bytes, prior?.mode ?? (0o666 & ~process.umask()), !prior);
    const committed = readDirectFile(target);
    if (!committed.bytes.equals(bytes)) throw new Error('Local file changed before its receipt could be published.');
    writeDurable(current, encoded, 0o600);
    return { createdId, committedPath: current, previousPath, unchanged };
  });
}

export function isLocalFileRevisionHandle(handle: string): boolean {
  return /^state\/local-file-revisions\/[a-f0-9]{64}\/current\.json$/.test(handle);
}

/** Verify historical replacement from immutable descriptors and retained prior
 * bytes. This proves lineage, never that the latest target is still current;
 * the ordinary receipt reader must independently verify that at publication. */
export function localFileRevisionReplaces(input: {
  prior: HostLocalWriteCommitFacts; next: HostLocalWriteCommitFacts;
  target: string; expectedContentDigest: string; content: string;
}): boolean {
  try {
    if (!isLocalFileRevisionHandle(input.prior.handle) || input.prior.handle !== input.next.handle
      || input.prior.createdId !== input.next.createdId) return false;
    const root = realpathSync(BASE_DIR);
    const dir = path.dirname(path.join(root, input.next.handle));
    if (realpathSync(dir) !== dir) return false;
    const descriptors = readdirSync(dir).filter(name => /^[a-f0-9-]{36}\.prepared\.json$/.test(name));
    const find = (facts: HostLocalWriteCommitFacts): Revision | undefined => {
      for (const name of descriptors) {
        const bytes = readDirectFile(path.join(dir, name)).bytes;
        if (digest(bytes) !== facts.contentDigest) continue;
        const value = JSON.parse(bytes.toString('utf8')) as Revision;
        if (value.version !== 1 || value.kind !== 'local_file_revision_v1'
          || value.revisionId !== name.slice(0, -'.prepared.json'.length)
          || value.target !== input.target || value.createdId !== facts.createdId
          || value.createdId !== `file-${digest(input.target)}`
          || facts.handle !== `${PREFIX}${digest(input.target)}/current.json`) return undefined;
        return value;
      }
      return undefined;
    };
    const prior = find(input.prior), next = find(input.next);
    if (!prior || !next || prior.revisionId === next.revisionId || !next.previous) return false;
    const expectedPriorHandle = `${PREFIX}${digest(input.target)}/${next.revisionId}.before`;
    const content = Buffer.from(input.content.endsWith('\n') ? input.content : `${input.content}\n`);
    return next.previous.handle === expectedPriorHandle
      && prior.contentDigest === input.expectedContentDigest
      && next.previous.contentDigest === prior.contentDigest && next.previous.bytes === prior.bytes
      && digest(readDirectFile(path.join(root, expectedPriorHandle)).bytes) === prior.contentDigest
      && next.contentDigest === digest(content) && next.bytes === content.length;
  } catch { return false; }
}

/** Called only after the ordinary safe in-root reader verified the descriptor
 * bytes against the host receipt. The descriptor binds one canonical target;
 * no generic root expansion or caller-supplied path is accepted here. */
export function readLocalFileRevisionContent(facts: HostLocalWriteCommitFacts, descriptorBytes: Buffer): CommittedArtifactContent {
  try {
    const revision = JSON.parse(descriptorBytes.toString('utf8')) as Revision;
    if (!isLocalFileRevisionHandle(facts.handle) || digest(descriptorBytes) !== facts.contentDigest
      || revision.version !== 1 || revision.kind !== 'local_file_revision_v1'
      || typeof revision.target !== 'string' || !path.isAbsolute(revision.target)
      || canonicalLocalFileTarget(revision.target) !== revision.target
      || revision.createdId !== facts.createdId || revision.createdId !== `file-${digest(revision.target)}`
      || facts.handle !== `${PREFIX}${digest(revision.target)}/current.json`
      || !/^[a-f0-9]{64}$/.test(revision.contentDigest) || !Number.isSafeInteger(revision.bytes) || revision.bytes < 0) {
      throw new Error('Invalid local file revision descriptor.');
    }
    const current = readDirectFile(revision.target);
    const verified = current.bytes.length === revision.bytes && digest(current.bytes) === revision.contentDigest;
    return { parts: [{ handle: revision.target, bytes: current.bytes, role: 'file' }],
      totalBytes: current.bytes.length, verified,
      ...(verified ? {} : { unresolvedReason: 'content_digest_mismatch' }) };
  } catch (error) {
    return { parts: [], totalBytes: 0, verified: false,
      unresolvedReason: `local_file_revision_unreadable:${error instanceof Error ? error.name : 'error'}` };
  }
}
