import { createHash, randomUUID } from 'node:crypto';
import { getSession, listEvents, openEventLog } from './eventlog.js';
import { toolOutputLooksSuccessful } from './tool-evidence.js';
import type { ShellExecutionOutcome } from '../shell-execution-outcome.js';

/**
 * Durable artifact transactions for create-style tool calls.
 *
 * A successful provider create is not just prose in a tool result: it occupies
 * a named output slot for the run.  Claiming the slot before dispatch closes
 * the retry/crash race that created three Google Docs in the 2026-07-16 live
 * incident.  A retry must reuse a bound resource or verify an uncertain claim;
 * it may never blindly create a replacement.
 *
 * The table lives beside harness sessions because the transaction lifetime is
 * a run/session concern.  Durable memory may project a bound resource later,
 * but memory recall is never the authority for whether a write may repeat.
 */

export type ArtifactStatus = 'pending' | 'bound' | 'uncertain';
export type ArtifactKind = 'google_doc' | 'site' | 'file' | 'resource';

export interface ArtifactIntent {
  kind: ArtifactKind;
  provider: string;
  /** Stable output slot within a session. Direct provider calls default to the
   * primary slot; high-level tools should pass an explicit key for multi-artifact
   * work (for example `proposal`, `appendix`, `client-copy`). */
  slotKey: string;
  title?: string;
  createShape: string;
}

export interface RunArtifact {
  id: string;
  sessionId: string;
  /** Stable logical run/turn identity. A durable chat session can contain many
   * independent requests, so idempotency must never be keyed to session alone. */
  runScopeId: string;
  slotKey: string;
  kind: ArtifactKind;
  provider: string;
  title: string | null;
  createShape: string;
  status: ArtifactStatus;
  resourceId: string | null;
  uri: string | null;
  sourceCallId: string | null;
  /** A create response supplied a stable pointer, but only an independent
   * provider read-back proves that exact pointer is readable. This is binding
   * verification, not a claim that the artifact's full contents were QA'd. */
  bindingVerifiedAt: string | null;
  verificationCallId: string | null;
  verificationShape: string | null;
  verificationFingerprint: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactResource {
  resourceId?: string;
  uri?: string;
  title?: string;
}

export interface ArtifactVerificationIntent {
  kind: Extract<ArtifactKind, 'google_doc' | 'site'>;
  provider: 'Google Docs' | 'Netlify';
  /** Exact provider id requested by the read-back call. A title, list query,
   * ambient cwd, or URL-only probe is deliberately insufficient. */
  resourceId: string;
  verificationShape: string;
}

export type ArtifactScopeLineageReason =
  | 'new_run'
  | 'same_user_turn_fallback'
  | 'manual_continue'
  | 'restart_recovery'
  | 'artifact_verification_continue'
  | 'awaiting_user_input_reply';

export interface ArtifactRunScope {
  sessionId: string;
  attemptScopeId: string;
  rootScopeId: string;
  sourceUserSeq: number;
  reason: ArtifactScopeLineageReason;
}

export type ArtifactClaim =
  | { acquired: true; artifact: RunArtifact }
  | { acquired: false; artifact: RunArtifact };

export class ArtifactLineagePersistenceError extends Error {
  constructor(public readonly sessionId: string, cause: unknown) {
    super(`Could not persist one authoritative artifact root for session ${sessionId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'ArtifactLineagePersistenceError';
    this.cause = cause;
  }
}

interface ArtifactRow {
  id: string;
  session_id: string;
  run_scope_id: string;
  slot_key: string;
  kind: ArtifactKind;
  provider: string;
  title: string | null;
  create_shape: string;
  status: ArtifactStatus;
  resource_id: string | null;
  uri: string | null;
  source_call_id: string | null;
  binding_verified_at: string | null;
  verification_call_id: string | null;
  verification_shape: string | null;
  verification_fingerprint: string | null;
  created_at: string;
  updated_at: string;
}

let schemaReady = false;
let schemaReadyDb: ReturnType<typeof openEventLog> | null = null;

function ensureSchema(): void {
  const db = openEventLog();
  // resetEventLog/closeEventLog replace the SQLite handle. A process-global
  // boolean alone then lies about schema readiness and the first later tool
  // call fails with "no such table". Cache against the concrete handle so a
  // reopened database self-initializes exactly once without a per-call query.
  if (schemaReady && schemaReadyDb === db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_artifacts (
      id             TEXT PRIMARY KEY,
      session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      run_scope_id   TEXT NOT NULL,
      slot_key       TEXT NOT NULL,
      kind           TEXT NOT NULL,
      provider       TEXT NOT NULL,
      title          TEXT,
      create_shape   TEXT NOT NULL,
      status         TEXT NOT NULL CHECK (status IN ('pending','bound','uncertain')),
      resource_id    TEXT,
      uri            TEXT,
      source_call_id TEXT,
      binding_verified_at TEXT,
      verification_call_id TEXT,
      verification_shape TEXT,
      verification_fingerprint TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      UNIQUE(session_id, run_scope_id, slot_key)
    );
    CREATE INDEX IF NOT EXISTS idx_run_artifacts_session
      ON run_artifacts(session_id, run_scope_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_run_artifacts_resource
      ON run_artifacts(provider, resource_id);
    CREATE TABLE IF NOT EXISTS artifact_run_scopes (
      session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      attempt_scope_id TEXT NOT NULL,
      root_scope_id    TEXT NOT NULL,
      source_user_seq  INTEGER NOT NULL DEFAULT 0,
      reason           TEXT NOT NULL,
      created_at       TEXT NOT NULL,
      PRIMARY KEY(session_id, attempt_scope_id)
    );
    CREATE INDEX IF NOT EXISTS idx_artifact_run_scopes_user
      ON artifact_run_scopes(session_id, source_user_seq DESC, created_at DESC);
    CREATE TABLE IF NOT EXISTS artifact_source_roots (
      session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      source_user_seq INTEGER NOT NULL,
      root_scope_id   TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      PRIMARY KEY(session_id, source_user_seq)
    );
  `);
  // The artifact ledger first shipped as a lazy table outside eventlog's
  // numbered migrations. Existing installs may therefore already have the
  // original table. Add verification proof columns conservatively in place;
  // never rebuild/drop a table that may contain the only pointer to a remote
  // resource. Re-check after an ALTER error so two startup paths racing the
  // same additive migration are harmless.
  const ensureColumn = (name: string, declaration: string): void => {
    const hasColumn = (): boolean => (db.prepare('PRAGMA table_info(run_artifacts)').all() as Array<{ name: string }>)
      .some((column) => column.name === name);
    if (hasColumn()) return;
    try {
      db.exec(`ALTER TABLE run_artifacts ADD COLUMN ${declaration}`);
    } catch (error) {
      if (!hasColumn()) throw error;
    }
  };
  ensureColumn('binding_verified_at', 'binding_verified_at TEXT');
  ensureColumn('verification_call_id', 'verification_call_id TEXT');
  ensureColumn('verification_shape', 'verification_shape TEXT');
  ensureColumn('verification_fingerprint', 'verification_fingerprint TEXT');
  // Older ledgers used only the attempt-scoped mapping. Seed one canonical
  // source authority from the earliest mapping so an additive upgrade retains
  // its established root while closing the cross-lane check-then-insert race.
  db.exec(`
    INSERT OR IGNORE INTO artifact_source_roots
      (session_id, source_user_seq, root_scope_id, created_at)
    SELECT s.session_id, s.source_user_seq, s.root_scope_id, s.created_at
      FROM artifact_run_scopes s
     WHERE s.source_user_seq > 0
       AND EXISTS (
         SELECT 1 FROM sessions owner WHERE owner.id = s.session_id
       )
       AND NOT EXISTS (
         SELECT 1
           FROM artifact_run_scopes earlier
          WHERE earlier.session_id = s.session_id
            AND earlier.source_user_seq = s.source_user_seq
            AND (
              earlier.created_at < s.created_at
              OR (earlier.created_at = s.created_at AND earlier.rowid < s.rowid)
            )
       );
  `);
  schemaReady = true;
  schemaReadyDb = db;
}

function fromRow(row: ArtifactRow): RunArtifact {
  return {
    id: row.id,
    sessionId: row.session_id,
    runScopeId: row.run_scope_id,
    slotKey: row.slot_key,
    kind: row.kind,
    provider: row.provider,
    title: row.title,
    createShape: row.create_shape,
    status: row.status,
    resourceId: row.resource_id,
    uri: row.uri,
    sourceCallId: row.source_call_id,
    bindingVerifiedAt: row.binding_verified_at ?? null,
    verificationCallId: row.verification_call_id ?? null,
    verificationShape: row.verification_shape ?? null,
    verificationFingerprint: row.verification_fingerprint ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function cleanKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 96);
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function toolTail(name: string): string {
  return name.replace(/^mcp__/, '').split('__').at(-1) ?? name;
}

function innerToolCall(toolName: string, rawArgs: unknown): { shape: string; args: Record<string, unknown> } {
  const outer = parseObject(rawArgs);
  const tail = toolTail(toolName);
  if (tail === 'composio_execute_tool' || toolName === 'composio_execute_tool') {
    const shape = String(outer.tool_slug ?? '').trim().toUpperCase();
    return { shape, args: parseObject(outer.arguments) };
  }
  // Keep the MCP provider namespace for native tools.  Looking only at the
  // final segment (`create_document`) loses the fact that this is a Google
  // Docs create and makes production-shaped MCP names invisible here.
  return { shape: toolName.replace(/^mcp__/, '').trim().toUpperCase(), args: outer };
}

function stringField(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function explicitSlot(args: Record<string, unknown>, kind: ArtifactKind): string {
  const key = stringField(args, ['artifact_key', 'artifactKey', 'output_key', 'outputKey']);
  return `${kind}:${cleanKey(key || 'primary') || 'primary'}`;
}

function hasExplicitSlot(rawArgs: unknown): boolean {
  const args = parseObject(rawArgs);
  const nested = parseObject(args.arguments);
  return Boolean(
    stringField(args, ['artifact_key', 'artifactKey', 'output_key', 'outputKey'])
    ?? stringField(nested, ['artifact_key', 'artifactKey', 'output_key', 'outputKey']),
  );
}

/** Multiple remote outputs are opt-in from the concrete objective. A generic
 * multi-item research task must not silently turn renamed retries into new
 * documents. When the user explicitly asks for multiple docs/sites, the
 * provider title/name becomes a deterministic output identity so legitimate
 * siblings no longer collide in the `primary` slot. */
export function objectiveRequestsMultipleArtifacts(objective: string, kind: ArtifactKind): boolean {
  const text = objective.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!text) return false;
  const count = '(?:2|3|4|5|6|7|8|9|10|two|three|four|five|six|seven|eight|nine|ten|multiple|several)';
  const noun = kind === 'google_doc'
    ? '(?:google\\s+)?(?:docs?|documents?)'
    : kind === 'site'
      ? '(?:web\\s*)?sites?'
      : kind === 'file'
        ? 'files?'
        : 'resources?';
  return new RegExp(`\\b${count}\\s+(?:separate\\s+|distinct\\s+|individual\\s+)?${noun}\\b`, 'i').test(text)
    || new RegExp(`\\b(?:separate|distinct|individual)\\s+${noun}\\b`, 'i').test(text)
    || new RegExp(`\\b${noun}\\s+(?:for\\s+each|per)\\b`, 'i').test(text);
}

/** Expand an implicit primary slot only when the objective explicitly names
 * multiple artifacts of this kind AND the call carries a stable provider
 * title/name. Mutable content/command args are never an output identity: if no
 * stable key exists we fail closed on `primary`, so a rewritten retry cannot
 * create a sibling. */
export function scopeArtifactIntentForObjective(
  intent: ArtifactIntent,
  objective: string,
  rawArgs: unknown,
): ArtifactIntent {
  if (!intent.slotKey.endsWith(':primary') || hasExplicitSlot(rawArgs)) return intent;
  if (!objectiveRequestsMultipleArtifacts(objective, intent.kind)) return intent;
  const identity = cleanKey(intent.title ?? '');
  return identity ? { ...intent, slotKey: `${intent.kind}:${identity}` } : intent;
}

function normalizedShape(shape: string): string {
  return shape
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Classify only production-shaped, exact-id provider reads. Broad search/list,
 * metadata fragments (for example END_INDEX), ambient `netlify status`, and
 * HTTP probes are not binding proof and intentionally return null. */
export function artifactVerificationIntentForTool(
  toolName: string,
  rawArgs: unknown,
): ArtifactVerificationIntent | null {
  const { shape, args } = innerToolCall(toolName, rawArgs);
  const normalized = normalizedShape(shape);

  if (
    /^(?:CX_)?GOOGLE_?DOCS?_(?:GET_DOCUMENT(?:_BY_ID|_PLAINTEXT)?|READ_DOCUMENT)$/.test(normalized)
  ) {
    const resourceId = stringField(args, [
      'document_id', 'documentId', 'documentid', 'doc_id', 'docId', 'id',
    ]);
    if (!resourceId) return null;
    return {
      kind: 'google_doc',
      provider: 'Google Docs',
      resourceId,
      verificationShape: normalized,
    };
  }

  if (/^(?:CX_)?NETLIFY_(?:GET_SITE|GETSITE)$/.test(normalized)) {
    const resourceId = stringField(args, ['site_id', 'siteId', 'siteid', 'id']);
    if (!resourceId) return null;
    return {
      kind: 'site', provider: 'Netlify', resourceId, verificationShape: normalized,
    };
  }

  if (toolTail(toolName) === 'run_shell_command') {
    const command = stringField(args, ['command']) ?? '';
    const exactGetter = /\b(?:npx\s+(?:--yes\s+)?(?:@netlify\/cli|netlify-cli)\s+|netlify(?:-cli)?\s+)api\s+getsite\b/i;
    if (!exactGetter.test(command)) return null;
    // A read-back hidden in a compound create/deploy command is not an
    // independent observation and must never certify the binding.
    if (/\bnetlify(?:-cli)?\b[^\n;|&]*(?:sites?:create|site:create|deploy|publish)\b/i.test(command)) return null;
    const resourceId = command.match(/["']?site_id["']?\s*:\s*["']([A-Za-z0-9_-]+)["']/i)?.[1];
    if (!resourceId) return null;
    return {
      kind: 'site',
      provider: 'Netlify',
      resourceId,
      verificationShape: 'NETLIFY_API_GETSITE',
    };
  }

  return null;
}

/** Identify create operations that must be transactional. Unknown tools remain
 * outside the ledger; a false positive here would remove legitimate features. */
export function artifactIntentForTool(toolName: string, rawArgs: unknown): ArtifactIntent | null {
  const { shape, args } = innerToolCall(toolName, rawArgs);
  const upper = shape.toUpperCase();

  if (
    /GOOGLE.*DOC/.test(upper)
    && /CREATE/.test(upper)
    && /DOCUMENT|DOC/.test(upper)
    && !/TAB|HEADER|FOOTER|FOOTNOTE|RANGE|BULLET|TABLE/.test(upper)
  ) {
    return {
      kind: 'google_doc',
      provider: 'Google Docs',
      slotKey: explicitSlot(args, 'google_doc'),
      title: stringField(args, ['title', 'name', 'document_title', 'documentTitle']),
      createShape: upper,
    };
  }

  if (toolTail(toolName) === 'run_shell_command') {
    const command = stringField(args, ['command']) ?? '';
    if (/\bnetlify(?:-cli)?\b[^\n]*(?:sites?:create|site:create|sites:create)\b/i.test(command)) {
      const name = command.match(/--(?:name|site)\s+(?:["']([^"']+)["']|([^\s]+))/i);
      let resolvedName = name?.[1] ?? name?.[2];
      const variable = resolvedName?.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/)?.[1];
      if (variable) {
        const assignment = command.match(new RegExp(`(?:^|[;\\n]\\s*)(?:export\\s+)?${variable}\\s*=\\s*(?:["']([^"']+)["']|([^;\\s]+))`));
        resolvedName = assignment?.[1] ?? assignment?.[2];
      }
      return {
        kind: 'site',
        provider: 'Netlify',
        slotKey: explicitSlot(args, 'site'),
        title: resolvedName && !resolvedName.startsWith('$') ? resolvedName : undefined,
        createShape: 'NETLIFY_SITE_CREATE',
      };
    }
  }

  return null;
}

export function getRunArtifact(sessionId: string, slotKey: string, runScopeId = sessionId): RunArtifact | null {
  ensureSchema();
  const row = openEventLog().prepare(
    'SELECT * FROM run_artifacts WHERE session_id = ? AND run_scope_id = ? AND slot_key = ?',
  ).get(sessionId, runScopeId, slotKey) as ArtifactRow | undefined;
  return row ? fromRow(row) : null;
}

export function listRunArtifacts(sessionId: string, runScopeId?: string): RunArtifact[] {
  ensureSchema();
  const rows = runScopeId
    ? openEventLog().prepare(
      'SELECT * FROM run_artifacts WHERE session_id = ? AND run_scope_id = ? ORDER BY created_at ASC, rowid ASC',
    ).all(sessionId, runScopeId)
    : openEventLog().prepare(
      'SELECT * FROM run_artifacts WHERE session_id = ? ORDER BY created_at ASC, rowid ASC',
    ).all(sessionId);
  return (rows as ArtifactRow[]).map(fromRow);
}

/** Rows that prevent a clean artifact-backed completion. `bound` without a
 * provider read-back is included alongside pending/uncertain attempts. */
export function listUnverifiedRunArtifacts(sessionId: string, runScopeId?: string): RunArtifact[] {
  return listRunArtifacts(sessionId, runScopeId).filter(
    (artifact) => artifact.status !== 'bound' || !artifact.bindingVerifiedAt,
  );
}

interface ArtifactRunScopeRow {
  session_id: string;
  attempt_scope_id: string;
  root_scope_id: string;
  source_user_seq: number;
  reason: ArtifactScopeLineageReason;
}

function scopeFromRow(row: ArtifactRunScopeRow): ArtifactRunScope {
  return {
    sessionId: row.session_id,
    attemptScopeId: row.attempt_scope_id,
    rootScopeId: row.root_scope_id,
    sourceUserSeq: row.source_user_seq,
    reason: row.reason,
  };
}

function continuationControl(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[.!]+$/g, '').replace(/\s+/g, ' ');
  return new Set([
    'continue', 'resume', 'proceed', 'go ahead', 'keep going', 'retry',
    'yes', 'yep', 'yeah', 'ok', 'okay',
  ]).has(normalized)
    || text.startsWith('You hit a step / time budget on the previous turn and the user has now replied `continue`.')
    || text.startsWith('The previous run in this session was interrupted by a daemon restart and has been automatically resumed.');
}

function mostRecentArtifactRoot(sessionId: string, beforeUserSeq: number): string | null {
  ensureSchema();
  const db = openEventLog();
  const mapped = db.prepare(`
    SELECT root_scope_id
      FROM artifact_run_scopes
     WHERE session_id = ? AND source_user_seq < ?
     ORDER BY source_user_seq DESC, created_at DESC
     LIMIT 1
  `).get(sessionId, beforeUserSeq) as { root_scope_id: string } | undefined;
  if (mapped?.root_scope_id) return mapped.root_scope_id;
  const artifact = db.prepare(`
    SELECT run_scope_id
      FROM run_artifacts
     WHERE session_id = ?
     ORDER BY updated_at DESC, rowid DESC
     LIMIT 1
  `).get(sessionId) as { run_scope_id: string } | undefined;
  return artifact?.run_scope_id ?? null;
}

/** Resolve an ephemeral lane/attempt scope to one durable artifact root.
 *
 * - two lanes serving the same recorded user turn share a root (fallback);
 * - a structured budget/restart/artifact-verification continuation inherits the
 *   previous root, but an unrelated new message does not;
 * - the mapping is durable, so a daemon restart cannot reset idempotency.
 *
 * This is deliberately independent of model prose and broad keyword matching:
 * lineage requires both a typed prior terminal state and a narrow continuation
 * control/current recovery directive. */
export function resolveArtifactRunScopeId(
  sessionId: string,
  attemptScopeId: string,
  sourceUserSeq?: number,
): string {
  ensureSchema();
  const db = openEventLog();
  const existing = db.prepare(`
    SELECT session_id, attempt_scope_id, root_scope_id, source_user_seq, reason
      FROM artifact_run_scopes
     WHERE session_id = ? AND attempt_scope_id = ?
  `).get(sessionId, attemptScopeId) as ArtifactRunScopeRow | undefined;
  if (existing) return existing.root_scope_id;

  let latestUserSeq = 0;
  let latestUserText = '';
  let priorCompletion: {
    reason?: unknown;
    artifactVerification?: unknown;
    artifactRunScopeId?: unknown;
  } | undefined;
  let priorCompletionSeq = 0;
  let immediateAwaitingInputReply = false;
  try {
    const events = listEvents(sessionId, {
      types: ['user_input_received', 'conversation_completed'],
      desc: false,
    });
    const users = events.filter((event) => event.type === 'user_input_received');
    const latestUser = Number.isSafeInteger(sourceUserSeq) && (sourceUserSeq ?? 0) > 0
      ? users.find((event) => event.seq === sourceUserSeq)
      : users.at(-1);
    latestUserSeq = latestUser?.seq ?? 0;
    latestUserText = String((latestUser?.data as { text?: unknown } | undefined)?.text ?? '');
    const priorCompletionEvent = events
      .filter((event) => event.type === 'conversation_completed' && event.seq < latestUserSeq)
      .at(-1);
    priorCompletionSeq = priorCompletionEvent?.seq ?? 0;
    priorCompletion = priorCompletionEvent?.data as {
      reason?: unknown;
      artifactVerification?: unknown;
      artifactRunScopeId?: unknown;
    } | undefined;
    immediateAwaitingInputReply = priorCompletion?.reason === 'awaiting_user_input'
      && priorCompletionSeq > 0
      && !users.some((event) => event.seq > priorCompletionSeq && event.seq < latestUserSeq);
  } catch { /* a missing event trail starts a conservative new root */ }

  const sameTurn = latestUserSeq > 0
    ? db.prepare(`
      SELECT root_scope_id
        FROM artifact_source_roots
       WHERE session_id = ? AND source_user_seq = ?
    `).get(sessionId, latestUserSeq) as { root_scope_id: string } | undefined
    : undefined;

  let rootScopeId = sameTurn?.root_scope_id ?? attemptScopeId;
  let reason: ArtifactScopeLineageReason = sameTurn ? 'same_user_turn_fallback' : 'new_run';
  if (!sameTurn && (continuationControl(latestUserText) || immediateAwaitingInputReply)) {
    const terminalReason = String(priorCompletion?.reason ?? '');
    const verification = priorCompletion?.artifactVerification as { status?: unknown } | undefined;
    const continuationReason: ArtifactScopeLineageReason | null =
      terminalReason === 'interrupted_by_restart'
        ? 'restart_recovery'
        : immediateAwaitingInputReply
            ? 'awaiting_user_input_reply'
          : verification?.status === 'pending'
            ? 'artifact_verification_continue'
          : terminalReason === 'awaiting_continue' || terminalReason === 'limit_exceeded'
            ? 'manual_continue'
            : null;
    if (continuationReason) {
      const terminalRoot = typeof priorCompletion?.artifactRunScopeId === 'string'
        ? priorCompletion.artifactRunScopeId.trim()
        : '';
      // An arbitrary clarification answer is allowed to continue only the
      // exact root named by the immediately preceding typed pause. Narrow
      // continue/restart controls retain the legacy lookup for older terminals.
      const previousRoot = immediateAwaitingInputReply
        ? terminalRoot || null
        : terminalRoot || mostRecentArtifactRoot(sessionId, latestUserSeq);
      if (previousRoot) {
        rootScopeId = previousRoot;
        reason = continuationReason;
      }
    }
  }

  try {
    const persist = db.transaction((): string => {
      const createdAt = new Date().toISOString();
      let authoritativeRoot = rootScopeId;
      let authoritativeReason = reason;
      if (latestUserSeq > 0) {
        const authorityInsert = db.prepare(`
          INSERT OR IGNORE INTO artifact_source_roots
            (session_id, source_user_seq, root_scope_id, created_at)
          VALUES (?, ?, ?, ?)
        `).run(sessionId, latestUserSeq, rootScopeId, createdAt);
        const authority = db.prepare(`
          SELECT root_scope_id
            FROM artifact_source_roots
           WHERE session_id = ? AND source_user_seq = ?
        `).get(sessionId, latestUserSeq) as { root_scope_id: string } | undefined;
        if (authority?.root_scope_id) authoritativeRoot = authority.root_scope_id;
        // Another lane won the unique source authority after our optimistic
        // read. Its root is canonical; this attempt is a same-turn fallback.
        if (authorityInsert.changes === 0 && !sameTurn) {
          authoritativeReason = 'same_user_turn_fallback';
        }
      }
      db.prepare(`
        INSERT OR IGNORE INTO artifact_run_scopes
          (session_id, attempt_scope_id, root_scope_id, source_user_seq, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        sessionId,
        attemptScopeId,
        authoritativeRoot,
        latestUserSeq,
        authoritativeReason,
        createdAt,
      );
      const mapped = db.prepare(`
        SELECT root_scope_id
          FROM artifact_run_scopes
         WHERE session_id = ? AND attempt_scope_id = ?
      `).get(sessionId, attemptScopeId) as { root_scope_id: string } | undefined;
      return mapped?.root_scope_id ?? authoritativeRoot;
    });
    return persist();
  } catch (error) {
    // Out-of-band SDK callers/tests may intentionally run without a harness
    // session row. They have no durable artifact authority to inherit; keep the
    // supplied scope and preserve the pre-ledger behavior instead of failing.
    if (!getSession(sessionId)) return rootScopeId;
    // A real session must never proceed with an optimistic per-lane root after
    // lock/corruption/persistence failure: competing lanes could then create
    // different resources. Fail closed and let the caller retry the turn.
    throw new ArtifactLineagePersistenceError(sessionId, error);
  }
}

export function getArtifactRunScope(sessionId: string, attemptScopeId: string): ArtifactRunScope | null {
  ensureSchema();
  const row = openEventLog().prepare(`
    SELECT session_id, attempt_scope_id, root_scope_id, source_user_seq, reason
      FROM artifact_run_scopes
     WHERE session_id = ? AND attempt_scope_id = ?
  `).get(sessionId, attemptScopeId) as ArtifactRunScopeRow | undefined;
  return row ? scopeFromRow(row) : null;
}

/** Read-only projection from one accepted user event to its durable artifact
 * root. Returns null for ordinary turns whose candidate lineage was never used,
 * even if a legacy/source mapping happens to exist without an artifact row. */
export function getArtifactRootForSourceUserSeq(
  sessionId: string,
  sourceUserSeq: number,
): string | null {
  if (!Number.isSafeInteger(sourceUserSeq) || sourceUserSeq <= 0) return null;
  ensureSchema();
  const row = openEventLog().prepare(`
    SELECT s.root_scope_id
      FROM artifact_source_roots s
     WHERE s.session_id = ?
       AND s.source_user_seq = ?
       AND EXISTS (
         SELECT 1
           FROM run_artifacts a
          WHERE a.session_id = s.session_id
            AND a.run_scope_id = s.root_scope_id
       )
     LIMIT 1
  `).get(sessionId, sourceUserSeq) as { root_scope_id?: string } | undefined;
  return typeof row?.root_scope_id === 'string' && row.root_scope_id.trim()
    ? row.root_scope_id
    : null;
}

export function artifactObjectiveForRunScope(sessionId: string, rootScopeId: string): string {
  ensureSchema();
  const row = openEventLog().prepare(`
    SELECT json_extract(e.data_json, '$.text') AS text
      FROM artifact_run_scopes s
      JOIN events e ON e.session_id = s.session_id AND e.seq = s.source_user_seq
     WHERE s.session_id = ? AND s.root_scope_id = ?
     ORDER BY s.source_user_seq ASC, s.created_at ASC
     LIMIT 1
  `).get(sessionId, rootScopeId) as { text?: string | null } | undefined;
  return typeof row?.text === 'string' ? row.text : '';
}

/** Atomic claim. `acquired:false` is an instruction to reuse/verify the returned
 * row; callers must not dispatch another create. */
export function claimArtifactSlot(
  sessionId: string,
  intent: ArtifactIntent,
  sourceCallId?: string,
  runScopeId = sessionId,
): ArtifactClaim {
  ensureSchema();
  const db = openEventLog();
  const now = new Date().toISOString();
  const id = randomUUID();
  const result = db.prepare(`
    INSERT OR IGNORE INTO run_artifacts
      (id, session_id, run_scope_id, slot_key, kind, provider, title, create_shape, status,
       resource_id, uri, source_call_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, ?)
  `).run(
    id,
    sessionId,
    runScopeId,
    intent.slotKey,
    intent.kind,
    intent.provider,
    intent.title ?? null,
    intent.createShape,
    sourceCallId ?? null,
    now,
    now,
  );
  const artifact = getRunArtifact(sessionId, intent.slotKey, runScopeId);
  if (!artifact) throw new Error('artifact claim was not readable after insert');
  return { acquired: result.changes === 1, artifact };
}

export function bindArtifactSlot(
  sessionId: string,
  slotKey: string,
  resource: ArtifactResource,
  sourceCallId?: string,
  runScopeId = sessionId,
): RunArtifact {
  ensureSchema();
  const now = new Date().toISOString();
  openEventLog().prepare(`
    UPDATE run_artifacts
       SET status = 'bound',
           resource_id = COALESCE(?, resource_id),
           uri = COALESCE(?, uri),
           title = COALESCE(?, title),
           source_call_id = COALESCE(?, source_call_id),
           binding_verified_at = NULL,
           verification_call_id = NULL,
           verification_shape = NULL,
           verification_fingerprint = NULL,
           updated_at = ?
     WHERE session_id = ? AND run_scope_id = ? AND slot_key = ?
  `).run(
    resource.resourceId ?? null,
    resource.uri ?? null,
    resource.title ?? null,
    sourceCallId ?? null,
    now,
    sessionId,
    runScopeId,
    slotKey,
  );
  const artifact = getRunArtifact(sessionId, slotKey, runScopeId);
  if (!artifact) throw new Error(`artifact slot ${slotKey} is not claimed`);
  return artifact;
}

/** A dispatched create with no trustworthy ID is uncertain, never failed. The
 * external write may have succeeded; retry must verify rather than recreate. */
export function markArtifactUncertain(
  sessionId: string,
  slotKey: string,
  sourceCallId?: string,
  runScopeId = sessionId,
): RunArtifact {
  ensureSchema();
  openEventLog().prepare(`
    UPDATE run_artifacts
       SET status = 'uncertain',
           source_call_id = COALESCE(?, source_call_id),
           binding_verified_at = NULL,
           verification_call_id = NULL,
           verification_shape = NULL,
           verification_fingerprint = NULL,
           updated_at = ?
     WHERE session_id = ? AND run_scope_id = ? AND slot_key = ?
  `).run(sourceCallId ?? null, new Date().toISOString(), sessionId, runScopeId, slotKey);
  const artifact = getRunArtifact(sessionId, slotKey, runScopeId);
  if (!artifact) throw new Error(`artifact slot ${slotKey} is not claimed`);
  return artifact;
}

/** Release is only safe before provider dispatch. Once a call may have crossed
 * the network boundary use markArtifactUncertain instead. */
export function releaseArtifactClaim(sessionId: string, slotKey: string, runScopeId = sessionId): boolean {
  ensureSchema();
  return openEventLog().prepare(
    "DELETE FROM run_artifacts WHERE session_id = ? AND run_scope_id = ? AND slot_key = ? AND status = 'pending'",
  ).run(sessionId, runScopeId, slotKey).changes === 1;
}

function getRunArtifactById(id: string): RunArtifact | null {
  ensureSchema();
  const row = openEventLog().prepare('SELECT * FROM run_artifacts WHERE id = ?').get(id) as ArtifactRow | undefined;
  return row ? fromRow(row) : null;
}

/** Settle the exact row acquired by one provider call. The call-id predicate is
 * critical for native MCP parallelism: an out-of-order result can never bind a
 * sibling claim merely because both calls proposed the same slot. */
export function bindClaimedArtifact(
  artifactId: string,
  expectedSourceCallId: string | undefined,
  resource: ArtifactResource,
): RunArtifact | null {
  ensureSchema();
  const now = new Date().toISOString();
  const result = openEventLog().prepare(`
    UPDATE run_artifacts
       SET status = 'bound',
           resource_id = COALESCE(?, resource_id),
           uri = COALESCE(?, uri),
           title = COALESCE(?, title),
           binding_verified_at = NULL,
           verification_call_id = NULL,
           verification_shape = NULL,
           verification_fingerprint = NULL,
           updated_at = ?
     WHERE id = ?
       AND (? IS NULL OR source_call_id = ?)
  `).run(
    resource.resourceId ?? null,
    resource.uri ?? null,
    resource.title ?? null,
    now,
    artifactId,
    expectedSourceCallId ?? null,
    expectedSourceCallId ?? null,
  );
  return result.changes === 1 ? getRunArtifactById(artifactId) : null;
}

export function markClaimedArtifactUncertain(
  artifactId: string,
  expectedSourceCallId?: string,
): RunArtifact | null {
  ensureSchema();
  const result = openEventLog().prepare(`
    UPDATE run_artifacts
       SET status = 'uncertain',
           binding_verified_at = NULL,
           verification_call_id = NULL,
           verification_shape = NULL,
           verification_fingerprint = NULL,
           updated_at = ?
     WHERE id = ?
       AND (? IS NULL OR source_call_id = ?)
  `).run(
    new Date().toISOString(),
    artifactId,
    expectedSourceCallId ?? null,
    expectedSourceCallId ?? null,
  );
  return result.changes === 1 ? getRunArtifactById(artifactId) : null;
}

export function releaseClaimedArtifact(
  artifactId: string,
  expectedSourceCallId?: string,
): boolean {
  ensureSchema();
  return openEventLog().prepare(`
    DELETE FROM run_artifacts
     WHERE id = ? AND status = 'pending'
       AND (? IS NULL OR source_call_id = ?)
  `).run(
    artifactId,
    expectedSourceCallId ?? null,
    expectedSourceCallId ?? null,
  ).changes === 1;
}

function walkForKey(value: unknown, wanted: Set<string>, depth = 0): string | undefined {
  if (depth > 7 || value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 80)) {
      const found = walkForKey(item, wanted, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(obj)) {
    if (wanted.has(key.toLowerCase()) && typeof child === 'string' && child.trim()) return child.trim();
  }
  for (const child of Object.values(obj)) {
    const found = walkForKey(child, wanted, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function parseLooseResult(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { /* provider formatter may be JS-ish */ }
  const documentId = value.match(/(?:"documentId"|"document_id"|documentId|document_id)\s*:\s*"([A-Za-z0-9_-]{10,})"/i)?.[1];
  const siteId = value.match(/(?:"site_id"|"siteId"|site_id|siteId)\s*:\s*"([A-Za-z0-9_-]{6,})"/i)?.[1]
    ?? value.match(/\bProject\s+ID\s*:\s*([A-Za-z0-9_-]{6,})/i)?.[1]
    ?? value.match(/\bSite\s+ID\s*:\s*([A-Za-z0-9_-]{6,})/i)?.[1];
  const uri = value.match(/https:\/\/docs\.google\.com\/document\/d\/[A-Za-z0-9_-]+\/edit/i)?.[0]
    ?? value.match(/\b(?:Website|Site|Live)\s+URL\s*:\s*(https:\/\/[^\s]+)/i)?.[1]
    ?? value.match(/https:\/\/[A-Za-z0-9.-]+\.netlify\.app\/?/i)?.[0]
    ?? value.match(/\bAdmin\s+URL\s*:\s*(https:\/\/[^\s]+)/i)?.[1];
  return { documentId, siteId, uri };
}

function googleDocumentIdFromUri(uri: string | undefined): string | undefined {
  return uri?.match(/^https:\/\/docs\.google\.com\/document\/d\/([A-Za-z0-9_-]+)(?:\/|$|[?#])/i)?.[1];
}

function jsonRecordFromOutput(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch { /* shell results wrap stdout in an exit-code envelope */ }
  const stdout = text.match(/(?:^|\n)stdout:\s*\n([\s\S]*)$/i)?.[1] ?? text;
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(stdout.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function directResultObject(value: unknown): Record<string, unknown> | null {
  const parsed = jsonRecordFromOutput(value);
  if (!parsed) return null;
  const data = parsed.data;
  return data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : parsed;
}

function readbackResource(intent: ArtifactVerificationIntent, output: unknown): ArtifactResource | null {
  const parsed = jsonRecordFromOutput(output);
  const direct = directResultObject(output);
  if (intent.kind === 'google_doc') {
    const uri = walkForKey(parsed, new Set(['display_url', 'documenturl', 'document_url', 'url', 'uri']))
      ?? (typeof output === 'string'
        ? output.match(/https:\/\/docs\.google\.com\/document\/d\/[A-Za-z0-9_-]+(?:\/edit)?/i)?.[0]
        : undefined);
    const resourceId = walkForKey(parsed, new Set(['documentid', 'document_id', 'docid', 'doc_id']))
      ?? googleDocumentIdFromUri(uri);
    return resourceId ? { resourceId, uri } : null;
  }
  if (!direct) return null;
  // Netlify getSite returns the site at the top level. Never recursively accept
  // a generic `id`, which could be an account, owner, deploy, or build id.
  const resourceId = stringField(direct, ['site_id', 'siteId', 'siteid', 'id']);
  const uri = stringField(direct, ['ssl_url', 'sslUrl', 'url', 'deploy_url', 'deployUrl']);
  return resourceId ? { resourceId, uri } : null;
}

function readbackOutputLooksSuccessful(output: unknown, explicitOk: boolean): boolean {
  if (!explicitOk || !toolOutputLooksSuccessful(output, explicitOk)) return false;
  if (typeof output === 'string') {
    const exitCode = output.match(/(?:^|\n)exit_code:\s*(-?\d+)\b/i)?.[1];
    if (exitCode !== undefined && Number(exitCode) !== 0) return false;
  }
  return true;
}

/** Persist an exact-id provider read-back. Both halves must agree: the read
 * request names the already-bound id, and the successful response returns that
 * same id (or, for Google Docs, its canonical document URL). Mismatches and
 * failures are no-ops, never exceptions that can break the user's work. */
export function verifyArtifactBindingFromToolResult(
  sessionId: string,
  runScopeId: string,
  toolName: string,
  rawArgs: unknown,
  output: unknown,
  sourceCallId?: string,
  explicitOk = true,
): RunArtifact | null {
  const intent = artifactVerificationIntentForTool(toolName, rawArgs);
  if (!intent || !readbackOutputLooksSuccessful(output, explicitOk)) return null;
  const response = readbackResource(intent, output);
  if (!response?.resourceId || response.resourceId !== intent.resourceId) return null;

  ensureSchema();
  const db = openEventLog();
  const row = db.prepare(`
    SELECT * FROM run_artifacts
     WHERE session_id = ? AND run_scope_id = ? AND kind = ? AND provider = ?
       AND status = 'bound' AND resource_id = ?
     ORDER BY created_at ASC
     LIMIT 1
  `).get(
    sessionId,
    runScopeId,
    intent.kind,
    intent.provider,
    intent.resourceId,
  ) as ArtifactRow | undefined;
  if (!row) return null;

  const now = new Date().toISOString();
  const fingerprint = createHash('sha256')
    .update([
      sessionId,
      runScopeId,
      row.slot_key,
      intent.verificationShape,
      intent.resourceId,
      response.resourceId,
      response.uri ?? '',
    ].join('\0'))
    .digest('hex')
    .slice(0, 16);
  db.prepare(`
    UPDATE run_artifacts
       SET binding_verified_at = COALESCE(binding_verified_at, ?),
           verification_call_id = COALESCE(verification_call_id, ?),
           verification_shape = COALESCE(verification_shape, ?),
           verification_fingerprint = COALESCE(verification_fingerprint, ?),
           updated_at = ?
     WHERE id = ? AND status = 'bound' AND resource_id = ?
  `).run(
    now,
    sourceCallId ?? null,
    intent.verificationShape,
    fingerprint,
    now,
    row.id,
    intent.resourceId,
  );
  return getRunArtifact(sessionId, row.slot_key, runScopeId);
}

/** Extract only stable artifact identifiers from a successful create result. */
export function extractArtifactResource(intent: ArtifactIntent, output: unknown): ArtifactResource | null {
  const parsed = parseLooseResult(output);
  const commonTitle = walkForKey(parsed, new Set(['title', 'name']));
  if (intent.kind === 'google_doc') {
    const uri = walkForKey(parsed, new Set(['display_url', 'documenturl', 'document_url', 'url', 'uri']))
      ?? (typeof output === 'string'
        ? output.match(/https:\/\/docs\.google\.com\/document\/d\/[A-Za-z0-9_-]+(?:\/edit)?/i)?.[0]
        : undefined);
    const resourceId = walkForKey(parsed, new Set(['documentid', 'document_id', 'docid', 'doc_id']))
      ?? googleDocumentIdFromUri(uri);
    const canonicalUri = uri ?? (resourceId ? `https://docs.google.com/document/d/${resourceId}/edit` : undefined);
    return resourceId || canonicalUri ? { resourceId, uri: canonicalUri, title: commonTitle ?? intent.title } : null;
  }
  if (intent.kind === 'site') {
    const direct = directResultObject(output);
    const resourceId = direct
      ? stringField(direct, ['siteid', 'site_id', 'siteId', 'id'])
      : walkForKey(parsed, new Set(['siteid', 'site_id']));
    const uri = walkForKey(parsed, new Set(['url', 'uri', 'ssl_url', 'sslurl', 'deploy_url']));
    return resourceId || uri ? { resourceId, uri, title: commonTitle ?? intent.title } : null;
  }
  return null;
}

export function artifactReuseMessage(artifact: RunArtifact): string {
  if (artifact.status === 'bound') {
    const pointer = artifact.uri ?? artifact.resourceId ?? artifact.id;
    if (artifact.bindingVerifiedAt) {
      return `Artifact slot ${artifact.slotKey} is already provider-verified and bound to ${pointer}. Reuse or update that resource; do not create another.`;
    }
    const repair = artifact.kind === 'site' && artifact.resourceId
      ? ` Read it back exactly with netlify api getSite --data '{"site_id":"${artifact.resourceId}"}', then reuse or update it explicitly with --site ${artifact.resourceId}; do not run sites:create again.`
      : artifact.kind === 'google_doc' && artifact.resourceId
        ? ` Read it back with GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT using document_id=${artifact.resourceId}. Reuse or update document ${artifact.resourceId}; do not run document create again.`
        : ' Verify that exact resource, then reuse or update it; do not create another.';
    return `Artifact slot ${artifact.slotKey} is already bound but not yet provider-verified: ${pointer}.${repair}`;
  }
  return `Artifact slot ${artifact.slotKey} already has a ${artifact.status} create attempt (${artifact.sourceCallId ?? artifact.id}). Verify that attempt before retrying; do not create another resource blindly.`;
}

/** A provider gateway can prove that execution stopped before the network
 * mutation boundary (bad args, missing/ambiguous connection, standing-rule
 * block). Only that explicit proof makes releasing a pending claim safe. Any
 * timeout, thrown error, or unmarked failure remains uncertain. */
export function artifactOutputProvesNoDispatch(
  output: unknown,
  executionOutcome?: ShellExecutionOutcome,
): boolean {
  // Typed execution truth outranks rendered shell prose. `effect:none` includes
  // local no-start failures and narrow provider-adapter precondition rejections;
  // either makes retrying this artifact slot safe.
  if (executionOutcome?.effect === 'none') return true;
  if (executionOutcome?.dispatch === 'not_started') return true;
  if (typeof output === 'string') {
    return /\[provider-dispatch:not-started:[a-z0-9_-]+\]/i.test(output);
  }
  if (!output || typeof output !== 'object' || Array.isArray(output)) return false;
  const row = output as Record<string, unknown>;
  return row.ok === false && row.dispatched === false;
}

/** Stable digest for UI/telemetry without exposing full artifact contents. */
export function artifactFingerprint(artifact: Pick<RunArtifact, 'sessionId' | 'runScopeId' | 'slotKey' | 'resourceId' | 'uri'>): string {
  return createHash('sha256')
    .update([artifact.sessionId, artifact.runScopeId, artifact.slotKey, artifact.resourceId ?? '', artifact.uri ?? ''].join('\0'))
    .digest('hex')
    .slice(0, 16);
}

export function _resetArtifactLedgerForTests(): void {
  schemaReady = false;
  schemaReadyDb = null;
}
