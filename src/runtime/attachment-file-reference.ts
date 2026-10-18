/** Exact bytes selected with an accepted request. This extends the existing
 * attachment snapshot store; it is not permission to execute or publish them. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { getUserInputEventAtSequence } from './harness/eventlog.js';
import { readConsumedTaskContinuityPacket } from '../memory/task-continuity.js';
import { SECRET_BASENAME_RE } from '../integrations/composio/staged-file-blob-store.js';

export const RAW_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const ATTACHMENT_FILE_SOURCE_FIELD = 'attachmentFiles';
const STORE = path.join(BASE_DIR, 'state', 'attachments-files');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const DENIED = /\.(?:exe|dmg|iso|app|bin|dll|so|dylib|pem|p12|pfx|keychain-db)$/i;

export interface AttachmentFileSource { sessionId: string; sourceUserSeq: number }
export interface AttachmentFileReference {
  version: 1;
  snapshotId: string;
  name: string;
  bytes: number;
  sha256: string;
  identity: { dev: string; ino: string; mtimeNs: string; ctimeNs: string };
}

export function attachmentFileNameAllowed(name: string): boolean {
  return name.length > 0 && name.length <= 120 && path.basename(name) === name
    && !/[\x00-\x1f\x7f\\/]/.test(name) && !SECRET_BASENAME_RE.test(name) && !DENIED.test(name);
}

function parse(value: unknown): AttachmentFileReference | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const identity = row.identity as Record<string, unknown> | undefined;
  if (Object.keys(row).sort().join(',') !== 'bytes,identity,name,sha256,snapshotId,version'
    || row.version !== 1 || typeof row.snapshotId !== 'string' || !UUID.test(row.snapshotId)
    || typeof row.name !== 'string' || !attachmentFileNameAllowed(row.name)
    || !Number.isSafeInteger(row.bytes) || Number(row.bytes) <= 0 || Number(row.bytes) > RAW_ATTACHMENT_MAX_BYTES
    || typeof row.sha256 !== 'string' || !DIGEST.test(row.sha256)
    || !identity || typeof identity !== 'object' || Array.isArray(identity)
    || Object.keys(identity).sort().join(',') !== 'ctimeNs,dev,ino,mtimeNs'
    || !['dev', 'ino', 'mtimeNs', 'ctimeNs'].every(key => typeof identity[key] === 'string' && /^\d+$/.test(identity[key] as string))) return null;
  return { version: 1, snapshotId: row.snapshotId, name: row.name, bytes: Number(row.bytes), sha256: row.sha256,
    identity: { dev: String(identity.dev), ino: String(identity.ino), mtimeNs: String(identity.mtimeNs), ctimeNs: String(identity.ctimeNs) } };
}

export function attachmentFilePath(reference: AttachmentFileReference): string {
  const exact = parse(reference);
  if (!exact) throw new Error('Invalid attachment file reference.');
  return path.join(storePath(), `${exact.snapshotId}__${exact.name}`);
}

function storePath(): string {
  if (!lstatSync(STORE).isDirectory() || lstatSync(STORE).isSymbolicLink()) throw new Error('Attachment snapshot store changed.');
  return realpathSync(STORE);
}

/** Recognition is denial-only. It never makes an arbitrary state path usable. */
export function isAttachmentSnapshotPath(requested: string): boolean {
  if (typeof requested !== 'string' || !path.isAbsolute(requested.trim())) return false;
  const candidates = [path.resolve(requested.trim())];
  const roots = [path.resolve(STORE)];
  try { candidates.push(realpathSync(requested.trim())); } catch { /* missing paths still match lexically */ }
  try { roots.push(storePath()); } catch { /* absent store grants nothing */ }
  return roots.some(root => candidates.some(candidate => {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }));
}

function stable(stat: BigIntStats, reference: AttachmentFileReference): boolean {
  return stat.isFile() && stat.nlink === 1n && stat.size === BigInt(reference.bytes)
    && String(stat.dev) === reference.identity.dev && String(stat.ino) === reference.identity.ino
    && String(stat.mtimeNs) === reference.identity.mtimeNs && String(stat.ctimeNs) === reference.identity.ctimeNs;
}

function readExact(reference: AttachmentFileReference): Buffer {
  const requested = attachmentFilePath(reference);
  let fd: number | undefined;
  try {
    if (realpathSync(requested) !== requested) throw new Error('Attachment snapshot path changed.');
    fd = openSync(requested, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!stable(fstatSync(fd, { bigint: true }), reference)) throw new Error('Attachment snapshot changed.');
    const bytes = Buffer.alloc(reference.bytes);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    if (offset !== bytes.length || !stable(fstatSync(fd, { bigint: true }), reference)
      || realpathSync(requested) !== requested || createHash('sha256').update(bytes).digest('hex') !== reference.sha256) {
      throw new Error('Attachment snapshot changed.');
    }
    return bytes;
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Called only after the shared ingestion path has saved a new private file. */
export function captureAttachmentFileReference(snapshotPath: string, name: string): AttachmentFileReference {
  const basename = path.basename(snapshotPath);
  const snapshotId = basename.slice(0, 36);
  if (!UUID.test(snapshotId) || basename !== `${snapshotId}__${name}` || !attachmentFileNameAllowed(name)
    || ![path.join(STORE, basename), path.join(storePath(), basename)].includes(path.resolve(snapshotPath))) throw new Error('Invalid attachment snapshot.');
  let fd: number | undefined;
  try {
    if (realpathSync(snapshotPath) !== path.join(storePath(), basename) || lstatSync(snapshotPath).isSymbolicLink()) throw new Error('Invalid attachment snapshot.');
    fd = openSync(snapshotPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size <= 0 || stat.size > BigInt(RAW_ATTACHMENT_MAX_BYTES)) throw new Error('Invalid attachment size.');
    const bytes = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    const reference: AttachmentFileReference = { version: 1, snapshotId, name, bytes: Number(stat.size),
      sha256: createHash('sha256').update(bytes).digest('hex'), identity: {
        dev: String(stat.dev), ino: String(stat.ino), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs),
      } };
    if (offset !== bytes.length || !stable(fstatSync(fd, { bigint: true }), reference)
      || realpathSync(snapshotPath) !== attachmentFilePath(reference)) throw new Error('Attachment snapshot changed.');
    return reference;
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Copy only valid, intact host snapshots into immutable accepted-source data. */
export function acceptedAttachmentFiles(attachments: readonly { file?: AttachmentFileReference }[]): AttachmentFileReference[] {
  const references = attachments.flatMap(attachment => attachment.file ? [parse(attachment.file)] : []);
  if (references.some(reference => !reference) || references.length > 10) throw new Error('Invalid attachment files.');
  const unique = new Map<string, AttachmentFileReference>();
  for (const reference of references) {
    readExact(reference!);
    unique.set(reference!.snapshotId, reference!);
  }
  return [...unique.values()];
}

function sourceReferences(source: AttachmentFileSource): AttachmentFileReference[] {
  if (!source.sessionId || !Number.isSafeInteger(source.sourceUserSeq) || source.sourceUserSeq <= 0) return [];
  let seq = source.sourceUserSeq;
  const visited = new Set<number>();
  for (let depth = 0; depth < 5; depth++) {
    if (visited.has(seq)) return [];
    visited.add(seq);
    const event = getUserInputEventAtSequence(source.sessionId, seq);
    if (!event) return [];
    const raw = event.data[ATTACHMENT_FILE_SOURCE_FIELD];
    if (raw !== undefined) {
      if (!Array.isArray(raw) || raw.length > 10) return [];
      const refs = raw.map(parse);
      return refs.every(Boolean) ? refs as AttachmentFileReference[] : [];
    }
    const continuation = readConsumedTaskContinuityPacket({ sessionId: source.sessionId, consumingSourceUserSeq: seq });
    if (continuation.status !== 'consumed' || ['declined', 'declined_with_new_task'].includes(continuation.resolution.disposition)) return [];
    const parent = continuation.packet.originatingSourceUserSeq;
    if (!Number.isSafeInteger(parent) || parent <= 0 || parent >= seq) return [];
    seq = parent;
  }
  return [];
}

/** A path alone never opens the state store. The current immutable source (or
 * its durably proven clarification parent) must name these exact bytes. */
export function sourceOwnedAttachmentFile(requested: string, source: AttachmentFileSource): AttachmentFileReference {
  const matches = sourceReferences(source).filter(reference => attachmentFilePath(reference) === path.resolve(requested));
  if (matches.length !== 1) throw new Error('This request does not own that attachment file. Attach the file to this request.');
  readExact(matches[0]!);
  return matches[0]!;
}

export function readSourceOwnedAttachmentFile(reference: AttachmentFileReference, source: AttachmentFileSource): Buffer {
  const current = sourceOwnedAttachmentFile(attachmentFilePath(reference), source);
  if (JSON.stringify(current) !== JSON.stringify(reference)) throw new Error('Attachment file reference changed.');
  return readExact(current);
}
