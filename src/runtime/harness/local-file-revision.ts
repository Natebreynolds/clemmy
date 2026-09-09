import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync,
  mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../../config.js';
import { withFileLockSyncStrict } from '../atomic-json.js';
import type { CommittedArtifactContent, HostLocalWriteCommitFacts } from './host-local-write-commit.js';

const PREFIX = 'state/local-file-revisions/';
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

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
};

/** One registered file-tool execution: retain the exact previous bytes before
 * touching the target, replace atomically, then publish a stable receipt handle.
 * The prepared journal and prior bytes remain recoverable if publication fails
 * after the target changed. Errors propagate; they never claim no effect. */
export function commitLocalFileRevision(input: {
  target: string;
  content: string;
  mode: 'create' | 'append' | 'overwrite';
}): { createdId: string; committedPath: string; previousPath: string | null; unchanged: boolean } {
  const target = canonicalLocalFileTarget(input.target);
  const key = digest(target);
  const createdId = `file-${key}`;
  const root = realpathSync(BASE_DIR);
  const dir = path.join(root, PREFIX, key);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Never follow a replaced receipt directory outside the protected store.
  if (realpathSync(dir) !== dir) throw new Error('Local file revision directory changed.');
  const current = path.join(dir, 'current.json');
  return withFileLockSyncStrict(current, () => {
    const prior = existsSync(target) ? readDirectFile(target) : null;
    if (input.mode === 'create' && prior) throw new Error(`Refused to overwrite existing file: ${target}. Use mode="append" or mode="overwrite" for a requested revision.`);
    const content = input.content.endsWith('\n') ? input.content : `${input.content}\n`;
    const bytes = input.mode === 'append' && prior
      ? Buffer.concat([prior.bytes, Buffer.from(prior.bytes.length && prior.bytes.at(-1) !== 10 ? '\n' : ''), Buffer.from(content)])
      : Buffer.from(content);
    const revisionId = randomUUID();
    const previousPath = prior ? path.join(dir, `${revisionId}.before`) : null;
    if (prior && previousPath) writeDurable(previousPath, prior.bytes, 0o600, true);
    const revision: Revision = { version: 1, kind: 'local_file_revision_v1', createdId, revisionId, target,
      contentDigest: digest(bytes), bytes: bytes.length,
      previous: prior && previousPath ? { handle: path.relative(root, previousPath).split(path.sep).join('/'),
        contentDigest: digest(prior.bytes), bytes: prior.bytes.length, mode: prior.mode } : null };
    const encoded = Buffer.from(JSON.stringify(revision));
    writeDurable(path.join(dir, `${revisionId}.prepared.json`), encoded, 0o600, true);
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
