/**
 * Workspaces ("Spaces" in code) — the persistent store for agent-authored
 * interactive surfaces. A Space is a directory under BASE_DIR/spaces/<slug>/:
 *
 *   spaces/<slug>/
 *     view/index.html        # Clem-authored view (the ONLY served subtree)
 *     view/<asset>           # optional extra view assets
 *     view-history/<ts>.html # version snapshots (one-click revert)
 *     data.json              # the dataset (atomic last-write)   — never served
 *     notes.jsonl            # user notes/actions (append-only)  — never served
 *     audit.jsonl            # data-plane API audit (guardrail)  — never served
 *     data/<runner>          # Clem-authored fetch scripts        — never served
 *     space.json             # manifest (source of truth for this Space)
 *
 * Design choices:
 *  - The per-Space `space.json` IS the source of truth. The index is built by
 *    scanning each `spaces/<slug>/space.json` (self-healing by construction — no
 *    separate index file to drift). Cardinality is low (tens), scan-per-list is fine.
 *  - Writes are atomic (temp + rename) so a crash mid-write can't corrupt a
 *    manifest. Mirrors the workflow-store idiom.
 *  - The view lives in a `view/` subtree so the serving route can expose ONLY
 *    that subtree and never leak data.json / notes / the manifest.
 *
 * Pure persistence layer — no Express, no agent loop, no focus/workflow deps.
 */
import { randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { BASE_DIR, getRuntimeEnv } from '../config.js';
import { deleteWorkspaceIndex, indexWorkspaceRecord, reindexWorkspaceRecords } from './workspace-db.js';

export const SPACES_DIR = path.join(BASE_DIR, 'spaces');

/**
 * Workspaces feature flag. DEFAULT ON (beta) — Clem can build interactive
 * Workspaces out of the box. This is a kill-switch: set CLEMENTINE_SPACES to
 * 0 / false / off / no (in ~/.clementine-next/.env or the process env) to
 * disable the tools/routes/UI. Reads process env AND the .env via getRuntimeEnv
 * so it works however the daemon was launched. Mirrors isConsoleNextEnabled.
 */
export function isSpacesEnabled(): boolean {
  const raw = getRuntimeEnv('CLEMENTINE_SPACES', '').trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}

/** Slug rules: lowercase kebab, 2–63 chars, no traversal. Path-safe by design. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;

export function isValidSpaceSlug(slug: string): boolean {
  return typeof slug === 'string' && SLUG_RE.test(slug);
}

/**
 * Workspace runner declarations are filenames under data/, not paths. Keeping
 * this strict makes save-time validation and runtime execution agree, and avoids
 * accidentally executing files from served view/assets or other workspace dirs.
 */
export function runnerFilenameError(runner: string): string | null {
  const name = runner.trim();
  if (!name) return 'runner filename is empty';
  if (
    name === '.'
    || name === '..'
    || name.includes('/')
    || name.includes('\\')
    || name.includes('\0')
  ) {
    return `runner must be a filename under data/ (for example "refresh.mjs"), not a path: ${runner}`;
  }
  return null;
}

export interface SpaceDataSource {
  /** Stable id within the Space (e.g. "daily_pull"). */
  id: string;
  /** Script filename Clem authored; copied into the shadow workflow's scripts/. */
  runner?: string;
  /** OR a stored Composio op + frozen args (creds resolve server-side). */
  composioSlug?: string;
  composioArgs?: Record<string, unknown>;
  /** Optional cron for the daily/periodic refresh (omit = on-demand only). */
  schedule?: string;
  timezone?: string;
}

/**
 * A side-effecting action the view can trigger server-side (e.g. "send this
 * email via Outlook"). Declared by Clem at authoring time; the view supplies
 * the variable args at click time. Credentials resolve server-side — the view
 * never sees a token. This is the "two-way" half: a Workspace can act, not just
 * display. Mirrors SpaceDataSource but performs a side effect instead of
 * returning a dataset.
 */
export interface SpaceAction {
  id: string;
  label?: string;
  /** A Composio tool to call (e.g. OUTLOOK_SEND_EMAIL) — the common case. */
  composioSlug?: string;
  /** OR a runner script under data/ that performs the side effect. */
  runner?: string;
  /** Base args merged under the caller-supplied args (caller fills/overrides). */
  argsTemplate?: Record<string, unknown>;
  /** Hint to the view that it should confirm before firing (advisory). */
  confirm?: boolean;
}

export interface SpaceRevision {
  version: number;
  ts: string;
  bytes: number;
  /** Relative path to the snapshot under the Space dir. */
  file: string;
}

export type SpaceStatus = 'active' | 'paused' | 'archived';

export interface SpaceRecord {
  id: string;
  title: string;
  status: SpaceStatus;
  /** Relative to the Space dir; the served entry point. */
  viewEntry: string;
  dataSources: SpaceDataSource[];
  actions: SpaceAction[];
  reengage?: { triggers: string[]; guidance?: string };
  /** The chat/focus session that authored it — re-engagement target. */
  originSessionId?: string;
  focusId?: number | null;
  version: number;
  revisions: SpaceRevision[];
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
  lastRefreshedAt?: string;
  recipe?: string;
  /** Non-persisted diagnostics from normalizing a hand-written space.json. */
  manifestErrors?: string[];
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Atomic write: temp file in the same dir + rename (rename is atomic on POSIX). */
function atomicWrite(file: string, content: string): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, file);
}

/** Resolve the on-disk dir for a Space, guarding against traversal. */
export function resolveSpaceDir(slug: string): string {
  if (!isValidSpaceSlug(slug)) throw new Error(`invalid space slug: ${slug}`);
  const dir = path.resolve(SPACES_DIR, slug);
  // Defense in depth: the resolved dir must stay directly under SPACES_DIR.
  if (path.dirname(dir) !== path.resolve(SPACES_DIR)) {
    throw new Error(`space dir escaped SPACES_DIR: ${slug}`);
  }
  return dir;
}

/**
 * Resolve a path INSIDE a Space dir, guarding traversal. Used by the
 * data-store and routes for every fs touch.
 */
export function resolveInSpace(slug: string, rel: string): string {
  const base = resolveSpaceDir(slug);
  const target = path.resolve(base, rel);
  const relative = path.relative(base, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`path escaped space dir: ${slug} / ${rel}`);
  }
  return target;
}

function manifestPath(slug: string): string {
  return path.join(resolveSpaceDir(slug), 'space.json');
}

function asStr(v: unknown): string | undefined { return typeof v === 'string' && v ? v : undefined; }
function asObj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
}
function parseJsonObjField(
  v: unknown,
  label: string,
  manifestErrors: string[],
): Record<string, unknown> | undefined {
  if (asObj(v)) return v as Record<string, unknown>;
  if (typeof v === 'string' && v.trim()) {
    try {
      const p = JSON.parse(v);
      const obj = asObj(p);
      if (obj) return obj;
      manifestErrors.push(`${label} must be a JSON object, not ${Array.isArray(p) ? 'an array' : typeof p}.`);
    } catch (err) {
      manifestErrors.push(`${label} is not valid JSON: ${err instanceof Error ? err.message : String(err)}.`);
    }
  } else if (v != null) {
    manifestErrors.push(`${label} must be a JSON object string, not ${Array.isArray(v) ? 'an array' : typeof v}.`);
  }
  return undefined;
}

/** Normalize a data source, accepting BOTH the canonical camelCase shape and
 *  the snake_case tool-param names the agent may hand-write (composio_slug,
 *  composio_args_json). */
function normDataSource(raw: unknown, manifestErrors: string[], index: number): SpaceDataSource {
  const d = asObj(raw) ?? {};
  const ds: SpaceDataSource = { id: asStr(d.id) ?? '' };
  const label = `Data source "${ds.id || `#${index + 1}`}"`;
  const runner = asStr(d.runner);
  if (runner) {
    ds.runner = runner;
    const err = runnerFilenameError(runner);
    if (err) manifestErrors.push(`${label} ${err}.`);
  }
  const cs = asStr(d.composioSlug) ?? asStr(d.composio_slug); if (cs) ds.composioSlug = cs;
  if (d.composioArgs != null) {
    const ca = parseJsonObjField(d.composioArgs, `${label} composioArgs`, manifestErrors);
    if (ca) ds.composioArgs = ca;
  } else {
    const ca = parseJsonObjField(d.composio_args_json, `${label} composio_args_json`, manifestErrors);
    if (ca) ds.composioArgs = ca;
  }
  const sched = asStr(d.schedule); if (sched) ds.schedule = sched;
  const tz = asStr(d.timezone); if (tz) ds.timezone = tz;
  return ds;
}

/** Normalize an action, accepting canonical + snake_case (composio_slug,
 *  args_template_json) the agent may hand-write. */
function normAction(raw: unknown, manifestErrors: string[], index: number): SpaceAction {
  const a = asObj(raw) ?? {};
  const act: SpaceAction = { id: asStr(a.id) ?? '' };
  const label = asStr(a.label); if (label) act.label = label;
  const cs = asStr(a.composioSlug) ?? asStr(a.composio_slug); if (cs) act.composioSlug = cs;
  const diagnosticLabel = `Action "${act.id || `#${index + 1}`}"`;
  const runner = asStr(a.runner);
  if (runner) {
    act.runner = runner;
    const err = runnerFilenameError(runner);
    if (err) manifestErrors.push(`${diagnosticLabel} ${err}.`);
  }
  if (a.argsTemplate != null) {
    const tpl = parseJsonObjField(a.argsTemplate, `${diagnosticLabel} argsTemplate`, manifestErrors);
    if (tpl) act.argsTemplate = tpl;
  } else {
    const tpl = parseJsonObjField(a.args_template_json, `${diagnosticLabel} args_template_json`, manifestErrors);
    if (tpl) act.argsTemplate = tpl;
  }
  if (a.confirm === true) act.confirm = true;
  return act;
}

/**
 * Build a valid SpaceRecord from a parsed manifest, tolerating partial or
 * hand-written ones (the manifest is the source of truth — the agent often
 * writes it directly rather than via space_save). Backfills timestamps,
 * defaults arrays, and maps the snake_case tool-param field names + flat
 * reengage fields onto the canonical shape. Returns undefined if the id
 * doesn't match (not a real manifest for this slug).
 */
function normalizeManifest(raw: unknown, slug: string, fallbackTime: string): SpaceRecord | undefined {
  const m = asObj(raw);
  if (!m || m.id !== slug) return undefined;
  const manifestErrors: string[] = [];
  let reengage = asObj(m.reengage) as { triggers: string[]; guidance?: string } | undefined;
  if (!reengage && (Array.isArray(m.reengageTriggers) || m.reengageGuidance)) {
    reengage = {
      triggers: Array.isArray(m.reengageTriggers) ? (m.reengageTriggers as string[]) : [],
      guidance: asStr(m.reengageGuidance),
    };
  }
  const status = m.status === 'paused' || m.status === 'archived' ? m.status : 'active';
  const rec: SpaceRecord = {
    id: slug,
    title: asStr(m.title) ?? slug,
    status,
    viewEntry: asStr(m.viewEntry) ?? 'view/index.html',
    dataSources: Array.isArray(m.dataSources) ? m.dataSources.map((src, index) => normDataSource(src, manifestErrors, index)) : [],
    actions: Array.isArray(m.actions) ? m.actions.map((act, index) => normAction(act, manifestErrors, index)) : [],
    reengage,
    originSessionId: asStr(m.originSessionId),
    focusId: typeof m.focusId === 'number' ? m.focusId : null,
    version: typeof m.version === 'number' ? m.version : 1,
    revisions: Array.isArray(m.revisions) ? m.revisions as SpaceRevision[] : [],
    createdAt: asStr(m.createdAt) ?? fallbackTime,
    updatedAt: asStr(m.updatedAt) ?? fallbackTime,
    lastOpenedAt: asStr(m.lastOpenedAt),
    lastRefreshedAt: asStr(m.lastRefreshedAt),
    recipe: asStr(m.recipe),
  };
  if (manifestErrors.length > 0) rec.manifestErrors = manifestErrors;
  return rec;
}

function missingManifestFixes(
  errors: string[] | undefined,
  hasDataSources: boolean,
  hasActions: boolean,
): string[] {
  const missing: string[] = [];
  if (!errors || errors.length === 0) return missing;
  if (errors.some((e) => /^Data source /.test(e)) && !hasDataSources) missing.push('dataSources');
  if (errors.some((e) => /^Action /.test(e)) && !hasActions) missing.push('actions');
  return missing;
}

function declaredRunnerErrors(
  dataSources: SpaceDataSource[] | undefined,
  actions: SpaceAction[] | undefined,
): string[] {
  const errors: string[] = [];
  for (const [index, src] of (dataSources ?? []).entries()) {
    if (src.runner === undefined) continue;
    const err = runnerFilenameError(src.runner);
    if (err) errors.push(`Data source "${src.id || `#${index + 1}`}" ${err}.`);
  }
  for (const [index, action] of (actions ?? []).entries()) {
    if (action.runner === undefined) continue;
    const err = runnerFilenameError(action.runner);
    if (err) errors.push(`Action "${action.id || `#${index + 1}`}" ${err}.`);
  }
  return errors;
}

function assertValidDeclaredRunners(
  dataSources: SpaceDataSource[] | undefined,
  actions: SpaceAction[] | undefined,
): void {
  const errors = declaredRunnerErrors(dataSources, actions);
  if (errors.length > 0) {
    throw new Error(`invalid workspace runner declarations:\n- ${errors.join('\n- ')}`);
  }
}

function persistableRecord(record: SpaceRecord): Omit<SpaceRecord, 'manifestErrors'> {
  const { manifestErrors: _manifestErrors, ...persisted } = record;
  return persisted;
}

function readManifest(slug: string): SpaceRecord | undefined {
  try {
    const file = manifestPath(slug);
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    let fallbackTime: string;
    try { fallbackTime = statSync(file).mtime.toISOString(); } catch { fallbackTime = new Date(0).toISOString(); }
    return normalizeManifest(raw, slug, fallbackTime);
  } catch {
    return undefined;
  }
}

export interface SaveSpaceInput {
  id: string;
  title: string;
  status?: SpaceStatus;
  viewEntry?: string;
  dataSources?: SpaceDataSource[];
  actions?: SpaceAction[];
  reengage?: { triggers: string[]; guidance?: string };
  originSessionId?: string;
  focusId?: number | null;
  recipe?: string;
}

export class SpaceStore {
  /** List every Space by scanning each spaces/<slug>/space.json (newest first). */
  list(includeArchived = false): SpaceRecord[] {
    if (!existsSync(SPACES_DIR)) return [];
    const out: SpaceRecord[] = [];
    let entries: string[] = [];
    try {
      entries = readdirSync(SPACES_DIR);
    } catch {
      return [];
    }
    for (const name of entries) {
      if (!isValidSpaceSlug(name)) continue;
      let isDir = false;
      try { isDir = statSync(path.join(SPACES_DIR, name)).isDirectory(); } catch { continue; }
      if (!isDir) continue;
      const rec = readManifest(name);
      if (!rec) continue;
      if (!includeArchived && rec.status === 'archived') continue;
      out.push(rec);
    }
    return out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  get(slug: string): SpaceRecord | undefined {
    if (!isValidSpaceSlug(slug)) return undefined;
    return readManifest(slug);
  }

  /** Create or update a Space manifest (idempotent by slug). */
  save(input: SaveSpaceInput): SpaceRecord {
    if (!isValidSpaceSlug(input.id)) {
      throw new Error(`invalid space slug "${input.id}" — use lowercase kebab-case (2-63 chars).`);
    }
    const dir = resolveSpaceDir(input.id);
    ensureDir(dir);
    const now = new Date().toISOString();
    const existing = readManifest(input.id);
    const missingFixes = missingManifestFixes(
      existing?.manifestErrors,
      input.dataSources !== undefined,
      input.actions !== undefined,
    );
    if (missingFixes.length > 0) {
      throw new Error(`existing space manifest has invalid fields; pass corrected ${missingFixes.join(' and ')} before saving`);
    }
    assertValidDeclaredRunners(input.dataSources, input.actions);
    const record: SpaceRecord = {
      id: input.id,
      title: input.title.trim().slice(0, 200) || input.id,
      status: input.status ?? existing?.status ?? 'active',
      viewEntry: input.viewEntry ?? existing?.viewEntry ?? 'view/index.html',
      dataSources: input.dataSources ?? existing?.dataSources ?? [],
      actions: input.actions ?? existing?.actions ?? [],
      reengage: input.reengage ?? existing?.reengage,
      originSessionId: input.originSessionId ?? existing?.originSessionId,
      focusId: input.focusId ?? existing?.focusId ?? null,
      version: existing?.version ?? 1,
      revisions: existing?.revisions ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastOpenedAt: existing?.lastOpenedAt,
      lastRefreshedAt: existing?.lastRefreshedAt,
      recipe: input.recipe ?? existing?.recipe,
    };
    atomicWrite(manifestPath(input.id), JSON.stringify(persistableRecord(record), null, 2));
    indexWorkspaceRecord(record, {
      eventType: existing ? 'workspace_file_changed' : 'workspace_created',
      actor: 'space-store',
      payload: { mutation: existing ? 'save:update' : 'save:create' },
    });
    return record;
  }

  /** Patch a subset of fields on an existing Space. */
  update(slug: string, patch: Partial<Omit<SpaceRecord, 'id' | 'createdAt'>>): SpaceRecord | undefined {
    const existing = readManifest(slug);
    if (!existing) return undefined;
    const missingFixes = missingManifestFixes(
      existing.manifestErrors,
      'dataSources' in patch,
      'actions' in patch,
    );
    if (missingFixes.length > 0) return existing;
    assertValidDeclaredRunners(patch.dataSources, patch.actions);
    const record: SpaceRecord = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    delete record.manifestErrors;
    atomicWrite(manifestPath(slug), JSON.stringify(persistableRecord(record), null, 2));
    indexWorkspaceRecord(record, {
      eventType: 'workspace_file_changed',
      actor: 'space-store',
      payload: { mutation: 'update' },
    });
    return record;
  }

  /**
   * Snapshot the current view file into view-history/ and bump the version.
   * Call BEFORE overwriting view/index.html so a bad edit is always revertible.
   * No-op if there's no current view yet.
   */
  recordRevision(slug: string): SpaceRecord | undefined {
    const existing = readManifest(slug);
    if (!existing) return undefined;
    const viewFile = resolveInSpace(slug, existing.viewEntry);
    if (!existsSync(viewFile)) return existing;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const snapRel = path.join('view-history', `${ts}-v${existing.version}.html`);
    const snapAbs = resolveInSpace(slug, snapRel);
    ensureDir(path.dirname(snapAbs));
    const content = readFileSync(viewFile, 'utf-8');
    writeFileSync(snapAbs, content, 'utf-8');
    const revision: SpaceRevision = {
      version: existing.version,
      ts: new Date().toISOString(),
      bytes: Buffer.byteLength(content, 'utf-8'),
      file: snapRel,
    };
    if (existing.manifestErrors && existing.manifestErrors.length > 0) {
      try {
        const file = manifestPath(slug);
        const raw = JSON.parse(readFileSync(file, 'utf-8'));
        const obj = asObj(raw);
        if (!obj) return existing;
        obj.version = existing.version + 1;
        obj.revisions = [...existing.revisions, revision].slice(-50);
        obj.updatedAt = new Date().toISOString();
        atomicWrite(file, JSON.stringify(obj, null, 2));
        const updated = readManifest(slug) ?? existing;
        indexWorkspaceRecord(updated, {
          eventType: 'workspace_file_changed',
          actor: 'space-store',
          payload: { mutation: 'recordRevision' },
        });
        return updated;
      } catch {
        return existing;
      }
    }
    return this.update(slug, {
      version: existing.version + 1,
      revisions: [...existing.revisions, revision].slice(-50),
    });
  }

  /** Archive (soft) — keeps files for restore. */
  archive(slug: string): SpaceRecord | undefined {
    const existing = readManifest(slug);
    if (existing?.manifestErrors && existing.manifestErrors.length > 0) {
      try {
        const file = manifestPath(slug);
        const raw = JSON.parse(readFileSync(file, 'utf-8'));
        const obj = asObj(raw);
        if (!obj) return undefined;
        obj.status = 'archived';
        obj.updatedAt = new Date().toISOString();
        atomicWrite(file, JSON.stringify(obj, null, 2));
        const updated = readManifest(slug);
        if (updated) {
          indexWorkspaceRecord(updated, {
            eventType: 'workspace_file_changed',
            actor: 'space-store',
            payload: { mutation: 'archive' },
          });
        }
        return updated;
      } catch {
        return undefined;
      }
    }
    return this.update(slug, { status: 'archived' });
  }

  /** Hard-delete the entire Space directory. Irreversible. */
  remove(slug: string): boolean {
    if (!isValidSpaceSlug(slug)) return false;
    const dir = resolveSpaceDir(slug);
    if (!existsSync(dir)) return false;
    rmSync(dir, { recursive: true, force: true });
    deleteWorkspaceIndex(slug, { actor: 'space-store' });
    return true;
  }

  /** Rebuild the queryable DB index from manifest files. Manifests remain source of truth. */
  reindex(includeArchived = true): number {
    return reindexWorkspaceRecords(this.list(includeArchived), {
      actor: 'space-store',
      payload: { mutation: 'reindex' },
    });
  }
}

export const spaceStore = new SpaceStore();
