import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BASE_DIR } from '../config.js';
import { recordOperationalEvent, type WorkspaceOperationalEventType } from '../runtime/operational-telemetry.js';
import { WORKSPACE_SCHEMA_SQL } from './workspace-db-schema.js';
import type { SpaceAction, SpaceDataSource, SpaceRecord, SpaceRevision } from './store.js';

export const WORKSPACE_STATE_DIR = path.join(BASE_DIR, 'state');
export const WORKSPACE_DB_PATH = path.join(WORKSPACE_STATE_DIR, 'workspaces.db');
export const WORKSPACE_SPACES_DIR = path.join(BASE_DIR, 'spaces');

type WorkspaceFileKind = 'view' | 'asset' | 'runner' | 'data' | 'note' | 'audit' | 'manifest' | 'snapshot' | 'other';

export interface IndexWorkspaceOptions {
  db?: Database.Database;
  rootDir?: string;
  eventType?: WorkspaceOperationalEventType;
  actor?: string;
  payload?: Record<string, unknown>;
  now?: Date;
  emitOperational?: boolean;
}

export interface WorkspaceIndexRow {
  id: string;
  slug: string;
  title: string;
  status: SpaceRecord['status'];
  updatedAt: string;
}

let cachedDb: Database.Database | null = null;

export function openWorkspaceDb(): Database.Database {
  if (cachedDb) return cachedDb;
  ensureStateDir();
  const db = new Database(WORKSPACE_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(WORKSPACE_SCHEMA_SQL);
  cachedDb = db;
  return db;
}

export function closeWorkspaceDb(): void {
  if (!cachedDb) return;
  cachedDb.close();
  cachedDb = null;
}

/** Test-only reset. Workspace DB is a rebuildable index, not the source of truth. */
export function resetWorkspaceDbForTest(): void {
  closeWorkspaceDb();
  for (const suffix of ['', '-wal', '-shm']) {
    const file = WORKSPACE_DB_PATH + suffix;
    if (existsSync(file)) unlinkSync(file);
  }
}

export function indexWorkspaceRecord(record: SpaceRecord, options: IndexWorkspaceOptions = {}): void {
  const db = options.db ?? openWorkspaceDb();
  const rootDir = options.rootDir ?? resolveWorkspaceRoot(record.id);
  const now = (options.now ?? new Date()).toISOString();
  try {
    const tx = db.transaction(() => {
      upsertWorkspace(db, record, rootDir);
      replaceDataSources(db, record, now);
      replaceActions(db, record, now);
      replaceFilesAndRevisions(db, record, rootDir);
      appendWorkspaceStateEvent(db, record.id, {
        eventType: options.eventType ?? 'workspace_file_changed',
        actor: options.actor ?? 'workspace-index',
        payload: {
          title: record.title,
          status: record.status,
          version: record.version,
          ...(options.payload ?? {}),
        },
        createdAt: now,
      });
    });
    tx();
    if (options.emitOperational !== false && !options.db) {
      recordOperationalEvent({
        source: 'workspace',
        type: options.eventType ?? 'workspace_file_changed',
        severity: 'info',
        workspaceId: record.id,
        sessionId: record.originSessionId,
        actor: options.actor ?? 'workspace-index',
        now: new Date(now),
        payload: {
          title: record.title,
          status: record.status,
          version: record.version,
          rootDir,
          ...(options.payload ?? {}),
        },
      });
    }
  } catch {
    // Rebuildable index; never break Space writes because the index is unavailable.
  }
}

export function deleteWorkspaceIndex(
  slug: string,
  options: { db?: Database.Database; actor?: string; emitOperational?: boolean; now?: Date } = {},
): void {
  if (!isValidWorkspaceSlug(slug)) return;
  const db = options.db ?? openWorkspaceDb();
  try {
    db.prepare('DELETE FROM workspaces WHERE slug = ?').run(slug);
    if (options.emitOperational !== false && !options.db) {
      recordOperationalEvent({
        source: 'workspace',
        type: 'workspace_file_changed',
        severity: 'warn',
        workspaceId: slug,
        actor: options.actor ?? 'workspace-index',
        now: options.now,
        payload: { deleted: true },
      });
    }
  } catch {
    // Best-effort.
  }
}

export function reindexWorkspaceRecords(records: SpaceRecord[], options: Omit<IndexWorkspaceOptions, 'eventType'> = {}): number {
  let indexed = 0;
  for (const record of records) {
    indexWorkspaceRecord(record, {
      ...options,
      eventType: 'workspace_file_changed',
      payload: { reindexed: true, ...(options.payload ?? {}) },
    });
    indexed += 1;
  }
  return indexed;
}

export function listIndexedWorkspaces(db: Database.Database = openWorkspaceDb()): WorkspaceIndexRow[] {
  const rows = db.prepare(`
    SELECT id, slug, title, status, updated_at
    FROM workspaces
    ORDER BY updated_at DESC
  `).all() as Array<{ id: string; slug: string; title: string; status: SpaceRecord['status']; updated_at: string }>;
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    status: row.status,
    updatedAt: row.updated_at,
  }));
}

function upsertWorkspace(db: Database.Database, record: SpaceRecord, rootDir: string): void {
  db.prepare(`
    INSERT INTO workspaces (
      id, slug, title, status, root_dir, view_entry, origin_session_id, focus_id,
      recipe_json, metadata_json, created_at, updated_at, last_opened_at,
      last_refreshed_at
    ) VALUES (
      @id, @slug, @title, @status, @rootDir, @viewEntry, @originSessionId, @focusId,
      @recipeJson, @metadataJson, @createdAt, @updatedAt, @lastOpenedAt,
      @lastRefreshedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      slug = excluded.slug,
      title = excluded.title,
      status = excluded.status,
      root_dir = excluded.root_dir,
      view_entry = excluded.view_entry,
      origin_session_id = excluded.origin_session_id,
      focus_id = excluded.focus_id,
      recipe_json = excluded.recipe_json,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at,
      last_opened_at = excluded.last_opened_at,
      last_refreshed_at = excluded.last_refreshed_at
  `).run({
    id: record.id,
    slug: record.id,
    title: record.title,
    status: record.status,
    rootDir,
    viewEntry: record.viewEntry,
    originSessionId: record.originSessionId ?? null,
    focusId: record.focusId ?? null,
    recipeJson: record.recipe ? JSON.stringify({ text: record.recipe }) : null,
    metadataJson: JSON.stringify({
      reengage: record.reengage,
      manifestErrors: record.manifestErrors,
      version: record.version,
    }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastOpenedAt: record.lastOpenedAt ?? null,
    lastRefreshedAt: record.lastRefreshedAt ?? null,
  });
}

function replaceDataSources(db: Database.Database, record: SpaceRecord, now: string): void {
  db.prepare('DELETE FROM workspace_data_sources WHERE workspace_id = ?').run(record.id);
  const insert = db.prepare(`
    INSERT INTO workspace_data_sources (
      id, workspace_id, runner, composio_slug, args_json, schedule, timezone,
      created_at, updated_at
    ) VALUES (
      @id, @workspaceId, @runner, @composioSlug, @argsJson, @schedule, @timezone,
      @createdAt, @updatedAt
    )
  `);
  for (const [index, source] of record.dataSources.entries()) {
    if (!source.runner && !source.composioSlug) continue;
    insert.run({
      id: sourceRowId(record.id, source, index),
      workspaceId: record.id,
      runner: source.runner ?? null,
      composioSlug: source.composioSlug ?? null,
      argsJson: JSON.stringify(source.composioArgs ?? {}),
      schedule: source.schedule ?? null,
      timezone: source.timezone ?? null,
      createdAt: record.createdAt,
      updatedAt: now,
    });
  }
}

function replaceActions(db: Database.Database, record: SpaceRecord, now: string): void {
  db.prepare('DELETE FROM workspace_actions WHERE workspace_id = ?').run(record.id);
  const insert = db.prepare(`
    INSERT INTO workspace_actions (
      id, workspace_id, runner, composio_slug, args_template_json, side_effect,
      approval_policy, created_at, updated_at
    ) VALUES (
      @id, @workspaceId, @runner, @composioSlug, @argsTemplateJson, @sideEffect,
      @approvalPolicy, @createdAt, @updatedAt
    )
  `);
  for (const [index, action] of record.actions.entries()) {
    if (!action.runner && !action.composioSlug) continue;
    insert.run({
      id: actionRowId(record.id, action, index),
      workspaceId: record.id,
      runner: action.runner ?? null,
      composioSlug: action.composioSlug ?? null,
      argsTemplateJson: JSON.stringify(action.argsTemplate ?? {}),
      sideEffect: sideEffectForAction(action),
      approvalPolicy: 'required',
      createdAt: record.createdAt,
      updatedAt: now,
    });
  }
}

function replaceFilesAndRevisions(db: Database.Database, record: SpaceRecord, rootDir: string): void {
  db.prepare('DELETE FROM workspace_revisions WHERE workspace_id = ?').run(record.id);
  db.prepare('DELETE FROM workspace_files WHERE workspace_id = ?').run(record.id);
  const files = collectWorkspaceFiles(record, rootDir);
  const fileIdsByRel = new Map<string, string>();
  const insertFile = db.prepare(`
    INSERT INTO workspace_files (
      id, workspace_id, rel_path, kind, content_hash, bytes, version, created_at,
      updated_at
    ) VALUES (
      @id, @workspaceId, @relPath, @kind, @contentHash, @bytes, @version, @createdAt,
      @updatedAt
    )
  `);
  for (const file of files) {
    const id = fileRowId(record.id, file.relPath);
    fileIdsByRel.set(file.relPath, id);
    insertFile.run({
      id,
      workspaceId: record.id,
      relPath: file.relPath,
      kind: file.kind,
      contentHash: file.contentHash,
      bytes: file.bytes,
      version: file.relPath === record.viewEntry ? record.version : 1,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
    });
  }
  replaceRevisions(db, record, rootDir, fileIdsByRel);
}

function replaceRevisions(
  db: Database.Database,
  record: SpaceRecord,
  rootDir: string,
  fileIdsByRel: Map<string, string>,
): void {
  const insert = db.prepare(`
    INSERT INTO workspace_revisions (
      id, workspace_id, file_id, version, snapshot_path, content_hash, bytes,
      author_session_id, created_at
    ) VALUES (
      @id, @workspaceId, @fileId, @version, @snapshotPath, @contentHash, @bytes,
      @authorSessionId, @createdAt
    )
  `);
  for (const revision of record.revisions) {
    const snapshot = statWorkspaceFile(rootDir, revision.file);
    insert.run({
      id: revisionRowId(record.id, revision),
      workspaceId: record.id,
      fileId: fileIdsByRel.get(revision.file) ?? null,
      version: revision.version,
      snapshotPath: revision.file,
      contentHash: snapshot?.contentHash ?? hashString(`${record.id}:${revision.file}:${revision.version}:${revision.ts}`),
      bytes: snapshot?.bytes ?? revision.bytes,
      authorSessionId: record.originSessionId ?? null,
      createdAt: revision.ts,
    });
  }
}

function appendWorkspaceStateEvent(
  db: Database.Database,
  workspaceId: string,
  input: {
    eventType: WorkspaceOperationalEventType;
    actor: string;
    payload: Record<string, unknown>;
    createdAt: string;
  },
): void {
  const seq = ((db.prepare(`
    SELECT COALESCE(MAX(seq), 0) + 1 AS seq
    FROM workspace_state_events
    WHERE workspace_id = ?
  `).get(workspaceId) as { seq: number } | undefined)?.seq) ?? 1;
  db.prepare(`
    INSERT INTO workspace_state_events (
      id, workspace_id, seq, session_id, event_type, actor, payload_json, created_at
    ) VALUES (
      @id, @workspaceId, @seq, @sessionId, @eventType, @actor, @payloadJson, @createdAt
    )
  `).run({
    id: randomUUID(),
    workspaceId,
    seq,
    sessionId: typeof input.payload.originSessionId === 'string' ? input.payload.originSessionId : null,
    eventType: input.eventType,
    actor: input.actor,
    payloadJson: JSON.stringify(input.payload),
    createdAt: input.createdAt,
  });
}

interface IndexedWorkspaceFile {
  relPath: string;
  kind: WorkspaceFileKind;
  contentHash: string;
  bytes: number;
  createdAt: string;
  updatedAt: string;
}

function collectWorkspaceFiles(record: SpaceRecord, rootDir: string): IndexedWorkspaceFile[] {
  const rels = new Set<string>(['space.json', record.viewEntry, 'data.json', 'notes.jsonl', 'audit.jsonl']);
  for (const source of record.dataSources) if (source.runner) rels.add(path.posix.join('data', source.runner));
  for (const action of record.actions) if (action.runner) rels.add(path.posix.join('data', action.runner));
  for (const revision of record.revisions) rels.add(revision.file);
  for (const rel of walkWorkspaceFiles(rootDir, 'view')) rels.add(rel);
  for (const rel of walkWorkspaceFiles(rootDir, 'data')) rels.add(rel);
  for (const rel of walkWorkspaceFiles(rootDir, 'view-history')) rels.add(rel);

  const out: IndexedWorkspaceFile[] = [];
  for (const relPath of rels) {
    const stat = statWorkspaceFile(rootDir, relPath);
    if (!stat) continue;
    out.push({
      relPath,
      kind: classifyWorkspaceFile(record, relPath),
      ...stat,
    });
  }
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function walkWorkspaceFiles(rootDir: string, relDir: string): string[] {
  const abs = path.join(rootDir, relDir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        visit(full);
      } else if (st.isFile()) {
        out.push(toPosix(path.relative(rootDir, full)));
      }
    }
  };
  visit(abs);
  return out;
}

function statWorkspaceFile(rootDir: string, relPath: string): Omit<IndexedWorkspaceFile, 'relPath' | 'kind'> | null {
  const full = safeJoin(rootDir, relPath);
  if (!full || !existsSync(full)) return null;
  try {
    const st = statSync(full);
    if (!st.isFile()) return null;
    return {
      contentHash: hashBuffer(readFileSync(full)),
      bytes: st.size,
      createdAt: st.birthtime.toISOString(),
      updatedAt: st.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

function classifyWorkspaceFile(record: SpaceRecord, relPath: string): WorkspaceFileKind {
  if (relPath === 'space.json') return 'manifest';
  if (relPath === record.viewEntry) return 'view';
  if (relPath === 'data.json') return 'data';
  if (relPath === 'notes.jsonl') return 'note';
  if (relPath === 'audit.jsonl') return 'audit';
  if (relPath.startsWith('view-history/')) return 'snapshot';
  if (relPath.startsWith('view/')) return 'asset';
  if (relPath.startsWith('data/')) return 'runner';
  return 'other';
}

function resolveWorkspaceRoot(slug: string): string {
  if (!isValidWorkspaceSlug(slug)) throw new Error(`invalid workspace slug: ${slug}`);
  return path.join(WORKSPACE_SPACES_DIR, slug);
}

function isValidWorkspaceSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(slug);
}

function sourceRowId(workspaceId: string, source: SpaceDataSource, index: number): string {
  return `${workspaceId}:source:${source.id || index}`;
}

function actionRowId(workspaceId: string, action: SpaceAction, index: number): string {
  return `${workspaceId}:action:${action.id || index}`;
}

function fileRowId(workspaceId: string, relPath: string): string {
  return `${workspaceId}:file:${hashString(relPath).slice(0, 16)}`;
}

function revisionRowId(workspaceId: string, revision: SpaceRevision): string {
  return `${workspaceId}:revision:${revision.version}:${hashString(`${revision.file}:${revision.ts}`).slice(0, 12)}`;
}

function sideEffectForAction(action: SpaceAction): 'write' | 'send' {
  const slug = `${action.composioSlug ?? ''} ${action.runner ?? ''}`.toLowerCase();
  return slug.includes('send') || slug.includes('email') || slug.includes('mail') ? 'send' : 'write';
}

function safeJoin(rootDir: string, relPath: string): string | null {
  const target = path.resolve(rootDir, relPath);
  const rel = path.relative(rootDir, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function hashBuffer(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function ensureStateDir(): void {
  if (!existsSync(WORKSPACE_STATE_DIR)) mkdirSync(WORKSPACE_STATE_DIR, { recursive: true });
}
