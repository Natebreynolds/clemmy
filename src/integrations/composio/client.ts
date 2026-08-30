import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Composio, ComposioToolNotFoundError } from '@composio/core';
import { BASE_DIR } from '../../config.js';
import { readEnvFile, writeEnvFile } from '../../setup/env-file.js';
import { getMachineId } from '../../runtime/machine-id.js';
import { getSecretStore } from '../../runtime/secrets/index.js';
import { currentToolAbortSignal } from '../../runtime/tool-abort-context.js';
import { cachedIdentityEmail, cachedConnectionOwner, recordConnectionOwner } from './identity-cache.js';
import { ExternalWritePreDispatchError } from '../../runtime/harness/external-write-admission.js';
import {
  executeComposioCliTool,
  getComposioCliStatus,
  invalidateComposioCliStatusCache,
  peekCurrentComposioCliStatus,
  searchComposioCliTools,
  type ComposioCliStatus,
} from './cli.js';
import { composioSlugIsReadOnly } from './slug-effect.js';
import { aliasLabelFor } from '../../memory/account-alias-store.js';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';

const ENV_FILE = path.join(BASE_DIR, '.env');
const CACHE_DIR = path.join(BASE_DIR, 'state');
const CATALOG_CACHE_FILE = path.join(CACHE_DIR, 'composio-catalog-cache.json');
const CONNECTION_SUPPRESSION_FILE = path.join(CACHE_DIR, 'composio-connection-suppression.json');
const CONNECTION_SUPPRESSION_SOURCE_FILES = [
  CONNECTION_SUPPRESSION_FILE,
  path.join(CACHE_DIR, 'calendar-monitor.json'),
  path.join(CACHE_DIR, 'inbox-monitor.json'),
];
const SECRET_VAULT_FILE = path.join(CACHE_DIR, 'secrets-vault.json');
const DEFAULT_USER_ID = 'default';
const DERIVED_USER_ID_PREFIX = 'clementine-';
// A connection whose identity/entity no longer lines up (reconnect-class), OR a
// dispatch that reached Composio with NO usable connection resolved for the
// toolkit. The latter surfaces as an auth-config/scheme lookup miss
// (`Auth_Config_AuthSchemeNotFound`, a bare `AuthSchemeNotFound`, or an
// "unsupported OAuth2 authentication" rejection): the resolver deferred past the
// connection and dispatched on the bare entity, which has no auth config for the
// toolkit. Treating these as reconnect-class makes the execute path self-heal
// (invalidate snapshot → re-resolve FRESH → retry once) and, if still
// unresolved, surface a "reconnect <app>, do not retry" signal instead of
// returning an opaque ERROR the model retries turn after turn until its budget
// is spent. Reconnect-shaped provider output is useful diagnosis, not replay
// provenance: reads may self-heal, while mutations remain ambiguous unless a
// local typed preflight proves the provider boundary was never crossed.
const RECONNECT_REQUIRED_RE =
  /ConnectedAccountEntityIdMismatch|connected account[^\n]{0,100}(?:user|entity)[ _-]?id[^\n]{0,80}(?:does not match|mismatch)|user[ _-]?id[^\n]{0,80}does not match[^\n]{0,80}provided user[ _-]?id|ToolRouterV2[_-]?NoActiveConnection|\bNoActiveConnection\b|\bno active connection\b|Auth[_ ]?Config[_ ]?AuthSchemeNotFound|\bAuthSchemeNotFound\b|unsupported OAuth2/i;
const CONNECTIONS_TTL_MS = 60_000;
const CONNECTED_ACCOUNTS_LIST_TIMEOUT_MS = 15_000;
const CATALOG_TTL_MS = 60 * 60_000;
const BACKEND_VALUES = ['auto', 'sdk', 'cli'] as const;
export const COMPOSIO_AUTH_CONFIGS_URL = 'https://dashboard.composio.dev/~/project/auth-configs';

export type ToolkitAuthMode = 'managed' | 'byo' | 'none';
export type ComposioExecutionBackend = typeof BACKEND_VALUES[number];

export interface CuratedToolkit {
  slug: string;
  displayName: string;
  authMode: ToolkitAuthMode;
  /** Adapter-declared presentation aliases used only for explicit namespace alignment. */
  namespaceAliases?: readonly string[];
}

export const CURATED_TOOLKITS: CuratedToolkit[] = [
  { slug: 'gmail', displayName: 'Gmail', authMode: 'managed' },
  { slug: 'googlecalendar', displayName: 'Google Calendar', authMode: 'managed' },
  { slug: 'googledrive', displayName: 'Google Drive', authMode: 'managed' },
  {
    slug: 'googlesheets',
    displayName: 'Google Sheets',
    authMode: 'managed',
    namespaceAliases: ['Google Sheet'],
  },
  { slug: 'googledocs', displayName: 'Google Docs', authMode: 'managed' },
  { slug: 'slack', displayName: 'Slack', authMode: 'managed' },
  { slug: 'github', displayName: 'GitHub', authMode: 'managed' },
  { slug: 'linear', displayName: 'Linear', authMode: 'managed' },
  { slug: 'notion', displayName: 'Notion', authMode: 'managed' },
  { slug: 'hubspot', displayName: 'HubSpot', authMode: 'managed' },
  { slug: 'salesforce', displayName: 'Salesforce', authMode: 'managed' },
  { slug: 'discord', displayName: 'Discord', authMode: 'managed' },
  { slug: 'trello', displayName: 'Trello', authMode: 'managed' },
  { slug: 'asana', displayName: 'Asana', authMode: 'managed' },
  { slug: 'jira', displayName: 'Jira', authMode: 'managed' },
  { slug: 'airtable', displayName: 'Airtable', authMode: 'managed' },
  { slug: 'figma', displayName: 'Figma', authMode: 'managed' },
  { slug: 'dropbox', displayName: 'Dropbox', authMode: 'managed' },
  { slug: 'stripe', displayName: 'Stripe', authMode: 'managed' },
  { slug: 'supabase', displayName: 'Supabase', authMode: 'managed' },
  { slug: 'outlook', displayName: 'Outlook / Microsoft 365', authMode: 'managed' },
  { slug: 'one_drive', displayName: 'OneDrive', authMode: 'managed' },
  { slug: 'zoom', displayName: 'Zoom', authMode: 'managed' },
  { slug: 'twitter', displayName: 'Twitter / X', authMode: 'byo' },
];

const DISPLAY_NAME_BY_SLUG = new Map(CURATED_TOOLKITS.map((toolkit) => [toolkit.slug, toolkit.displayName]));

export interface ConnectedToolkit {
  slug: string;
  connectionId: string;
  status: string;
  alias?: string;
  accountLabel?: string;
  accountEmail?: string;
  accountName?: string;
  accountAvatarUrl?: string;
  createdAt?: string;
  /** Composio's own stable per-connection handle (e.g. `gmail_red-castle`). A
   *  secondary identity key for connection selection when no accountEmail is
   *  known — see selectToolkitConnection(). */
  wordId?: string;
  /** The Composio entity (user_id) that OWNS this connection — dispatch must
   *  send this userId with the pinned connectedAccountId or Composio 400s with
   *  ConnectedAccountEntityIdMismatch. From the raw v3 listing (the SDK strips
   *  it); absent when only the SDK fallback listing was available. */
  ownerUserId?: string;
}

export interface ComposioConnectionSuppression {
  reason?: string;
  suppressUntil: string;
  lastErrorAt?: string;
  failures?: number;
}

export interface ComposioConnectionSuppressionState {
  suppressedConnections?: Record<string, ComposioConnectionSuppression>;
}

export interface CatalogToolkit {
  slug: string;
  name: string;
  logoUrl?: string;
  description?: string;
  toolsCount?: number;
  authMode: ToolkitAuthMode;
  categories: { slug: string; name: string }[];
}

export interface ComposioToolkitTool {
  slug: string;
  name: string;
  description?: string;
  toolkitSlug?: string;
  inputParameters?: unknown;
  /** Exact provider result payload schema from the same definition row as
   * inputParameters. This describes `execute(...).data`, never Clementine's
   * outer `{successful,data,error}` envelope. */
  outputParameters?: unknown;
  /** Exact operation version returned with this provider definition. */
  version?: string;
}

/** The live discovery boundary is deliberately smaller than the foreground
 * result surface. One server-side query may oversample for ranking/dedupe, but
 * it never enumerates a toolkit page. */
export const COMPOSIO_LIVE_SEARCH_OVERSAMPLE_LIMIT = 16;
/** Single-term rungs issued in parallel when narrower rungs return nothing.
 * Bounded so one unresolved role can never become foreground enumeration. */
const COMPOSIO_SEARCH_RELAXATION_FANOUT = 4;
/** Sentinel for the final rung: ask the connected carriers with no text
 * filter, because a connection already granted its catalog. */
const PROVIDER_SEARCH_UNFILTERED_RUNG = '';
export const COMPOSIO_LIVE_SEARCH_RETURN_LIMIT = 8;

export class ComposioSearchProviderContractError extends Error {
  readonly code = 'composio_search_provider_contract_refused' as const;

  constructor() {
    super(`Composio filtered search exceeded the ${COMPOSIO_LIVE_SEARCH_OVERSAMPLE_LIMIT}-definition provider contract.`);
    this.name = 'ComposioSearchProviderContractError';
  }
}

export class ComposioExactToolProviderContractError extends Error {
  readonly code = 'composio_exact_tool_provider_contract_refused' as const;

  constructor() {
    super('Composio exact-tool metadata lookup returned more than one definition.');
    this.name = 'ComposioExactToolProviderContractError';
  }
}

function normalizeSuppression(value: unknown): ComposioConnectionSuppression | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const rec = value as Record<string, unknown>;
  const suppressUntil = typeof rec.suppressUntil === 'string' ? rec.suppressUntil : undefined;
  if (!suppressUntil) return undefined;
  return {
    reason: typeof rec.reason === 'string' ? rec.reason : undefined,
    suppressUntil,
    lastErrorAt: typeof rec.lastErrorAt === 'string' ? rec.lastErrorAt : undefined,
    failures: typeof rec.failures === 'number' ? rec.failures : undefined,
  };
}

function isSuppressionActive(rec: ComposioConnectionSuppression | undefined, nowMs: number): rec is ComposioConnectionSuppression {
  if (!rec) return false;
  const until = Date.parse(rec.suppressUntil);
  return Number.isFinite(until) && until > nowMs;
}

export function readComposioConnectionSuppressionState(nowMs = Date.now()): ComposioConnectionSuppressionState {
  const suppressedConnections: Record<string, ComposioConnectionSuppression> = {};
  for (const file of CONNECTION_SUPPRESSION_SOURCE_FILES) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
      const raw = parsed.suppressedConnections && typeof parsed.suppressedConnections === 'object'
        ? parsed.suppressedConnections as Record<string, unknown>
        : {};
      for (const [connectionId, value] of Object.entries(raw)) {
        const rec = normalizeSuppression(value);
        if (!isSuppressionActive(rec, nowMs)) continue;
        const existing = suppressedConnections[connectionId];
        if (!existing || Date.parse(rec.suppressUntil) > Date.parse(existing.suppressUntil)) {
          suppressedConnections[connectionId] = rec;
        }
      }
    } catch {
      // A corrupt monitor state file must not hide every Composio connection.
    }
  }
  return Object.keys(suppressedConnections).length > 0 ? { suppressedConnections } : {};
}

export function saveComposioConnectionSuppressionState(
  state: ComposioConnectionSuppressionState,
  nowMs = Date.now(),
): void {
  const suppressedConnections: Record<string, ComposioConnectionSuppression> = {};
  for (const [connectionId, rec] of Object.entries(state.suppressedConnections ?? {})) {
    if (isSuppressionActive(rec, nowMs)) suppressedConnections[connectionId] = rec;
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(
    CONNECTION_SUPPRESSION_FILE,
    JSON.stringify({ suppressedConnections }, null, 2),
  );
  // A connection that just failed ownership/auth validation must stop looking
  // healthy on the next Connect read, not after the dashboard SWR window.
  bustComposioDashboardCaches();
}

export function filterSuppressedConnectedToolkits(
  connections: ConnectedToolkit[],
  state: ComposioConnectionSuppressionState,
  nowMs = Date.now(),
): ConnectedToolkit[] {
  return connections.filter((connection) => !isSuppressionActive(state.suppressedConnections?.[connection.connectionId], nowMs));
}

export function listSuppressedConnectedToolkitViews(
  connections: ConnectedToolkit[],
  state: ComposioConnectionSuppressionState,
  nowMs = Date.now(),
): Array<ConnectedToolkit & { suppression: ComposioConnectionSuppression }> {
  const out: Array<ConnectedToolkit & { suppression: ComposioConnectionSuppression }> = [];
  for (const connection of connections) {
    const suppression = state.suppressedConnections?.[connection.connectionId];
    if (isSuppressionActive(suppression, nowMs)) out.push({ ...connection, suppression });
  }
  return out;
}

export interface ComposioDashboardConnection {
  slug: string;
  /** Keep both names: legacy dashboard consumes connectionId; SPA consumes id. */
  connectionId: string;
  id: string;
  status: string;
  providerStatus: string;
  usable: boolean;
  needsReconnect: boolean;
  suppressionReason: string | null;
  suppressUntil: string | null;
  /** When execution last proved this connection broken (suppression evidence).
   *  Null while the connection is healthy. Drives the Connect screen's
   *  "stopped working Xm ago" honesty line. */
  lastFailureAt: string | null;
  alias: string | null;
  accountLabel: string | null;
  accountEmail: string | null;
  accountName: string | null;
  accountAvatarUrl: string | null;
  createdAt: string | null;
  /** The user's own memory label for this account (e.g. "work", "personal"),
   *  from account-alias-store. Null when unlabeled. Drives the desktop UI and
   *  the agent's mailbox routing. */
  userLabel: string | null;
}

export interface ComposioDashboardToolkit {
  slug: string;
  displayName: string;
  authMode: ToolkitAuthMode;
  hasAuthConfig: boolean;
  logoUrl: string | null;
  description: string | null;
  toolCount: number | null;
  categories: { slug: string; name: string }[];
  connections: ComposioDashboardConnection[];
}

export interface ComposioDashboardSnapshot {
  enabled: boolean;
  apiKeyPresent: boolean;
  maskedApiKey?: string;
  userId: string;
  executionBackend: ComposioExecutionBackend;
  cli: ComposioCliStatus;
  connected: ComposioDashboardConnection[];
  toolkits: ComposioDashboardToolkit[];
  featured: string[];
  totalCount: number;
  catalogError?: string | null;
}

interface AccountIdentity {
  email?: string;
  name?: string;
  avatarUrl?: string;
  label?: string;
}

let singleton: Composio | null = null;
let localEnvCache: { at: number; env: Record<string, string> } | null = null;
let connectionsCache: { at: number; data: ConnectedToolkit[] } | null = null;
let connectionsGeneration = 0;
let connectionsInflight: { generation: number; promise: Promise<ConnectedToolkit[]> } | null = null;
// Durable last-successful snapshot. Survives invalidateConnectedAccountSnapshot()
// (the routine cache-bust the self-heal fires) so a transient refresh failure — an
// API throttle under a wide worker fan-out, or the generation-changed race — can
// serve the last-known-good connections instead of an EMPTY list. An empty snapshot
// makes resolution defer → a bare dispatch under an entity that may own no
// connection for the toolkit → a permanent-looking Auth_Config_AuthSchemeNotFound
// for a lane that is actually fine (live 2026-07-24: a 60-worker research fan-out
// throttled the snapshot fetch and every worker hard-failed auth). Cleared only on a
// real client reset (API-key change), where the prior account's connections no longer apply.
let lastGoodConnections: ConnectedToolkit[] | null = null;
// A refresh superseded by a newer generation (concurrent invalidation) throws
// this specific message so a stale in-flight result is never served. It is NOT a
// transient fetch failure — the caller should get the newer refresh, so this
// error propagates (retry contract) rather than degrading to last-good.
const SNAPSHOT_SUPERSEDED_MESSAGE = 'Composio account state changed during refresh; retry the operation.';
let connectedAccountsLoaderForTest: (() => Promise<Array<Record<string, unknown>>>) | null = null;
interface ConnectedAccountsRawListResponse {
  ok: boolean;
  status?: number;
  json(): Promise<unknown>;
}
interface ConnectedAccountsListTransports {
  rawList(input: { apiKey: string; signal: AbortSignal }): Promise<ConnectedAccountsRawListResponse>;
  sdkList(input: { limit: number }): Promise<unknown> | null;
}
let connectedAccountsListTransportsForTest: ConnectedAccountsListTransports | null = null;
// Test-only override: null follows the real vault/env chain, while an empty
// string proves the genuinely keyless AUTO lane without touching a developer's
// local credential files.
let composioApiKeyOverrideForTest: string | null = null;
let catalogCache: { at: number; data: CatalogToolkit[] } | null = null;

// Per-toolkit tool-list cache (D3): composio_search_tools fans out to
// listComposioToolkitTools once PER connected toolkit PER search, each a
// network round-trip (curated v3 fetch + raw SDK list). A toolkit's tool set is
// stable within a session, so a short TTL turns the second+ search of a session
// from multi-second into in-memory. Keyed by (slug, limit). Busted whenever
// connections change (a new connection can expose a toolkit's tools for the
// first time).
const TOOLKIT_TOOLS_TTL_MS = 15 * 60 * 1000;
const toolkitToolsCache = new Map<string, { at: number; data: ComposioToolkitTool[] }>();
// Kept out-of-band so provider provenance never leaks into tool catalog output
// or schema payloads. Cached objects retain their ORIGINAL observation time;
// replaying the 15-minute list cache cannot mint a fresh execution lease.
const toolSchemaObservedAt = new WeakMap<object, number>();

export function composioToolSchemaObservedAt(tool: ComposioToolkitTool): number | undefined {
  return tool && typeof tool === 'object' ? toolSchemaObservedAt.get(tool) : undefined;
}

export function composioToolOperationVersion(tool: ComposioToolkitTool): string | undefined {
  const version = tool && typeof tool === 'object' ? tool.version?.trim() : '';
  return version && version.length <= 160 && /^[A-Za-z0-9_.:-]+$/.test(version)
    ? version
    : undefined;
}
/** Clear the per-toolkit tool-list cache. Exported for tests + connection busts. */
export function bustToolkitToolsCache(): void {
  toolkitToolsCache.clear();
}

function readLocalEnv(): Record<string, string> {
  const now = Date.now();
  if (localEnvCache && now - localEnvCache.at < 2_000) return localEnvCache.env;
  const env = readEnvFile(ENV_FILE);
  localEnvCache = { at: now, env };
  return env;
}

function readSecretFromFileVaultSync(name: string): string | undefined {
  if (!existsSync(SECRET_VAULT_FILE)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(SECRET_VAULT_FILE, 'utf-8')) as {
      version?: string;
      entries?: Record<string, string>;
    };
    if (parsed.version !== 'v1' || !parsed.entries) return undefined;
    const value = parsed.entries[name];
    return value && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function readComposioEnv(key: 'COMPOSIO_API_KEY' | 'COMPOSIO_USER_ID'): string {
  if (key === 'COMPOSIO_API_KEY' && composioApiKeyOverrideForTest !== null) {
    return composioApiKeyOverrideForTest;
  }
  // Precedence matches CompositeSecretStore: vault → env. Previously
  // process.env won, which let a stale/bad value in .env silently mask
  // a freshly-saved vault value. (Observed 2026-05-23: user had two
  // different keys and the bad .env one beat the good vault one.)
  if (key === 'COMPOSIO_API_KEY') {
    const vaultValue = readSecretFromFileVaultSync('composio_api_key')?.trim();
    if (vaultValue) return vaultValue;
  }
  const fromProcess = process.env[key]?.trim();
  if (fromProcess) return fromProcess;
  const fromEnvFile = readLocalEnv()[key]?.trim();
  if (fromEnvFile) return fromEnvFile;
  return '';
}

function readComposioConfigEnv(key: 'COMPOSIO_BACKEND'): string {
  const fromProcess = process.env[key]?.trim();
  if (fromProcess) return fromProcess;
  return readLocalEnv()[key]?.trim() ?? '';
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/** Current Composio failures can hide the useful code/message under cause or
 * getErrorData(). Keep this classifier at the client boundary so AUTO never
 * repeats a deterministic CLI connection failure through the SDK. */
export function isComposioReconnectRequiredError(value: unknown): boolean {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let hasReconnectCode = false;

  const visit = (input: unknown, depth: number): void => {
    if (input === null || input === undefined || depth > 4 || seen.has(input)) return;
    if (typeof input === 'string' || typeof input === 'number') {
      parts.push(String(input));
      return;
    }
    if (typeof input !== 'object') return;
    seen.add(input);

    const record = input as Record<string, unknown> & { getErrorData?: () => unknown };
    for (const [key, nested] of Object.entries(record)) {
      if (/^(?:code|errorCode|error_code)$/i.test(key) && (nested === 1810 || nested === 1812 || nested === '1810' || nested === '1812')) {
        hasReconnectCode = true;
      }
      visit(nested, depth + 1);
    }
    if (input instanceof Error) {
      parts.push(input.name, input.message);
      visit((input as Error & { cause?: unknown }).cause, depth + 1);
    }
    try {
      if (typeof record.getErrorData === 'function') visit(record.getErrorData(), depth + 1);
    } catch {
      // Best-effort classification only.
    }
  };

  visit(value, 0);
  return hasReconnectCode || RECONNECT_REQUIRED_RE.test(parts.join(' ').slice(0, 8_000));
}

export class ComposioReconnectRequiredError extends Error {
  readonly cause: unknown;

  constructor(toolSlug: string, cause: unknown) {
    const toolkitSlug = toolSlug.split('_')[0]?.toLowerCase() || 'this app';
    const app = toolkitSlug === 'this app' ? toolkitSlug : displayNameFor(toolkitSlug);
    super(`The saved ${app} connection cannot be used by Clementine's current Composio user. Open Connect and reconnect ${app}. Do not retry this action until it is reconnected.`);
    this.name = 'ComposioReconnectRequiredError';
    this.cause = cause;
  }
}

/** AUTO backend protection: a CLI mutation can commit remotely and then lose
 * its response. Falling through to the SDK on that ambiguous error would run
 * the same external write twice. */
export class ComposioDispatchUncertainError extends Error {
  readonly cause: unknown;
  readonly toolSlug: string;

  constructor(toolSlug: string, cause: unknown) {
    super(`${toolSlug} may already have completed through the Composio CLI. SDK fallback was suppressed. Verify the remote state before retrying this mutation.`);
    this.name = 'ComposioDispatchUncertainError';
    this.toolSlug = toolSlug;
    this.cause = cause;
  }
}

/** Locally-created proof that a Composio provider call never started.
 *
 * This class is deliberately nominal: replay authority comes from
 * `instanceof`, never from a message, status, marker, or structurally similar
 * provider payload. A remote response can echo any of those fields after a
 * mutation committed; it cannot become an instance created by this process
 * before dispatch. */
export class ComposioPreDispatchError extends ExternalWritePreDispatchError {
  readonly reason: 'cli-unavailable' | 'cli-auth' | 'sdk-unavailable' | 'tool-not-found' | 'connection-ambiguous' | 'preparation-required';

  constructor(
    reason: ComposioPreDispatchError['reason'],
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ComposioPreDispatchError';
    this.reason = reason;
  }
}

/** True only when the CLI could not have crossed the provider boundary. Keep
 * this intentionally nominal. Provider timeouts, 4xx/5xx responses, broken
 * pipes, CLI error text, and even `[provider-dispatch:not-started:*]` prose are
 * ambiguous for writes: all can be returned or echoed after a remote commit.
 * Only a class instance constructed by a local preflight before invocation may
 * authorize replay. */
export function composioCliErrorProvesNoDispatch(error: unknown): boolean {
  return error instanceof ComposioPreDispatchError;
}

export function composioAutoFallbackAllowed(toolSlug: string, error: unknown): boolean {
  return composioSlugIsReadOnly(toolSlug) || composioCliErrorProvesNoDispatch(error);
}

export function maskApiKey(value: string): string {
  if (!value) return '';
  if (value.length <= 10) return `${value.slice(0, 3)}...`;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function displayNameFor(slug: string): string {
  return DISPLAY_NAME_BY_SLUG.get(slug) ?? humanize(slug);
}

function humanize(slug: string): string {
  return slug
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** Staging directory for the file pipeline: tool downloads land here (the
 *  execute response carries the local filePath) and auto-uploads may read from
 *  here or anywhere under home (the SDK's sensitive-path denylist — .ssh,
 *  .aws, .env*, key files — still refuses credentials, and every upload rides
 *  the normal external-write gates). */
export function composioFilesDir(): string {
  return path.join(BASE_DIR, 'files');
}

/** Kill-switch: CLEMMY_COMPOSIO_FILES=off restores the legacy no-file client. */
function composioFilePipelineEnabled(): boolean {
  return (process.env.CLEMMY_COMPOSIO_FILES ?? 'on').trim().toLowerCase() !== 'off';
}

export function getComposio(): Composio | null {
  if (singleton) return singleton;
  const apiKey = readComposioEnv('COMPOSIO_API_KEY');
  if (!apiKey) return null;
  // File pipeline (2026-07-21, employee-basic capability wave): without these
  // flags a downloaded attachment surfaced only as an S3 URL (or a base64 blob
  // the digest tier truncates) and file_uploadable params could not read local
  // paths — "move this file from Outlook to Drive", the most basic employee
  // action, had no working path. With them, the SDK downloads file outputs to
  // our staging dir and returns the LOCAL filePath in the tool result, and
  // upload params accept a local path (allowlist + credential denylist).
  if (composioFilePipelineEnabled()) {
    const filesDir = composioFilesDir();
    try { mkdirSync(filesDir, { recursive: true }); } catch { /* the SDK falls back to ~/.composio/files */ }
    singleton = new Composio({
      apiKey,
      // Clementine owns provider-call observability locally. The SDK's
      // independent telemetry adds an unrelated background request, makes
      // deterministic fetch/abort accounting harder, and is unnecessary for a
      // user-controlled local agent.
      allowTracking: false,
      // The SDK otherwise starts an unawaited NPM-registry version check during
      // construction. Provider clients must never create an unowned crossing.
      disableVersionCheck: true,
      dangerouslyAllowAutoUploadDownloadFiles: true,
      fileDownloadDir: filesDir,
      fileUploadDirs: [filesDir, os.homedir()],
      // sensitiveFileUploadProtection stays default ON.
    });
  } else {
    singleton = new Composio({ apiKey, allowTracking: false, disableVersionCheck: true });
  }
  installAbortAwareFetch(singleton);
  return singleton;
}

/**
 * Make the Composio HTTP client honor a per-tool-call AbortSignal carried on the
 * harness abort context (runtime/tool-abort-context). When a tool call times out,
 * brackets.ts aborts its controller; without this wrap the underlying request keeps
 * running and burns provider credits (the 2026-06-24 Apify case).
 *
 * The @composio/core SDK's `execute` path (whose exact error-string shapes feed the
 * version-retry regex below) stays completely intact — we only wrap the underlying
 * @composio/client (Stainless) instance's `fetch`, which it stores as a plain mutable
 * property and invokes as `this.fetch.call(undefined, url, init)` (verified in the
 * installed client.js). We merge the ALS signal into each request's existing signal
 * via `AbortSignal.any`.
 *
 * Fully fail-open: any structural surprise, no ALS signal, or the kill-switch off
 * (⇒ no controller is ever created in brackets, so no ALS signal is set) leaves fetch
 * behaving exactly as before. Exported for the fetch-merge unit test. */
export function installAbortAwareFetch(composio: Composio): void {
  try {
    const client = rawComposioClient(composio) as {
      fetch?: (url: unknown, init?: Record<string, unknown>) => Promise<unknown>;
      __clemAbortAware?: boolean;
    } | null;
    if (!client || typeof client.fetch !== 'function' || client.__clemAbortAware) return;
    const original = client.fetch;
    // The SDK calls `this.fetch.call(undefined, ...)`, so the wrapper must not rely
    // on `this`; the original is global fetch and is likewise invoked unbound.
    const wrapped = (url: unknown, init?: Record<string, unknown>): Promise<unknown> => {
      let signal: AbortSignal | undefined;
      try { signal = currentToolAbortSignal(); } catch { signal = undefined; }
      if (!signal) return original.call(undefined, url, init);
      try {
        const existing = init && (init as { signal?: unknown }).signal;
        const parts = [existing, signal].filter(
          (s): s is AbortSignal => Boolean(s) && typeof (s as AbortSignal).addEventListener === 'function',
        );
        const merged = typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function' && parts.length > 0
          ? AbortSignal.any(parts)
          : signal;
        return original.call(undefined, url, { ...(init ?? {}), signal: merged });
      } catch {
        return original.call(undefined, url, init); // fail-open — abort is best-effort, never required for correctness
      }
    };
    client.fetch = wrapped;
    Object.defineProperty(client, '__clemAbortAware', { value: true, enumerable: false });
  } catch {
    /* fail-open: leave fetch untouched */
  }
}

export function isComposioEnabled(): boolean {
  return Boolean(readComposioEnv('COMPOSIO_API_KEY'));
}

export function getComposioCredentialStatus(): {
  enabled: boolean;
  apiKeyPresent: boolean;
  maskedApiKey?: string;
  userId: string;
  executionBackend: ComposioExecutionBackend;
} {
  const apiKey = readComposioEnv('COMPOSIO_API_KEY');
  return {
    enabled: Boolean(apiKey),
    apiKeyPresent: Boolean(apiKey),
    maskedApiKey: apiKey ? maskApiKey(apiKey) : undefined,
    userId: configuredUserId() ?? derivedComposioUserId(),
    executionBackend: getComposioExecutionBackend(),
  };
}

export function getComposioExecutionBackend(): ComposioExecutionBackend {
  const raw = readComposioConfigEnv('COMPOSIO_BACKEND').toLowerCase();
  return (BACKEND_VALUES as readonly string[]).includes(raw) ? raw as ComposioExecutionBackend : 'auto';
}

/** Single backend-lane decision shared by gateway resolution and execution.
 * AUTO with a configured SDK key is SDK-owned; AUTO falls to the CLI default
 * only when no SDK key exists. Keeping this pure prevents the resolver from
 * proving an SDK account route that execute later sends through the CLI. */
export function composioExecutionUsesCliOnlyLane(status: {
  executionBackend: ComposioExecutionBackend;
  apiKeyPresent: boolean;
}): boolean {
  return status.executionBackend === 'cli'
    || (status.executionBackend === 'auto' && !status.apiKeyPresent);
}

export function saveComposioExecutionBackend(backend: string): ComposioExecutionBackend {
  const normalized = (BACKEND_VALUES as readonly string[]).includes(backend) ? backend as ComposioExecutionBackend : 'auto';
  const env = readEnvFile(ENV_FILE);
  env.COMPOSIO_BACKEND = normalized;
  writeEnvFile(ENV_FILE, env);
  process.env.COMPOSIO_BACKEND = normalized;
  resetComposioClient();
  return normalized;
}

function composioCliOptions(): { apiKey?: string; userId?: string } {
  const apiKey = readComposioEnv('COMPOSIO_API_KEY');
  const userId = configuredUserId() ?? derivedComposioUserId();
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(userId ? { userId } : {}),
  };
}

/** Completed CLI readiness for a business dispatch. This is deliberately a
 * synchronous peek: preparing/executing a call may never start `--version` or
 * `whoami` inside the business logical call. */
export function peekCurrentComposioCliExecutionStatus(): ComposioCliStatus | null {
  return peekCurrentComposioCliStatus(composioCliOptions());
}

async function getComposioRuntimeStatusLive(): Promise<ReturnType<typeof getComposioCredentialStatus> & {
  cli: ComposioCliStatus;
}> {
  const credentials = getComposioCredentialStatus();
  const cli = await getComposioCliStatus(composioCliOptions());
  return { ...credentials, cli };
}

// ─── Dashboard read caches (stale-while-revalidate) ─────────────────────────
// The Connect screen fetches status + the toolkit snapshot on EVERY mount and
// re-polls every 20–30s; both did live upstream work per request (~4.3s each,
// measured live 2026-07-07) so clicking into Connect sat on a blank pane.
// SWR semantics: fresh → serve cached; stale → serve cached AND refresh in
// the background; cold → await one deduped live fetch. Mutations (api-key
// save, authorize, disconnect, explicit refresh) bust both entries so the UI
// never shows a connection state older than the user's own last action.
interface SwrEntry<T> { value: T | null; fetchedAt: number; inflight: Promise<T> | null }

function swrFetch<T>(entry: SwrEntry<T>, ttlMs: number, live: () => Promise<T>): Promise<T> {
  const age = Date.now() - entry.fetchedAt;
  const refresh = (): Promise<T> => {
    entry.inflight ??= live().then(
      (value) => { entry.value = value; entry.fetchedAt = Date.now(); entry.inflight = null; return value; },
      (err: unknown) => { entry.inflight = null; throw err; },
    );
    return entry.inflight;
  };
  if (entry.value !== null && age < ttlMs) return Promise.resolve(entry.value);
  if (entry.value !== null) {
    void refresh().catch(() => { /* stale value stays served; next poll retries */ });
    return Promise.resolve(entry.value);
  }
  return refresh();
}

const COMPOSIO_STATUS_TTL_MS = 45_000;
const COMPOSIO_SNAPSHOT_TTL_MS = 60_000;
const statusSwr: SwrEntry<Awaited<ReturnType<typeof getComposioRuntimeStatusLive>>> = { value: null, fetchedAt: 0, inflight: null };
const snapshotSwr: SwrEntry<ComposioDashboardSnapshot> = { value: null, fetchedAt: 0, inflight: null };

/** Bust the dashboard read caches after any connection-state mutation. */
export function bustComposioDashboardCaches(): void {
  statusSwr.value = null; statusSwr.fetchedAt = 0;
  snapshotSwr.value = null; snapshotSwr.fetchedAt = 0;
}

export async function getComposioRuntimeStatus(): Promise<ReturnType<typeof getComposioCredentialStatus> & {
  cli: ComposioCliStatus;
}> {
  return swrFetch(statusSwr, COMPOSIO_STATUS_TTL_MS, getComposioRuntimeStatusLive);
}

/**
 * Validate an API key against Composio's API BEFORE writing it to .env.
 * Distinguishes three cases:
 *   - 'valid'   — Composio accepted the key (returned 2xx on a 1-item probe).
 *   - 'invalid' — Composio rejected (401/403). The key text itself is wrong.
 *   - 'unknown' — Network failure / 5xx / timeout. Caller should still
 *                 allow the save (don't lock the user out when Composio
 *                 is down or the laptop is offline).
 *
 * This is a single ~200ms round-trip on a 5s timeout. It does NOT touch
 * the singleton client or any cache — the caller saves on its own.
 */
export async function validateComposioApiKey(apiKey: string): Promise<{
  result: 'valid' | 'invalid' | 'unknown';
  message?: string;
}> {
  const trimmed = apiKey.trim();
  if (!trimmed) return { result: 'invalid', message: 'API key is empty.' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch('https://backend.composio.dev/api/v3/connected_accounts?limit=1', {
      headers: { 'x-api-key': trimmed, 'accept': 'application/json' },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      let detail: string | undefined;
      try {
        const body = await res.json() as { error?: { message?: string } };
        detail = body?.error?.message;
      } catch { /* ignore */ }
      return { result: 'invalid', message: detail ?? `Composio rejected the API key (HTTP ${res.status}).` };
    }
    if (res.ok) return { result: 'valid' };
    // Other status codes (5xx, 429) are "unknown" — don't block save.
    return { result: 'unknown', message: `Composio returned HTTP ${res.status} during validation; the key was saved without confirmation.` };
  } catch (err) {
    return {
      result: 'unknown',
      message: `Could not reach Composio to validate the key (${err instanceof Error ? err.message : String(err)}); the key was saved without confirmation.`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function saveComposioCredentials(apiKey: string, userId?: string): Promise<void> {
  const trimmedKey = apiKey.trim();
  if (!trimmedKey) throw new Error('COMPOSIO_API_KEY is required.');

  // Canonical store (file vault) — same backend the SecretStore uses
  // for every other credential. The dashboard used to write directly
  // to .env which then DIVERGED from the vault when other paths wrote
  // there too. Routing through the SecretStore makes the vault the
  // single source of truth. (Drift detection added 2026-05-23 surfaces
  // any remaining .env values inherited from older installs.)
  const store = await getSecretStore();
  await store.set('composio_api_key', trimmedKey);

  // user_id has no SecretStore descriptor (not a credential), so it
  // continues to live in .env. This is the value the user can override
  // per-org; getPreferredUserId() auto-resolves when blank.
  if (userId !== undefined) {
    const env = readEnvFile(ENV_FILE);
    const trimmedUserId = userId.trim();
    if (trimmedUserId) env.COMPOSIO_USER_ID = trimmedUserId;
    else delete env.COMPOSIO_USER_ID;
    writeEnvFile(ENV_FILE, env);
    if (trimmedUserId) process.env.COMPOSIO_USER_ID = trimmedUserId;
    else delete process.env.COMPOSIO_USER_ID;
  }

  // Also push into process.env so in-process reads see the new key
  // immediately — readComposioEnv prefers vault now, but other code
  // paths that read process.env directly (e.g. CLI subprocess env)
  // still rely on this.
  process.env.COMPOSIO_API_KEY = trimmedKey;
  resetComposioClient();
}

export function resetComposioClient(): void {
  singleton = null;
  localEnvCache = null;
  invalidateConnectedAccountSnapshot();
  lastGoodConnections = null; // API key changed → the prior account's connections no longer apply
  catalogCache = null;
  toolkitToolsCache.clear();
  invalidateComposioCliStatusCache();
}

export function clearConnectedToolkitsCache(): void {
  invalidateConnectedAccountSnapshot();
  // A new/changed connection can expose a toolkit's tools for the first time.
  toolkitToolsCache.clear();
}

function invalidateConnectedAccountSnapshot(): void {
  connectionsGeneration += 1;
  connectionsCache = null;
  // A prior request cannot be cancelled, but detaching it prevents new callers
  // from joining it. Its late result is ignored by the generation check.
  connectionsInflight = null;
}

function configuredUserId(): string | undefined {
  const value = readComposioEnv('COMPOSIO_USER_ID');
  return value && value !== DEFAULT_USER_ID ? value : undefined;
}

function derivedComposioUserId(): string {
  const machineId = getMachineId()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return `${DERIVED_USER_ID_PREFIX}${machineId || 'local-machine'}`;
}

/** Persist an auto-resolved id once so the SDK, CLI subprocesses, and future
 * daemon boots all route through the same Composio entity without another
 * account-list probe. Re-check the file immediately before writing so a
 * user-supplied id that arrived during the probe always wins. */
function persistResolvedComposioUserId(resolved: string): string {
  const processValue = process.env.COMPOSIO_USER_ID?.trim();
  if (processValue && processValue !== DEFAULT_USER_ID) return processValue;

  const env = readEnvFile(ENV_FILE);
  const fileValue = env.COMPOSIO_USER_ID?.trim();
  if (fileValue && fileValue !== DEFAULT_USER_ID) {
    process.env.COMPOSIO_USER_ID = fileValue;
    localEnvCache = { at: Date.now(), env };
    return fileValue;
  }

  env.COMPOSIO_USER_ID = resolved;
  writeEnvFile(ENV_FILE, env);
  process.env.COMPOSIO_USER_ID = resolved;
  localEnvCache = { at: Date.now(), env };
  return resolved;
}

/**
 * The Composio ENTITY this daemon acts as. NOT the mailbox selector — the
 * mailbox is decided by the identity-resolved connectedAccountId (see
 * selectToolkitConnection). This is only: `configuredUserId()` (advanced
 * per-org override via COMPOSIO_USER_ID) → else `derivedComposioUserId()`
 * (`clementine-<machine>`, the entity Clem creates connections under and the
 * tools.execute fallback when no specific connection resolves). Pure + local:
 * no network. (The old auto-detect read `user_id` off the account list, which
 * the @composio/core SDK strips — it could never return a value, so it's gone.)
 */
export function getPreferredUserId(): string {
  const explicit = configuredUserId();
  if (explicit) return explicit;
  return persistResolvedComposioUserId(derivedComposioUserId());
}

function rawComposioClient(composio: Composio): any {
  return typeof (composio as any).getClient === 'function'
    ? (composio as any).getClient()
    : (composio as any).client;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const [, payload] = jwt.split('.');
    if (!payload) return null;
    const padded = payload + '==='.slice((payload.length + 3) % 4);
    return JSON.parse(Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractAccountIdentity(state: unknown, data: unknown): AccountIdentity {
  const stateObj = obj(state);
  const dataObj = obj(data);
  const out: AccountIdentity = {};

  const idToken = str(stateObj.id_token) ?? str(dataObj.id_token);
  if (idToken) {
    const payload = decodeJwtPayload(idToken);
    if (payload) {
      out.email = str(payload.email);
      out.name = str(payload.name) ?? str(payload.given_name);
      out.avatarUrl = str(payload.picture);
    }
  }

  for (const source of [dataObj, stateObj]) {
    const profile = source.user_info && typeof source.user_info === 'object'
      ? source.user_info as Record<string, unknown>
      : source.profile && typeof source.profile === 'object'
        ? source.profile as Record<string, unknown>
        : {};
    out.email = out.email ?? str(profile.email) ?? str(source.email);
    out.name = out.name ?? str(profile.name) ?? str(profile.display_name) ?? str(source.name) ?? str(source.display_name);
    out.avatarUrl = out.avatarUrl ?? str(profile.picture) ?? str(profile.avatar_url) ?? str(source.picture) ?? str(source.avatar_url);
  }

  const fallback =
    str(stateObj.shop) ??
    str(stateObj.subdomain) ??
    str(stateObj.domain) ??
    str(stateObj.account_id) ??
    str(dataObj.shop) ??
    str(dataObj.subdomain);

  out.label = out.email ?? out.name ?? fallback;
  return out;
}

type ConnectedAccountItemsLoadOutcome =
  | { kind: 'authoritative'; items: Array<Record<string, unknown>> }
  | { kind: 'transient'; reason: string };

function decodeConnectedAccountItems(value: unknown): Array<Record<string, unknown>> | null {
  if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
  if (!value || typeof value !== 'object') return null;
  const items = (value as { items?: unknown }).items;
  return Array.isArray(items) ? items as Array<Record<string, unknown>> : null;
}

function connectedAccountLoadFailure(reason: string): ConnectedAccountItemsLoadOutcome {
  return { kind: 'transient', reason };
}

/**
 * Try raw v3 first (it preserves owner user_id), then the SDK compatibility
 * listing. The caller owns the ONE absolute phase deadline; neither leg gets a
 * fresh timeout window. A provider response is authoritative only when its
 * payload contains an actual items array — including a genuine empty array.
 */
async function loadConnectedAccountItemsWithinPhase(
  apiKey: string,
  signal: AbortSignal,
): Promise<ConnectedAccountItemsLoadOutcome> {
  let rawFailure = 'raw connected-account listing was unavailable';
  try {
    const res = connectedAccountsListTransportsForTest
      ? await connectedAccountsListTransportsForTest.rawList({ apiKey, signal })
      : await fetch('https://backend.composio.dev/api/v3/connected_accounts?limit=100', {
          headers: { 'x-api-key': apiKey },
          signal,
        });
    if (res.ok) {
      const items = decodeConnectedAccountItems(await res.json());
      if (items) return { kind: 'authoritative', items };
      rawFailure = 'raw connected-account listing returned an invalid payload';
    } else {
      rawFailure = `raw connected-account listing returned HTTP ${res.status ?? 'error'}`;
    }
  } catch (err) {
    if (signal.aborted) return connectedAccountLoadFailure('connected-account listing deadline exceeded');
    rawFailure = err instanceof Error ? err.message : String(err);
  }

  if (signal.aborted) return connectedAccountLoadFailure('connected-account listing deadline exceeded');

  // SDK fallback exposes no owner ids, but remains useful when raw v3 is
  // transiently unavailable. It accepts no AbortSignal, so the outer phase
  // race is its cancellation owner. A late SDK result resolves only this
  // abandoned local promise; publication happens solely from the raced outcome.
  let sdkRequest: Promise<unknown> | null;
  try {
    sdkRequest = connectedAccountsListTransportsForTest
      ? connectedAccountsListTransportsForTest.sdkList({ limit: 100 })
      : (() => {
          const composio = getComposio();
          return composio
            ? (composio as any).connectedAccounts.list({ limit: 100 }) as Promise<unknown>
            : null;
        })();
  } catch (err) {
    return connectedAccountLoadFailure(err instanceof Error ? err.message : String(err));
  }
  if (!sdkRequest) return connectedAccountLoadFailure(rawFailure);
  try {
    const items = decodeConnectedAccountItems(await sdkRequest);
    if (signal.aborted) return connectedAccountLoadFailure('connected-account listing deadline exceeded');
    return items
      ? { kind: 'authoritative', items }
      : connectedAccountLoadFailure('SDK connected-account listing returned an invalid payload');
  } catch (err) {
    if (signal.aborted) return connectedAccountLoadFailure('connected-account listing deadline exceeded');
    return connectedAccountLoadFailure(err instanceof Error ? err.message : String(err));
  }
}

async function loadConnectedAccountItems(): Promise<ConnectedAccountItemsLoadOutcome> {
  if (connectedAccountsLoaderForTest) {
    try {
      return { kind: 'authoritative', items: await connectedAccountsLoaderForTest() };
    } catch (err) {
      return connectedAccountLoadFailure(err instanceof Error ? err.message : String(err));
    }
  }
  const apiKey = readComposioEnv('COMPOSIO_API_KEY');
  if (!apiKey) return connectedAccountLoadFailure('Composio API key is unavailable');

  const controller = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ConnectedAccountItemsLoadOutcome>((resolve) => {
    deadlineTimer = setTimeout(() => {
      controller.abort();
      resolve(connectedAccountLoadFailure('connected-account listing deadline exceeded'));
    }, CONNECTED_ACCOUNTS_LIST_TIMEOUT_MS);
  });
  // Start the deadline before either provider leg. Raw failure therefore leaves
  // only the remaining phase time for the SDK; it never opens a second 15s wait.
  const providerPhase = loadConnectedAccountItemsWithinPhase(apiKey, controller.signal);
  try {
    return await Promise.race([providerPhase, deadline]);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

/** Dispatch entity for a resolved/pinned connection: the userId that OWNS it
 *  (from the snapshot), else the configured/derived fallback. Pure. */
/**
 * When identity resolution ends ambiguous (2+ distinct connected accounts) or
 * identity-absent (the remembered mailbox is gone) AND the dispatch entity owns
 * none of the toolkit's connections, a bare dispatch is provably doomed — the
 * backend answers "no active connection", which reads as NOT CONNECTED to a
 * user whose Connect screen shows Active (live 2026-08-04 invite blast).
 * Returns the REAL question to surface instead, or null when a bare dispatch
 * might legitimately succeed. Pure + exported for the pin test.
 */
export function bareDispatchDoomedQuestion(
  outcome: ToolkitConnectionOutcome,
  snapshotConns: ConnectedToolkit[],
  toolSlug: string,
  dispatchUserId: string,
): string | null {
  if (outcome.kind !== 'ambiguous' && outcome.kind !== 'identity-absent') return null;
  const toolLower = toolSlug.toLowerCase();
  const entityOwnsOne = snapshotConns.some((c) => c.connectionId
    && toolMatchesConnection(toolLower, (c.slug ?? '').toLowerCase())
    && (c.ownerUserId ?? '') === dispatchUserId);
  if (entityOwnsOne) return null;
  const candidates = outcome.candidates
    .map((c) => c.email || c.wordId || c.connectionId)
    .filter(Boolean)
    .slice(0, 6)
    .join(', ');
  return outcome.kind === 'identity-absent'
    ? `The remembered account (${outcome.want}) is no longer connected for this toolkit. Connected now: ${candidates || 'none'}. Ask the user which account to use (or to reconnect the remembered one) — do NOT retry unchanged and do NOT report the toolkit as disconnected.`
    : `Multiple accounts are connected for this toolkit (${candidates}). Ask the user which one to use — do NOT retry unchanged and do NOT report the toolkit as disconnected.`;
}

export function dispatchUserIdFor(
  connectionId: string | undefined,
  conns: ConnectedToolkit[],
  fallback: string,
): string {
  if (!connectionId) return fallback;
  // Owner from the live snapshot, else the durable cache (survives a transient
  // raw-v3 outage where the SDK fallback strips user_id), else the fallback.
  const owner = conns.find((c) => c.connectionId === connectionId)?.ownerUserId
    ?? cachedConnectionOwner(connectionId);
  return owner && owner.trim() ? owner : fallback;
}

/** One generation-safe account snapshot feeds connection routing and preferred
 * user selection. This removes the duplicate connectedAccounts.list probes. */
async function refreshConnectedToolkits(): Promise<ConnectedToolkit[]> {
  const generation = connectionsGeneration;
  if (connectionsInflight?.generation === generation) return connectionsInflight.promise;
  let promise!: Promise<ConnectedToolkit[]>;
  promise = (async (): Promise<ConnectedToolkit[]> => {
    const loaded = await loadConnectedAccountItems();
    // Generation and outcome are checked BEFORE mapping. Mapping records
    // connection-owner authority, so even that local side effect must not run
    // for a superseded request, a timeout, or another transient failure.
    if (generation !== connectionsGeneration) {
      throw new Error(SNAPSHOT_SUPERSEDED_MESSAGE);
    }
    if (loaded.kind === 'transient') {
      throw new Error(`Composio connected-account refresh was transient: ${loaded.reason}`);
    }
    const decoded = loaded.items.map((item) => {
      const toolkit = obj(item.toolkit);
      const authConfig = obj(item.authConfig);
      const identity = extractAccountIdentity(item.state, item.data);
      const slug =
        str(toolkit.slug) ??
        str(authConfig.toolkit_slug) ??
        str(authConfig.toolkitSlug) ??
        str(item.toolkit_slug) ??
        str(item.toolkitSlug) ??
        'unknown';

      return {
        slug,
        connectionId: str(item.id) ?? str(item.nanoid) ?? str(item.connectionId) ?? '',
        status: str(item.status) ?? 'UNKNOWN',
        alias: str(item.alias),
        accountLabel: identity.label,
        accountEmail: identity.email,
        accountName: identity.name,
        accountAvatarUrl: identity.avatarUrl,
        createdAt: str(item.createdAt) ?? str(item.created_at),
        wordId: str(item.wordId) ?? str(item.word_id),
        ownerUserId: str(item.user_id) ?? str(item.userId),
      };
    });
    // A successful provider payload with non-empty but malformed rows is not
    // proof of an empty account registry. Reject the whole generation rather
    // than filtering every row away and clearing a healthy last-good view.
    if (decoded.some((connection) => !connection.connectionId || connection.slug === 'unknown')) {
      throw new Error('Composio connected-account refresh returned an incomplete snapshot.');
    }
    const data = decoded.map((connection) => {
      // Identity enrichment: when the listing carries no email (Microsoft
      // tokens expose none), serve the mailbox a profile probe learned for
      // this connection — so same-mailbox re-auths merge and named accounts
      // ("use my acme email") resolve. See identity-cache.ts.
      // Also persist the owning entity (raw v3 exposes it; the SDK strips it)
      // so a later v3 outage still pairs the correct owner at dispatch.
      if (connection.ownerUserId) recordConnectionOwner(connection.connectionId, connection.ownerUserId);
      if (connection.accountEmail) return connection;
      const learned = cachedIdentityEmail(connection.connectionId);
      return learned ? { ...connection, accountEmail: learned } : connection;
    });
    connectionsCache = {
      at: Date.now(),
      data,
    };
    lastGoodConnections = data;
    // Connection publication stays metadata-only. Starting an unawaited
    // 200-definition enumeration here still competes with the foreground
    // role search (and can outlive its turn); the bounded live search owns
    // cold discovery. Offline maintenance may call the explicit index
    // reconciler, but a connection read never starts catalog fan-out.
    return data;
  })().finally(() => {
    if (connectionsInflight?.promise === promise) connectionsInflight = null;
  });
  connectionsInflight = { generation, promise };
  return promise;
}

export async function listConnectedToolkits(
  options: { requireFresh?: boolean } = {},
): Promise<ConnectedToolkit[]> {
  const now = Date.now();
  // Fresh → serve cached.
  if (connectionsCache && now - connectionsCache.at < CONNECTIONS_TTL_MS) return connectionsCache.data;
  // Execution routing must use a fresh account snapshot. Dashboard/status reads
  // may use SWR because they cannot produce a side effect.
  if (options.requireFresh) {
    // Execution routing wants a fresh snapshot, but a transient refresh failure
    // must not degrade to EMPTY (→ resolution defers → bare dispatch under a
    // non-owning entity → false AuthSchemeNotFound). Serve last-good instead —
    // except a genuine supersession, which must propagate its retry contract.
    try { return await refreshConnectedToolkits(); }
    catch (err) {
      if (err instanceof Error && err.message === SNAPSHOT_SUPERSEDED_MESSAGE) throw err;
      return lastGoodConnections ?? [];
    }
  }
  if (connectionsCache) {
    void refreshConnectedToolkits().catch(() => { /* stale stays served; next call retries */ });
    return connectionsCache.data;
  }
  try {
    return await refreshConnectedToolkits();
  } catch (err) {
    // A transient failure (a throttle under a wide fan-out) must NOT erase a
    // healthy lane. Serve last-good; empty only when we never successfully
    // fetched. A supersession propagates (the caller retries onto the newer gen).
    if (err instanceof Error && err.message === SNAPSHOT_SUPERSEDED_MESSAGE) throw err;
    return lastGoodConnections ?? [];
  }
}

export async function listUsableConnectedToolkits(
  options: { requireFresh?: boolean } = {},
): Promise<ConnectedToolkit[]> {
  return filterSuppressedConnectedToolkits(
    await listConnectedToolkits(options),
    readComposioConnectionSuppressionState(),
  );
}

export type SelectedComposioConnectionRevalidation =
  | { ok: true }
  | {
      ok: false;
      identifier: string;
      reason: 'missing_or_changed' | 'inactive_or_suppressed';
    };

/**
 * One strict live account snapshot for the selected definition set. This does
 * not serve last-good/cache state: executable authority must still point at
 * the same active, unsuppressed connection id staged during discovery.
 */
export async function revalidateSelectedComposioConnections(
  selections: readonly { identifier: string; connectionId: string }[],
): Promise<SelectedComposioConnectionRevalidation> {
  if (selections.length === 0) return { ok: true };
  const fresh = await refreshConnectedToolkits();
  const usable = filterSuppressedConnectedToolkits(
    fresh,
    readComposioConnectionSuppressionState(),
  );
  for (const selection of selections) {
    const identifier = selection.identifier.trim();
    const connectionId = selection.connectionId.trim();
    const current = fresh.find((connection) => connection.connectionId === connectionId);
    if (
      !identifier
      || !connectionId
      || connectionId === 'runtime'
      || !current
      || !toolMatchesConnection(identifier.toLowerCase(), current.slug.trim().toLowerCase())
    ) {
      return { ok: false, identifier, reason: 'missing_or_changed' };
    }
    if (
      !usable.some((connection) => connection.connectionId === connectionId)
      || !/^(?:active|enabled)$/i.test(current.status.trim())
    ) {
      return { ok: false, identifier, reason: 'inactive_or_suppressed' };
    }
  }
  return { ok: true };
}

export async function listSuppressedConnectedToolkits(): Promise<Array<ConnectedToolkit & { suppression: ComposioConnectionSuppression }>> {
  const all = await listConnectedToolkits();
  return listSuppressedConnectedToolkitViews(all, readComposioConnectionSuppressionState());
}

/** Convert provider connection state into the dashboard's truthful health
 * contract. Composio may still label a legacy account ACTIVE after execution
 * proves that it belongs to a different entity; active suppression evidence
 * wins over that stale provider label. */
export function toComposioDashboardConnection(
  connection: ConnectedToolkit,
  suppressionState: ComposioConnectionSuppressionState,
  nowMs = Date.now(),
): ComposioDashboardConnection {
  const suppression = suppressionState.suppressedConnections?.[connection.connectionId];
  const suppressed = isSuppressionActive(suppression, nowMs);
  const providerStatus = connection.status || 'UNKNOWN';
  const providerNeedsReconnect = /expired|inactive|failed|revoked|deleted/i.test(providerStatus);
  const needsReconnect = suppressed || providerNeedsReconnect;
  const usable = !needsReconnect && /active|enabled/i.test(providerStatus);

  return {
    slug: connection.slug,
    connectionId: connection.connectionId,
    id: connection.connectionId,
    status: suppressed ? 'NEEDS_RECONNECT' : providerStatus,
    providerStatus,
    usable,
    needsReconnect,
    suppressionReason: suppressed ? suppression.reason ?? 'suppressed' : null,
    suppressUntil: suppressed ? suppression.suppressUntil : null,
    lastFailureAt: suppressed ? suppression.lastErrorAt ?? null : null,
    alias: connection.alias ?? null,
    accountLabel: connection.accountLabel ?? null,
    accountEmail: connection.accountEmail ?? null,
    accountName: connection.accountName ?? null,
    accountAvatarUrl: connection.accountAvatarUrl ?? null,
    createdAt: connection.createdAt ?? null,
    userLabel: aliasLabelFor(connection.slug, connection.accountEmail ?? undefined, connection.connectionId) ?? null,
  };
}

interface RawCatalogItem {
  slug?: string;
  name?: string;
  meta?: {
    logo?: string;
    description?: string;
    toolsCount?: number;
    tools_count?: number;
    categories?: Array<{ slug: string; name: string }>;
  };
  composioManagedAuthSchemes?: string[];
  composio_managed_auth_schemes?: string[];
  authSchemes?: string[];
  auth_schemes?: string[];
  noAuth?: boolean;
  no_auth?: boolean;
}

function normalizeCatalogItem(item: RawCatalogItem): CatalogToolkit | null {
  const slug = str(item.slug);
  if (!slug) return null;
  const managed = item.composioManagedAuthSchemes ?? item.composio_managed_auth_schemes ?? [];
  const schemes = item.authSchemes ?? item.auth_schemes ?? [];
  const noAuth = item.noAuth ?? item.no_auth ?? false;
  return {
    slug,
    name: str(item.name) ?? displayNameFor(slug),
    logoUrl: item.meta?.logo,
    description: item.meta?.description,
    toolsCount: item.meta?.toolsCount ?? item.meta?.tools_count,
    authMode: noAuth ? 'none' : (managed.length > 0 ? 'managed' : (schemes.length > 0 ? 'byo' : 'none')),
    categories: item.meta?.categories ?? [],
  };
}

function readCatalogCache(): CatalogToolkit[] {
  try {
    if (!existsSync(CATALOG_CACHE_FILE)) return [];
    const parsed = JSON.parse(readFileSync(CATALOG_CACHE_FILE, 'utf-8')) as { at?: number; data?: CatalogToolkit[] };
    if (!parsed.at || !Array.isArray(parsed.data)) return [];
    if (Date.now() - parsed.at > CATALOG_TTL_MS * 24) return [];
    return parsed.data;
  } catch {
    return [];
  }
}

/** Synchronous, best-effort read of the cached toolkit catalog (slug + name).
 *  For author-time use (e.g. detecting a toolkit the chat discussed) where an
 *  async catalog fetch would be too heavy. Returns [] when the cache is cold. */
export function listCachedToolkits(): CatalogToolkit[] {
  return readCatalogCache();
}

function writeCatalogCache(data: CatalogToolkit[]): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CATALOG_CACHE_FILE, JSON.stringify({ at: Date.now(), data }, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

export async function listAllToolkits(): Promise<CatalogToolkit[]> {
  const now = Date.now();
  if (catalogCache && catalogCache.data.length > 0 && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.data;
  const composio = getComposio();
  if (!composio) {
    return CURATED_TOOLKITS.map((toolkit) => ({
      slug: toolkit.slug,
      name: toolkit.displayName,
      authMode: toolkit.authMode,
      categories: [],
    }));
  }

  let result: CatalogToolkit[] = [];
  let lastError: unknown;
  try {
    result = await fetchCatalogViaRawClient(composio);
  } catch (error) {
    lastError = error;
  }

  if (result.length === 0) {
    try {
      result = await fetchCatalogViaWrapper(composio);
    } catch (error) {
      lastError = error;
    }
  }

  if (result.length === 0) {
    const stale = readCatalogCache();
    if (stale.length > 0) {
      catalogCache = { at: now, data: stale };
      return stale;
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown error');
    throw new Error(`Composio catalog fetch failed: ${message}`);
  }

  catalogCache = { at: now, data: result };
  writeCatalogCache(result);
  return result;
}

async function fetchCatalogViaRawClient(composio: Composio): Promise<CatalogToolkit[]> {
  const out: CatalogToolkit[] = [];
  let cursor: string | undefined;
  const rawClient = rawComposioClient(composio);
  for (let page = 0; page < 30; page++) {
    const resp = await rawClient.toolkits.list({ limit: 500, ...(cursor ? { cursor } : {}) });
    const items = (resp?.items ?? []) as RawCatalogItem[];
    for (const item of items) {
      const normalized = normalizeCatalogItem(item);
      if (normalized) out.push(normalized);
    }
    cursor = resp?.next_cursor ?? resp?.nextCursor;
    if (!cursor || items.length === 0) break;
  }
  return out;
}

async function fetchCatalogViaWrapper(composio: Composio): Promise<CatalogToolkit[]> {
  const resp = await (composio as any).toolkits.get({ limit: 500 });
  const items = (Array.isArray(resp) ? resp : (resp?.items ?? [])) as RawCatalogItem[];
  return items.map(normalizeCatalogItem).filter((item): item is CatalogToolkit => item !== null);
}

export async function listToolkitSlugsWithAuthConfig(): Promise<Set<string>> {
  const composio = getComposio();
  if (!composio) return new Set();
  try {
    const resp = await (composio as any).authConfigs.list({ limit: 200 });
    const items = Array.isArray(resp) ? resp : (resp?.items ?? []);
    return new Set((items as Array<Record<string, unknown>>)
      .map((item) => {
        const toolkit = obj(item.toolkit);
        return str(toolkit.slug) ?? str(item.toolkit_slug) ?? str(item.toolkitSlug);
      })
      .filter((slug): slug is string => Boolean(slug)));
  } catch {
    return new Set();
  }
}

function authConfigToolkitSlug(item: Record<string, unknown>): string | undefined {
  const toolkit = obj(item.toolkit);
  const authConfig = obj(item.auth_config);
  return str(toolkit.slug)
    ?? str(item.toolkit_slug)
    ?? str(item.toolkitSlug)
    ?? str(authConfig.toolkit_slug)
    ?? str(authConfig.toolkitSlug);
}

function authConfigId(item: Record<string, unknown>): string | undefined {
  const authConfig = obj(item.auth_config);
  return str(item.id)
    ?? str(item.nanoid)
    ?? str(item.auth_config_id)
    ?? str(item.authConfigId)
    ?? str(authConfig.id)
    ?? str(authConfig.nanoid);
}

function authConfigAuthScheme(item: Record<string, unknown>): string | undefined {
  const authConfig = obj(item.auth_config);
  return str(item.auth_scheme)
    ?? str(item.authScheme)
    ?? str(authConfig.auth_scheme)
    ?? str(authConfig.authScheme)
    ?? str(item.mode)
    ?? str(authConfig.mode);
}

function selectAuthConfigIdForToolkit(
  items: Array<Record<string, unknown>>,
  slug: string,
  expectedAuthScheme?: string,
): string | null {
  const normalizedSlug = slug.trim().toLowerCase();
  const normalizedScheme = expectedAuthScheme?.trim().toUpperCase();
  for (const item of items) {
    const itemSlug = authConfigToolkitSlug(item)?.toLowerCase();
    const itemScheme = authConfigAuthScheme(item)?.toUpperCase();
    const id = authConfigId(item);
    if (
      id
      && itemSlug === normalizedSlug
      && (!normalizedScheme || itemScheme === normalizedScheme)
    ) return id;
  }
  return null;
}

async function findToolkitAuthConfigId(
  composio: Composio,
  slug: string,
  expectedAuthScheme?: string,
): Promise<string | null> {
  const collect = (resp: unknown): Array<Record<string, unknown>> => {
    const items = Array.isArray(resp) ? resp : (obj(resp).items ?? []);
    return Array.isArray(items) ? items.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')) : [];
  };

  // Prefer the server-side toolkit filter when available, but keep a
  // fallback for SDK/API shape drift. Composio has changed auth-config
  // response casing a few times, so selectAuthConfigIdForToolkit()
  // intentionally accepts both snake_case and camelCase.
  try {
    const filtered = collect(await (composio as any).authConfigs.list({ limit: 20, toolkit: slug }));
    const id = selectAuthConfigIdForToolkit(filtered, slug, expectedAuthScheme)
      ?? (!expectedAuthScheme && filtered.length === 1 ? authConfigId(filtered[0]) : null);
    if (id) return id;
  } catch {
    // Fall through to the broader list.
  }

  const resp = await (composio as any).authConfigs.list({ limit: 200 });
  return selectAuthConfigIdForToolkit(collect(resp), slug, expectedAuthScheme);
}

export class ComposioNeedsAuthConfigError extends Error {
  constructor(public readonly slug: string, public readonly underlying: string) {
    super(`Toolkit "${slug}" needs an auth config in Composio before OAuth can start. Open ${COMPOSIO_AUTH_CONFIGS_URL} and add the toolkit to your project.`);
    this.name = 'ComposioNeedsAuthConfigError';
  }
}

export async function authorizeToolkit(
  slug: string,
  expectedAuthScheme?: string,
): Promise<{ redirectUrl: string | null; connectionId: string }> {
  const composio = getComposio();
  if (!composio) throw new Error('COMPOSIO_API_KEY is not configured.');

  const userId = getPreferredUserId();
  try {
    const authConfigIdToUse = await findToolkitAuthConfigId(composio, slug, expectedAuthScheme);
    if (!authConfigIdToUse) {
      throw new ComposioNeedsAuthConfigError(
        slug,
        `No auth_config for "${slug}" in this Composio project. Add one at ${COMPOSIO_AUTH_CONFIGS_URL} before connecting.`,
      );
    }

    // Do not use composio.toolkits.authorize() here. In @composio/core
    // 0.10.0 it still delegates to connectedAccounts.initiate(), and
    // Composio is retiring that path for managed OAuth orgs in favor of
    // Connect Link (/api/v3/connected_accounts/link).
    const connection = await (composio as any).connectedAccounts.link(userId, authConfigIdToUse, { allowMultiple: true });
    invalidateConnectedAccountSnapshot();
    return {
      redirectUrl: connection.redirectUrl ?? connection.redirect_url ?? null,
      connectionId: connection.id ?? connection.connectedAccountId ?? connection.connected_account_id ?? '',
    };
  } catch (error) {
    const status = (error as { status?: number; statusCode?: number }).status ?? (error as { statusCode?: number }).statusCode;
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("fetch Toolkit with slug") || status === 404) {
      throw new Error(`Toolkit "${slug}" was not found in Composio's catalog.`);
    }
    if (status === 400 || status === 401 || status === 403) {
      throw new ComposioNeedsAuthConfigError(slug, message);
    }
    throw error;
  }
}

/**
 * Fetch the help/setup metadata for a toolkit — used by the
 * Clementine-native setup modal to render the toolkit's
 * fields, descriptions, and "where do I get my API key" link.
 * Returns null when Composio is misconfigured (caller treats as
 * "fall back to generic prompt").
 */
export interface ComposioToolkitSetupMeta {
  name: string;
  description: string | null;
  appUrl: string | null;
  authHintUrl: string | null;
  authGuideUrl: string | null;
  fields: Array<{ name: string; label: string; description: string | null; default: string | null; isSecret: boolean; required: boolean }>;
  authScheme: string;
}

export async function getToolkitSetupMeta(slug: string): Promise<ComposioToolkitSetupMeta | null> {
  const composioApiKey = readComposioEnv('COMPOSIO_API_KEY');
  if (!composioApiKey) return null;
  try {
    const res = await fetch(`https://backend.composio.dev/api/v3/toolkits/${encodeURIComponent(slug)}`, {
      headers: { 'x-api-key': composioApiKey },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const detail = Array.isArray(data.auth_config_details)
      ? (data.auth_config_details[0] as Record<string, unknown>)
      : null;
    const fieldsObj = detail ? obj(detail.fields) : {};
    const initiation = obj((fieldsObj as { connected_account_initiation?: unknown }).connected_account_initiation);
    const required = Array.isArray(initiation.required) ? initiation.required : [];
    const fields = (required as Array<Record<string, unknown>>).map((f) => ({
      name: str(f.name) ?? '',
      label: str(f.displayName) ?? str(f.name) ?? '',
      description: str(f.description) ?? null,
      default: str(f.default) ?? null,
      isSecret: Boolean(f.is_secret),
      required: Boolean(f.required),
    })).filter((f) => f.name);
    const meta = obj(data.meta);
    return {
      name: str(data.name) ?? slug,
      description: str(meta.description) ?? null,
      appUrl: str(meta.app_url) ?? null,
      authHintUrl: detail ? str((detail as { auth_hint_url?: unknown }).auth_hint_url) ?? null : null,
      authGuideUrl: str(data.auth_guide_url) ?? null,
      fields,
      authScheme: detail ? str((detail as { mode?: unknown }).mode) ?? 'API_KEY' : 'API_KEY',
    };
  } catch {
    return null;
  }
}

/**
 * One-shot setup for OAUTH2 toolkits that have NO project-level
 * auth_config yet. Composio's catalog tells us via the toolkit's
 * `composio_managed_auth_schemes` whether they offer managed OAuth
 * credentials — if they do, we create a `use_composio_managed_auth`
 * auth_config for the user automatically. Then the regular
 * `authorizeToolkit` flow can run and Composio's OAuth window will
 * load correctly (it loads broken when there's no auth_config).
 *
 * If Composio has NO managed creds for the toolkit, callers fall
 * back to Composio's auth-configs page — there's no way to skip the manual
 * BYO setup in that case.
 */
export async function setupOAuthToolkit(slug: string): Promise<{ ok: true; authConfigId: string }> {
  const composioApiKey = readComposioEnv('COMPOSIO_API_KEY');
  if (!composioApiKey) throw new Error('COMPOSIO_API_KEY is not configured.');
  const composio = getComposio();
  if (composio) {
    const existing = await findToolkitAuthConfigId(composio, slug, 'OAUTH2');
    if (existing) return { ok: true, authConfigId: existing };
  }

  const res = await fetch('https://backend.composio.dev/api/v3/auth_configs', {
    method: 'POST',
    headers: {
      'x-api-key': composioApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      toolkit: { slug },
      auth_config: {
        type: 'use_composio_managed_auth',
        name: slug,
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Composio auth_config create failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const result = (await res.json()) as Record<string, unknown>;
  const authConfigInner = obj(result.auth_config);
  const authConfigId = str(result.id) ?? str(authConfigInner.id) ?? str(result.nanoid) ?? '';
  if (!authConfigId) {
    throw new Error(`Composio returned no auth_config id. Body: ${JSON.stringify(result).slice(0, 200)}`);
  }
  invalidateConnectedAccountSnapshot();
  return { ok: true, authConfigId };
}

export type InAppToolkitConnection =
  | ({ kind: 'authorization' } & Awaited<ReturnType<typeof authorizeToolkit>>)
  | { kind: 'credentials'; setup: ComposioToolkitSetupMeta };

export interface InAppToolkitConnectionDeps {
  getSetupMeta: (slug: string) => Promise<ComposioToolkitSetupMeta | null>;
  authorize: (
    slug: string,
    expectedAuthScheme?: string,
  ) => Promise<Awaited<ReturnType<typeof authorizeToolkit>>>;
  setupOAuth: (slug: string) => Promise<Awaited<ReturnType<typeof setupOAuthToolkit>>>;
}

export function isRedirectableToolkitAuthScheme(authScheme: string): boolean {
  return /OAUTH|DCR/i.test(authScheme);
}

export function selectToolkitCredentialValues(
  setup: ComposioToolkitSetupMeta,
  submitted: Record<string, unknown>,
): { credentials: Record<string, string>; missing: string[] } {
  const fields = setup.fields.length > 0
    ? setup.fields
    : [{ name: 'generic_api_key', label: 'API Key', description: null, default: null, isSecret: true, required: true }];
  const credentials: Record<string, string> = {};
  const missing: string[] = [];
  for (const field of fields) {
    const submittedValue = submitted[field.name];
    const supplied = typeof submittedValue === 'string' ? submittedValue.trim() : '';
    const value = supplied || field.default?.trim() || '';
    if (value) credentials[field.name] = value;
    else if (field.required) missing.push(field.label || field.name);
  }
  return { credentials, missing };
}

/**
 * One Clementine-native connection entrypoint:
 *  - API key/basic/bearer apps return their field schema for our own modal.
 *  - OAuth apps with an existing auth config return a Connect Link.
 *  - OAuth apps without a config get Composio-managed auth provisioned here,
 *    then return a Connect Link — no dashboard detour.
 */
export async function prepareInAppToolkitConnection(
  slug: string,
  deps: InAppToolkitConnectionDeps = {
    getSetupMeta: getToolkitSetupMeta,
    authorize: authorizeToolkit,
    setupOAuth: setupOAuthToolkit,
  },
): Promise<InAppToolkitConnection> {
  const setup = await deps.getSetupMeta(slug);
  if (setup && !isRedirectableToolkitAuthScheme(setup.authScheme)) {
    return { kind: 'credentials', setup };
  }

  try {
    return { kind: 'authorization', ...await deps.authorize(slug, setup?.authScheme) };
  } catch (error) {
    if (!(error instanceof ComposioNeedsAuthConfigError)) throw error;
    if (!setup || !isRedirectableToolkitAuthScheme(setup.authScheme)) throw error;
    await deps.setupOAuth(slug);
    return { kind: 'authorization', ...await deps.authorize(slug, setup.authScheme) };
  }
}

export async function disconnectToolkit(connectionId: string): Promise<void> {
  const composio = getComposio();
  if (!composio) throw new Error('COMPOSIO_API_KEY is not configured.');
  await (composio as any).connectedAccounts.delete(connectionId);
  invalidateConnectedAccountSnapshot();
}

/**
 * One-shot setup for direct-credential toolkits (API_KEY, BASIC, bearer,
 * and similar schemes). We call Composio's REST API directly via fetch —
 * the SDK's typed shapes mismatch the actual API contract (the SDK
 * serializes `toolkit.slug` in a way the server rejects with
 * "Expected string, received object").
 *
 * The correct API shape, probed 2026-05-21:
 *   POST /api/v3/auth_configs
 *     { "toolkit": { "slug": "..." },
 *       "auth_config": { "type": "use_custom_auth",
 *                        "authScheme": "API_KEY",  // ← camelCase
 *                        "name": "..." } }
 *
 *   POST /api/v3/connected_accounts
 *     { "auth_config": { "id": "ac_..." },
 *       "connection": { "user_id": "...",
 *                       "state": { "authScheme": "API_KEY",
 *                                  "val": { "status": "ACTIVE",
 *                                           "generic_api_key": "...",
 *                                           "base_url": "..." (optional) } } } }
 */
export async function setupCredentialToolkit(
  slug: string,
  authScheme: string,
  credentials: Record<string, string>,
): Promise<{ ok: true; authConfigId: string; connectionId: string }> {
  const composioApiKey = readComposioEnv('COMPOSIO_API_KEY');
  if (!composioApiKey) throw new Error('COMPOSIO_API_KEY is not configured.');
  const scheme = authScheme.trim().toUpperCase();
  if (!scheme || isRedirectableToolkitAuthScheme(scheme)) {
    throw new Error(`Toolkit "${slug}" uses redirect authentication; credentials must not be submitted directly.`);
  }
  const credentialValues: Record<string, string> = {};
  for (const [key, raw] of Object.entries(credentials)) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(key) || key.toLowerCase() === 'status' || !value) continue;
    credentialValues[key] = value;
  }
  if (Object.keys(credentialValues).length === 0) throw new Error('At least one credential value is required.');
  const userId = getPreferredUserId();

  // Step 1 — project-level auth_config. Reuse one when present so adding a
  // second account does not litter the project with duplicate configs.
  const composio = getComposio();
  let authConfigId = composio ? await findToolkitAuthConfigId(composio, slug, scheme) : null;
  if (!authConfigId) {
    const createAuthRes = await fetch('https://backend.composio.dev/api/v3/auth_configs', {
      method: 'POST',
      headers: {
        'x-api-key': composioApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        toolkit: { slug },
        auth_config: {
          type: 'use_custom_auth',
          authScheme: scheme,
          name: slug,
        },
      }),
    });
    if (!createAuthRes.ok) {
      const body = await createAuthRes.text();
      throw new Error(`Composio auth_config create failed (${createAuthRes.status}): ${body.slice(0, 300)}`);
    }
    const authConfig = (await createAuthRes.json()) as Record<string, unknown>;
    const authConfigInner = obj(authConfig.auth_config);
    authConfigId = str(authConfig.id)
      ?? str(authConfigInner.id)
      ?? str(authConfig.nanoid)
      ?? null;
  }
  if (!authConfigId) {
    throw new Error('Composio returned no auth_config id.');
  }

  // Step 2 — per-user connection. State carries only the toolkit fields the
  // daemon validated against live setup metadata; secrets never touch the UI
  // snapshot, logs, or local env file.
  const val: Record<string, unknown> = {
    status: 'ACTIVE',
    ...credentialValues,
  };
  const createConnRes = await fetch('https://backend.composio.dev/api/v3/connected_accounts', {
    method: 'POST',
    headers: {
      'x-api-key': composioApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      auth_config: { id: authConfigId },
      connection: {
        user_id: userId,
        state: {
          authScheme: scheme,
          val,
        },
      },
      validate_credentials: true,
    }),
  });
  if (!createConnRes.ok) {
    // Do not surface the provider response body: some providers echo submitted
    // state on validation failure, which could expose a credential in the UI.
    throw new Error(
      `Composio rejected the ${slug} credentials (${createConnRes.status}). Verify the values and try again.`,
    );
  }
  const connection = (await createConnRes.json()) as Record<string, unknown>;
  const connectionId = str(connection.id) ?? str(connection.nanoid) ?? '';

  // Bust caches so the dashboard refresh picks up the new connection.
  invalidateConnectedAccountSnapshot();
  return { ok: true, authConfigId, connectionId };
}

/** Back-compatible API-key wrapper for older callers. */
export async function setupApiKeyToolkit(
  slug: string,
  apiKey: string,
  baseUrl?: string,
): Promise<{ ok: true; authConfigId: string; connectionId: string }> {
  return setupCredentialToolkit(slug, 'API_KEY', {
    generic_api_key: apiKey,
    ...(baseUrl ? { base_url: baseUrl } : {}),
  });
}

function normalizedComposioActionSlug(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(normalized)
    ? normalized
    : undefined;
}

function cliSchemaObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return record.type === 'object'
    || (record.properties && typeof record.properties === 'object' && !Array.isArray(record.properties))
    ? record
    : undefined;
}

/**
 * Project one exact action schema from a CLI search result.
 *
 * The CLI may return inline schemas or absolute paths beneath its private
 * `~/.composio/tool_definitions` cache. Search output is provider-controlled,
 * so a path is accepted only when it is explicitly mapped to the requested
 * PRIMARY slug, its real path remains beneath that fixed root, and its file
 * name is the exact slug. Related/schema-less candidates never qualify.
 * Exported as a pure test seam; production passes the real home directory.
 */
export function exactComposioCliSchemaFromSearch(
  value: unknown,
  requestedSlug: string,
  homeDir = os.homedir(),
): Record<string, unknown> | null {
  const wanted = normalizedComposioActionSlug(requestedSlug);
  if (!wanted) return null;
  let root = value;
  if (typeof root === 'string') {
    try { root = JSON.parse(root) as unknown; } catch { return null; }
  }

  let exactPrimary = false;
  let inlineSchema: Record<string, unknown> | undefined;
  let mappedSchemaPath: string | undefined;
  const seen = new Set<object>();
  let visited = 0;
  const visit = (node: unknown, depth: number, relatedContext = false): void => {
    if (depth > 8 || visited >= 2_000 || node === null || node === undefined) return;
    visited += 1;
    if (typeof node === 'string') {
      const trimmed = node.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try { visit(JSON.parse(trimmed) as unknown, depth + 1, relatedContext); } catch { /* plain provider text */ }
      }
      return;
    }
    if (typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1, relatedContext);
      return;
    }

    const record = node as Record<string, unknown>;
    const explicitSlug = normalizedComposioActionSlug(
      record.tool_slug ?? record.toolSlug ?? record.slug,
    );
    if (!relatedContext && explicitSlug === wanted) {
      exactPrimary = true;
      inlineSchema = cliSchemaObject(
        record.inputParameters
        ?? record.input_parameters
        ?? record.inputSchema
        ?? record.input_schema
        ?? record.parameters
        ?? record.schema,
      ) ?? inlineSchema;
    }
    if (!relatedContext && Array.isArray(record.primary_tool_slugs)) {
      if (record.primary_tool_slugs.some((slug) => normalizedComposioActionSlug(slug) === wanted)) {
        exactPrimary = true;
      }
    }
    // Intentionally ignore related_tool_slugs: related search suggestions are
    // discovery hints, not exact executable contract authority.
    const toolSchemas = record.tool_schemas;
    if (!relatedContext && toolSchemas && typeof toolSchemas === 'object' && !Array.isArray(toolSchemas)) {
      const primary = (toolSchemas as Record<string, unknown>).primary;
      if (primary && typeof primary === 'object' && !Array.isArray(primary)) {
        for (const [slug, candidatePath] of Object.entries(primary as Record<string, unknown>)) {
          if (normalizedComposioActionSlug(slug) === wanted && typeof candidatePath === 'string') {
            mappedSchemaPath = candidatePath;
          }
        }
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (key === 'related_tool_slugs') continue;
      if (child && (typeof child === 'object' || typeof child === 'string')) {
        visit(child, depth + 1, relatedContext || /^related(?:_|$)/i.test(key));
      }
    }
  };
  visit(root, 0);
  if (!exactPrimary) return null;
  if (inlineSchema) {
    try { return structuredClone(inlineSchema); } catch { return null; }
  }
  if (!mappedSchemaPath) return null;

  let schemaRoot: string;
  try {
    schemaRoot = realpathSync(path.resolve(homeDir, '.composio', 'tool_definitions'));
  } catch {
    return null;
  }
  const expanded = mappedSchemaPath === '~'
    ? homeDir
    : mappedSchemaPath.startsWith('~/') || mappedSchemaPath.startsWith(`~${path.sep}`)
      ? path.join(homeDir, mappedSchemaPath.slice(2))
      : mappedSchemaPath;
  if (!path.isAbsolute(expanded)) return null;
  try {
    const file = realpathSync(path.resolve(expanded));
    if (file !== schemaRoot && !file.startsWith(`${schemaRoot}${path.sep}`)) return null;
    if (path.basename(file).toUpperCase() !== `${wanted}.JSON`) return null;
    const stats = statSync(file);
    if (!stats.isFile() || stats.size <= 0 || stats.size > 1_000_000) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const schema = cliSchemaObject(
      record.inputSchema
      ?? record.input_schema
      ?? record.inputParameters
      ?? record.input_parameters
      ?? record,
    );
    return schema ? structuredClone(schema) : null;
  } catch {
    return null;
  }
}

async function getComposioToolBySlugViaCli(wanted: string): Promise<ComposioToolkitTool | null> {
  if (normalizedComposioActionSlug(wanted) !== wanted) return null;
  const toolkitSlug = CURATED_TOOLKITS
    .map((toolkit) => toolkit.slug)
    .sort((left, right) => right.length - left.length)
    .find((slug) => wanted.startsWith(`${slug.toUpperCase()}_`))
    ?? (wanted.split('_')[0] ?? '').toLowerCase();
  if (!toolkitSlug) return null;
  // Authority is ordered by request START. A slower older search that returns
  // after a newer observation must not roll the schema lease forward.
  const observedAt = Date.now();
  try {
    const result = await searchComposioCliTools(wanted, {
      ...composioCliOptions(),
      toolkitSlug,
      limit: 1,
    });
    const inputParameters = exactComposioCliSchemaFromSearch(result, wanted);
    if (!inputParameters) return null;
    const tool: ComposioToolkitTool = {
      slug: wanted,
      name: wanted,
      toolkitSlug,
      inputParameters,
    };
    toolSchemaObservedAt.set(tool, observedAt);
    return tool;
  } catch {
    return null;
  }
}

/**
 * Re-read one selected action through an exact provider filter. Unlike the
 * compatibility getter below, this final authority check never falls back to
 * a toolkit listing: a missing, renamed, ambiguous, or unsupported exact
 * response is a refusal, not permission to enumerate hundreds of definitions.
 */
export async function getExactComposioToolBySlug(slug: string): Promise<ComposioToolkitTool | null> {
  if (!slug) return null;
  const wanted = slug.toUpperCase();
  if (normalizedComposioActionSlug(wanted) !== wanted) return null;
  const composio = getComposio() as any;
  if (!composio) return getComposioToolBySlugViaCli(wanted);

  const observedAt = Date.now();
  const raw = await composio.tools.getRawComposioTools({ tools: [wanted], limit: 1 });
  const list = Array.isArray(raw)
    ? raw
    : (Array.isArray(raw?.items) ? raw.items : []);
  if (list.length > 1) throw new ComposioExactToolProviderContractError();
  const item = list[0];
  if (!item || String(item.slug ?? '').toUpperCase() !== wanted) return null;
  const toolkit = obj(item.toolkit);
  const toolkitSlug = str(toolkit.slug) ?? str(item.toolkitSlug) ?? str(item.toolkit_slug);
  const hasCamelOutput = Object.prototype.hasOwnProperty.call(item, 'outputParameters');
  const hasSnakeOutput = Object.prototype.hasOwnProperty.call(item, 'output_parameters');
  const tool = {
    slug: item.slug,
    name: item.name ?? item.slug,
    description: item.description ?? '',
    ...(toolkitSlug ? { toolkitSlug } : {}),
    inputParameters: item.inputParameters ?? item.input_parameters,
    ...(hasCamelOutput
      ? { outputParameters: item.outputParameters }
      : hasSnakeOutput
        ? { outputParameters: item.output_parameters }
        : {}),
    ...(str(item.version) ? { version: str(item.version) } : {}),
  } as ComposioToolkitTool;
  toolSchemaObservedAt.set(tool, observedAt);
  return tool;
}

/**
 * Revalidate MANY exact slugs in ONE provider call.
 *
 * Same authority contract as the single-slug lookup — a row counts only if the
 * provider returns that exact slug — but the cost is one request for the whole
 * batch instead of one per slug. Discovery revalidates several advisory
 * nominations at once, and per-slug calls would put that cost on every turn.
 *
 * The provider is not trusted to answer only what was asked: a row whose slug
 * was not requested is dropped rather than returned, so a loose server-side
 * filter can never widen the caller's universe.
 */
export async function getExactComposioToolsBySlugs(
  slugs: readonly string[],
): Promise<Map<string, ComposioToolkitTool>> {
  const wanted = new Set<string>();
  for (const raw of slugs) {
    const slug = String(raw ?? '').trim().toUpperCase();
    if (!slug || normalizedComposioActionSlug(slug) !== slug) continue;
    wanted.add(slug);
  }
  const found = new Map<string, ComposioToolkitTool>();
  if (wanted.size === 0) return found;

  const composio = getComposio() as any;
  if (!composio) {
    // Keyless/CLI installs have no batch endpoint; fall back per slug.
    for (const slug of wanted) {
      const tool = await getComposioToolBySlugViaCli(slug);
      if (tool && String(tool.slug ?? '').toUpperCase() === slug) found.set(slug, tool);
    }
    return found;
  }

  const requested = [...wanted];
  const observedAt = Date.now();
  const raw = await composio.tools.getRawComposioTools({
    tools: requested,
    limit: requested.length,
  });
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.items) ? raw.items : []);
  for (const item of list) {
    const slug = String(item?.slug ?? '').toUpperCase();
    // Never accept a row nobody asked for, and never let a duplicate row
    // silently replace the first observation of the same slug.
    if (!slug || !wanted.has(slug) || found.has(slug)) continue;
    const toolkit = obj(item.toolkit);
    const toolkitSlug = str(toolkit.slug) ?? str(item.toolkitSlug) ?? str(item.toolkit_slug);
    const hasCamelOutput = Object.prototype.hasOwnProperty.call(item, 'outputParameters');
    const hasSnakeOutput = Object.prototype.hasOwnProperty.call(item, 'output_parameters');
    const tool = {
      slug: item.slug,
      name: item.name ?? item.slug,
      description: item.description ?? '',
      ...(toolkitSlug ? { toolkitSlug } : {}),
      inputParameters: item.inputParameters ?? item.input_parameters,
      ...(hasCamelOutput
        ? { outputParameters: item.outputParameters }
        : hasSnakeOutput
          ? { outputParameters: item.output_parameters }
          : {}),
      ...(str(item.version) ? { version: str(item.version) } : {}),
    } as ComposioToolkitTool;
    toolSchemaObservedAt.set(tool, observedAt);
    found.set(slug, tool);
  }
  return found;
}

/**
 * Fetch ONE tool's raw definition by exact slug. The per-toolkit listing is
 * capped and large toolkits (Outlook alone clears 200 actions) can miss the
 * one slug a settlement needs to bind its contract to — the exact-slug filter
 * asks the API for precisely that tool. Falls back to a deep toolkit listing
 * because some SDK versions ignore the `tools` filter.
 */
export async function getComposioToolBySlug(slug: string): Promise<ComposioToolkitTool | null> {
  if (!slug) return null;
  const wanted = slug.toUpperCase();
  const composio = getComposio() as any;
  // Keyless/AUTO and explicit CLI installs have no SDK catalog. Renew only
  // this requested action's schema through one constrained CLI search; never
  // list or search unrelated toolkits as a fallback.
  if (!composio) return getComposioToolBySlugViaCli(wanted);
  try {
    // Order observations by request start, not response completion. Two
    // overlapping lookups can finish out of order; a slower older request must
    // never look newer and roll schema authority back.
    const observedAt = Date.now();
    const raw = await composio.tools.getRawComposioTools({ tools: [wanted] });
    const list = Array.isArray(raw) ? raw : (raw?.items ?? []);
    for (const item of list) {
      if (String(item?.slug ?? '').toUpperCase() === wanted) {
        const tool = {
          slug: item.slug,
          name: item.name ?? item.slug,
          description: item.description ?? '',
          inputParameters: item.inputParameters ?? item.input_parameters,
          outputParameters: item.outputParameters ?? item.output_parameters,
          version: str(item.version),
        } as ComposioToolkitTool;
        toolSchemaObservedAt.set(tool, observedAt);
        return tool;
      }
    }
  } catch { /* fall through to the toolkit listing */ }
  const toolkit = (slug.split('_')[0] ?? '').toLowerCase();
  if (!toolkit) return null;
  try {
    // An exact authority refresh must not fall back to the process's 15-minute
    // toolkit cache. Supplying the current client as an override forces a live
    // listing while preserving the existing SDK-version compatibility path.
    const tools = await listComposioToolkitTools(toolkit, 500, composio);
    return tools.find((tool) => String(tool.slug ?? '').toUpperCase() === wanted) ?? null;
  } catch {
    return null;
  }
}

export async function listComposioToolkitTools(
  slug: string,
  limit = 80,
  composioOverride?: unknown,
): Promise<ComposioToolkitTool[]> {
  const composio = (composioOverride ?? getComposio()) as any;
  if (!composio) throw new Error('COMPOSIO_API_KEY is not configured.');

  // Only cache the default path: an explicit composioOverride (tests, special
  // callers) must hit the live SDK.
  const cacheable = composioOverride === undefined;
  const cacheKey = `${slug}::${limit}`;
  if (cacheable) {
    const hit = toolkitToolsCache.get(cacheKey);
    if (hit && Date.now() - hit.at < TOOLKIT_TOOLS_TTL_MS) return hit.data;
  }

  const observedAt = Date.now();

  const seen = new Set<string>();
  const tools: ComposioToolkitTool[] = [];
  const ingest = (raw: unknown): void => {
    const items = Array.isArray(raw) ? raw : ((raw as { items?: unknown[] } | null)?.items ?? []);
    for (const item of items as Array<Record<string, unknown>>) {
      const toolkit = obj(item.toolkit);
      const toolSlug = str(item.slug) ?? str(item.name);
      if (!toolSlug || seen.has(toolSlug)) continue;
      seen.add(toolSlug);
      const tool: ComposioToolkitTool = {
        slug: toolSlug,
        name: str(item.name) ?? toolSlug,
        description: str(item.description),
        toolkitSlug: str(toolkit.slug) ?? slug,
        inputParameters: item.inputParameters ?? item.input_parameters ?? item.parameters,
        outputParameters: item.outputParameters ?? item.output_parameters,
        version: str(item.version),
      };
      toolSchemaObservedAt.set(tool, observedAt);
      tools.push(tool);
    }
  };

  // CURATED set FIRST via a DIRECT v3 call WITHOUT toolkit_versions. Every SDK
  // list path (getRawComposioTools AND the lower-level client.tools.list) pins
  // toolkit_versions="latest", which the Composio API resolves to the RAW
  // OpenAPI import and EXCLUDES Composio's curated actions — e.g. the
  // OUTLOOK_OUTLOOK_* family (SEND_EMAIL / REPLY_EMAIL). Only omitting the
  // version returns the curated/published set, and the SDK can't omit it — so
  // we hit the endpoint directly. (Diagnosed 2026-06-03: composio_search_tools
  // surfaced an Outlook send tool 0/81 times because of this pin, so Clem
  // wrongly reported "send is not exposed.") Curated is ingested first so its
  // slugs win de-dup and rank ahead in discovery. Best-effort: any failure
  // falls through to the raw set below.
  try {
    const apiKey = readComposioEnv('COMPOSIO_API_KEY');
    if (apiKey) {
      const base = String((composio.client?.baseURL as string | undefined) ?? 'https://backend.composio.dev').replace(/\/+$/, '');
      const root = /\/api\/v\d+$/.test(base) ? base : `${base}/api/v3`;
      const url = `${root}/tools?toolkit_slug=${encodeURIComponent(slug)}&limit=${limit}`;
      // 5s timeout (matches validateComposioApiKey above) so a stuck curated
      // fetch can't stall the per-toolkit search loop in composio_search_tools.
      // An AbortError is caught here and falls through to the raw set.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      try {
        const res = await fetch(url, { headers: { 'x-api-key': apiKey, accept: 'application/json' }, signal: controller.signal });
        if (res.ok) ingest(await res.json());
      } finally {
        clearTimeout(timeout);
      }
    }
  } catch {
    // best-effort: if the curated fetch fails (network / timeout / non-JSON), the raw set below still returns.
  }

  // RAW set ("latest") for full OpenAPI coverage + any user custom tools.
  try {
    const raw = await composio.tools.getRawComposioTools({ toolkits: [slug], limit });
    ingest(raw);
  } catch (err) {
    if (tools.length === 0) throw err; // only surface if we got nothing at all
  }

  // Cache only a non-empty result (a throw above on a fully-empty fetch never
  // reaches here, so we never cache a transient failure).
  if (cacheable && tools.length > 0) {
    toolkitToolsCache.set(cacheKey, { at: Date.now(), data: tools });
  }
  return tools;
}

/**
 * Search the installed SDK's live catalog across only the user's connected
 * toolkits. This is the cold-path counterpart to the advisory local index:
 * the provider performs the text filter, Clementine bounds/filter/dedupes the
 * returned definitions, and there is deliberately no unfiltered list fallback.
 *
 * The returned rows are exact provider definitions observed by this request.
 * Plan admission still re-reads the model-selected definitions before it mints
 * executable authority, so discovery metadata can never become a stale invoke
 * port by itself.
 */
/**
 * Grammatical function words. This is a LANGUAGE list, not a capability list:
 * it says nothing about which tools exist or which provider owns them, only
 * which tokens carry no retrieval signal in anyone's catalog.
 */
const PROVIDER_SEARCH_FUNCTION_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'at', 'by',
  'with', 'from', 'into', 'it', 'is', 'are', 'be', 'my', 'me', 'our', 'your',
  'that', 'this', 'then', 'please', 'can', 'could', 'would', 'should', 'will',
  'do', 'does', 'let', 'lets', 'us', 'we', 'i',
]);

/**
 * Ask the provider in the provider's own language.
 *
 * The live `search` filter is a KEYWORD match that narrows as terms are added,
 * not a semantic one. Measured 2026-08-26 against the real account (19
 * connected toolkits): the natural-language role "create a Google Sheet and
 * write a header row" returned ZERO rows, while "sheet header" returned 3 and
 * a single salient term returned the full 16-row page. Discovery had been
 * handing the model's English sentence straight to that filter, so an ordinary
 * request phrased as a sentence discovered nothing and was refused as though
 * the capability did not exist — with the toolkit connected the whole time.
 *
 * A role is therefore asked as a ladder: the exact query, then its content
 * terms, then a bounded fan-out over the most capability-bearing single terms,
 * and finally the connected toolkits themselves with no filter at all. That
 * last rung is the contract a connection already implies: connecting a carrier
 * grants its catalog, so a connected carrier must never answer an unresolved
 * role with silence. The first rung the provider answers wins; later rungs are
 * paid ONLY on a miss, which today costs a hard failure.
 *
 * Relaxation widens the QUESTION asked of the provider, never the authority
 * granted: the caller still admits only identifiers that an actual provider
 * response contained.
 *
 * Nothing here names a provider, a toolkit, or an operation. Salience is read
 * from the account's own live connections, so a carrier connected tomorrow is
 * ranked by the same rule with no code change.
 */
/**
 * Order provider rows by how well they answer the request that was actually
 * made. Used to pick which rows survive the bounded discovery window when a
 * relaxed rung returns more than the window holds; the caller re-ranks for
 * presentation. Identifier matches outweigh prose because a slug names the
 * operation, while a description merely mentions it.
 */
function rankAgainstRequest(items: readonly unknown[], query: string): unknown[] {
  const terms = [...new Set(query.toLowerCase().split(/[^a-z0-9]+/g))]
    .filter((term) => term.length >= 2 && !PROVIDER_SEARCH_FUNCTION_WORDS.has(term));
  if (terms.length === 0) return [...items];
  const relevance = (value: unknown): number => {
    const item = obj(value);
    const slug = (str(item.slug) ?? '').toLowerCase();
    const name = (str(item.name) ?? '').toLowerCase();
    const description = (str(item.description) ?? '').toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (slug.includes(term)) score += 5;
      if (name.includes(term)) score += 2;
      if (description.includes(term)) score += 1;
    }
    return score;
  };
  return [...items]
    .map((value, index) => ({ value, index, score: relevance(value) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.value);
}

export function providerKeywordSearchRungs(
  query: string,
  connectedToolkits: readonly string[],
): readonly (readonly string[])[] {
  const normalized = query.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const terms: string[] = [];
  for (const raw of normalized.toLowerCase().split(/[^a-z0-9]+/g)) {
    const term = raw.trim();
    if (term.length < 2 || PROVIDER_SEARCH_FUNCTION_WORDS.has(term)) continue;
    if (!terms.includes(term)) terms.push(term);
  }
  const rungs: string[][] = [[normalized]];
  const contentQuery = terms.join(' ');
  if (contentQuery && contentQuery !== normalized.toLowerCase()) rungs.push([contentQuery]);
  const slugs = connectedToolkits.map((slug) => slug.toLowerCase());
  // A term naming one of THIS account's connected carriers is the most
  // capability-bearing token available; it is derived from live connections,
  // never from anything written down here.
  const salience = (term: string): number =>
    (slugs.some((slug) => slug.includes(term) || term.includes(slug)) ? 100 : 0) + term.length;
  const fanout = [...terms]
    .sort((left, right) => salience(right) - salience(left) || left.localeCompare(right))
    .slice(0, COMPOSIO_SEARCH_RELAXATION_FANOUT);
  if (fanout.length > 1 || (fanout.length === 1 && fanout[0] !== contentQuery)) {
    rungs.push(fanout);
  }
  // The unfiltered rung: what the connection itself already granted.
  rungs.push([PROVIDER_SEARCH_UNFILTERED_RUNG]);
  return rungs;
}

export async function searchConnectedComposioTools(
  toolkitSlugs: readonly string[],
  query: string,
  limit = COMPOSIO_LIVE_SEARCH_OVERSAMPLE_LIMIT,
): Promise<ComposioToolkitTool[]> {
  const normalizedQuery = query.replace(/\s+/g, ' ').trim();
  if (!normalizedQuery) return [];
  const connected = [...new Set(toolkitSlugs
    .map((slug) => slug.trim().toLowerCase())
    .filter(Boolean))]
    .sort();
  if (connected.length === 0) return [];
  const composio = getComposio() as any;
  if (!composio?.tools?.getRawComposioTools) return [];

  const requestedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 1;
  const returnLimit = Math.max(1, Math.min(
    requestedLimit,
    COMPOSIO_LIVE_SEARCH_OVERSAMPLE_LIMIT,
  ));
  const connectedSet = new Set(connected);
  const seen = new Set<string>();
  const out: ComposioToolkitTool[] = [];

  const parse = (raw: unknown): unknown[] => {
    const items = Array.isArray(raw)
      ? raw
      : (Array.isArray((raw as { items?: unknown[] } | null)?.items)
          ? (raw as { items: unknown[] }).items
          : []);
    if (items.length > COMPOSIO_LIVE_SEARCH_OVERSAMPLE_LIMIT) {
      throw new ComposioSearchProviderContractError();
    }
    return items;
  };

  const ingest = (items: readonly unknown[]): void => {
    const observedAt = Date.now();
    for (const value of items) {
    const item = obj(value);
    const slug = str(item.slug)?.trim();
    if (!slug) continue;
    const toolkit = obj(item.toolkit);
    let toolkitSlug = (
      str(toolkit.slug)
      ?? str(item.toolkitSlug)
      ?? str(item.toolkit_slug)
      ?? ''
    ).trim().toLowerCase();
    if (!toolkitSlug) {
      const upperSlug = slug.toUpperCase();
      toolkitSlug = connected
        .filter((candidate) => upperSlug.startsWith(`${candidate.toUpperCase()}_`))
        .sort((left, right) => right.length - left.length)[0] ?? '';
    }
    if (!connectedSet.has(toolkitSlug)) continue;
    const identity = slug.toUpperCase();
    if (seen.has(identity)) continue;
    seen.add(identity);
    const tool: ComposioToolkitTool = {
      slug,
      name: str(item.name) ?? slug,
      description: str(item.description),
      toolkitSlug,
      inputParameters: item.inputParameters
        ?? item.input_parameters
        ?? item.parameters,
      outputParameters: item.outputParameters ?? item.output_parameters,
      version: str(item.version),
    };
    toolSchemaObservedAt.set(tool, observedAt);
    out.push(tool);
      if (out.length >= returnLimit) break;
    }
  };

  for (const rung of providerKeywordSearchRungs(normalizedQuery, connected)) {
    const responses = await Promise.all(rung.map((search) =>
      composio.tools.getRawComposioTools({
        toolkits: connected,
        ...(search === PROVIDER_SEARCH_UNFILTERED_RUNG ? {} : { search }),
        limit: COMPOSIO_LIVE_SEARCH_OVERSAMPLE_LIMIT,
      } as never)));
    // Order the rung's whole union against the ORIGINAL request before the
    // bounded window is spent. A rung can ask several terms at once, and each
    // answer arrives in the provider's own order, so draining them as they
    // land lets ARRIVAL decide what RELEVANCE is supposed to decide.
    // Measured 2026-08-26: a broad term matching several connected carriers
    // filled all sixteen rows by itself, and the operation the request was
    // actually about never entered the window at all. Every row here still
    // came from a real provider response — this chooses among them, it never
    // invents one.
    ingest(rankAgainstRequest(responses.flatMap(parse), normalizedQuery));
    // The first rung the provider actually answers owns the result. A later
    // rung is never paid once discovery has rows to rank.
    if (out.length > 0) break;
  }
  return out;
}

/**
 * Resolve a tool's OWN version via a direct version-free v3 retrieve.
 *
 * Curated Composio actions (e.g. OUTLOOK_OUTLOOK_SEND_EMAIL) live in the
 * published namespace with a pinned version (e.g. "00000000_00") and 404 under
 * the SDK's default toolkit_versions=latest — so listComposioToolkitTools can
 * SURFACE them (it fetches version-free) but tools.execute() can't RESOLVE them
 * ("Unable to retrieve tool"). This returns the slug's version so execute can
 * pin it. Exported for tests. Best-effort: undefined on any failure.
 */
// Successful slug→version resolutions are memoized with a TTL: long enough to
// make the not-found retry deterministic instead of racing a fresh 5s fetch on
// the batch's first cold item (ask-first batch regression: item 1 of 10 died on exactly that
// race), short enough that a composio tool REPUBLISH (new pinned version) heals
// without a daemon restart. Failures are never cached — the next call re-probes.
const COMPOSIO_VERSION_TTL_MS = 15 * 60 * 1000;
const composioToolVersionCache = new Map<string, { version: string; at: number }>();

export async function resolveComposioToolVersion(slug: string): Promise<string | undefined> {
  try {
    const cached = composioToolVersionCache.get(slug);
    if (cached && Date.now() - cached.at < COMPOSIO_VERSION_TTL_MS) return cached.version;
    const apiKey = readComposioEnv('COMPOSIO_API_KEY');
    if (!apiKey || !slug) return undefined;
    const composio = getComposio();
    const base = String(((composio as unknown as { client?: { baseURL?: unknown } })?.client?.baseURL as string | undefined) ?? 'https://backend.composio.dev').replace(/\/+$/, '');
    const root = /\/api\/v\d+$/.test(base) ? base : `${base}/api/v3`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const res = await fetch(`${root}/tools/${encodeURIComponent(slug)}`, {
        headers: { 'x-api-key': apiKey, accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) return undefined;
      const data = (await res.json()) as { version?: unknown };
      const version = typeof data.version === 'string' && data.version ? data.version : undefined;
      if (version) composioToolVersionCache.set(slug, { version, at: Date.now() });
      return version;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return undefined;
  }
}

/** Opaque, process-local preparation for exactly one provider crossing. The
 * model/tool payload cannot mint one; only the provider adapter's synchronous
 * current-state preflight can. */
export interface PreparedComposioOneShotDispatch {
  readonly __preparedComposioOneShotDispatch: unique symbol;
}

/** Opaque preparation for one raw `/files/upload/request` POST. This lane is
 * SDK-only: a CLI subprocess cannot prove its internal network cardinality. */
export interface PreparedComposioPresignOneShot {
  readonly __preparedComposioPresignOneShot: unique symbol;
}

interface PreparedComposioOneShotState {
  lane: 'sdk';
  toolSlug: string;
  args: Record<string, unknown>;
  connectedAccountId?: string;
  userId: string;
  providerOperationVersion?: string;
  rawClient?: {
    tools?: {
      execute?: (
        slug: string,
        body: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ) => Promise<unknown>;
    };
  };
}

const preparedComposioOneShots = new WeakMap<object, PreparedComposioOneShotState>();

interface PreparedComposioPresignOneShotState {
  args: Readonly<{
    filename: string;
    mimetype: string;
    md5: string;
    tool_slug: string;
    toolkit_slug: string;
  }>;
  rawClient: {
    files: {
      createPresignedURL: (
        body: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ) => Promise<unknown>;
    };
  };
}

const preparedComposioPresignOneShots = new WeakMap<object, PreparedComposioPresignOneShotState>();

export interface PreparedComposioOneShotIdentity {
  lane: 'sdk';
  toolSlug: string;
  providerArgumentDigest: string;
  connectedAccountId: string | null;
  providerOperationVersion: string | null;
}

export interface PreparedComposioPresignOneShotIdentity {
  providerArgumentDigest: string;
  toolSlug: string;
  toolkitSlug: string;
}

function preparedProviderArgumentDigest(args: Record<string, unknown>): string {
  return createHash('sha256').update(closedCanonicalJson(args, {
    maxDepth: 96,
    maxNodes: 500_000,
    maxStringBytes: 32 * 1024 * 1024,
    maxTotalBytes: 32 * 1024 * 1024,
  })).digest('hex');
}

/** Copy-safe identity for binding an opaque one-shot to a separate execution
 * authority. Provider arguments and credentials never leave this module. */
export function inspectPreparedComposioOneShotDispatch(
  prepared: PreparedComposioOneShotDispatch,
): Readonly<PreparedComposioOneShotIdentity> | null {
  const state = preparedComposioOneShots.get(prepared as object);
  if (!state) return null;
  let providerArgumentDigest: string;
  try {
    providerArgumentDigest = preparedProviderArgumentDigest(state.args);
  } catch {
    return null;
  }
  return Object.freeze({
    lane: state.lane,
    toolSlug: state.toolSlug,
    providerArgumentDigest,
    connectedAccountId: state.connectedAccountId ?? null,
    providerOperationVersion: state.providerOperationVersion ?? null,
  });
}

/** Copy-safe identity; filename and content digests remain behind the token. */
export function inspectPreparedComposioPresignOneShot(
  prepared: PreparedComposioPresignOneShot,
): Readonly<PreparedComposioPresignOneShotIdentity> | null {
  const state = preparedComposioPresignOneShots.get(prepared as object);
  if (!state) return null;
  try {
    return Object.freeze({
      providerArgumentDigest: preparedProviderArgumentDigest(state.args),
      toolSlug: state.args.tool_slug,
      toolkitSlug: state.args.toolkit_slug,
    });
  } catch {
    return null;
  }
}

function normalizePreparedConnectionId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && !/^(?:null|undefined|none)$/i.test(normalized)
    ? normalized
    : undefined;
}

function exactPreparedOperationVersion(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length <= 160 && /^[A-Za-z0-9_.:-]+$/.test(normalized)
    ? normalized
    : undefined;
}

/** Pure/current preparation for the terminal adapter. It starts no provider
 * work: connected-account ownership must already be current, and SDK
 * construction has telemetry/version checks disabled. CLI execution is not a
 * prepared lane because the subprocess cannot prove one provider request. */
export function prepareComposioOneShotDispatch(input: {
  toolSlug: string;
  args: Record<string, unknown>;
  connectedAccountId?: string;
  providerOperationVersion?: string;
}): PreparedComposioOneShotDispatch {
  const toolSlug = input.toolSlug.trim();
  if (!toolSlug) {
    throw new ComposioPreDispatchError('preparation-required', 'Composio operation identity is not prepared.');
  }
  let args: Record<string, unknown>;
  try {
    args = structuredClone(input.args);
  } catch (cause) {
    throw new ComposioPreDispatchError(
      'preparation-required',
      `${toolSlug} arguments could not be frozen before dispatch.`,
      cause,
    );
  }

  const credentials = getComposioCredentialStatus();
  const connectedAccountId = normalizePreparedConnectionId(input.connectedAccountId);
  if (composioExecutionUsesCliOnlyLane(credentials)) {
    throw new ComposioPreDispatchError(
      'preparation-required',
      `${toolSlug} prepared execution requires the exact SDK no-retry transport; the CLI cannot prove one provider request.`,
    );
  }
  const providerOperationVersion = exactPreparedOperationVersion(input.providerOperationVersion);
  if (!providerOperationVersion) {
    throw new ComposioPreDispatchError(
      'preparation-required',
      `${toolSlug} has no exact current provider operation version.`,
    );
  }
  const snapshot = peekCurrentConnectedToolkits();
  let userId = credentials.userId;
  if (connectedAccountId) {
    if (!snapshot) {
      throw new ComposioPreDispatchError(
        'preparation-required',
        `${toolSlug} has no current connected-account observation.`,
      );
    }
    const connection = snapshot.find((row) => row.connectionId === connectedAccountId);
    if (!connection || !/active|enabled|initiat/i.test(connection.status ?? '')) {
      throw new ComposioPreDispatchError(
        'preparation-required',
        `${toolSlug} connected account ${connectedAccountId} is not current and usable.`,
      );
    }
    const owner = connection.ownerUserId ?? cachedConnectionOwner(connectedAccountId);
    if (!owner?.trim()) {
      throw new ComposioPreDispatchError(
        'preparation-required',
        `${toolSlug} connected account ${connectedAccountId} has no prepared owning provider identity.`,
      );
    }
    userId = owner.trim();
  }
  const composio = getComposio();
  if (!composio) {
    throw new ComposioPreDispatchError('sdk-unavailable', 'COMPOSIO_API_KEY is not configured.');
  }
  const raw = rawComposioClient(composio);
  const rawNoRetry = raw && typeof raw.withOptions === 'function'
    ? raw.withOptions({ maxRetries: 0 })
    : null;
  if (!rawNoRetry || typeof rawNoRetry.tools?.execute !== 'function') {
    throw new ComposioPreDispatchError(
      'preparation-required',
      `${toolSlug} has no exact one-request Composio transport.`,
    );
  }
  const state: PreparedComposioOneShotState = {
    lane: 'sdk',
    toolSlug,
    args,
    connectedAccountId,
    userId,
    providerOperationVersion,
    rawClient: rawNoRetry,
  };

  const prepared = Object.freeze(Object.create(null)) as PreparedComposioOneShotDispatch;
  preparedComposioOneShots.set(prepared, state);
  return prepared;
}

function exactPresignPreparationArgs(
  input: Record<string, unknown>,
): PreparedComposioPresignOneShotState['args'] | null {
  const filename = input.filename;
  const mimetype = input.mimetype;
  const md5 = input.md5;
  const toolSlug = input.tool_slug;
  const toolkitSlug = input.toolkit_slug;
  if (
    Object.keys(input).sort().join('\0') !== ['filename', 'md5', 'mimetype', 'tool_slug', 'toolkit_slug'].sort().join('\0')
    || typeof filename !== 'string'
    || filename.length < 1
    || filename.length > 255
    || filename !== filename.trim()
    || /[\\/\u0000-\u001f\u007f]/.test(filename)
    || filename === '.'
    || filename === '..'
    || typeof mimetype !== 'string'
    || mimetype.length < 1
    || mimetype.length > 512
    || mimetype !== mimetype.trim()
    || /[\u0000-\u001f\u007f]/.test(mimetype)
    || typeof md5 !== 'string'
    || !/^[a-f0-9]{32}$/.test(md5)
    || typeof toolSlug !== 'string'
    || toolSlug.length < 1
    || toolSlug.length > 512
    || !/^[A-Za-z0-9_.:-]+$/.test(toolSlug)
    || typeof toolkitSlug !== 'string'
    || toolkitSlug.length < 1
    || toolkitSlug.length > 160
    || !/^[a-z0-9_-]+$/.test(toolkitSlug)
  ) return null;
  return Object.freeze({
    filename,
    mimetype,
    md5,
    tool_slug: toolSlug,
    toolkit_slug: toolkitSlug,
  });
}

/** Pure/current preparation for one no-retry presign POST. */
export function prepareComposioPresignOneShot(input: {
  args: Record<string, unknown>;
}): PreparedComposioPresignOneShot {
  let cloned: Record<string, unknown>;
  try {
    cloned = structuredClone(input.args);
  } catch (cause) {
    throw new ComposioPreDispatchError(
      'preparation-required',
      'Composio presign arguments could not be frozen before dispatch.',
      cause,
    );
  }
  const args = exactPresignPreparationArgs(cloned);
  if (!args) {
    throw new ComposioPreDispatchError(
      'preparation-required',
      'Composio presign arguments are not exact.',
    );
  }
  const credentials = getComposioCredentialStatus();
  if (composioExecutionUsesCliOnlyLane(credentials)) {
    throw new ComposioPreDispatchError(
      'preparation-required',
      'Staged Composio file transfer requires the exact SDK transport.',
    );
  }
  const composio = getComposio();
  if (!composio) {
    throw new ComposioPreDispatchError('sdk-unavailable', 'COMPOSIO_API_KEY is not configured.');
  }
  const raw = rawComposioClient(composio);
  const rawNoRetry = raw && typeof raw.withOptions === 'function'
    ? raw.withOptions({ maxRetries: 0 })
    : null;
  if (!rawNoRetry || typeof rawNoRetry.files?.createPresignedURL !== 'function') {
    throw new ComposioPreDispatchError(
      'preparation-required',
      'Composio has no exact one-request staged-file presign transport.',
    );
  }
  const prepared = Object.freeze(Object.create(null)) as PreparedComposioPresignOneShot;
  preparedComposioPresignOneShots.set(prepared, {
    args,
    rawClient: rawNoRetry as PreparedComposioPresignOneShotState['rawClient'],
  });
  return prepared;
}

/** One `/api/v3.1/files/upload/request` POST, no SDK retry or modifier. */
export async function executePreparedComposioPresign(
  prepared: PreparedComposioPresignOneShot,
): Promise<unknown> {
  const state = preparedComposioPresignOneShots.get(prepared as object);
  if (!state) {
    throw new ComposioPreDispatchError(
      'preparation-required',
      'Composio staged-file presign requires an opaque prepared one-shot.',
    );
  }
  preparedComposioPresignOneShots.delete(prepared as object);
  const signal = currentToolAbortSignal();
  return state.rawClient.files.createPresignedURL(
    { ...state.args },
    signal ? { signal } : undefined,
  );
}

/** The terminal body: one no-retry v3.1 POST.
 * It performs no schema lookup, account listing, reconnect, version fetch,
 * fallback, upload/download modifier, or retry. */
export async function executePreparedComposioTool(
  prepared: PreparedComposioOneShotDispatch,
): Promise<unknown> {
  const state = preparedComposioOneShots.get(prepared);
  if (!state) {
    throw new ComposioPreDispatchError(
      'preparation-required',
      'Composio terminal dispatch requires an opaque prepared one-shot.',
    );
  }
  // One-shot ownership: consume before entering the terminal body so neither a
  // returned failure nor a throw can reuse the same preparation.
  preparedComposioOneShots.delete(prepared);
  const execute = state.rawClient?.tools?.execute;
  if (!execute || !state.providerOperationVersion) {
    throw new ComposioPreDispatchError('preparation-required', 'Prepared Composio SDK transport was lost.');
  }
  const body: Record<string, unknown> = {
    arguments: state.args,
    user_id: state.userId,
    version: state.providerOperationVersion,
    ...(state.connectedAccountId
      ? { connected_account_id: state.connectedAccountId }
      : {}),
  };
  const signal = currentToolAbortSignal();
  const raw = await execute.call(
    state.rawClient!.tools,
    state.toolSlug,
    body,
    signal ? { signal } : undefined,
  ) as Record<string, unknown>;
  return {
    data: raw?.data,
    error: raw?.error ?? null,
    successful: raw?.successful === true,
    ...(raw?.log_id !== undefined || raw?.logId !== undefined
      ? { logId: raw.log_id ?? raw.logId }
      : {}),
    ...(raw?.session_info !== undefined || raw?.sessionInfo !== undefined
      ? { sessionInfo: raw.session_info ?? raw.sessionInfo }
      : {}),
  };
}

export async function executeComposioTool(
  toolSlug: string,
  args: Record<string, unknown>,
  connectedAccountId?: string,
  preferredIdentity?: string,
): Promise<unknown> {
  const backend = getComposioExecutionBackend();
  let cliReadFailureAwaitingSdkFallback: unknown;
  let hasCliReadFailureAwaitingSdkFallback = false;
  const cliOnlyLane = composioExecutionUsesCliOnlyLane({
    executionBackend: backend,
    apiKeyPresent: Boolean(readComposioEnv('COMPOSIO_API_KEY')),
  });
  // The Composio ENTITY (user_id) is only the fallback when no specific
  // connection resolves; the MAILBOX is chosen by the identity-resolved
  // connectedAccountId below. Pure/local, no network (getPreferredUserId).
  const userId = getPreferredUserId();

  // A model (esp. a BYO/GLM backend) can serialize a null account id as the
  // LITERAL string "null"/"undefined"/"none" — truthy, so it both bypasses the
  // live-connection auto-resolver below AND is forwarded to Composio as a bogus
  // account id it cannot resolve, surfacing only as a generic dispatch error
  // (the 2026-06-29 Apify incident: every call carried connected_account_id:"null").
  // Treat those as "no pinned account" so the resolver picks the real live
  // connection. Same junk-string guard as normalizeInlineConnectedAccountId.
  const pinnedAccountId =
    connectedAccountId
    && !['null', 'undefined', 'none', ''].includes(connectedAccountId.trim().toLowerCase())
      ? connectedAccountId
      : undefined;

  if (cliOnlyLane && !pinnedAccountId) {
    const cliOptions = { ...composioCliOptions(), userId };
    const cliStatus = await getComposioCliStatus(cliOptions);
    if (cliStatus.installed && (backend === 'cli' || cliStatus.authenticated)) {
      try {
        return await executeComposioCliTool(toolSlug, args, cliOptions);
      } catch (error) {
        if (isComposioReconnectRequiredError(error)) {
          throw new ComposioReconnectRequiredError(toolSlug, error);
        }
        if (backend === 'cli') throw error;
        // Reads can always fall back. A mutation may fall back only when the
        // CLI proves it never dispatched (missing binary/auth/version). A
        // timeout/5xx/generic exit may have committed remotely; replaying it
        // through the SDK would duplicate the write under one logical call.
        if (!composioAutoFallbackAllowed(toolSlug, error)) {
          // An independent auth/read probe describes the lane NOW; it cannot
          // establish whether the earlier mutation committed before losing its
          // response. Never use a post-failure probe to authorize SDK replay.
          throw new ComposioDispatchUncertainError(toolSlug, error);
        }
        // AUTO may still recover a failed read through an available SDK client.
        // Retain the actual CLI failure until that client is proven available;
        // otherwise the nominal "missing API key" condition would erase the
        // provider/CLI rejection that explains why this call failed.
        if (composioSlugIsReadOnly(toolSlug)) {
          cliReadFailureAwaitingSdkFallback = error;
          hasCliReadFailureAwaitingSdkFallback = true;
        }
      }
    } else if (backend === 'cli') {
      // This status check completed before executeComposioCliTool was invoked,
      // so its nominal local error is valid replay provenance.
      throw new ComposioPreDispatchError(
        cliStatus.installed ? 'cli-auth' : 'cli-unavailable',
        cliStatus.installed
          ? 'Composio CLI is installed, but no CLI login was detected. Run composio login or switch the backend to AUTO/SDK.'
          : 'Composio CLI is not installed. Install it or switch the backend to AUTO/SDK.',
      );
    }
  }

  const composio = getComposio();
  // No SDK client was constructed, so this nominal local error is strictly
  // pre-dispatch. The same API-key prose inside a provider error is not proof.
  if (!composio) {
    if (hasCliReadFailureAwaitingSdkFallback) {
      throw cliReadFailureAwaitingSdkFallback;
    }
    throw new ComposioPreDispatchError(
      'sdk-unavailable',
      'COMPOSIO_API_KEY is not configured.',
    );
  }
  // "Know about the connection, then query the right one": when the caller
  // didn't pin a connection, resolve the toolkit's live connection by IDENTITY
  // (selectToolkitConnection) rather than relying on a stale baked id or the
  // opaque user_id default. Served SWR-instant from the cached snapshot (E1);
  // the self-heal below backstops a just-changed connection.
  let selfHealedConnection = false;
  const resolutionOutcome = pinnedAccountId
    ? null
    : await resolveToolkitConnectionOutcome(toolSlug, preferredIdentity);
  let resolvedConnection = pinnedAccountId
    ?? (resolutionOutcome?.kind === 'resolved' ? resolutionOutcome.connectionId : undefined);
  // OWNER-PAIR dispatch: Composio validates that userId and connectedAccountId
  // MATCH — a pinned connection dispatched under a different entity 400s with
  // ConnectedAccountEntityIdMismatch. So the dispatch userId is the entity that
  // OWNS the resolved connection (raw-v3 snapshot), falling back to the
  // configured/derived entity only when no specific connection is pinned.
  let snapshotConns: ConnectedToolkit[] = [];
  try { snapshotConns = await listUsableConnectedToolkits(); } catch { snapshotConns = []; }
  // NEVER DISPATCH BARE WHEN A CONNECTION EXISTS. The SDK sends the dispatch as
  // `{ connected_account_id, user_id }`; with NO connected_account_id the backend
  // resolves auth by user_id alone, which returns Auth_Config_AuthSchemeNotFound
  // whenever the dispatch entity owns no connection for the toolkit (the live
  // 2026-07-24 shape: COMPOSIO_USER_ID owns zero connections; every real
  // connection is under other entities). So if identity resolution DEFERRED but
  // the snapshot holds exactly ONE connection for this toolkit, pin it — the
  // dispatchUserIdFor pairing below routes it under its true owner. Genuinely
  // ambiguous (2+ distinct) or truly-absent toolkits still fall through to a bare
  // dispatch and fail legibly. Kill-switch: CLEMMY_COMPOSIO_LONE_CONN_DISPATCH=off.
  if (!resolvedConnection && (process.env.CLEMMY_COMPOSIO_LONE_CONN_DISPATCH ?? 'on').toLowerCase() !== 'off') {
    resolvedConnection = loneToolkitConnection(toolSlug, snapshotConns) ?? resolvedConnection;
  }
  // AMBIGUITY IS A QUESTION, NOT "NOT CONNECTED" (live 2026-08-04: a user with
  // multiple Outlook identities got "no active Outlook connection" on an
  // invite blast while their Connect screen showed Active). The legacy
  // resolveToolkitConnectionId wrapper collapsed `ambiguous`/`identity-absent`
  // to undefined, so the doomed bare dispatch under an entity owning none of
  // the candidates produced the FAKE not-connected error. When the bare
  // dispatch is provably doomed — 2+ distinct identities matched and the
  // dispatch entity owns none of them — fail pre-dispatch with the real
  // question, naming the mailboxes so the model can ask the user which to use.
  if (!resolvedConnection && resolutionOutcome) {
    const doomed = bareDispatchDoomedQuestion(resolutionOutcome, snapshotConns, toolSlug, userId);
    if (doomed) throw new ComposioPreDispatchError('connection-ambiguous', doomed);
  }
  const body: Record<string, unknown> = {
    userId: dispatchUserIdFor(resolvedConnection, snapshotConns, userId),
    arguments: args,
    dangerouslySkipVersionCheck: true,
  };
  if (resolvedConnection) body.connectedAccountId = resolvedConnection;

  // Self-heal (E2): we picked this connection from a possibly-stale SWR snapshot,
  // or resolution DEFERRED (no connection) and we dispatched on the bare entity.
  // Either way a reconnect-class failure — thrown OR returned as a
  // `successful:false` result (e.g. Auth_Config_AuthSchemeNotFound on a freshly
  // spawned worker whose snapshot was cold) — means the live connection wasn't
  // used. Bust the cache, re-resolve FRESH once, and retry only if we land on a
  // DIFFERENT connection. Never fires for a caller-pinned account (the user's
  // explicit choice); at most one extra round-trip. Reads may self-heal. A
  // mutation may not: reconnect-shaped provider errors/results are not proof
  // that the first remote call failed before committing.
  const reResolveFreshRetry = async (
    failure: unknown,
  ): Promise<{ retried: true; result: unknown } | { retried: false }> => {
    if (!composioAutoFallbackAllowed(toolSlug, failure)) return { retried: false };
    if (!(connSwrEnabled() && pinnedAccountId === undefined && !selfHealedConnection)) return { retried: false };
    selfHealedConnection = true;
    invalidateConnectedAccountSnapshot();
    const fresh = await resolveToolkitConnectionId(toolSlug, preferredIdentity);
    if (!fresh || fresh === resolvedConnection) return { retried: false };
    let freshConns: ConnectedToolkit[] = [];
    try { freshConns = await listUsableConnectedToolkits(); } catch { freshConns = []; }
    const result = await (composio as any).tools.execute(toolSlug, {
      ...body,
      userId: dispatchUserIdFor(fresh, freshConns, userId),
      connectedAccountId: fresh,
    });
    return { retried: true, result };
  };

  let result: unknown;
  try {
    result = await (composio as any).tools.execute(toolSlug, body);
  } catch (err) {
    if (isComposioReconnectRequiredError(err)) {
      const healed = await reResolveFreshRetry(err);
      if (healed.retried) return healed.result;
      throw new ComposioReconnectRequiredError(toolSlug, err);
    }
    // NOMINAL tool-not-found proof (live 2026-07-31: a wrong GOOGLESHEETS slug
    // parked a whole turn as "dispatch uncertain" + artifact jail — the user
    // read it as "the sheet died mid-flight" when NOTHING was ever sent). The
    // SDK throws ComposioToolNotFoundError at exactly ONE site — the
    // tool-definition GET inside execute, BEFORE any execution request is
    // constructed (verified against @composio/core dist). An instanceof of the
    // SDK's own class is therefore local-boundary proof of zero dispatch —
    // unlike message TEXT, which a provider or post-commit sub-call could echo
    // (the long-standing rule below stays intact for text shapes).
    if (err instanceof ComposioToolNotFoundError) {
      if (body.version === undefined) {
        // With proof of no dispatch, the curated-slug version retry is safe
        // for mutations too, not only reads.
        const version = await resolveComposioToolVersion(toolSlug);
        if (version) return await (composio as any).tools.execute(toolSlug, { ...body, version });
      }
      throw new ComposioPreDispatchError(
        'tool-not-found',
        `Tool slug "${toolSlug}" does not exist in the Composio catalog — the provider never received any request, so nothing was created, sent, or changed. `
        + 'Find the correct slug (composio_search_tools or tool_search) and retry with it.',
        err,
      );
    }
    // v0.5.65 — discover/execute version split. The SDK resolves a slug under
    // toolkit_versions=latest, but CURATED slugs (now discoverable via the
    // version-free broker fetch) live in the PUBLISHED namespace and 404 under
    // 'latest' → "Unable to retrieve tool". That text is not execution
    // provenance: a provider or post-commit sub-call can return the same phrase.
    // Reads may retry pinned to the resolved version; mutations must surface the
    // first outcome as ambiguous instead of crossing the boundary twice.
    const msg = err instanceof Error ? err.message : String(err);
    if (
      composioAutoFallbackAllowed(toolSlug, err)
      && body.version === undefined
      && /unable to retrieve tool|tool not found|ComposioToolNotFound/i.test(msg)
    ) {
      const version = await resolveComposioToolVersion(toolSlug);
      if (version) return await (composio as any).tools.execute(toolSlug, { ...body, version });
    }
    throw err;
  }
  // Returned reconnect-class shape (`successful:false` with an auth-config/scheme
  // miss): the SDK didn't throw, so the thrown-path self-heal never ran. Apply
  // the same fresh re-resolve + single retry here so a cold-snapshot worker
  // recovers to success instead of returning an unusable result the model then
  // grinds on. A genuinely unresolvable toolkit falls through and the returned
  // reconnect error surfaces its "reconnect <app>" guidance downstream.
  if (isComposioReconnectRequiredError(result)) {
    const healed = await reResolveFreshRetry(result);
    if (healed.retried) return healed.result;
  }
  return result;
}

/**
 * Resolve the connection to use for a toolkit when the caller pinned none.
 * Returns a connectionId ONLY when unambiguous — exactly one connection for the
 * toolkit, or exactly one ACTIVE among several — so it never guesses wrong. For
 * zero or genuinely-ambiguous-multiple it returns undefined and the caller
 * falls back to composio's own default resolution. This is the durable fix for
 * stale-connection rot: the live connection is queried per call, never cached
 * into a tool-choice (see stripBakedConnectionId).
 */
/** Normalized email for identity comparison — mirrors sender-verify's
 *  normalizeEmail so every layer keys mailboxes identically. */
function normEmail(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/^smtp:/, '');
}

/** Canonical toolkit match: a `one_drive` connection matches an
 *  `ONE_DRIVE_UPLOAD_FILE` tool, and a bare `google` connection does NOT match a
 *  `GOOGLEDRIVE_*` tool. Shared by resolution so every layer selects the same set. */
function toolMatchesConnection(toolSlugLower: string, connSlugLower: string): boolean {
  if (!connSlugLower) return false;
  return toolSlugLower === connSlugLower || toolSlugLower.startsWith(`${connSlugLower}_`);
}

/**
 * The single unambiguous connection for a toolkit in the given snapshot, else
 * undefined. Used at dispatch to AVOID a bare (connectionId-less) call when a
 * connection exists: the Composio SDK resolves a bare dispatch by user_id alone,
 * which 500s with Auth_Config_AuthSchemeNotFound whenever the dispatch entity
 * owns no connection for the toolkit. Returns an id ONLY when exactly one
 * distinct connection matches — never guesses among genuinely ambiguous mailboxes
 * (those must ASK). Status-agnostic on purpose: pinning a stale-but-listed
 * connection yields a precise "reconnect" error, strictly better than a bare
 * dispatch's opaque auth-config miss. Pure + exported for test.
 */
export function loneToolkitConnection(toolSlug: string, snapshotConns: ConnectedToolkit[]): string | undefined {
  const toolLower = toolSlug.toLowerCase();
  const distinct = [...new Set(
    snapshotConns
      .filter((c) => c.connectionId && toolMatchesConnection(toolLower, (c.slug ?? '').toLowerCase()))
      .map((c) => c.connectionId),
  )];
  return distinct.length === 1 ? distinct[0] : undefined;
}

export interface DistinctIdentity {
  email?: string;
  connectionId: string;
  wordId?: string;
}

export type ToolkitConnectionOutcome =
  | { kind: 'resolved'; connectionId: string; identity?: string }
  | { kind: 'defer' } // 0 usable candidates → let composio pick its default entity
  | { kind: 'ambiguous'; candidates: DistinctIdentity[] } // N distinct mailboxes, no disambiguator → ASK
  | { kind: 'identity-absent'; want: string; candidates: DistinctIdentity[] }; // recalled mailbox no longer connected → ASK

function identityResolveEnabled(): boolean {
  return (process.env.CLEMMY_COMPOSIO_IDENTITY_RESOLVE ?? 'on').toLowerCase() !== 'off';
}

/** Kill-switch for the SWR-serve + self-heal hot path (E). Off → the execute
 *  path re-resolves fresh each call (the pre-E behavior) and skips self-heal. */
function connSwrEnabled(): boolean {
  return (process.env.CLEMMY_COMPOSIO_CONN_SWR ?? 'on').toLowerCase() !== 'off';
}

/**
 * Identity-layered connection selection (pure + testable). Collapses same-mailbox
 * re-auths into one identity (keyed by normalized accountEmail, else Composio's
 * wordId, else the connection id — unknown identities are NEVER merged), picks
 * the freshest genuinely-active representative, and returns a three/four-valued
 * outcome so a genuinely multi-mailbox user is ASKED rather than guessed for.
 * The old "give up on >1 active → defer to user_id" behavior lives behind the
 * CLEMMY_COMPOSIO_IDENTITY_RESOLVE=off kill-switch.
 */
export function selectToolkitConnection(
  toolSlug: string,
  conns: ConnectedToolkit[],
  identityHint?: string,
): ToolkitConnectionOutcome {
  const toolLower = toolSlug.toLowerCase();

  if (!identityResolveEnabled()) {
    // Legacy: single match, or a single ACTIVE among many, resolves; else defer.
    const matched = conns.filter((c) => c.slug && c.connectionId && toolLower.startsWith(c.slug.toLowerCase()));
    if (matched.length === 0) return { kind: 'defer' };
    if (matched.length === 1) return { kind: 'resolved', connectionId: matched[0].connectionId };
    const active = matched.filter((c) => /active|enabled|initiat/i.test(c.status));
    return active.length === 1 ? { kind: 'resolved', connectionId: active[0].connectionId } : { kind: 'defer' };
  }

  const matched = conns.filter((c) => c.connectionId && toolMatchesConnection(toolLower, (c.slug ?? '').toLowerCase()));
  if (matched.length === 0) return { kind: 'defer' };
  const liveish = matched.filter((c) => /active|enabled|initiat/i.test(c.status ?? ''));
  if (liveish.length === 0) return { kind: 'defer' };

  const groups = new Map<string, ConnectedToolkit[]>();
  for (const c of liveish) {
    const email = normEmail(c.accountEmail);
    const key = email.includes('@') ? email : c.wordId ? `word:${c.wordId}` : `conn:${c.connectionId}`;
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(c);
  }

  const activeTier = (s: string): number => (/^(active|enabled)$/i.test(s.trim()) ? 0 : 1);
  const representative = (members: ConnectedToolkit[]): ConnectedToolkit =>
    [...members].sort((a, b) => {
      const ta = activeTier(a.status ?? '');
      const tb = activeTier(b.status ?? '');
      if (ta !== tb) return ta - tb; // genuine ACTIVE beats an in-flight INITIATED re-auth
      const da = a.createdAt ?? '';
      const db = b.createdAt ?? '';
      if (da !== db) return da < db ? 1 : -1; // createdAt DESC (freshest)
      return a.connectionId < b.connectionId ? -1 : 1;
    })[0];

  const distinct: DistinctIdentity[] = [...groups.entries()].map(([key, members]) => {
    const rep = representative(members);
    return {
      email: key.includes('@') ? key : (normEmail(rep.accountEmail).includes('@') ? normEmail(rep.accountEmail) : undefined),
      connectionId: rep.connectionId,
      wordId: rep.wordId,
    };
  });

  const wantEmail = normEmail(identityHint);
  if (wantEmail.includes('@')) {
    const hit = distinct.find((d) => d.email === wantEmail);
    if (hit) return { kind: 'resolved', connectionId: hit.connectionId, identity: hit.email };
    return { kind: 'identity-absent', want: wantEmail, candidates: distinct }; // recalled mailbox gone → ASK, never fall through
  }

  if (distinct.length === 1) return { kind: 'resolved', connectionId: distinct[0].connectionId, identity: distinct[0].email };
  return { kind: 'ambiguous', candidates: distinct }; // genuinely different mailboxes → ASK
}

export async function resolveToolkitConnectionOutcome(
  toolSlug: string,
  identityHint?: string,
): Promise<ToolkitConnectionOutcome> {
  try {
    // SWR-serve the cached snapshot on the hot path (E1); the self-heal in
    // executeComposioTool busts + refetches only on a real connection error.
    // Kill-switch off → pre-emptive fresh fetch (the pre-E behavior).
    const conns = await listUsableConnectedToolkits({ requireFresh: !connSwrEnabled() });
    return selectToolkitConnection(toolSlug, conns, identityHint);
  } catch {
    return { kind: 'defer' };
  }
}

export async function resolveToolkitConnectionId(toolSlug: string, identityHint?: string): Promise<string | undefined> {
  const outcome = await resolveToolkitConnectionOutcome(toolSlug, identityHint);
  return outcome.kind === 'resolved' ? outcome.connectionId : undefined;
}

/** Back-compat pure wrapper (legacy `string | undefined`): only `resolved`
 *  yields an id; defer/ambiguous/identity-absent → undefined. */
export function pickToolkitConnection(toolSlug: string, conns: ConnectedToolkit[]): string | undefined {
  const outcome = selectToolkitConnection(toolSlug, conns);
  return outcome.kind === 'resolved' ? outcome.connectionId : undefined;
}

export async function searchComposioToolsViaCli(
  query: string,
  options: { toolkitSlug?: string; limit?: number } = {},
): Promise<unknown> {
  const userId = await getPreferredUserId();
  return searchComposioCliTools(query, {
    ...composioCliOptions(),
    userId,
    toolkitSlug: options.toolkitSlug,
    limit: options.limit,
  });
}

export async function buildComposioDashboardSnapshot(): Promise<ComposioDashboardSnapshot> {
  return swrFetch(snapshotSwr, COMPOSIO_SNAPSHOT_TTL_MS, buildComposioDashboardSnapshotLive);
}

async function buildComposioDashboardSnapshotLive(): Promise<ComposioDashboardSnapshot> {
  const credentials = getComposioCredentialStatus();
  const cli = await getComposioCliStatus(composioCliOptions());
  if (!credentials.enabled) {
    const toolkits = CURATED_TOOLKITS.map((toolkit) => ({
      slug: toolkit.slug,
      displayName: toolkit.displayName,
      authMode: toolkit.authMode,
      hasAuthConfig: false,
      logoUrl: null,
      description: null,
      toolCount: null,
      categories: [],
      connections: [],
    }));
    return {
      ...credentials,
      cli,
      connected: [],
      toolkits,
      featured: toolkits.map((toolkit) => toolkit.slug),
      totalCount: toolkits.length,
      catalogError: null,
    };
  }

  let catalog: CatalogToolkit[] = [];
  let catalogError: string | null = null;
  try {
    catalog = await listAllToolkits();
  } catch (error) {
    catalogError = error instanceof Error ? error.message : String(error);
    catalog = CURATED_TOOLKITS.map((toolkit) => ({
      slug: toolkit.slug,
      name: toolkit.displayName,
      authMode: toolkit.authMode,
      categories: [],
    }));
  }

  const [connected, configured] = await Promise.all([
    listConnectedToolkits(),
    listToolkitSlugsWithAuthConfig(),
  ]);

  const suppressionState = readComposioConnectionSuppressionState();
  const dashboardConnections = connected.map((connection) =>
    toComposioDashboardConnection(connection, suppressionState));

  const connectionsBySlug = new Map<string, ComposioDashboardConnection[]>();
  for (const connection of dashboardConnections) {
    const list = connectionsBySlug.get(connection.slug) ?? [];
    list.push(connection);
    connectionsBySlug.set(connection.slug, list);
  }

  const catalogBySlug = new Map(catalog.map((toolkit) => [toolkit.slug, toolkit]));
  const orphanSlugs = [...connectionsBySlug.keys()].filter((slug) => !catalogBySlug.has(slug));
  const toolkits: ComposioDashboardToolkit[] = [
    ...catalog.map((toolkit) => ({
      slug: toolkit.slug,
      displayName: toolkit.name,
      authMode: toolkit.authMode,
      hasAuthConfig: configured.has(toolkit.slug),
      logoUrl: toolkit.logoUrl ?? null,
      description: toolkit.description ?? null,
      toolCount: toolkit.toolsCount ?? null,
      categories: toolkit.categories,
      connections: connectionsBySlug.get(toolkit.slug) ?? [],
    })),
    ...orphanSlugs.map((slug) => ({
      slug,
      displayName: displayNameFor(slug),
      authMode: 'managed' as ToolkitAuthMode,
      hasAuthConfig: configured.has(slug),
      logoUrl: null,
      description: null,
      toolCount: null,
      categories: [],
      connections: connectionsBySlug.get(slug) ?? [],
    })),
  ];

  const connectedSlugs = new Set(connected.map((connection) => connection.slug));
  const curated = new Set(CURATED_TOOLKITS.map((toolkit) => toolkit.slug));
  const featured = [
    ...toolkits.filter((toolkit) => connectedSlugs.has(toolkit.slug)).map((toolkit) => toolkit.slug),
    ...toolkits.filter((toolkit) => !connectedSlugs.has(toolkit.slug) && curated.has(toolkit.slug)).map((toolkit) => toolkit.slug),
    ...toolkits
      .filter((toolkit) => !connectedSlugs.has(toolkit.slug) && !curated.has(toolkit.slug))
      .sort((left, right) => (right.toolCount ?? 0) - (left.toolCount ?? 0))
      .slice(0, 12)
      .map((toolkit) => toolkit.slug),
  ].slice(0, 30);

  return {
    ...credentials,
    cli,
    connected: dashboardConnections,
    toolkits,
    featured,
    totalCount: toolkits.length,
    catalogError,
  };
}

export const __test__ = {
  authConfigId,
  authConfigAuthScheme,
  authConfigToolkitSlug,
  selectAuthConfigIdForToolkit,
  derivedComposioUserId,
  setComposioClient(client: unknown): void {
    singleton = client as Composio;
  },
  setComposioApiKeyOverride(value: string | null): void {
    composioApiKeyOverrideForTest = value;
  },
  setConnectedAccountsLoader(
    loader: (() => Promise<Array<Record<string, unknown>>>) | null,
  ): void {
    connectedAccountsLoaderForTest = loader;
    if (loader) connectedAccountsListTransportsForTest = null;
    invalidateConnectedAccountSnapshot();
  },
  setConnectedAccountsListTransports(
    transports: ConnectedAccountsListTransports | null,
  ): void {
    connectedAccountsListTransportsForTest = transports;
    if (transports) connectedAccountsLoaderForTest = null;
    invalidateConnectedAccountSnapshot();
  },
};

/**
 * Synchronous snapshot of the connection registry — the cached (or last-good)
 * listing, never a probe. For sync preflight seams (typed capability
 * resolution) that must not block a turn on a network call. Empty means "no
 * registry available", which callers must treat as UNKNOWN, never as
 * disconnected — absence of the registry is not absence of the connection.
 */
export function peekConnectedToolkits(): ConnectedToolkit[] {
  return connectionsCache?.data ?? lastGoodConnections ?? [];
}

/**
 * Synchronous execution-preparation view of the connection registry.
 *
 * Unlike `peekConnectedToolkits()`, this never falls back to an arbitrarily old
 * last-good snapshot. `null` means no current provider observation is prepared;
 * an empty array means a current observation proved there are no connections.
 * Provider adapters use this after planning/discovery so resolving a business
 * call cannot start a hidden account-list request before its physical attempt.
 */
export function peekCurrentConnectedToolkits(nowMs = Date.now()): ConnectedToolkit[] | null {
  if (!connectionsCache) return null;
  const age = nowMs - connectionsCache.at;
  if (!Number.isFinite(age) || age < 0 || age >= CONNECTIONS_TTL_MS) return null;
  return connectionsCache.data;
}
