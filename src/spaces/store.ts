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
 *     space.json             # manifest/configuration source of truth
 *
 * Design choices:
 *  - The per-Space `space.json` is the manifest/configuration source of truth.
 *    Durable dataset history lives in workspaces.db; data.json is its current
 *    compatibility projection. Listing still scans manifests so file-authored
 *    Workspaces remain discoverable and self-healing.
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
import { BASE_DIR } from '../config.js';
import { purgeWorkspaceObservationMemory } from '../memory/workspace-observation-bridge.js';
import { deleteWorkspaceIndex, indexWorkspaceRecord, reindexWorkspaceRecords } from './workspace-db.js';

export const SPACES_DIR = path.join(BASE_DIR, 'spaces');
/** Hidden, invalid-as-a-slug directory used as the durable hard-delete marker. */
export const WORKSPACE_DELETE_QUARANTINE_DIR = path.join(
  SPACES_DIR,
  '.delete-quarantine',
);

/** Slug rules: lowercase kebab, 2–63 chars, no traversal. Path-safe by design. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;
const DELETE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidSpaceSlug(slug: string): boolean {
  return typeof slug === 'string' && SLUG_RE.test(slug);
}

export function workspaceDeletionQuarantinePath(
  slug: string,
  deletionId: string,
): string {
  if (!isValidSpaceSlug(slug)) throw new Error(`invalid workspace slug: ${slug}`);
  if (!DELETE_ID_RE.test(deletionId)) throw new Error('invalid workspace deletion id');
  return path.join(WORKSPACE_DELETE_QUARANTINE_DIR, `${slug}--${deletionId}`);
}

function quarantinedWorkspaceSlug(entry: string): string | null {
  const match = /^(.*)--([0-9a-f-]{36})$/i.exec(entry);
  if (!match || !isValidSpaceSlug(match[1]) || !DELETE_ID_RE.test(match[2])) return null;
  return match[1];
}

/**
 * Complete interrupted hard deletes. The hidden directory is the durable
 * intent marker: DB history is removed before its files, and any failure leaves
 * the marker in place so save/recreate remains fail-closed.
 */
export function recoverWorkspaceDeletionQuarantine(slug?: string): number {
  if (slug !== undefined && !isValidSpaceSlug(slug)) {
    throw new Error(`invalid workspace slug: ${slug}`);
  }
  if (!existsSync(WORKSPACE_DELETE_QUARANTINE_DIR)) return 0;
  let entries: string[];
  try {
    entries = readdirSync(WORKSPACE_DELETE_QUARANTINE_DIR);
  } catch (err) {
    throw new Error(`could not inspect Workspace deletion quarantine: ${(err as Error).message}`);
  }
  let recovered = 0;
  for (const entry of entries.sort()) {
    const quarantinedSlug = quarantinedWorkspaceSlug(entry);
    if (!quarantinedSlug || (slug !== undefined && quarantinedSlug !== slug)) continue;
    const quarantinedDir = path.join(WORKSPACE_DELETE_QUARANTINE_DIR, entry);
    let isDirectory: boolean;
    try {
      isDirectory = statSync(quarantinedDir).isDirectory();
    } catch (err) {
      throw new Error(
        `could not inspect quarantined Workspace "${quarantinedSlug}": ${(err as Error).message}`,
      );
    }
    if (!isDirectory) {
      throw new Error(`invalid deletion quarantine marker for Workspace "${quarantinedSlug}"`);
    }
    deleteWorkspaceIndex(quarantinedSlug, {
      actor: 'space-store-delete-recovery',
    });
    purgeWorkspaceObservationMemory(quarantinedSlug);
    rmSync(quarantinedDir, { recursive: true, force: true });
    recovered += 1;
  }
  return recovered;
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
  /** Explicit product contract: zero rows is a valid, usable state (for
   * example a new content calendar before its first draft). */
  allowEmpty?: boolean;
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

/** Shared product/UI bound for stable source and action identities. */
export const WORKSPACE_IDENTITY_MAX_CHARS = 120;
const WORKSPACE_IDENTITY_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

function workspaceIdentityDisplay(value: string, fallback: string): string {
  const printable = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '�');
  if (!printable) return fallback;
  return `${printable.slice(0, 80)}${printable.length > 80 ? '…' : ''}`;
}

/**
 * Validate the stable keys used to address Workspace data sources and actions.
 *
 * Keep this structural and deterministic: identities must already be canonical
 * at the authoring boundary so refreshes, projections, approvals, and actions
 * all address the same item. Map deliberately permits otherwise-safe keys such
 * as "__proto__", "constructor", and "prototype".
 */
export function workspaceIdentityErrors(
  dataSources: ReadonlyArray<{ id?: unknown }> | undefined,
  actions: ReadonlyArray<{ id?: unknown }> | undefined,
): string[] {
  const errors: string[] = [];

  const validate = (
    items: ReadonlyArray<{ id?: unknown }>,
    kind: 'Data source' | 'Action',
    duplicateKind: 'data source' | 'action',
  ): void => {
    const firstIndexById = new Map<string, number>();
    for (const [index, item] of items.entries()) {
      const raw = typeof item?.id === 'string' ? item.id : '';
      const canonical = raw.trim();
      const fallback = `#${index + 1}`;
      const label = workspaceIdentityDisplay(raw, fallback);
      const canonicalLabel = workspaceIdentityDisplay(canonical, fallback);

      if (!canonical) {
        errors.push(`${kind} "${label}" id must contain a non-whitespace value.`);
        continue;
      }
      if (raw !== canonical) {
        errors.push(
          `${kind} "${label}" id must not have leading or trailing whitespace (use "${canonicalLabel}").`,
        );
      }
      if (canonical.length > WORKSPACE_IDENTITY_MAX_CHARS) {
        errors.push(
          `${kind} "${label}" id exceeds the ${WORKSPACE_IDENTITY_MAX_CHARS} character limit.`,
        );
      }
      if (WORKSPACE_IDENTITY_CONTROL_RE.test(canonical)) {
        errors.push(`${kind} "${label}" id cannot contain control characters.`);
      }
      if (kind === 'Data source' && canonical === '_meta') {
        errors.push(`${kind} "${label}" uses reserved id "_meta".`);
      }

      const firstIndex = firstIndexById.get(canonical);
      if (firstIndex !== undefined) {
        errors.push(
          `Duplicate ${duplicateKind} id "${canonicalLabel}" (entries ${firstIndex + 1} and ${index + 1}).`,
        );
      } else {
        firstIndexById.set(canonical, index);
      }
    }
  };

  validate(dataSources ?? [], 'Data source', 'data source');
  validate(actions ?? [], 'Action', 'action');
  return errors;
}

export interface SpaceRevision {
  version: number;
  ts: string;
  bytes: number;
  /** Relative path to the snapshot under the Space dir. */
  file: string;
}

/**
 * The Workspace's durable north star. Unlike a transient chat plan, this lives
 * with the surface and survives compaction, brain changes, scheduled refreshes,
 * and later edits. It is deliberately small: the model owns the implementation;
 * the harness only preserves what "good" means and what must not drift.
 */
export interface SpaceContract {
  objective: string;
  successCriteria: string[];
  invariants: string[];
}

export type SpaceStatus = 'active' | 'paused' | 'archived';

export interface SpaceRecord {
  id: string;
  title: string;
  status: SpaceStatus;
  /** Living objective/spec for this long-lived collaboration surface. */
  contract?: SpaceContract;
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

export type SpaceFreshnessState = 'no_sources' | 'fresh' | 'stale' | 'never_refreshed';

export interface SpaceRunnerHealth {
  kind: 'dataSource' | 'action';
  id: string;
  runner: string;
  present: boolean;
  invalid?: string;
}

export interface SpaceHealthSnapshot {
  id: string;
  title: string;
  status: SpaceStatus;
  version: number;
  generatedAt: string;
  counts: {
    dataSources: number;
    actions: number;
    revisions: number;
    runners: number;
  };
  view: {
    entry: string;
    exists: boolean;
    bytes: number;
    mtime?: string;
  };
  runners: SpaceRunnerHealth[];
  freshness: {
    state: SpaceFreshnessState;
    lastRefreshedAt?: string;
    ageMs?: number;
    staleAfterMs: number;
  };
  issues: string[];
}

const DEFAULT_STALE_AFTER_MS = 36 * 60 * 60 * 1000;

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

const CONTRACT_OBJECTIVE_MAX_CHARS = 1_200;
const CONTRACT_LIST_MAX_ITEMS = 12;
const CONTRACT_ITEM_MAX_CHARS = 500;

function contractText(v: unknown, maxChars: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const text = v.replace(/\s+/g, ' ').trim().slice(0, maxChars);
  return text || undefined;
}

function contractList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    const text = contractText(raw, CONTRACT_ITEM_MAX_CHARS);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= CONTRACT_LIST_MAX_ITEMS) break;
  }
  return out;
}

/**
 * Merge a partial contract without inventing requirements. `undefined`/`null`
 * preserves the prior field; an explicit [] clears a list. A contract only
 * exists when it has a real objective, so legacy/blank Workspaces stay valid.
 */
export function mergeSpaceContract(
  current: SpaceContract | undefined,
  patch: {
    objective?: unknown;
    successCriteria?: unknown;
    invariants?: unknown;
  },
): SpaceContract | undefined {
  const requestedObjective = patch.objective == null
    ? undefined
    : contractText(patch.objective, CONTRACT_OBJECTIVE_MAX_CHARS);
  // A provided-but-blank objective means "objective unchanged", not "discard
  // the rest of this patch" — list edits must still apply to an existing
  // contract. Without any objective a contract still cannot come into being.
  const objective = requestedObjective || current?.objective;
  if (!objective) return current;
  const successCriteria = patch.successCriteria == null
    ? [...(current?.successCriteria ?? [])]
    : (contractList(patch.successCriteria) ?? [...(current?.successCriteria ?? [])]);
  const invariants = patch.invariants == null
    ? [...(current?.invariants ?? [])]
    : (contractList(patch.invariants) ?? [...(current?.invariants ?? [])]);
  return { objective, successCriteria, invariants };
}

function normalizeContract(m: Record<string, unknown>): SpaceContract | undefined {
  const nested = asObj(m.contract);
  return mergeSpaceContract(undefined, {
    objective: nested?.objective ?? m.objective,
    successCriteria:
      nested?.successCriteria
      ?? nested?.success_criteria
      ?? m.successCriteria
      ?? m.success_criteria,
    invariants: nested?.invariants ?? nested?.guardrails ?? m.invariants ?? m.guardrails,
  });
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
  if (d.allowEmpty === true || d.allow_empty === true) ds.allowEmpty = true;
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
    contract: normalizeContract(m),
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
  manifestErrors.push(...workspaceIdentityErrors(rec.dataSources, rec.actions));
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

function assertValidWorkspaceIdentities(
  dataSources: SpaceDataSource[] | undefined,
  actions: SpaceAction[] | undefined,
): void {
  const errors = workspaceIdentityErrors(dataSources, actions);
  if (errors.length > 0) {
    throw new Error(`invalid workspace identities:\n- ${errors.join('\n- ')}`);
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

function declaredRunnerHealth(record: SpaceRecord): SpaceRunnerHealth[] {
  const out: SpaceRunnerHealth[] = [];
  for (const src of record.dataSources) {
    if (!src.runner) continue;
    const invalid = runnerFilenameError(src.runner) ?? undefined;
    let present = false;
    if (!invalid) {
      try { present = existsSync(resolveInSpace(record.id, path.join('data', src.runner))); } catch { present = false; }
    }
    out.push({ kind: 'dataSource', id: src.id, runner: src.runner, present, ...(invalid ? { invalid } : {}) });
  }
  for (const action of record.actions) {
    if (!action.runner) continue;
    const invalid = runnerFilenameError(action.runner) ?? undefined;
    let present = false;
    if (!invalid) {
      try { present = existsSync(resolveInSpace(record.id, path.join('data', action.runner))); } catch { present = false; }
    }
    out.push({ kind: 'action', id: action.id, runner: action.runner, present, ...(invalid ? { invalid } : {}) });
  }
  return out;
}

function readDataMeta(record: SpaceRecord): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(resolveInSpace(record.id, 'data.json'), 'utf-8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const meta = (raw as Record<string, unknown>)._meta;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
    return meta as Record<string, unknown>;
  } catch {
    return {};
  }
}

function sourceFailureFromMeta(meta: Record<string, unknown>, sourceId: string): { error?: string; refreshedAt?: string } | null {
  const entry = meta[sourceId];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const rec = entry as Record<string, unknown>;
  if (rec.ok !== false) return null;
  return {
    error: typeof rec.error === 'string' && rec.error.trim() ? rec.error.trim() : undefined,
    refreshedAt: typeof rec.refreshedAt === 'string' && rec.refreshedAt.trim() ? rec.refreshedAt.trim() : undefined,
  };
}

function sourcePendingApprovalFromMeta(
  meta: Record<string, unknown>,
  sourceId: string,
): { approvalId?: string; refreshedAt?: string } | null {
  const entry = meta[sourceId];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const rec = entry as Record<string, unknown>;
  if (rec.ok !== null || rec.status !== 'awaiting_approval') return null;
  return {
    approvalId: typeof rec.approvalId === 'string' && rec.approvalId.trim() ? rec.approvalId.trim() : undefined,
    refreshedAt: typeof rec.refreshedAt === 'string' && rec.refreshedAt.trim() ? rec.refreshedAt.trim() : undefined,
  };
}

export function buildSpaceHealthSnapshot(
  record: SpaceRecord,
  opts: { now?: number; staleAfterMs?: number } = {},
): SpaceHealthSnapshot {
  const now = opts.now ?? Date.now();
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const issues: string[] = [...(record.manifestErrors ?? [])];
  let view: SpaceHealthSnapshot['view'] = { entry: record.viewEntry, exists: false, bytes: 0 };
  try {
    const viewFile = resolveInSpace(record.id, record.viewEntry);
    const st = statSync(viewFile);
    if (st.isFile()) {
      view = {
        entry: record.viewEntry,
        exists: true,
        bytes: st.size,
        mtime: st.mtime.toISOString(),
      };
    }
  } catch {
    view = { entry: record.viewEntry, exists: false, bytes: 0 };
  }
  if (!view.exists) issues.push(`view entry "${record.viewEntry}" is missing`);

  const runners = declaredRunnerHealth(record);
  for (const runner of runners) {
    const label = runner.kind === 'dataSource' ? 'data source' : 'action';
    if (runner.invalid) {
      issues.push(`${label} "${runner.id}" runner "${runner.runner}" is invalid: ${runner.invalid}`);
    } else if (!runner.present) {
      issues.push(`${label} "${runner.id}" declares data/${runner.runner}, but the file is missing`);
    }
  }

  const dataMeta = readDataMeta(record);
  for (const source of record.dataSources) {
    const pending = sourcePendingApprovalFromMeta(dataMeta, source.id);
    if (pending) {
      const when = pending.refreshedAt ? ` since ${pending.refreshedAt}` : '';
      const approval = pending.approvalId ? ` (${pending.approvalId})` : '';
      issues.push(`data source "${source.id}" is awaiting pinned-entrypoint approval${when}${approval}`);
      continue;
    }
    const failure = sourceFailureFromMeta(dataMeta, source.id);
    if (!failure) continue;
    const when = failure.refreshedAt ? ` at ${failure.refreshedAt}` : '';
    const why = failure.error ? `: ${failure.error}` : '';
    issues.push(`data source "${source.id}" last refresh failed${when}${why}`);
  }

  let freshness: SpaceHealthSnapshot['freshness'];
  if (record.dataSources.length === 0) {
    freshness = { state: 'no_sources', staleAfterMs };
  } else if (!record.lastRefreshedAt) {
    freshness = { state: 'never_refreshed', staleAfterMs };
    issues.push('data sources have never refreshed');
  } else {
    const parsed = Date.parse(record.lastRefreshedAt);
    const ageMs = Number.isFinite(parsed) ? Math.max(0, now - parsed) : undefined;
    const state: SpaceFreshnessState = ageMs !== undefined && ageMs <= staleAfterMs ? 'fresh' : 'stale';
    freshness = { state, lastRefreshedAt: record.lastRefreshedAt, ...(ageMs !== undefined ? { ageMs } : {}), staleAfterMs };
    if (state === 'stale') issues.push(`last data refresh is older than ${Math.round(staleAfterMs / 3_600_000)} hours`);
  }

  return {
    id: record.id,
    title: record.title,
    status: record.status,
    version: record.version,
    generatedAt: new Date(now).toISOString(),
    counts: {
      dataSources: record.dataSources.length,
      actions: record.actions.length,
      revisions: record.revisions.length,
      runners: runners.length,
    },
    view,
    runners,
    freshness,
    issues,
  };
}

export interface SaveSpaceInput {
  id: string;
  title: string;
  status?: SpaceStatus;
  contract?: SpaceContract;
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
    try {
      recoverWorkspaceDeletionQuarantine();
    } catch {
      // A failed recovery marker remains hidden and durable. Recreate is still
      // blocked by save(), while unrelated Workspaces remain listable.
    }
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
    // A prior process may have stopped after moving this slug into quarantine.
    // Complete its DB cascade before a new generation can claim the same slug.
    recoverWorkspaceDeletionQuarantine(input.id);
    const dir = resolveSpaceDir(input.id);
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
    const dataSources = input.dataSources ?? existing?.dataSources ?? [];
    const actions = input.actions ?? existing?.actions ?? [];
    assertValidWorkspaceIdentities(dataSources, actions);
    assertValidDeclaredRunners(input.dataSources, input.actions);
    const record: SpaceRecord = {
      id: input.id,
      title: input.title.trim().slice(0, 200) || input.id,
      status: input.status ?? existing?.status ?? 'active',
      contract: input.contract ?? existing?.contract,
      viewEntry: input.viewEntry ?? existing?.viewEntry ?? 'view/index.html',
      dataSources,
      actions,
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
    ensureDir(dir);
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
    assertValidWorkspaceIdentities(
      patch.dataSources ?? existing.dataSources,
      patch.actions ?? existing.actions,
    );
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

  /**
   * Hard-delete a Workspace without allowing temporal history to reattach.
   *
   * Files first move atomically to a hidden quarantine. The directory is
   * removed only after both SQLite stores confirm their cascading deletes.
   * A Workspace DB failure restores the original directory where possible.
   * Once that first DB commits, a memory purge failure leaves the quarantine
   * marker in place so restart recovery finishes before slug reuse.
   */
  remove(slug: string): boolean {
    if (!isValidSpaceSlug(slug)) return false;
    const dir = resolveSpaceDir(slug);
    let recovered = 0;
    try {
      recovered = recoverWorkspaceDeletionQuarantine(slug);
    } catch {
      return false;
    }
    if (!existsSync(dir)) return recovered > 0;
    const deletionId = randomUUID();
    const quarantinedDir = workspaceDeletionQuarantinePath(slug, deletionId);
    try {
      ensureDir(WORKSPACE_DELETE_QUARANTINE_DIR);
      renameSync(dir, quarantinedDir);
    } catch {
      return false;
    }

    let durableDeleteCommitted = false;
    try {
      deleteWorkspaceIndex(slug, { actor: 'space-store' });
      durableDeleteCommitted = true;
      purgeWorkspaceObservationMemory(slug);
      rmSync(quarantinedDir, { recursive: true, force: true });
      return true;
    } catch {
      if (!durableDeleteCommitted && existsSync(quarantinedDir) && !existsSync(dir)) {
        try {
          renameSync(quarantinedDir, dir);
        } catch {
          // Leave the marker in quarantine. save(slug) must finish the durable
          // delete before the slug can ever be reused.
        }
      }
      return false;
    }
  }

  /** Rebuild the queryable DB index from manifest files. Manifests remain source of truth. */
  reindex(includeArchived = true): number {
    return reindexWorkspaceRecords(this.list(includeArchived), {
      actor: 'space-store',
      payload: { mutation: 'reindex' },
    });
  }

  health(slug: string): SpaceHealthSnapshot | undefined {
    const rec = this.get(slug);
    return rec ? buildSpaceHealthSnapshot(rec) : undefined;
  }

  listHealth(includeArchived = false): SpaceHealthSnapshot[] {
    return this.list(includeArchived).map((rec) => buildSpaceHealthSnapshot(rec));
  }
}

export const spaceStore = new SpaceStore();
