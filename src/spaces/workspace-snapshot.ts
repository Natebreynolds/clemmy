/** Cooperative Space snapshot boundary. SQLite decides whether an interrupted
 * static document update committed; the journal restores/completes its file
 * projections before an application reader observes them. This is not a claim
 * that unrelated raw filesystem readers see an atomic multi-file rename. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BASE_DIR } from '../config.js';
import { withFileLockSyncStrict } from '../runtime/atomic-json.js';
import { workspaceDataContentDigest } from './workspace-set-data-contract.js';

const spaces = path.join(BASE_DIR, 'spaces');
const JOURNAL = '.clementine-workspace-update.json';
const RECEIPT = '.clementine-workspace-commit.json';
const MAX_JOURNAL_BYTES = 8_000_000;
const held = new Set<string>();
const slugPattern = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;

export interface WorkspaceUpdateComponent {
  path: string;
  before: string | null;
  after: string;
}
export interface WorkspaceUpdateJournal {
  version: 1;
  slug: string;
  refreshId: string;
  dataDigest: string;
  components: WorkspaceUpdateComponent[];
}
export interface WorkspaceUpdateRecovery {
  committed: boolean;
  journal: WorkspaceUpdateJournal;
}

function rootFor(slug: string): string {
  if (!slugPattern.test(slug)) throw new Error('Invalid Workspace snapshot identity');
  return path.join(spaces, slug);
}

function componentPath(slug: string, relative: string): string {
  const root = rootFor(slug);
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === '..' || part === '.')) {
    throw new Error('Invalid Workspace snapshot component path');
  }
  const target = path.join(root, relative);
  const realRoot = realpathSync(root);
  const parent = realpathSync(path.dirname(target));
  const rel = path.relative(realRoot, parent);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Workspace snapshot component escaped its root');
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Workspace snapshot component is not a direct file');
  }
  return target;
}

/** Durable same-directory replacement, also used for journal intent. */
export function writeWorkspaceSnapshotFile(file: string, content: string): void {
  const temp = `${file}.${process.pid}.${randomUUID()}.snapshot-tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temp, file);
    const directory = openSync(path.dirname(file), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
  }
}

function durableRemove(file: string): void {
  rmSync(file, { force: true });
  const directory = openSync(path.dirname(file), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function validateJournal(raw: unknown, slug: string): WorkspaceUpdateJournal {
  const value = raw as WorkspaceUpdateJournal;
  if (!value || value.version !== 1 || value.slug !== slug
    || typeof value.refreshId !== 'string' || !/^[a-zA-Z0-9:_-]{1,200}$/.test(value.refreshId)
    || typeof value.dataDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.dataDigest)
    || !Array.isArray(value.components) || value.components.length !== 4) {
    throw new Error('Invalid Workspace update recovery journal');
  }
  const names = new Set<string>();
  for (const component of value.components) {
    if (!component || typeof component.path !== 'string' || names.has(component.path)
      || !(component.before === null || typeof component.before === 'string') || typeof component.after !== 'string') {
      throw new Error('Invalid Workspace update recovery component');
    }
    names.add(component.path);
    componentPath(slug, component.path);
  }
  if (!names.has('space.json') || !names.has('data.json') || !names.has(RECEIPT)
    || [...names].filter(name => name.startsWith('view/')).length !== 1) {
    throw new Error('Workspace update recovery requires its exact manifest, view, data and receipt');
  }
  const data = value.components.find(component => component.path === 'data.json')!;
  if (workspaceDataContentDigest(JSON.parse(data.after)) !== value.dataDigest) {
    throw new Error('Workspace update recovery document digest does not match');
  }
  const manifest = value.components.find(component => component.path === 'space.json')!;
  for (const bytes of [manifest.before, manifest.after]) {
    if (bytes === null) throw new Error('Workspace update requires an existing manifest');
    const record = JSON.parse(bytes);
    if (record.id !== slug || record.contentMode !== 'static_snapshot'
      || typeof record.viewEntry !== 'string' || !names.has(record.viewEntry)
      || !Array.isArray(record.dataSources) || record.dataSources.length !== 0) {
      throw new Error('Workspace update recovery manifest does not match its static target');
    }
  }
  return value;
}

function recoverUnlocked(slug: string): WorkspaceUpdateRecovery | undefined {
  const file = path.join(rootFor(slug), JOURNAL);
  if (!existsSync(file)) return undefined;
  componentPath(slug, JOURNAL);
  const raw = readFileSync(file, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > MAX_JOURNAL_BYTES) throw new Error('Workspace update recovery journal is too large');
  const journal = validateJournal(JSON.parse(raw), slug);
  // Read the existing owner's durable observation, never an uncommitted row
  // on its cached writer connection. Keeping this narrow reader independent
  // also preserves the cold-import boundary of the host artifact verifier.
  const db = new Database(path.join(BASE_DIR, 'state', 'workspaces.db'), { readonly: true, fileMustExist: true });
  let row: { status: string; projection_mode: string; cause: string; content_hash: string } | undefined;
  try {
    db.pragma('query_only = ON');
    row = db.prepare('SELECT status, projection_mode, cause, content_hash FROM workspace_dataset_observations WHERE workspace_id = ? AND source_key = ? AND refresh_id = ?').get(slug, '$document', journal.refreshId) as typeof row;
  } finally { db.close(); }
  if (row && (row.status !== 'ok' || row.projection_mode !== 'document'
    || row.cause !== 'static_document_update' || row.content_hash !== journal.dataDigest)) {
    throw new Error('Workspace update recovery disagrees with its committed observation');
  }
  const committed = Boolean(row);
  // An unmanaged writer can change files despite the advisory lock. Recovery
  // only completes known before/after components; it must not overwrite a
  // third generation and pretend that it was a torn write of this journal.
  for (const component of journal.components) {
    const target = componentPath(slug, component.path);
    const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
    if (current !== component.before && current !== component.after) {
      throw new Error('Workspace update recovery found an unrelated component generation');
    }
  }
  for (const component of journal.components) {
    const target = componentPath(slug, component.path);
    const bytes = committed ? component.after : component.before;
    if (bytes === null) durableRemove(target);
    else writeWorkspaceSnapshotFile(target, bytes);
  }
  durableRemove(file);
  return { committed, journal };
}

function encodeWorkspaceUpdateJournal(journal: WorkspaceUpdateJournal): string {
  validateJournal(journal, journal.slug);
  const bytes = JSON.stringify(journal);
  if (Buffer.byteLength(bytes, 'utf8') > MAX_JOURNAL_BYTES) throw new Error('Workspace update cannot fit its durable recovery journal');
  return bytes;
}

/** Reject an unrecoverable-size intent before indexing or observation effects. */
export function assertWorkspaceUpdateJournalFits(journal: WorkspaceUpdateJournal): void {
  encodeWorkspaceUpdateJournal(journal);
}

export function persistWorkspaceUpdateJournal(journal: WorkspaceUpdateJournal): void {
  if (!held.has(journal.slug)) throw new Error('Workspace update intent requires the mutation owner');
  writeWorkspaceSnapshotFile(path.join(rootFor(journal.slug), JOURNAL), encodeWorkspaceUpdateJournal(journal));
}

export function clearWorkspaceUpdateJournal(slug: string): void {
  if (!held.has(slug)) throw new Error('Workspace update completion requires the mutation owner');
  durableRemove(path.join(rootFor(slug), JOURNAL));
}

export function recoverWorkspaceSnapshotUnderOwner(slug: string): WorkspaceUpdateRecovery | undefined {
  if (!held.has(slug)) throw new Error('Workspace recovery requires its snapshot owner');
  return recoverUnlocked(slug);
}

/** Only synchronous reads may re-enter their current writer. Writes remain
 * non-reentrant, and independent processes always acquire the same strict lock. */
export function withWorkspaceSnapshotRead<T>(slug: string, read: () => T): T {
  rootFor(slug);
  if (held.has(slug)) return read();
  return withWorkspaceSnapshotMutation(slug, () => read());
}

export function withWorkspaceSnapshotMutation<T>(slug: string, write: (recovery?: WorkspaceUpdateRecovery) => T): T {
  rootFor(slug);
  if (held.has(slug)) throw new Error('Workspace mutation is not reentrant');
  mkdirSync(spaces, { recursive: true });
  return withFileLockSyncStrict(path.join(spaces, `.workspace-${slug}`), () => {
    held.add(slug);
    try {
      const recovery = recoverUnlocked(slug);
      const result = write(recovery);
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        throw new Error('Workspace snapshot ownership must remain synchronous');
      }
      return result;
    } finally { held.delete(slug); }
  });
}

/** Dataset observation commits are sub-operations of a static update. They
 * share its current synchronous owner; standalone refreshes acquire ownership.
 * Custom non-Space roots retain the workspace DB's existing embedding contract. */
export function withWorkspaceProjectionOwner<T>(slug: string, root: string, write: () => T): T {
  if (!slugPattern.test(slug) || path.resolve(root) !== rootFor(slug)) return write();
  if (held.has(slug)) return write();
  return withWorkspaceSnapshotMutation(slug, write);
}

export function workspaceSnapshotRevision(parts: { manifest: string; view: string; data: string }): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** Host artifact readers use this around the entire compound read, not once
 * per component, so a different writer cannot interleave the three reads. */
export function withWorkspaceSnapshotHandle<T>(handle: string, read: () => T): T {
  const match = /^spaces\/([a-z0-9][a-z0-9-]{0,61}[a-z0-9])\//.exec(handle);
  return match ? withWorkspaceSnapshotRead(match[1]!, read) : read();
}
