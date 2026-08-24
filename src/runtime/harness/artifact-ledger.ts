import { createHash, randomUUID } from 'node:crypto';
import { getSession, listEvents, openEventLog, resolveToolOutputForAuthority } from './eventlog.js';
import { toolOutputLooksSuccessful } from './tool-evidence.js';
import {
  inspectProviderEnvelope,
  projectProviderResult,
  pruneProviderRequestEchoes,
} from './provider-read-evidence.js';
import type { ShellExecutionOutcome } from '../shell-execution-outcome.js';
import { documentedComposioOperationSemantic } from '../../integrations/composio/operation-semantics.js';
import {
  authorizeGoogleSheetsSheetFromJsonReadbackRequest,
  extractGoogleSheetsSheetFromJsonTarget,
  verifyGoogleSheetsSheetFromJsonReadback,
  type GoogleSheetsSheetFromJsonContract,
  type GoogleSheetsSheetTarget,
} from './sheet-from-json-content-contract.js';
import { loadExpectedWorkContract } from './expected-work-contract.js';
import {
  redeemAuthoritativeResultPayload,
  redeemSuccessfulSettlementResultForHost,
} from './result-handle.js';

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
  /** Exact durable pre-dispatch reservation owned by this create attempt. */
  externalWriteEventId: string | null;
  externalWriteActionKey: string | null;
  externalWriteToolName: string | null;
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
  kind: ArtifactKind;
  provider: string;
  /** Exact provider id requested by the read-back call. A title, list query,
   * ambient cwd, or URL-only probe is deliberately insufficient. */
  resourceId: string;
  verificationShape: string;
}

export interface HostSealedArtifactContentContractV1 {
  version: 1;
  kind: 'host_sealed_artifact_content_v1';
  acceptedTaskId: string;
  graphId: string;
  graphHash: string;
  lineageNodeId: string;
  createNodeId: string;
  readbackNodeId: string;
  lineageContentDigest: string;
  intendedContentDigest: string;
  createBindingDigest: string;
  readbackBindingDigest: string;
  createEffect: 'external_write' | 'local_write';
  readbackEffect: 'read';
}

function canonicalHostArtifactJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalHostArtifactJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalHostArtifactJson(record[key])}`)
    .join(',')}}`;
}

export function hostArtifactContentDigest(value: unknown): string {
  return createHash('sha256').update(canonicalHostArtifactJson(value), 'utf8').digest('hex');
}

function boundedHostArtifactId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && !/\s/.test(value);
}

function digest64(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function parseHostSealedArtifactContentContract(
  value: unknown,
): HostSealedArtifactContentContractV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    'version',
    'kind',
    'acceptedTaskId',
    'graphId',
    'graphHash',
    'lineageNodeId',
    'createNodeId',
    'readbackNodeId',
    'lineageContentDigest',
    'intendedContentDigest',
    'createBindingDigest',
    'readbackBindingDigest',
    'createEffect',
    'readbackEffect',
  ]);
  if (Object.keys(record).length !== allowed.size
    || Object.keys(record).some((key) => !allowed.has(key))) return null;
  if (record.version !== 1 || record.kind !== 'host_sealed_artifact_content_v1') return null;
  for (const key of ['acceptedTaskId', 'graphId', 'lineageNodeId', 'createNodeId', 'readbackNodeId'] as const) {
    if (!boundedHostArtifactId(record[key])) return null;
  }
  for (const key of [
    'graphHash',
    'lineageContentDigest',
    'intendedContentDigest',
    'createBindingDigest',
    'readbackBindingDigest',
  ] as const) {
    if (!digest64(record[key])) return null;
  }
  if (record.lineageContentDigest !== record.intendedContentDigest) return null;
  if (record.createEffect !== 'external_write' && record.createEffect !== 'local_write') return null;
  if (record.readbackEffect !== 'read') return null;
  return record as unknown as HostSealedArtifactContentContractV1;
}

export function createHostSealedArtifactContentContract(
  input: Omit<HostSealedArtifactContentContractV1, 'version' | 'kind'>,
): HostSealedArtifactContentContractV1 {
  const contract: HostSealedArtifactContentContractV1 = {
    version: 1,
    kind: 'host_sealed_artifact_content_v1',
    ...input,
  };
  if (!parseHostSealedArtifactContentContract(contract)) {
    throw new Error('host-sealed artifact content contract is invalid');
  }
  return contract;
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
  external_write_event_id: string | null;
  external_write_action_key: string | null;
  external_write_tool_name: string | null;
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
      external_write_event_id TEXT,
      external_write_action_key TEXT,
      external_write_tool_name TEXT,
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
  ensureColumn('external_write_event_id', 'external_write_event_id TEXT');
  ensureColumn('external_write_action_key', 'external_write_action_key TEXT');
  ensureColumn('external_write_tool_name', 'external_write_tool_name TEXT');
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
    externalWriteEventId: row.external_write_event_id ?? null,
    externalWriteActionKey: row.external_write_action_key ?? null,
    externalWriteToolName: row.external_write_tool_name ?? null,
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

  // Google Sheets create is intentionally covered by the generic root-resource
  // classifier below, but its exact getters still need a provider-shaped
  // binding proof. A range read names one spreadsheet id and the response
  // echoes that same id, so it is independent proof that the newly bound root
  // is readable. Broad list/search operations never enter this branch.
  if (
    /^(?:CX_)?GOOGLE_?SHEETS?_(?:BATCH_GET|GET_VALUES|VALUES_(?:BATCH_)?GET|GET_SPREADSHEET(?:_BY_ID)?|SPREADSHEETS_GET)$/.test(normalized)
  ) {
    const resourceId = stringField(args, [
      'spreadsheet_id', 'spreadsheetId', 'spreadsheetid', 'id',
    ]);
    if (!resourceId) return null;
    return {
      kind: 'resource',
      provider: 'googlesheets',
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

  // Documented noun-shaped constructors share their operation semantics with
  // effect/approval classification. A lost provider response must not cause a
  // duplicate root artifact merely because the action name omits CREATE.
  const documented = documentedComposioOperationSemantic(shape);
  if (documented?.rootArtifact) {
    return {
      kind: documented.rootArtifact.kind,
      provider: documented.rootArtifact.provider,
      slotKey: explicitSlot(args, documented.rootArtifact.kind),
      title: stringField(args, ['title', 'name']),
      createShape: upper,
    };
  }

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
    const netlifySiteCreate =
      /\bnetlify(?:-cli)?\b[^\n]*(?:sites?:create|site:create|sites:create)\b/i.test(command)
      || /\bnetlify(?:-cli)?\s+api\s+(?:createSite|createSiteInTeam)\b/i.test(command);
    if (netlifySiteCreate) {
      const name = command.match(/--(?:name|site)\s+(?:["']([^"']+)["']|([^\s]+))/i);
      const apiName = command.match(/["']?name["']?\s*:\s*["']([^"']+)["']/i);
      let resolvedName = name?.[1] ?? name?.[2] ?? apiName?.[1];
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
        createShape: /\bapi\s+(?:createSite|createSiteInTeam)\b/i.test(command)
          ? 'NETLIFY_API_CREATE_SITE'
          : 'NETLIFY_SITE_CREATE',
      };
    }
    // GENERIC CLI create (2026-07-22 restructure — effect-anchored, no product
    // whitelist): ANY installed CLI running a create-verb subcommand claims a
    // generic artifact, so a mid-flight death on vercel/gh/wrangler/aws/…
    // gets the same uncertainty protection + recovery chain Netlify does. The
    // provider label is DERIVED from the executable, never enumerated.
    const generic = genericCliCreateIntent(command);
    if (generic) return generic;
    return null;
  }

  // GENERIC provider create (composio slugs / MCP tools): a create-verb shape
  // whose args carry a name/title identity and NO parent-container reference is
  // a root deliverable (AIRTABLE_CREATE_BASE, VERCEL_CREATE_PROJECT, …). Item-
  // level creates (records, rows, messages, comments) always reference their
  // parent container in args and are deliberately NOT claimed — they belong to
  // batches and the duplicate-send wall, not the one-deliverable slot model.
  // The generic branch applies ONLY to EXTERNAL surfaces — a composio slug or a
  // namespaced MCP tool. Local first-class tools (execution_create, focus_set,
  // workflow authoring, memory ops) are session bookkeeping, not provider
  // resources: claiming one parks the run on an "unresolved artifact" that
  // never existed outside the harness (live 2026-07-22, execution_create).
  const externalSurface = toolTail(toolName) === 'composio_execute_tool'
    || toolName === 'composio_execute_tool'
    || /__/.test(toolName);
  if (externalSurface && /(?:^|_)(CREATE|PROVISION|REGISTER)(?:_|$)/.test(upper)) {
    const title = stringField(args, ['title', 'name', 'display_name', 'displayName', 'label', 'slug']);
    if (title && !argsReferenceParentContainer(args) && !createsStructuralSubPart(upper)) {
      return {
        kind: 'resource',
        provider: providerLabelFromShape(shape),
        slotKey: explicitSlot(args, 'resource'),
        title,
        createShape: upper,
      };
    }
  }

  return null;
}

/** Creates of structural SUB-PARTS live inside an existing deliverable and are
 * re-inspectable through it — they are not session deliverables. This is a
 * vocabulary of parts applied uniformly to EVERY provider (unlike a provider
 * whitelist, it boxes no CLI/toolkit out of the ledger). */
const STRUCTURAL_SUB_PART_RE = /(?:^|_)(TAB|HEADER|FOOTER|FOOTNOTE|COMMENT|ROW|RECORD|RECORDS|FIELD|COLUMN|CELL|CARD|ITEM|LABEL|TAG|WEBHOOK|KEY|TOKEN|SECRET|MEMBER|REACTION|REMINDER|EVENT|MESSAGE)S?(?:_|$)/;

function createsStructuralSubPart(upperShape: string): boolean {
  const afterVerb = upperShape.split(/(?:^|_)(?:CREATE|PROVISION|REGISTER)(?:_|$)/)[1] ?? '';
  return STRUCTURAL_SUB_PART_RE.test(`_${afterVerb}_`) || STRUCTURAL_SUB_PART_RE.test(upperShape.slice(upperShape.indexOf('CREATE')));
}

/** Args that point INTO an existing container mark an item-level create. The
 * check is structural (any *_id/parent-ish key besides account routing), not a
 * noun list — AIRTABLE_CREATE_BASE has none; AIRTABLE_CREATE_RECORDS carries
 * baseId; SLACK_SEND has channel. */
function argsReferenceParentContainer(args: unknown): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  for (const key of Object.keys(args as Record<string, unknown>)) {
    const k = key.toLowerCase();
    if (k === 'connected_account_id' || k === 'connectedaccountid' || k === 'user_id' || k === 'userid') continue;
    // NOTE: workspace/org/team/account ids are ACCOUNT-SCOPING, not content
    // parents — a base/project created "in a workspace" is still a root
    // deliverable (live 2026-07-22: AIRTABLE_CREATE_BASE requires workspaceId
    // and silently skipped claiming). Only content containers count.
    if (/(^|_)(parent|base|table|board|channel|thread|folder|project|repo|doc|document|site|list)_?id$/.test(k)) return true;
    if (k === 'parent' || k === 'channel') return true;
  }
  return false;
}

/** "VERCEL_CREATE_PROJECT" → "vercel"; "mcp__linear__create_issue" → "linear". */
function providerLabelFromShape(shape: string): string {
  const mcp = shape.match(/^mcp__([^_]+(?:_[^_]+)*?)__/i)?.[1];
  if (mcp) return mcp.toLowerCase();
  const head = shape.replace(/^CX_/i, '').split('_')[0] ?? shape;
  return head.toLowerCase() || 'provider';
}

const CLI_CREATE_VERB_RE = /^(create|init|new|provision|register)$|^[a-z]+s?:create$/i;

/** Effect-anchored CLI create detection: `<cli> [sub] <create-verb> …` for ANY
 * executable. Reads the identity from common naming flags or the first bare
 * argument after the verb; fails closed to the primary slot when absent. */
function genericCliCreateIntent(command: string): ArtifactIntent | null {
  const cleaned = command.trim();
  if (!cleaned) return null;
  // First pipeline segment only — a create buried mid-pipeline is not the
  // command's primary effect claim.
  const segment = cleaned.split(/[|;&]/)[0].trim();
  const tokens = segment.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;
  let idx = 0;
  // Skip env assignments and runners (CI=1 npx --yes <cli> …).
  while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) idx += 1;
  if (tokens[idx] === 'npx') { idx += 1; while (idx < tokens.length && tokens[idx].startsWith('-')) idx += 1; }
  const cli = (tokens[idx] ?? '').replace(/^.*\//, '').replace(/@.*$/, '');
  if (!cli || /^(bash|sh|zsh|node|python3?|cat|echo|curl|wget|git)$/.test(cli)) return null;
  const rest = tokens.slice(idx + 1);
  const verbIndex = rest.findIndex((t) => CLI_CREATE_VERB_RE.test(t));
  if (verbIndex === -1) return null;
  const nameFlag = segment.match(/--(?:name|title|site|project|repo|app)[= ]+(?:["']([^"']+)["']|([^\s"']+))/i);
  const bareArg = rest.slice(verbIndex + 1).find((t) => !t.startsWith('-') && !/^["']?\$/.test(t));
  const title = nameFlag?.[1] ?? nameFlag?.[2] ?? bareArg?.replace(/^["']|["']$/g, '');
  return {
    kind: 'resource',
    provider: cli.toLowerCase(),
    slotKey: `resource:primary`,
    title: title && !title.startsWith('$') ? title : undefined,
    createShape: `CLI_${cli.toUpperCase()}_${(rest[verbIndex] ?? 'CREATE').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
  };
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

/** TRULY unresolved create claims — dispatch outcome unknown ('pending' /
 *  'uncertain'). A 'bound' claim is NOT in this set even when read-back
 *  verification hasn't run: the provider returned the resource (URI/ID in
 *  hand), so the deliverable exists — verification is an advisory, never a
 *  completion wall (live 2026-07-23: a successfully created Google Sheet —
 *  its VALUES_UPDATE already writing to it — parked the run behind an
 *  unanswerable "reply retry" loop that the standard lane has no machinery
 *  to satisfy). Double-create protection keys on THIS set. */
export function listUnresolvedCreateClaims(sessionId: string, runScopeId?: string): RunArtifact[] {
  return listRunArtifacts(sessionId, runScopeId).filter(
    (artifact) => artifact.status !== 'bound',
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
            || terminalReason === 'step_budget_parked' || terminalReason === 'sdk_step_budget_parked'
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

/**
 * The session's most recent artifact root that still carries UNVERIFIED
 * claims — how a NEW turn (e.g. the user's "retry" reply to an artifact park)
 * finds the claims a PRIOR turn parked on. Scope roots are keyed per
 * source-user-seq, so the fresh reply's own seq never resolves them
 * (2026-07-22 Netlify retry loop: the verification directive silently
 * no-opped and the park message replayed verbatim forever).
 */
export function latestPendingArtifactRootForSession(
  sessionId: string,
): { rootScopeId: string; sourceUserSeq: number } | null {
  ensureSchema();
  const rows = openEventLog().prepare(`
    SELECT DISTINCT s.root_scope_id, s.source_user_seq
      FROM artifact_source_roots s
     WHERE s.session_id = ?
     ORDER BY s.source_user_seq DESC
     LIMIT 8
  `).all(sessionId) as Array<{ root_scope_id: string; source_user_seq: number }>;
  for (const row of rows) {
    if (listUnverifiedRunArtifacts(sessionId, row.root_scope_id).length > 0) {
      return { rootScopeId: row.root_scope_id, sourceUserSeq: row.source_user_seq };
    }
  }
  return null;
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
  contentContract?: unknown,
): ArtifactClaim {
  ensureSchema();
  const db = openEventLog();
  const now = new Date().toISOString();
  const id = randomUUID();
  const contractJson = contentContract === undefined ? null : JSON.stringify(contentContract);
  if (
    contentContract !== undefined
    && (
      contractJson === undefined
      || contractJson === null
      || Buffer.byteLength(contractJson, 'utf8') > 1_000_000
      || !sourceCallId
    )
  ) throw new Error('artifact content verification contract is not bounded or lacks exact call identity');
  const claim = db.transaction((): ArtifactClaim => {
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
    const row = db.prepare(`
      SELECT * FROM run_artifacts
       WHERE session_id = ? AND run_scope_id = ? AND slot_key = ?
    `).get(sessionId, runScopeId, intent.slotKey) as ArtifactRow | undefined;
    if (!row) throw new Error('artifact claim was not readable after insert');
    if (result.changes === 1 && contractJson !== null && sourceCallId) {
      db.prepare(`
        INSERT INTO artifact_content_verifications
          (artifact_id, session_id, run_scope_id, create_logical_tool_call_id,
           contract_json, content_verified_at, verification_logical_call_id,
           verification_fingerprint, created_at)
        VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?)
      `).run(row.id, sessionId, runScopeId, sourceCallId, contractJson, now);
    }
    return { acquired: result.changes === 1, artifact: fromRow(row) };
  });
  return claim.immediate();
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

/** Bind the artifact claim to the exact durable write reservation minted after
 * admission. First writer wins; a replay/reused call id cannot retarget an
 * already-bound artifact to another reservation. */
export function bindClaimedArtifactExternalWrite(
  artifactId: string,
  expectedSourceCallId: string,
  reservation: { eventId: string; actionKey: string; toolName: string },
): RunArtifact | null {
  ensureSchema();
  const result = openEventLog().prepare(`
    UPDATE run_artifacts
       SET external_write_event_id = ?,
           external_write_action_key = ?,
           external_write_tool_name = ?,
           updated_at = ?
     WHERE id = ?
       AND source_call_id = ?
       AND (external_write_event_id IS NULL OR external_write_event_id = ?)
  `).run(
    reservation.eventId,
    reservation.actionKey,
    reservation.toolName,
    new Date().toISOString(),
    artifactId,
    expectedSourceCallId,
    reservation.eventId,
  );
  return result.changes === 1 ? getRunArtifactById(artifactId) : null;
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

/**
 * Resolve an UNCERTAIN/PENDING claim from a human-sanctioned verification
 * retry (2026-07-22 Netlify jail): a create that died mid-flight leaves a
 * claim status 'uncertain' — releaseClaimedArtifact only deletes 'pending'
 * and binding needs the create's own callback, so the claim was permanently
 * unresolvable even after the model FOUND the real resource. This is the
 * standard lane's explicit repair boundary:
 *  - bind: attach the verified provider resource only when this boundary can
 *    resolve one exact, parented provider-read lifecycle whose response names
 *    the same resourceId, then mark it verified.
 *  - absent: delete the claim — the provider was read and the resource
 *    provably does not exist; the duplicate wall still backstops the redo.
 */
export function resolveUncertainArtifactClaim(
  sessionId: string,
  artifactId: string,
  resolution:
    | { kind: 'bind'; resourceId: string; uri?: string; verificationCallId: string }
    | { kind: 'absent'; verificationCallId: string },
): { ok: boolean; reason?: string } {
  ensureSchema();
  const db = openEventLog();
  const row = db.prepare(
    'SELECT id, status FROM run_artifacts WHERE id = ? AND session_id = ?',
  ).get(artifactId, sessionId) as { id: string; status: string } | undefined;
  if (!row) return { ok: false, reason: 'no such claim in this session' };
  if (row.status === 'bound') return { ok: false, reason: 'claim is already bound' };
  if (row.status !== 'pending' && row.status !== 'uncertain') {
    return { ok: false, reason: `claim status ${row.status} is not resolvable` };
  }
  const verificationCallId = resolution.verificationCallId.trim();
  if (!verificationCallId) return { ok: false, reason: 'verification call id is required' };
  const authority = resolveToolOutputForAuthority(sessionId, verificationCallId);
  if (authority.status !== 'ok') {
    return { ok: false, reason: `verification output is ${authority.status}; run one fresh provider read` };
  }
  if (authority.effect !== 'read' && authority.effect !== 'compute') {
    return { ok: false, reason: 'verification must come from one parented read/compute invocation' };
  }
  let parsed: unknown = authority.record.output;
  try { parsed = JSON.parse(authority.record.output); } catch { /* a CLI read may return plain provider text */ }
  if (inspectProviderEnvelope(parsed).verdict !== 'clean') {
    return { ok: false, reason: 'verification output is contradictory or was not fully inspected' };
  }
  const providerResult = pruneProviderRequestEchoes(parsed);
  const evidenceText = typeof providerResult === 'string'
    ? providerResult
    : JSON.stringify(providerResult);
  const verificationShape = `artifact_claim_resolve:${resolution.kind}`;
  const verificationFingerprint = createHash('sha256')
    .update([sessionId, artifactId, verificationCallId, verificationShape, authority.record.output].join('\0'))
    .digest('hex')
    .slice(0, 16);
  const now = new Date().toISOString();
  if (resolution.kind === 'bind') {
    if (!evidenceText.includes(resolution.resourceId)) {
      return { ok: false, reason: 'resource id is absent from the exact provider result (request echoes do not count)' };
    }
    const changes = db.prepare(`
      UPDATE run_artifacts
         SET status = 'bound',
             resource_id = ?,
             uri = COALESCE(?, uri),
             binding_verified_at = ?,
             verification_call_id = ?,
             verification_shape = ?,
             verification_fingerprint = ?,
             updated_at = ?
       WHERE id = ? AND session_id = ? AND status IN ('pending', 'uncertain')
    `).run(
      resolution.resourceId,
      resolution.uri ?? null,
      now,
      verificationCallId,
      verificationShape,
      verificationFingerprint,
      now,
      artifactId,
      sessionId,
    ).changes;
    return changes === 1 ? { ok: true } : { ok: false, reason: 'claim changed concurrently' };
  }
  if (authority.record.truncatedAtWrite) {
    return { ok: false, reason: 'truncated verification output cannot prove global provider absence' };
  }
  const projection = projectProviderResult(providerResult, []);
  if (!projection.hasEmptyResult || projection.hasNonEmptyResult) {
    return { ok: false, reason: 'exact provider read does not prove one globally empty result' };
  }
  const changes = db.prepare(`
    DELETE FROM run_artifacts
     WHERE id = ? AND session_id = ? AND status IN ('pending', 'uncertain')
  `).run(artifactId, sessionId).changes;
  return changes === 1 ? { ok: true } : { ok: false, reason: 'claim changed concurrently' };
}

/**
 * Partition pending claims into superseded-vs-still-pending (2026-07-22
 * Netlify retry loop). A claim whose create died mid-flight (NO resourceId)
 * can never self-verify — it parked its session forever, even after a
 * sanctioned verification-retry successfully re-created the resource. When a
 * VERIFIED sibling of the same kind+provider exists in the scope, the dead
 * claim is provably replaced by the intentional re-create: releasing it cannot
 * hide a duplicate, because the verified sibling IS the deliverable the park
 * was protecting. Pure — the caller performs the release.
 */
export function partitionSupersededPendingClaims(input: {
  artifacts: Array<{ id: string; kind: string; provider: string; resourceId?: string | null }>;
  pending: Array<{ id: string; kind: string; provider: string; resourceId?: string | null }>;
}): { stillPending: typeof input.pending; superseded: typeof input.pending } {
  const pendingIds = new Set(input.pending.map((a) => a.id));
  const verifiedKinds = new Set(
    input.artifacts
      .filter((a) => !pendingIds.has(a.id) && a.resourceId)
      .map((a) => `${a.kind}::${a.provider}`),
  );
  const superseded = input.pending.filter((a) => !a.resourceId && verifiedKinds.has(`${a.kind}::${a.provider}`));
  const supersededIds = new Set(superseded.map((a) => a.id));
  return { stillPending: input.pending.filter((a) => !supersededIds.has(a.id)), superseded };
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
  // Current provider CLIs colorize label/value boundaries even when stdout is
  // captured non-interactively. Netlify CLI 24, for example, prints
  // `Project ID: <reset-code><uuid>`. Parse the semantic text, not terminal
  // decoration, or a successful create is persisted as URL-only and its later
  // exact-ID readback cannot settle the binding.
  const text = value.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
    '',
  );
  const documentId = text.match(/(?:"documentId"|"document_id"|documentId|document_id)\s*:\s*"([A-Za-z0-9_-]{10,})"/i)?.[1];
  const siteId = text.match(/(?:"site_id"|"siteId"|site_id|siteId)\s*:\s*"([A-Za-z0-9_-]{6,})"/i)?.[1]
    ?? text.match(/\bProject\s+ID\s*:\s*([A-Za-z0-9_-]{6,})/i)?.[1]
    ?? text.match(/\bSite\s+ID\s*:\s*([A-Za-z0-9_-]{6,})/i)?.[1];
  const uri = text.match(/https:\/\/docs\.google\.com\/document\/d\/[A-Za-z0-9_-]+\/edit/i)?.[0]
    ?? text.match(/\b(?:Website|Site|Live)\s+URL\s*:\s*(https:\/\/[^\s]+)/i)?.[1]
    ?? text.match(/https:\/\/[A-Za-z0-9.-]+\.netlify\.app\/?/i)?.[0]
    ?? text.match(/\bAdmin\s+URL\s*:\s*(https:\/\/[^\s]+)/i)?.[1];
  return { documentId, siteId, uri };
}

function canonicalArtifactUri(uri: string | null | undefined): string | null {
  const trimmed = uri?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    parsed.search = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

function googleDocumentIdFromUri(uri: string | undefined): string | undefined {
  return uri?.match(/^https:\/\/docs\.google\.com\/document\/d\/([A-Za-z0-9_-]+)(?:\/|$|[?#])/i)?.[1];
}

function googleSpreadsheetIdFromUri(uri: string | undefined): string | undefined {
  return uri?.match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)(?:\/|$|[?#])/i)?.[1];
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

/** Provider-returned content only. Request/input echo containers are excluded
 * recursively because proving that the caller asked for id X is not proving X
 * was read. Providers nest these echoes under data/response/result as well as
 * at the outer envelope. */
function readbackResultObjects(value: unknown): Record<string, unknown>[] {
  const parsed = jsonRecordFromOutput(value);
  if (!parsed) return [];
  const pruned = pruneProviderRequestEchoes(parsed) as Record<string, unknown>;
  const candidates: Record<string, unknown>[] = [];
  for (const key of ['data', 'response', 'result', 'output']) {
    const candidate = pruned[key];
    if (Array.isArray(candidate) && candidate.length > 0) {
      candidates.push({ items: candidate });
    } else if (candidate && typeof candidate === 'object') {
      const record = candidate as Record<string, unknown>;
      if (Object.keys(record).length > 0) candidates.push(record);
    }
  }
  const outer = Object.fromEntries(Object.entries(pruned)
    .filter(([key]) => !['data', 'response', 'result', 'output'].includes(key.toLowerCase())));
  if (Object.keys(outer).length > 0) candidates.push(outer);
  return candidates;
}

const RAW_READBACK_FAILURE_RE = /^(?:\[provider-dispatch:[^\]]+\]|[\s⚠️]*(?:(?:[A-Za-z0-9_.:/-]+)\s+)?(?:not found|no such|does not exist|error|failed|failure|unable|could not|cannot|denied|forbidden|unauthori[sz]ed|timed out|timeout|not connected)(?:\b|\s*[:(]))/i;

function rawReadbackUri(output: unknown, pattern: RegExp): string | undefined {
  if (typeof output !== 'string') return undefined;
  const text = output.trim();
  if (RAW_READBACK_FAILURE_RE.test(text)) return undefined;
  return text.match(pattern)?.[0];
}

function readbackResource(intent: ArtifactVerificationIntent, output: unknown): ArtifactResource | null {
  const parsed = jsonRecordFromOutput(output);
  const candidates = readbackResultObjects(output);
  if (intent.kind === 'google_doc') {
    const resources: ArtifactResource[] = [];
    for (const candidate of candidates) {
      const uri = walkForKey(candidate, new Set(['display_url', 'documenturl', 'document_url', 'url', 'uri']));
      const resourceId = walkForKey(candidate, new Set(['documentid', 'document_id', 'docid', 'doc_id']))
        ?? googleDocumentIdFromUri(uri);
      if (resourceId) resources.push({ resourceId, uri });
    }
    const rawUri = !parsed
      ? rawReadbackUri(output, /https:\/\/docs\.google\.com\/document\/d\/[A-Za-z0-9_-]+(?:\/edit)?/i)
      : undefined;
    if (rawUri) resources.push({ resourceId: googleDocumentIdFromUri(rawUri) ?? '', uri: rawUri });
    return resources.find((resource) => resource.resourceId === intent.resourceId) ?? resources[0] ?? null;
  }
  if (intent.kind === 'resource' && intent.provider === 'googlesheets') {
    const resources: ArtifactResource[] = [];
    for (const candidate of candidates) {
      const uri = walkForKey(candidate, new Set([
        'display_url', 'spreadsheeturl', 'spreadsheet_url', 'url', 'uri',
      ]));
      const resourceId = walkForKey(candidate, new Set([
        'spreadsheetid', 'spreadsheet_id',
      ])) ?? googleSpreadsheetIdFromUri(uri);
      if (resourceId) resources.push({ resourceId, uri });
    }
    const rawUri = !parsed
      ? rawReadbackUri(output, /https:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]+(?:\/edit)?/i)
      : undefined;
    if (rawUri) resources.push({ resourceId: googleSpreadsheetIdFromUri(rawUri) ?? '', uri: rawUri });
    return resources.find((resource) => resource.resourceId === intent.resourceId) ?? resources[0] ?? null;
  }
  // Netlify getSite returns the site at the top level. Never recursively accept
  // a generic `id`, which could be an account, owner, deploy, or build id.
  const resources: ArtifactResource[] = [];
  for (const candidate of candidates) {
    const resourceId = stringField(candidate, ['site_id', 'siteId', 'siteid', 'id']);
    const uri = stringField(candidate, ['ssl_url', 'sslUrl', 'url', 'deploy_url', 'deployUrl']);
    if (resourceId) resources.push({ resourceId, uri });
  }
  return resources.find((resource) => resource.resourceId === intent.resourceId) ?? resources[0] ?? null;
}

function readbackOutputLooksSuccessful(output: unknown, explicitOk: boolean): boolean {
  if (!explicitOk || !toolOutputLooksSuccessful(output, explicitOk)) return false;
  const structured = jsonRecordFromOutput(output);
  if (structured && inspectProviderEnvelope(structured).verdict !== 'clean') return false;
  if (typeof output === 'string') {
    const firstLine = output.trim().split(/\r?\n/, 1)[0] ?? '';
    if (RAW_READBACK_FAILURE_RE.test(firstLine)) return false;
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
  let row = db.prepare(`
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
  // A successful create can legitimately expose only a canonical URL (older
  // CLI output, provider formatter, or a pre-fix persisted row). An exact-ID
  // getter is still strong binding proof when BOTH the request and response
  // agree on the ID and the response URL independently matches exactly one
  // URL-only row from this run. Promote that row to the returned ID instead of
  // leaving truthful readback evidence detached forever.
  if (!row && response.uri) {
    const expectedUri = canonicalArtifactUri(response.uri);
    const candidates = db.prepare(`
      SELECT * FROM run_artifacts
       WHERE session_id = ? AND run_scope_id = ? AND kind = ? AND provider = ?
         AND status = 'bound' AND resource_id IS NULL AND uri IS NOT NULL
       ORDER BY created_at ASC
    `).all(
      sessionId,
      runScopeId,
      intent.kind,
      intent.provider,
    ) as ArtifactRow[];
    const uriMatches = candidates.filter(
      (candidate) => canonicalArtifactUri(candidate.uri) === expectedUri,
    );
    if (uriMatches.length === 1) row = uriMatches[0];
  }
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
       SET resource_id = COALESCE(resource_id, ?),
           uri = COALESCE(uri, ?),
           binding_verified_at = COALESCE(binding_verified_at, ?),
           verification_call_id = COALESCE(verification_call_id, ?),
           verification_shape = COALESCE(verification_shape, ?),
           verification_fingerprint = COALESCE(verification_fingerprint, ?),
           updated_at = ?
     WHERE id = ? AND status = 'bound'
       AND (resource_id = ? OR resource_id IS NULL)
  `).run(
    intent.resourceId,
    response.uri ?? null,
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

export type GeneratedArtifactReadbackAdmission =
  | {
      status: 'authorized';
      artifactId: string;
      runScopeId: string;
      createLogicalToolCallId: string;
      contentContract: unknown;
      resourceId: string;
    }
  | { status: 'unavailable'; reason: string };

function hostReadbackResourceId(args: unknown): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const value = (args as Record<string, unknown>).resourceId;
  return boundedHostArtifactId(value) ? value : null;
}

function hostLineageRecords(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const records = (value as { records?: unknown }).records;
  return Array.isArray(records) ? records : null;
}

/**
 * Provider-neutral counterpart to the mature provider-specific readback
 * contracts below. Authority comes only from the frozen graph binding and the
 * host-sealed content/lineage contract; semantic role labels and tool-name
 * vocabulary never authorize this path.
 */
export function authorizeHostSealedArtifactReadback(input: {
  sessionId: string;
  sourceUserSeq: number;
  contractId: string;
  createLogicalToolCallId: string;
  verificationRequirementId: string;
  readToolName: string;
  readArgs: unknown;
}): GeneratedArtifactReadbackAdmission {
  const requestedResourceId = hostReadbackResourceId(input.readArgs);
  if (!requestedResourceId) {
    return { status: 'unavailable', reason: 'host readback does not name one exact resource id' };
  }
  try {
    ensureSchema();
    const loaded = loadExpectedWorkContract(input.sessionId, input.sourceUserSeq);
    if (loaded.status !== 'ok' || loaded.contract.contractId !== input.contractId) {
      return { status: 'unavailable', reason: 'host readback has no exact frozen work contract' };
    }
    const db = openEventLog();
    const rows = db.prepare(`
      SELECT a.id AS artifact_id, a.run_scope_id, a.source_call_id,
             a.resource_id, a.status, c.contract_json
        FROM artifact_source_roots root
        JOIN run_artifacts a
          ON a.session_id = root.session_id
         AND a.run_scope_id = root.root_scope_id
        JOIN artifact_content_verifications c ON c.artifact_id = a.id
       WHERE root.session_id = ? AND root.source_user_seq = ?
         AND a.source_call_id = ? AND a.status = 'bound'
         AND a.resource_id = ?
    `).all(
      input.sessionId,
      input.sourceUserSeq,
      input.createLogicalToolCallId,
      requestedResourceId,
    ) as Array<{
      artifact_id: string;
      run_scope_id: string;
      source_call_id: string;
      resource_id: string;
      status: string;
      contract_json: string;
    }>;
    if (rows.length !== 1) {
      return { status: 'unavailable', reason: 'host readback target is missing or ambiguous' };
    }
    const row = rows[0]!;
    let rawContract: unknown;
    try { rawContract = JSON.parse(row.contract_json); } catch {
      return { status: 'unavailable', reason: 'host-sealed content contract is unreadable' };
    }
    const contract = parseHostSealedArtifactContentContract(rawContract);
    if (!contract) return { status: 'unavailable', reason: 'host-sealed content contract is invalid' };
    if (
      contract.acceptedTaskId !== loaded.contract.acceptedTaskId
      || contract.graphId !== loaded.contract.graphId
      || contract.graphHash !== loaded.contract.graphHash
      || contract.readbackNodeId !== input.verificationRequirementId
      || `logical:${contract.createNodeId}` !== input.createLogicalToolCallId
    ) return { status: 'unavailable', reason: 'host-sealed contract contradicts accepted graph identity' };

    const createOperation = loaded.contract.operations.find((operation) => operation.id === contract.createNodeId);
    const readbackOperation = loaded.contract.operations.find((operation) => operation.id === contract.readbackNodeId);
    if (
      !createOperation
      || !readbackOperation
      || createOperation.effect !== contract.createEffect
      || readbackOperation.effect !== 'read'
      || !createOperation.dependsOn.includes(contract.lineageNodeId)
      || !createOperation.dataFrom.includes(contract.lineageNodeId)
      || !readbackOperation.dependsOn.includes(contract.createNodeId)
      || !declaredGeneratedArtifactVerificationEdge({
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        contractId: input.contractId,
        createLogicalToolCallId: input.createLogicalToolCallId,
        verificationRequirementId: input.verificationRequirementId,
      })
    ) return { status: 'unavailable', reason: 'host-sealed contract does not preserve exact content lineage' };

    const bindingRows = db.prepare(`
      SELECT node_id, binding_json, binding_digest
        FROM graph_node_bindings
       WHERE session_id = ? AND source_user_seq = ? AND node_id IN (?, ?)
    `).all(
      input.sessionId,
      input.sourceUserSeq,
      contract.createNodeId,
      contract.readbackNodeId,
    ) as Array<{ node_id: string; binding_json: string; binding_digest: string }>;
    if (bindingRows.length !== 2) {
      return { status: 'unavailable', reason: 'host readback node bindings are incomplete' };
    }
    const createBindingRow = bindingRows.find((binding) => binding.node_id === contract.createNodeId);
    const readbackBindingRow = bindingRows.find((binding) => binding.node_id === contract.readbackNodeId);
    if (!createBindingRow || !readbackBindingRow) {
      return { status: 'unavailable', reason: 'host readback node bindings are ambiguous' };
    }
    const createBinding = JSON.parse(createBindingRow.binding_json) as Record<string, unknown>;
    const readbackBinding = JSON.parse(readbackBindingRow.binding_json) as Record<string, unknown>;
    const readArgs = input.readArgs as Record<string, unknown>;
    if (
      createBindingRow.binding_digest !== contract.createBindingDigest
      || readbackBindingRow.binding_digest !== contract.readbackBindingDigest
      || createBinding.effect !== contract.createEffect
      || readbackBinding.effect !== 'read'
      || readbackBinding.toolName !== input.readToolName
      || readArgs.capabilityId !== readbackBinding.capabilityId
      || readArgs.schemaVersion !== readbackBinding.schemaVersion
      || readArgs.schemaDigest !== readbackBinding.schemaDigest
    ) return { status: 'unavailable', reason: 'host readback capability binding is not exact and read-only' };

    const createSettlement = db.prepare(`
      SELECT b.requirement_id, b.effect_kind, s.outcome_kind, s.continues_requirement
        FROM expected_work_call_bindings b
        JOIN logical_call_settlements s
          ON s.session_id = b.session_id
         AND s.source_user_seq = b.source_user_seq
         AND s.logical_tool_call_id = b.logical_tool_call_id
       WHERE b.session_id = ? AND b.source_user_seq = ?
         AND b.logical_tool_call_id = ? AND b.contract_id = ?
    `).get(
      input.sessionId,
      input.sourceUserSeq,
      input.createLogicalToolCallId,
      input.contractId,
    ) as {
      requirement_id: string;
      effect_kind: string;
      outcome_kind: string;
      continues_requirement: number;
    } | undefined;
    if (
      !createSettlement
      || createSettlement.requirement_id !== contract.createNodeId
      || createSettlement.effect_kind !== contract.createEffect
      || createSettlement.outcome_kind !== 'succeeded'
      || createSettlement.continues_requirement !== 0
    ) return { status: 'unavailable', reason: 'host create predecessor is not durably settled' };

    const lineage = redeemAuthoritativeResultPayload({
      kind: 'successful_settlement',
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      acceptedTaskId: contract.acceptedTaskId,
      logicalToolCallId: `logical:${contract.lineageNodeId}`,
    });
    if (lineage.status !== 'ok') {
      return {
        status: 'unavailable',
        reason: `host content lineage result is unavailable (${lineage.status})`,
      };
    }
    const lineageRecords = hostLineageRecords(lineage.value.rawPayload);
    if (!lineageRecords || hostArtifactContentDigest(lineageRecords) !== contract.lineageContentDigest) {
      return { status: 'unavailable', reason: 'host content lineage digest does not match the sealed create input' };
    }
    return {
      status: 'authorized',
      artifactId: row.artifact_id,
      runScopeId: row.run_scope_id,
      createLogicalToolCallId: row.source_call_id,
      contentContract: contract,
      resourceId: row.resource_id,
    };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 300),
    };
  }
}

/**
 * Connect a downstream exact-ID read to the one generated artifact created by
 * its declared predecessor. The locator is host-owned: it comes from the
 * settled create result persisted in run_artifacts, never from model prose or
 * a title/list lookup. Ambiguity fails closed.
 */
export function authorizeGeneratedArtifactReadback(input: {
  sessionId: string;
  sourceUserSeq: number;
  contractId: string;
  createLogicalToolCallId: string;
  verificationRequirementId: string;
  readToolName: string;
  readArgs: unknown;
}): GeneratedArtifactReadbackAdmission {
  const read = artifactVerificationIntentForTool(input.readToolName, input.readArgs);
  if (!read) return { status: 'unavailable', reason: 'read is not an exact artifact-id getter' };
  try {
    ensureSchema();
    if (!declaredGeneratedArtifactVerificationEdge({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      contractId: input.contractId,
      createLogicalToolCallId: input.createLogicalToolCallId,
      verificationRequirementId: input.verificationRequirementId,
    })) {
      return { status: 'unavailable', reason: 'read is not the declared verification successor of this create' };
    }
    const rows = openEventLog().prepare(`
      SELECT a.id AS artifact_id, a.run_scope_id, a.source_call_id,
             a.kind, a.provider, a.resource_id, c.contract_json
        FROM artifact_source_roots root
        JOIN run_artifacts a
          ON a.session_id = root.session_id
         AND a.run_scope_id = root.root_scope_id
        JOIN artifact_content_verifications c ON c.artifact_id = a.id
       WHERE root.session_id = ? AND root.source_user_seq = ?
         AND a.source_call_id = ? AND a.status = 'bound'
         AND a.resource_id IS NOT NULL
    `).all(
      input.sessionId,
      input.sourceUserSeq,
      input.createLogicalToolCallId,
    ) as Array<{
      artifact_id: string;
      run_scope_id: string;
      source_call_id: string;
      kind: ArtifactKind;
      provider: string;
      resource_id: string;
      contract_json: string;
    }>;
    const matches = rows.filter((row) =>
      row.kind === read.kind
      && row.provider === read.provider
      && row.resource_id === read.resourceId);
    if (rows.length !== 1 || matches.length !== 1) {
      return {
        status: 'unavailable',
        reason: rows.length === 0
          ? 'declared create predecessor owns no generated artifact contract'
          : 'generated artifact target is ambiguous or does not match the exact read id',
      };
    }
    const row = matches[0]!;
    let contentContract: unknown;
    try { contentContract = JSON.parse(row.contract_json) as unknown; } catch {
      return { status: 'unavailable', reason: 'generated artifact content contract is unreadable' };
    }
    const contract = contentContract as GoogleSheetsSheetFromJsonContract;
    if (contract.kind !== 'googlesheets_sheet_from_json_content_v1') {
      return { status: 'unavailable', reason: 'generated artifact content contract is unsupported' };
    }
    const request = authorizeGoogleSheetsSheetFromJsonReadbackRequest(
      contract,
      {
        provider: 'googlesheets',
        spreadsheetId: row.resource_id,
        spreadsheetUrl: null,
      },
      input.readToolName,
      input.readArgs,
    );
    if (!request.authorized) {
      return { status: 'unavailable', reason: `exact generated readback refused: ${request.reason}` };
    }
    return {
      status: 'authorized',
      artifactId: row.artifact_id,
      runScopeId: row.run_scope_id,
      createLogicalToolCallId: row.source_call_id,
      contentContract,
      resourceId: row.resource_id,
    };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 300),
    };
  }
}

function declaredGeneratedArtifactVerificationEdge(input: {
  sessionId: string;
  sourceUserSeq: number;
  contractId: string;
  createLogicalToolCallId: string;
  verificationRequirementId?: string;
  verificationLogicalToolCallId?: string;
}): boolean {
  const loaded = loadExpectedWorkContract(input.sessionId, input.sourceUserSeq);
  if (loaded.status !== 'ok' || loaded.contract.contractId !== input.contractId) return false;
  try {
    const db = openEventLog();
    const create = db.prepare(`
      SELECT contract_id, requirement_id, effect_kind
        FROM expected_work_call_bindings
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(
      input.sessionId,
      input.sourceUserSeq,
      input.createLogicalToolCallId,
    ) as { contract_id: string; requirement_id: string; effect_kind: string } | undefined;
    if (!create || create.contract_id !== input.contractId || create.effect_kind !== 'external_write') return false;

    let verificationRequirementId = input.verificationRequirementId;
    if (input.verificationLogicalToolCallId) {
      const verification = db.prepare(`
        SELECT contract_id, requirement_id, effect_kind
          FROM expected_work_call_bindings
         WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
      `).get(
        input.sessionId,
        input.sourceUserSeq,
        input.verificationLogicalToolCallId,
      ) as { contract_id: string; requirement_id: string; effect_kind: string } | undefined;
      if (
        !verification
        || verification.contract_id !== input.contractId
        || verification.effect_kind !== 'read'
        || (verificationRequirementId && verification.requirement_id !== verificationRequirementId)
      ) return false;
      verificationRequirementId = verification.requirement_id;
    }
    if (!verificationRequirementId) return false;

    const createOperation = loaded.contract.operations.find((operation) => operation.id === create.requirement_id);
    const verificationOperation = loaded.contract.operations.find(
      (operation) => operation.id === verificationRequirementId,
    );
    return Boolean(
      createOperation
      && verificationOperation
      && createOperation.effect === 'external_write'
      && createOperation.cardinality.kind === 'once'
      && verificationOperation.effect === 'read'
      && verificationOperation.cardinality.kind === 'once'
      && verificationOperation.dependsOn.includes(createOperation.id)
    );
  } catch {
    return false;
  }
}

/** Persist the content verdict only after the exact read has returned. The
 * helper replays the frozen constructor contract against the provider's raw
 * read bytes; same-id readability without exact cell equality is not enough. */
export function verifyGeneratedArtifactContentFromToolResult(input: {
  sessionId: string;
  sourceUserSeq: number;
  verificationLogicalToolCallId: string;
  readToolName: string;
  readArgs: unknown;
  readResult: unknown;
}): boolean {
  try {
    ensureSchema();
    const readIntent = artifactVerificationIntentForTool(input.readToolName, input.readArgs);
    if (!readIntent) return false;
    const db = openEventLog();
    const rows = db.prepare(`
      SELECT a.id AS artifact_id, a.resource_id, a.uri, c.contract_json,
             c.create_logical_tool_call_id, vb.contract_id,
             vb.requirement_id AS verification_requirement_id
        FROM artifact_source_roots root
        JOIN run_artifacts a
          ON a.session_id = root.session_id
         AND a.run_scope_id = root.root_scope_id
        JOIN artifact_content_verifications c ON c.artifact_id = a.id
        JOIN expected_work_call_bindings vb
          ON vb.session_id = root.session_id
         AND vb.source_user_seq = root.source_user_seq
         AND vb.logical_tool_call_id = ?
       WHERE root.session_id = ? AND root.source_user_seq = ?
         AND a.status = 'bound' AND a.kind = ? AND a.provider = ?
         AND a.resource_id = ?
         AND vb.effect_kind = 'read'
    `).all(
      input.verificationLogicalToolCallId,
      input.sessionId,
      input.sourceUserSeq,
      readIntent.kind,
      readIntent.provider,
      readIntent.resourceId,
    ) as Array<{
      artifact_id: string;
      resource_id: string;
      uri: string | null;
      contract_json: string;
      create_logical_tool_call_id: string;
      contract_id: string;
      verification_requirement_id: string;
    }>;
    if (rows.length !== 1) return false;
    const row = rows[0]!;
    if (!declaredGeneratedArtifactVerificationEdge({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      contractId: row.contract_id,
      createLogicalToolCallId: row.create_logical_tool_call_id,
      verificationRequirementId: row.verification_requirement_id,
      verificationLogicalToolCallId: input.verificationLogicalToolCallId,
    })) return false;
    let contract: GoogleSheetsSheetFromJsonContract;
    try { contract = JSON.parse(row.contract_json) as GoogleSheetsSheetFromJsonContract; } catch { return false; }
    if (contract.kind !== 'googlesheets_sheet_from_json_content_v1') return false;
    const target: GoogleSheetsSheetTarget = {
      provider: 'googlesheets',
      spreadsheetId: row.resource_id,
      spreadsheetUrl: row.uri,
    };
    const verdict = verifyGoogleSheetsSheetFromJsonReadback(
      contract,
      target,
      input.readToolName,
      input.readArgs,
      input.readResult,
    );
    if (!verdict.verified) return false;
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({
        artifactId: row.artifact_id,
        verificationLogicalToolCallId: input.verificationLogicalToolCallId,
        readToolName: input.readToolName,
        readArgs: input.readArgs,
        readResult: input.readResult,
      }))
      .digest('hex');
    db.prepare(`
      UPDATE artifact_content_verifications
         SET content_verified_at = COALESCE(content_verified_at, ?),
             verification_logical_call_id = COALESCE(verification_logical_call_id, ?),
             verification_fingerprint = COALESCE(verification_fingerprint, ?)
       WHERE artifact_id = ?
         AND (verification_logical_call_id IS NULL OR verification_logical_call_id = ?)
    `).run(
      new Date().toISOString(),
      input.verificationLogicalToolCallId,
      fingerprint,
      row.artifact_id,
      input.verificationLogicalToolCallId,
    );
    const persisted = db.prepare(`
      SELECT verification_logical_call_id, verification_fingerprint
        FROM artifact_content_verifications WHERE artifact_id = ?
    `).get(row.artifact_id) as {
      verification_logical_call_id: string | null;
      verification_fingerprint: string | null;
    } | undefined;
    return persisted?.verification_logical_call_id === input.verificationLogicalToolCallId
      && persisted.verification_fingerprint === fingerprint;
  } catch {
    return false;
  }
}

/** Mark a host-sealed artifact verified only after an independent read-only
 * capability returned the exact created id and byte-equivalent content. */
export function verifyHostSealedArtifactContentFromReadback(input: {
  sessionId: string;
  sourceUserSeq: number;
  verificationLogicalToolCallId: string;
  readToolName: string;
  readArgs: unknown;
  returnedResourceId: string;
  readContent: unknown;
}): boolean {
  try {
    ensureSchema();
    if (!boundedHostArtifactId(input.returnedResourceId)) return false;
    if (inspectProviderEnvelope(input.readContent).verdict !== 'clean') return false;
    const db = openEventLog();
    const binding = db.prepare(`
      SELECT contract_id, requirement_id, effect_kind
        FROM expected_work_call_bindings
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(
      input.sessionId,
      input.sourceUserSeq,
      input.verificationLogicalToolCallId,
    ) as { contract_id: string; requirement_id: string; effect_kind: string } | undefined;
    if (!binding || binding.effect_kind !== 'read') return false;
    const loaded = loadExpectedWorkContract(input.sessionId, input.sourceUserSeq);
    if (loaded.status !== 'ok' || loaded.contract.contractId !== binding.contract_id) return false;
    const operation = loaded.contract.operations.find((candidate) => candidate.id === binding.requirement_id);
    if (!operation || operation.effect !== 'read') return false;
    const createDependencies = operation.dependsOn.filter((dependencyId) => {
      const dependency = loaded.contract.operations.find((candidate) => candidate.id === dependencyId);
      return dependency?.effect === 'external_write' || dependency?.effect === 'local_write';
    });
    if (createDependencies.length !== 1) return false;
    const createLogicalToolCallId = `logical:${createDependencies[0]}`;
    const authorized = authorizeHostSealedArtifactReadback({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      contractId: binding.contract_id,
      createLogicalToolCallId,
      verificationRequirementId: binding.requirement_id,
      readToolName: input.readToolName,
      readArgs: input.readArgs,
    });
    if (authorized.status !== 'authorized' || authorized.resourceId !== input.returnedResourceId) return false;
    const contract = parseHostSealedArtifactContentContract(authorized.contentContract);
    if (!contract || hostArtifactContentDigest(input.readContent) !== contract.intendedContentDigest) return false;
    const fingerprint = createHash('sha256').update(canonicalHostArtifactJson({
      artifactId: authorized.artifactId,
      verificationLogicalToolCallId: input.verificationLogicalToolCallId,
      returnedResourceId: input.returnedResourceId,
      readToolName: input.readToolName,
      readArgs: input.readArgs,
      contentDigest: contract.intendedContentDigest,
      createBindingDigest: contract.createBindingDigest,
      readbackBindingDigest: contract.readbackBindingDigest,
    })).digest('hex');
    const updated = db.prepare(`
      UPDATE artifact_content_verifications
         SET content_verified_at = COALESCE(content_verified_at, ?),
             verification_logical_call_id = COALESCE(verification_logical_call_id, ?),
             verification_fingerprint = COALESCE(verification_fingerprint, ?)
       WHERE artifact_id = ?
         AND create_logical_tool_call_id = ?
         AND (verification_logical_call_id IS NULL OR verification_logical_call_id = ?)
    `).run(
      new Date().toISOString(),
      input.verificationLogicalToolCallId,
      fingerprint,
      authorized.artifactId,
      createLogicalToolCallId,
      input.verificationLogicalToolCallId,
    );
    if (updated.changes !== 1) return false;
    const persisted = db.prepare(`
      SELECT verification_logical_call_id, verification_fingerprint
        FROM artifact_content_verifications WHERE artifact_id = ?
    `).get(authorized.artifactId) as {
      verification_logical_call_id: string | null;
      verification_fingerprint: string | null;
    } | undefined;
    return persisted?.verification_logical_call_id === input.verificationLogicalToolCallId
      && persisted.verification_fingerprint === fingerprint;
  } catch {
    return false;
  }
}

export type HostSealedArtifactDerivationVerification =
  | {
      status: 'verified';
      artifactId: string;
      lineageContentDigest: string;
      verificationLogicalToolCallId: string;
    }
  | { status: 'unavailable'; reason: string };

/**
 * Re-prove, from current durable bytes, that one settled create consumed the
 * exact result lineage declared by the frozen graph and that an independent
 * read-only successor returned those same bytes from the exact created id.
 *
 * This deliberately knows nothing about provider names, tool-name vocabulary,
 * artifact families, or semantic role labels. The only authority is the
 * host-sealed node binding, expected-work DAG, scoped settlement/result handle,
 * and content contract.
 */
export function verifyHostSealedArtifactDerivationForWrite(input: {
  sessionId: string;
  sourceUserSeq: number;
  createLogicalToolCallId: string;
  createdId: string;
  intendedContentDigest: string;
}): HostSealedArtifactDerivationVerification {
  if (
    !input.sessionId.trim()
    || !Number.isSafeInteger(input.sourceUserSeq)
    || input.sourceUserSeq <= 0
    || !input.createLogicalToolCallId.trim()
    || !boundedHostArtifactId(input.createdId)
    || !digest64(input.intendedContentDigest)
  ) return { status: 'unavailable', reason: 'exact derivation identity and content digest are required' };
  try {
    ensureSchema();
    const db = openEventLog();
    const rows = db.prepare(`
      SELECT a.id AS artifact_id, a.resource_id, a.status,
             c.contract_json, c.content_verified_at,
             c.verification_logical_call_id, c.verification_fingerprint
        FROM artifact_source_roots root
        JOIN run_artifacts a
          ON a.session_id = root.session_id
         AND a.run_scope_id = root.root_scope_id
        JOIN artifact_content_verifications c ON c.artifact_id = a.id
       WHERE root.session_id = ? AND root.source_user_seq = ?
         AND a.source_call_id = ? AND a.resource_id = ?
    `).all(
      input.sessionId,
      input.sourceUserSeq,
      input.createLogicalToolCallId,
      input.createdId,
    ) as Array<{
      artifact_id: string;
      resource_id: string;
      status: string;
      contract_json: string;
      content_verified_at: string | null;
      verification_logical_call_id: string | null;
      verification_fingerprint: string | null;
    }>;
    if (rows.length !== 1) {
      return { status: 'unavailable', reason: 'sealed derivation artifact is missing or ambiguous' };
    }
    const row = rows[0]!;
    if (
      row.status !== 'bound'
      || !row.content_verified_at
      || !row.verification_logical_call_id
      || !row.verification_fingerprint
    ) return { status: 'unavailable', reason: 'sealed derivation artifact has no completed content proof' };

    let rawContract: unknown;
    try { rawContract = JSON.parse(row.contract_json); } catch {
      return { status: 'unavailable', reason: 'sealed derivation contract is unreadable' };
    }
    const contract = parseHostSealedArtifactContentContract(rawContract);
    if (
      !contract
      || `logical:${contract.createNodeId}` !== input.createLogicalToolCallId
      || `logical:${contract.readbackNodeId}` !== row.verification_logical_call_id
      || contract.intendedContentDigest !== input.intendedContentDigest
      || contract.lineageContentDigest !== input.intendedContentDigest
    ) return { status: 'unavailable', reason: 'sealed derivation contract contradicts the settled write' };

    const loaded = loadExpectedWorkContract(input.sessionId, input.sourceUserSeq);
    if (
      loaded.status !== 'ok'
      || loaded.contract.acceptedTaskId !== contract.acceptedTaskId
      || loaded.contract.graphId !== contract.graphId
      || loaded.contract.graphHash !== contract.graphHash
    ) return { status: 'unavailable', reason: 'sealed derivation has no exact frozen graph authority' };
    const operations = new Map(loaded.contract.operations.map((operation) => [operation.id, operation]));
    const createOperation = operations.get(contract.createNodeId);
    const lineageOperation = operations.get(contract.lineageNodeId);
    const readbackOperation = operations.get(contract.readbackNodeId);
    if (
      !createOperation
      || !lineageOperation
      || !readbackOperation
      || createOperation.effect !== contract.createEffect
      || !createOperation.dependsOn.includes(contract.lineageNodeId)
      || !createOperation.dataFrom.includes(contract.lineageNodeId)
      || readbackOperation.effect !== 'read'
      || !readbackOperation.dependsOn.includes(contract.createNodeId)
    ) return { status: 'unavailable', reason: 'sealed derivation DAG edge is not exact' };

    const ancestors = new Set<string>();
    const pending = [contract.lineageNodeId];
    while (pending.length > 0) {
      const nodeId = pending.pop()!;
      if (ancestors.has(nodeId)) continue;
      const operation = operations.get(nodeId);
      if (!operation || nodeId === contract.createNodeId || nodeId === contract.readbackNodeId) {
        return { status: 'unavailable', reason: 'sealed derivation ancestor reference is invalid' };
      }
      ancestors.add(nodeId);
      for (const dependencyId of new Set([...operation.dependsOn, ...operation.dataFrom])) {
        if (!operations.has(dependencyId)) {
          return { status: 'unavailable', reason: 'sealed derivation ancestor is missing from frozen work' };
        }
        pending.push(dependencyId);
      }
    }
    if (![...ancestors].some((nodeId) => operations.get(nodeId)?.effect === 'read')) {
      return { status: 'unavailable', reason: 'sealed derivation has no upstream source read' };
    }

    for (const nodeId of ancestors) {
      const operation = operations.get(nodeId)!;
      const logicalToolCallId = `logical:${nodeId}`;
      const authority = db.prepare(`
        SELECT b.requirement_id, b.effect_kind, b.tool_name, b.argument_digest,
               s.outcome_kind, s.continues_requirement,
               n.binding_json, n.binding_digest
          FROM expected_work_call_bindings b
          JOIN logical_call_settlements s
            ON s.session_id = b.session_id
           AND s.source_user_seq = b.source_user_seq
           AND s.logical_tool_call_id = b.logical_tool_call_id
          JOIN graph_node_bindings n
            ON n.session_id = b.session_id
           AND n.source_user_seq = b.source_user_seq
           AND n.node_id = b.requirement_id
         WHERE b.session_id = ? AND b.source_user_seq = ?
           AND b.contract_id = ? AND b.logical_tool_call_id = ?
      `).get(
        input.sessionId,
        input.sourceUserSeq,
        loaded.contract.contractId,
        logicalToolCallId,
      ) as {
        requirement_id: string;
        effect_kind: string;
        tool_name: string;
        argument_digest: string;
        outcome_kind: string;
        continues_requirement: number;
        binding_json: string;
        binding_digest: string;
      } | undefined;
      if (!authority) return { status: 'unavailable', reason: `sealed derivation ancestor ${nodeId} is unsettled` };
      let binding: Record<string, unknown>;
      try { binding = JSON.parse(authority.binding_json) as Record<string, unknown>; } catch {
        return { status: 'unavailable', reason: `sealed derivation binding ${nodeId} is unreadable` };
      }
      const bindingEffect = (binding.effect === 'none' || binding.effect === 'host_only')
        ? 'compute'
        : binding.effect;
      if (
        authority.requirement_id !== nodeId
        || authority.effect_kind !== operation.effect
        || authority.outcome_kind !== 'succeeded'
        || authority.continues_requirement !== 0
        || binding.nodeId !== nodeId
        || binding.bindingDigest !== authority.binding_digest
        || bindingEffect !== operation.effect
        || binding.providerOperationId !== binding.toolName
        || binding.logicalToolName !== authority.tool_name
        || !digest64(authority.argument_digest)
      ) return { status: 'unavailable', reason: `sealed derivation authority is not exact for ${nodeId}` };
      const redeemed = redeemSuccessfulSettlementResultForHost({
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        acceptedTaskId: contract.acceptedTaskId,
        logicalToolCallId,
      });
      if (redeemed.status !== 'ok') {
        return { status: 'unavailable', reason: `sealed derivation result is unavailable for ${nodeId}` };
      }
      if (nodeId === contract.lineageNodeId) {
        const records = hostLineageRecords(redeemed.value.rawPayload);
        if (!records || hostArtifactContentDigest(records) !== contract.lineageContentDigest) {
          return { status: 'unavailable', reason: 'sealed derivation lineage bytes no longer match' };
        }
      }
    }

    const readbackBindingRow = db.prepare(`
      SELECT binding_json, binding_digest
        FROM graph_node_bindings
       WHERE session_id = ? AND source_user_seq = ? AND node_id = ?
    `).get(
      input.sessionId,
      input.sourceUserSeq,
      contract.readbackNodeId,
    ) as { binding_json: string; binding_digest: string } | undefined;
    if (!readbackBindingRow || readbackBindingRow.binding_digest !== contract.readbackBindingDigest) {
      return { status: 'unavailable', reason: 'sealed derivation readback binding is missing' };
    }
    let readbackBinding: Record<string, unknown>;
    try { readbackBinding = JSON.parse(readbackBindingRow.binding_json) as Record<string, unknown>; } catch {
      return { status: 'unavailable', reason: 'sealed derivation readback binding is unreadable' };
    }
    if (
      readbackBinding.effect !== 'read'
      || typeof readbackBinding.toolName !== 'string'
      || typeof readbackBinding.capabilityId !== 'string'
      || typeof readbackBinding.schemaVersion !== 'string'
      || typeof readbackBinding.schemaDigest !== 'string'
    ) return { status: 'unavailable', reason: 'sealed derivation readback is not bound read-only' };
    const authorized = authorizeHostSealedArtifactReadback({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      contractId: loaded.contract.contractId,
      createLogicalToolCallId: input.createLogicalToolCallId,
      verificationRequirementId: contract.readbackNodeId,
      readToolName: readbackBinding.toolName,
      readArgs: {
        resourceId: input.createdId,
        capabilityId: readbackBinding.capabilityId,
        schemaVersion: readbackBinding.schemaVersion,
        schemaDigest: readbackBinding.schemaDigest,
      },
    });
    if (authorized.status !== 'authorized' || authorized.resourceId !== input.createdId) {
      return { status: 'unavailable', reason: 'sealed derivation readback authorization no longer redeems' };
    }
    const readback = redeemSuccessfulSettlementResultForHost({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      acceptedTaskId: contract.acceptedTaskId,
      logicalToolCallId: row.verification_logical_call_id,
    });
    if (readback.status !== 'ok') {
      return { status: 'unavailable', reason: 'sealed derivation readback result is unavailable' };
    }
    const raw = readback.value.rawPayload;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { status: 'unavailable', reason: 'sealed derivation readback result is malformed' };
    }
    const readbackValue = raw as { id?: unknown; content?: unknown };
    if (
      readbackValue.id !== input.createdId
      || readbackValue.content === undefined
      || inspectProviderEnvelope(readbackValue.content).verdict !== 'clean'
      || hostArtifactContentDigest(readbackValue.content) !== input.intendedContentDigest
    ) return { status: 'unavailable', reason: 'sealed derivation readback bytes no longer match' };
    return {
      status: 'verified',
      artifactId: row.artifact_id,
      lineageContentDigest: contract.lineageContentDigest,
      verificationLogicalToolCallId: row.verification_logical_call_id,
    };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 300),
    };
  }
}

export function generatedArtifactContentVerificationForTests(input: {
  sessionId: string;
  sourceUserSeq: number;
  createLogicalToolCallId: string;
}): {
  artifactId: string;
  createLogicalToolCallId: string;
  contentVerifiedAt: string | null;
  verificationLogicalToolCallId: string | null;
  verificationFingerprint: string | null;
} | null {
  try {
    ensureSchema();
    const row = openEventLog().prepare(`
      SELECT c.artifact_id, c.create_logical_tool_call_id,
             c.content_verified_at, c.verification_logical_call_id,
             c.verification_fingerprint
        FROM artifact_source_roots root
        JOIN artifact_content_verifications c
          ON c.session_id = root.session_id
         AND c.run_scope_id = root.root_scope_id
       WHERE root.session_id = ? AND root.source_user_seq = ?
         AND c.create_logical_tool_call_id = ?
    `).get(
      input.sessionId,
      input.sourceUserSeq,
      input.createLogicalToolCallId,
    ) as {
      artifact_id: string;
      create_logical_tool_call_id: string;
      content_verified_at: string | null;
      verification_logical_call_id: string | null;
      verification_fingerprint: string | null;
    } | undefined;
    return row ? {
      artifactId: row.artifact_id,
      createLogicalToolCallId: row.create_logical_tool_call_id,
      contentVerifiedAt: row.content_verified_at,
      verificationLogicalToolCallId: row.verification_logical_call_id,
      verificationFingerprint: row.verification_fingerprint,
    } : null;
  } catch {
    return null;
  }
}

function exactGeneratedArtifactContentProof(input: {
  sessionId: string;
  sourceUserSeq: number;
  contractId: string;
  createLogicalToolCallIds?: readonly string[];
  verificationLogicalToolCallIds?: readonly string[];
}): boolean {
  const creates = input.createLogicalToolCallIds ?? [];
  const verifications = input.verificationLogicalToolCallIds ?? [];
  if (creates.length === 0 && verifications.length === 0) return false;
  try {
    ensureSchema();
    const rows = openEventLog().prepare(`
      SELECT c.create_logical_tool_call_id, c.verification_logical_call_id,
             vb.contract_id, vb.effect_kind, vb.requirement_id AS verification_requirement_id,
             s.outcome_kind, s.continues_requirement
        FROM artifact_source_roots root
        JOIN run_artifacts a
          ON a.session_id = root.session_id
         AND a.run_scope_id = root.root_scope_id
        JOIN artifact_content_verifications c ON c.artifact_id = a.id
        JOIN expected_work_call_bindings vb
          ON vb.session_id = c.session_id
         AND vb.source_user_seq = root.source_user_seq
         AND vb.logical_tool_call_id = c.verification_logical_call_id
        JOIN logical_call_settlements s
          ON s.session_id = vb.session_id
         AND s.source_user_seq = vb.source_user_seq
         AND s.logical_tool_call_id = vb.logical_tool_call_id
       WHERE root.session_id = ? AND root.source_user_seq = ?
         AND c.content_verified_at IS NOT NULL
         AND c.verification_logical_call_id IS NOT NULL
         AND c.verification_fingerprint IS NOT NULL
         AND a.status = 'bound' AND a.resource_id IS NOT NULL
    `).all(input.sessionId, input.sourceUserSeq) as Array<{
      create_logical_tool_call_id: string;
      verification_logical_call_id: string;
      contract_id: string;
      effect_kind: string;
      outcome_kind: string;
      continues_requirement: number;
      verification_requirement_id: string;
    }>;
    const matches = rows.filter((row) =>
      row.contract_id === input.contractId
      && row.effect_kind === 'read'
      && (row.outcome_kind === 'succeeded' || row.outcome_kind === 'empty_result')
      && row.continues_requirement === 0
      && (creates.length === 0 || creates.includes(row.create_logical_tool_call_id))
      && (verifications.length === 0 || verifications.includes(row.verification_logical_call_id))
      && declaredGeneratedArtifactVerificationEdge({
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        contractId: input.contractId,
        createLogicalToolCallId: row.create_logical_tool_call_id,
        verificationRequirementId: row.verification_requirement_id,
        verificationLogicalToolCallId: row.verification_logical_call_id,
      }));
    return matches.length === 1;
  } catch {
    return false;
  }
}

export function generatedArtifactWriteContentVerified(input: {
  sessionId: string;
  sourceUserSeq: number;
  contractId: string;
  createLogicalToolCallId: string;
}): boolean {
  return exactGeneratedArtifactContentProof({
    ...input,
    createLogicalToolCallIds: [input.createLogicalToolCallId],
  });
}

export function generatedArtifactReadContentVerified(input: {
  sessionId: string;
  sourceUserSeq: number;
  contractId: string;
  verificationLogicalToolCallId: string;
}): boolean {
  return exactGeneratedArtifactContentProof({
    ...input,
    verificationLogicalToolCallIds: [input.verificationLogicalToolCallId],
  });
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
  // Reviewed Google Sheets root constructors return `spreadsheetId` (or a
  // canonical spreadsheet URL). They also commonly include ambient account,
  // owner, drive-file, and request metadata with generic `id` fields. Never
  // let the generic resource fallback bind one of those unrelated ids to the
  // artifact slot: exact-ID readback would then target the wrong object and
  // the successfully created Sheet could become permanently unverifiable.
  if (intent.kind === 'resource' && intent.provider === 'googlesheets') {
    const target = extractGoogleSheetsSheetFromJsonTarget(output);
    if (!target) return null;
    return {
      resourceId: target.spreadsheetId,
      uri: target.spreadsheetUrl
        ?? `https://docs.google.com/spreadsheets/d/${target.spreadsheetId}/edit`,
      title: intent.title ?? commonTitle,
    };
  }
  // Generic kinds (the effect-anchored classifier): any stable id-shaped key or
  // canonical URL in the provider result proves the create landed — the same
  // evidence a human would read. Without this branch every generic claim
  // settled 'uncertain' even on SUCCESS, turning the broadened classifier into
  // a park factory instead of a safety net.
  const resourceId = walkForKey(parsed, new Set([
    'id', 'resource_id', 'resourceid', 'uid', 'uuid', 'spreadsheet_id', 'spreadsheetid',
  ]));
  const uri = walkForKey(parsed, new Set([
    'url', 'uri', 'html_url', 'web_url', 'link', 'permalink',
    'display_url', 'spreadsheet_url', 'spreadsheeturl',
  ]))
    ?? (typeof output === 'string' ? output.match(/https?:\/\/[^\s"')\]]+/i)?.[0] : undefined);
  return resourceId || uri ? { resourceId, uri, title: commonTitle ?? intent.title } : null;
}

export function artifactReuseMessage(artifact: RunArtifact): string {
  if (artifact.status === 'bound') {
    const pointer = artifact.uri ?? artifact.resourceId ?? artifact.id;
    if (artifact.bindingVerifiedAt) {
      return `Artifact slot ${artifact.slotKey} is already provider-verified and bound to ${pointer}. Use that existing resource; do not create another. Update it only under a separately declared authorized operation or turn.`;
    }
    const repair = artifact.kind === 'site' && artifact.resourceId
      ? ` Read it back exactly with netlify api getSite --data '{"site_id":"${artifact.resourceId}"}', then reconcile this create claim to that existing site; do not run sites:create again. Update it only under a separately declared authorized operation or turn.`
      : artifact.kind === 'google_doc' && artifact.resourceId
        ? ` Read it back with GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT using document_id=${artifact.resourceId}. Reconcile this create claim to existing document ${artifact.resourceId}; do not run document create again. Update it only under a separately declared authorized operation or turn.`
        : ' Verify that exact resource and reconcile the existing create claim; do not create another. Update it only under a separately declared authorized operation or turn.';
    return `Artifact slot ${artifact.slotKey} is already bound but not yet provider-verified: ${pointer}.${repair}`;
  }
  const attempt = artifact.sourceCallId ? `; provider attempt ${artifact.sourceCallId}` : '';
  return [
    `Artifact slot ${artifact.slotKey} already has an unresolved ${artifact.status} create claim (artifactId ${artifact.id}${attempt}).`,
    'Do not create another resource blindly.',
    'Verify that attempt before retrying with a read-only provider list/get.',
    `Then call artifact_claim_resolve with artifactId="${artifact.id}" and resolution="bind" plus the exact resourceId if it exists, or resolution="absent" if the read-back proves it does not; continue only after that resolution succeeds.`,
  ].join(' ');
}

/**
 * Only an internally typed local spawn failure can prove that a shell-backed
 * artifact create never crossed the dispatch boundary. Model-visible strings,
 * provider result objects, exit codes, and provider-phase classifications are
 * untrusted after a child starts and can never release a pending claim.
 */
export function artifactOutputProvesNoDispatch(
  _output: unknown,
  executionOutcome?: ShellExecutionOutcome,
): boolean {
  if (
    executionOutcome?.phase !== 'resolve'
    || executionOutcome.dispatch !== 'not_started'
    || executionOutcome.effect !== 'none'
  ) return false;
  return executionOutcome.errorKind === 'command_not_found'
    || executionOutcome.errorKind === 'permission_denied'
    || executionOutcome.errorKind === 'spawn_failed';
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
