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
  operation?: { key: string; requestDigest: string; previousRevisionDigest: string | null;
    /** The base this operation was admitted against, frozen with it. Absent
     * on records written before the base was recorded; recovery then reads
     * the base from the request as before. */
    expectedContentDigest?: string | null };
  /** Set when the host recorded bytes a command changed, not a file tool. */
  observedAfter?: { tool: string; callId: string };
};

/** One registered file-tool execution: retain the exact previous bytes before
 * touching the target, replace atomically, then publish a stable receipt handle.
 * The prepared journal and prior bytes remain recoverable if publication fails
 * after the target changed. Errors propagate; they never claim no effect. */
type LocalFileRevisionInput = {
  target: string;
  content: string;
  mode: 'create' | 'append' | 'overwrite' | 'replace';
  /** For replace: the exact text that must appear once; `content` replaces it. */
  find?: string;
  expectedContentDigest?: string;
  /** Host-owned occurrence identity, never a model-supplied write argument. */
  operationKey?: string;
};
export type LocalFileRevisionResult = { createdId: string; committedPath: string; previousPath: string | null; unchanged: boolean };
type LocalFileRevisionSnapshot = { target: string; handle: string; descriptorBytes: Buffer; contentBytes: Buffer };
const revisionSnapshots = new WeakMap<LocalFileRevisionResult, LocalFileRevisionSnapshot>();

/** Keep this operation's verified bytes before releasing its lock. The public
 * handle still names current.json: a later revision must invalidate current
 * verification, without being relabelled as this operation's result. */
function captureRevision(result: LocalFileRevisionResult, snapshot: LocalFileRevisionSnapshot): LocalFileRevisionResult {
  revisionSnapshots.set(result, { ...snapshot,
    descriptorBytes: Buffer.from(snapshot.descriptorBytes), contentBytes: Buffer.from(snapshot.contentBytes) });
  return result;
}

/** Only genuine store results carry a snapshot; callers receive defensive
 * copies, never mutable ownership of the retained operation bytes. */
export function getLocalFileRevisionSnapshot(result: LocalFileRevisionResult): LocalFileRevisionSnapshot {
  const saved = revisionSnapshots.get(result);
  if (!saved) throw new Error('No captured local file revision for this result.');
  return { ...saved, descriptorBytes: Buffer.from(saved.descriptorBytes), contentBytes: Buffer.from(saved.contentBytes) };
}

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
    const requestDigestFor = (expectedContentDigest: string | null) => digest(JSON.stringify({ target, content: input.content,
      mode: input.mode, expectedContentDigest,
      ...(input.mode === 'replace' ? { find: input.find ?? null } : {}) }));
    const requestDigest = requestDigestFor(input.expectedContentDigest ?? null);
    const operationFile = input.operationKey
      ? path.join(dir, `operation-${digest(input.operationKey)}.json`) : null;
    if (operationFile && existsSync(operationFile)) {
      const encoded = readDirectFile(operationFile).bytes;
      const saved = JSON.parse(encoded.toString('utf8')) as Revision;
      // The base is part of the operation's identity and was frozen with it:
      // recovery compares against the frozen base, never one recomputed from
      // what the conversation has seen since (its own write, for one).
      const frozenRequestDigest = saved.operation && saved.operation.expectedContentDigest !== undefined
        ? requestDigestFor(saved.operation.expectedContentDigest) : requestDigest;
      if (saved.version !== 1 || saved.kind !== 'local_file_revision_v1'
        || saved.target !== target || saved.createdId !== createdId
        || !/^[a-f0-9-]{36}$/.test(saved.revisionId)
        || !saved.operation || saved.operation.key !== input.operationKey
        || saved.operation.requestDigest !== frozenRequestDigest
        || !readDirectFile(path.join(dir, `${saved.revisionId}.prepared.json`)).bytes.equals(encoded)) {
        throw new LocalFileRevisionConflict('The recorded file operation does not match this request. No file content was changed.');
      }
      const currentBytes = existsSync(current) ? readDirectFile(current).bytes : null;
      const priorDescriptorMatches = (currentBytes ? digest(currentBytes) : null)
        === saved.operation.previousRevisionDigest;
      const recovered = existsSync(target) ? readDirectFile(target) : null;
      if ((!currentBytes?.equals(encoded) && !priorDescriptorMatches)
        || !recovered || digest(recovered.bytes) !== saved.contentDigest) {
        throw new LocalFileRevisionConflict('The recorded file operation cannot be recovered from the current bytes. No file content was changed.');
      }
      // The mutation landed but current.json may not have been published.
      // Recover only its receipt; never append or replace target bytes again.
      if (!currentBytes?.equals(encoded)) writeDurable(current, encoded, 0o600);
      return captureRevision({ createdId, committedPath: current,
        previousPath: saved.previous ? path.join(dir, `${saved.revisionId}.before`) : null,
        unchanged: true }, { target, handle: path.relative(root, current).split(path.sep).join('/'),
        descriptorBytes: encoded, contentBytes: recovered.bytes });
    }
    if (recoveryOnly) {
      throw new LocalFileRevisionConflict('No matching recorded file operation exists for recovery.');
    }
    const prior = existsSync(target) ? readDirectFile(target) : null;
    if (input.expectedContentDigest !== undefined
      && (!prior || digest(prior.bytes) !== input.expectedContentDigest)) {
      throw new LocalFileRevisionConflict('The local file changed since this conversation last read or wrote it. Re-read it and reconcile the outside edit before writing. No file content was changed.');
    }
    if (input.mode === 'create' && prior) throw new LocalFileCreateConflict(`Refused to overwrite existing file: ${target}. Use mode="append" or mode="overwrite" for a requested revision.`);
    const content = input.content.endsWith('\n') ? input.content : `${input.content}\n`;
    const bytes = input.mode === 'replace'
      ? replacedBytes(target, prior?.bytes ?? null, input.find ?? '', input.content)
      : input.mode === 'append' && prior
      ? Buffer.concat([prior.bytes, Buffer.from(prior.bytes.length && prior.bytes.at(-1) !== 10 ? '\n' : ''), Buffer.from(content)])
      : Buffer.from(content);
    const revisionId = randomUUID();
    const previousPath = prior ? path.join(dir, `${revisionId}.before`) : null;
    if (prior && previousPath) writeDurable(previousPath, prior.bytes, 0o600, true);
    const revision: Revision = { version: 1, kind: 'local_file_revision_v1', createdId, revisionId, target,
      contentDigest: digest(bytes), bytes: bytes.length,
      ...(input.operationKey ? { operation: { key: input.operationKey, requestDigest,
        previousRevisionDigest: existsSync(current) ? digest(readDirectFile(current).bytes) : null,
        expectedContentDigest: input.expectedContentDigest ?? null } } : {}),
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
    return captureRevision({ createdId, committedPath: current, previousPath, unchanged },
      { target, handle: path.relative(root, current).split(path.sep).join('/'),
        descriptorBytes: encoded, contentBytes: committed.bytes });
  });
}

/** The file with one exact passage changed. The passage must appear exactly
 * once, so the change lands where it was meant and nowhere else. */
function replacedBytes(target: string, prior: Buffer | null, find: string, replacement: string): Buffer {
  if (!prior) throw new LocalFileRevisionConflict(`File does not exist: ${target}. Nothing to replace; create it instead. No file content was changed.`);
  if (!find) throw new LocalFileRevisionConflict('mode="replace" needs `find`: the exact text to change. No file content was changed.');
  const text = prior.toString('utf8');
  const first = text.indexOf(find);
  if (first < 0) {
    throw new LocalFileRevisionConflict(`The text to replace was not found in ${target}. Re-read the file and copy the passage exactly as it appears. No file content was changed.`);
  }
  if (text.indexOf(find, first + 1) >= 0) {
    let count = 0;
    for (let at = text.indexOf(find); at >= 0; at = text.indexOf(find, at + 1)) count += 1;
    throw new LocalFileRevisionConflict(`The text to replace appears ${count} times in ${target}. Include enough surrounding text to match exactly one place. No file content was changed.`);
  }
  return Buffer.from(text.slice(0, first) + replacement + text.slice(first + find.length), 'utf8');
}

export function isLocalFileRevisionHandle(handle: string): boolean {
  return /^state\/local-file-revisions\/[a-f0-9]{64}\/current\.json$/.test(handle);
}

/** A recorded file as its current revision describes it, with the file's
 * present bytes when they are still exactly that revision; null otherwise. */
export function recordedLocalFileAtRevision(handle: string): {
  descriptorDigest: string; bytes: Buffer; mode: number;
} | null {
  if (!isLocalFileRevisionHandle(handle)) return null;
  try {
    const root = realpathSync(BASE_DIR);
    const descriptor = readDirectFile(path.join(root, handle)).bytes;
    const revision = JSON.parse(descriptor.toString('utf8')) as Revision;
    if (revision.version !== 1 || revision.kind !== 'local_file_revision_v1' || typeof revision.target !== 'string'
      || canonicalLocalFileTarget(revision.target) !== revision.target
      || handle !== `${PREFIX}${digest(revision.target)}/current.json`) return null;
    const file = readDirectFile(revision.target);
    if (file.bytes.length !== revision.bytes || digest(file.bytes) !== revision.contentDigest) return null;
    return { descriptorDigest: digest(descriptor), bytes: file.bytes, mode: file.mode };
  } catch { return null; }
}

/** A recorded file changed by a command run in the same request. The host saw
 * the file at its recorded revision just before the command and sees other
 * bytes after it, so the change is the command's: record those bytes as the
 * file's next revision, keeping the earlier bytes as its previous state, as a
 * file write does. A revision recorded in between, a file that is gone or no
 * longer plain, or bytes still moving record nothing. */
export function recordLocalFileRevisionAfterCommand(input: {
  handle: string;
  before: { descriptorDigest: string; bytes: Buffer; mode: number };
  command: { tool: string; callId: string };
}): { createdId: string; committedPath: string } | null {
  if (!isLocalFileRevisionHandle(input.handle)) return null;
  const root = realpathSync(BASE_DIR);
  const current = path.join(root, input.handle);
  const dir = path.dirname(current);
  if (realpathSync(dir) !== dir) return null;
  return withFileLockSyncStrict(current, () => {
    const descriptor = readDirectFile(current).bytes;
    if (digest(descriptor) !== input.before.descriptorDigest) return null;
    const recorded = JSON.parse(descriptor.toString('utf8')) as Revision;
    const target = recorded.target;
    if (recorded.version !== 1 || recorded.kind !== 'local_file_revision_v1' || typeof target !== 'string'
      || canonicalLocalFileTarget(target) !== target || recorded.createdId !== `file-${digest(target)}`
      || current !== path.join(root, PREFIX, digest(target), 'current.json')
      || digest(input.before.bytes) !== recorded.contentDigest || !existsSync(target)) return null;
    const after = readDirectFile(target);
    if (after.bytes.equals(input.before.bytes)) return null;
    const revisionId = randomUUID();
    const previousPath = path.join(dir, `${revisionId}.before`);
    writeDurable(previousPath, input.before.bytes, 0o600, true);
    const revision: Revision = { version: 1, kind: 'local_file_revision_v1', createdId: recorded.createdId, revisionId, target,
      contentDigest: digest(after.bytes), bytes: after.bytes.length,
      previous: { handle: path.relative(root, previousPath).split(path.sep).join('/'),
        contentDigest: recorded.contentDigest, bytes: input.before.bytes.length, mode: input.before.mode },
      observedAfter: { tool: input.command.tool, callId: input.command.callId } };
    const encoded = Buffer.from(JSON.stringify(revision));
    writeDurable(path.join(dir, `${revisionId}.prepared.json`), encoded, 0o600, true);
    if (!readDirectFile(target).bytes.equals(after.bytes)) return null;
    writeDurable(current, encoded, 0o600);
    return { createdId: recorded.createdId, committedPath: current };
  });
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
