import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Composio } from '@composio/core';
import { BASE_DIR } from '../../config.js';
import { readEnvFile, writeEnvFile } from '../../setup/env-file.js';
import { getSecretStore } from '../../runtime/secrets/index.js';
import {
  executeComposioCliTool,
  getComposioCliStatus,
  searchComposioCliTools,
  type ComposioCliStatus,
} from './cli.js';

const ENV_FILE = path.join(BASE_DIR, '.env');
const CACHE_DIR = path.join(BASE_DIR, 'state');
const CATALOG_CACHE_FILE = path.join(CACHE_DIR, 'composio-catalog-cache.json');
const SECRET_VAULT_FILE = path.join(CACHE_DIR, 'secrets-vault.json');
const DEFAULT_USER_ID = 'default';
const CONNECTIONS_TTL_MS = 60_000;
const CATALOG_TTL_MS = 60 * 60_000;
const USER_ID_TTL_MS = 60_000;
const BACKEND_VALUES = ['auto', 'sdk', 'cli'] as const;

export type ToolkitAuthMode = 'managed' | 'byo' | 'none';
export type ComposioExecutionBackend = typeof BACKEND_VALUES[number];

export interface CuratedToolkit {
  slug: string;
  displayName: string;
  authMode: ToolkitAuthMode;
}

export const CURATED_TOOLKITS: CuratedToolkit[] = [
  { slug: 'gmail', displayName: 'Gmail', authMode: 'managed' },
  { slug: 'googlecalendar', displayName: 'Google Calendar', authMode: 'managed' },
  { slug: 'googledrive', displayName: 'Google Drive', authMode: 'managed' },
  { slug: 'googlesheets', displayName: 'Google Sheets', authMode: 'managed' },
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
  connections: Array<{
    id: string;
    status: string;
    alias: string | null;
    accountLabel: string | null;
    accountEmail: string | null;
    accountName: string | null;
    accountAvatarUrl: string | null;
    createdAt: string | null;
  }>;
}

export interface ComposioDashboardSnapshot {
  enabled: boolean;
  apiKeyPresent: boolean;
  maskedApiKey?: string;
  userId: string;
  executionBackend: ComposioExecutionBackend;
  cli: ComposioCliStatus;
  connected: ConnectedToolkit[];
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
let catalogCache: { at: number; data: CatalogToolkit[] } | null = null;
let detectedPreferredUserId: { at: number; value: string } | null = null;

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

export function getComposio(): Composio | null {
  if (singleton) return singleton;
  const apiKey = readComposioEnv('COMPOSIO_API_KEY');
  if (!apiKey) return null;
  singleton = new Composio({ apiKey });
  return singleton;
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
    userId: readComposioEnv('COMPOSIO_USER_ID') || DEFAULT_USER_ID,
    executionBackend: getComposioExecutionBackend(),
  };
}

export function getComposioExecutionBackend(): ComposioExecutionBackend {
  const raw = readComposioConfigEnv('COMPOSIO_BACKEND').toLowerCase();
  return (BACKEND_VALUES as readonly string[]).includes(raw) ? raw as ComposioExecutionBackend : 'auto';
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
  const userId = readComposioEnv('COMPOSIO_USER_ID') || DEFAULT_USER_ID;
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(userId ? { userId } : {}),
  };
}

export async function getComposioRuntimeStatus(): Promise<ReturnType<typeof getComposioCredentialStatus> & {
  cli: ComposioCliStatus;
}> {
  const credentials = getComposioCredentialStatus();
  const cli = await getComposioCliStatus(composioCliOptions());
  return { ...credentials, cli };
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
  connectionsCache = null;
  catalogCache = null;
  detectedPreferredUserId = null;
}

export function clearConnectedToolkitsCache(): void {
  connectionsCache = null;
}

export async function getPreferredUserId(): Promise<string> {
  const explicit = readComposioEnv('COMPOSIO_USER_ID');
  if (explicit) return explicit;

  const now = Date.now();
  if (detectedPreferredUserId && now - detectedPreferredUserId.at < USER_ID_TTL_MS) {
    return detectedPreferredUserId.value;
  }

  const composio = getComposio();
  if (!composio) return DEFAULT_USER_ID;

  try {
    const rawClient = rawComposioClient(composio);
    const resp = await rawClient.connectedAccounts.list({ limit: 100 });
    const items = Array.isArray(resp) ? resp : (resp?.items ?? []);
    const counts = new Map<string, number>();
    for (const item of items as Array<Record<string, unknown>>) {
      const userId = str(item.user_id) ?? str(item.userId);
      if (!userId) continue;
      const weight = item.status === 'ACTIVE' ? 2 : 1;
      counts.set(userId, (counts.get(userId) ?? 0) + weight);
    }
    const [top] = [...counts.entries()].sort((left, right) => right[1] - left[1])[0] ?? [];
    if (top) {
      detectedPreferredUserId = { at: now, value: top };
      return top;
    }
  } catch {
    // Fall through to default. Composio auth still works for first-run users.
  }

  detectedPreferredUserId = { at: now, value: DEFAULT_USER_ID };
  return DEFAULT_USER_ID;
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

export async function listConnectedToolkits(): Promise<ConnectedToolkit[]> {
  const composio = getComposio();
  if (!composio) return [];

  const now = Date.now();
  if (connectionsCache && now - connectionsCache.at < CONNECTIONS_TTL_MS) return connectionsCache.data;

  try {
    const resp = await (composio as any).connectedAccounts.list({ limit: 100 });
    const items = Array.isArray(resp) ? resp : (resp?.items ?? []);
    const data = (items as Array<Record<string, unknown>>).map((item) => {
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
      };
    }).filter((connection) => connection.connectionId && connection.slug !== 'unknown');

    connectionsCache = { at: now, data };
    return data;
  } catch {
    return connectionsCache?.data ?? [];
  }
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

export class ComposioNeedsAuthConfigError extends Error {
  constructor(public readonly slug: string, public readonly underlying: string) {
    super(`Toolkit "${slug}" needs an auth config in Composio before OAuth can start. Open https://platform.composio.dev/auth-configs and add the toolkit to your project.`);
    this.name = 'ComposioNeedsAuthConfigError';
  }
}

export async function authorizeToolkit(slug: string): Promise<{ redirectUrl: string | null; connectionId: string }> {
  const composio = getComposio();
  if (!composio) throw new Error('COMPOSIO_API_KEY is not configured.');

  // Pre-flight check: if Composio has no auth_config for this toolkit,
  // toolkits.authorize() still returns a redirectUrl — but the hosted
  // OAuth page errors out with "Something went wrong. Clear your
  // session." (seen 2026-05-21 with apify + firecrawl). Skip the bad
  // dance and surface the proper "needs setup" path immediately.
  try {
    const configured = await listToolkitSlugsWithAuthConfig();
    if (!configured.has(slug)) {
      throw new ComposioNeedsAuthConfigError(
        slug,
        `No auth_config for "${slug}" in this Composio project. Add one at platform.composio.dev/auth-configs before connecting.`,
      );
    }
  } catch (error) {
    // Re-throw the structured needs-setup error; swallow listing
    // failures (rare — network blip etc.) and fall through to the
    // legacy authorize call which still has its own 400/401/403
    // fallback.
    if (error instanceof ComposioNeedsAuthConfigError) throw error;
  }

  const userId = await getPreferredUserId();
  try {
    const connection = await (composio as any).toolkits.authorize(userId, slug);
    detectedPreferredUserId = null;
    connectionsCache = null;
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
export async function getToolkitSetupMeta(slug: string): Promise<{
  name: string;
  description: string | null;
  appUrl: string | null;
  authHintUrl: string | null;
  authGuideUrl: string | null;
  fields: Array<{ name: string; label: string; description: string | null; default: string | null; isSecret: boolean; required: boolean }>;
  authScheme: string;
} | null> {
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
 * back to platform.composio.dev — there's no way to skip the manual
 * BYO setup in that case.
 */
export async function setupOAuthToolkit(slug: string): Promise<{ ok: true; authConfigId: string }> {
  const composioApiKey = readComposioEnv('COMPOSIO_API_KEY');
  if (!composioApiKey) throw new Error('COMPOSIO_API_KEY is not configured.');
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
  connectionsCache = null;
  detectedPreferredUserId = null;
  return { ok: true, authConfigId };
}

export async function disconnectToolkit(connectionId: string): Promise<void> {
  const composio = getComposio();
  if (!composio) throw new Error('COMPOSIO_API_KEY is not configured.');
  await (composio as any).connectedAccounts.delete(connectionId);
  connectionsCache = null;
}

/**
 * One-shot setup for API_KEY-mode toolkits whose hosted Composio popup
 * throws "Something went wrong" (firecrawl, apify, ...). We call
 * Composio's REST API directly via fetch — the SDK's typed shapes
 * mismatch the actual API contract (the SDK serializes `toolkit.slug`
 * in a way the server rejects with "Expected string, received object").
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
export async function setupApiKeyToolkit(
  slug: string,
  apiKey: string,
  baseUrl?: string,
): Promise<{ ok: true; authConfigId: string; connectionId: string }> {
  const composioApiKey = readComposioEnv('COMPOSIO_API_KEY');
  if (!composioApiKey) throw new Error('COMPOSIO_API_KEY is not configured.');
  const userId = await getPreferredUserId();

  // Step 1 — project-level auth_config (via raw fetch; see banner).
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
        authScheme: 'API_KEY',
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
  const authConfigId = str(authConfig.id)
    ?? str(authConfigInner.id)
    ?? str(authConfig.nanoid)
    ?? '';
  if (!authConfigId) {
    throw new Error(`Composio returned no auth_config id. Body: ${JSON.stringify(authConfig).slice(0, 200)}`);
  }

  // Step 2 — per-user connection. state carries the actual API key.
  const val: Record<string, unknown> = {
    status: 'ACTIVE',
    generic_api_key: apiKey,
  };
  if (baseUrl) val.base_url = baseUrl;
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
          authScheme: 'API_KEY',
          val,
        },
      },
      validate_credentials: false,
    }),
  });
  if (!createConnRes.ok) {
    const body = await createConnRes.text();
    throw new Error(`Composio connection create failed (${createConnRes.status}): ${body.slice(0, 300)}`);
  }
  const connection = (await createConnRes.json()) as Record<string, unknown>;
  const connectionId = str(connection.id) ?? str(connection.nanoid) ?? '';

  // Bust caches so the dashboard refresh picks up the new connection.
  connectionsCache = null;
  detectedPreferredUserId = null;
  return { ok: true, authConfigId, connectionId };
}

export async function listComposioToolkitTools(slug: string, limit = 80): Promise<ComposioToolkitTool[]> {
  const composio = getComposio();
  if (!composio) throw new Error('COMPOSIO_API_KEY is not configured.');
  const raw = await (composio as any).tools.getRawComposioTools({ toolkits: [slug], limit });
  const items = Array.isArray(raw) ? raw : (raw?.items ?? []);
  const tools: ComposioToolkitTool[] = [];
  for (const item of items as Array<Record<string, unknown>>) {
    const toolkit = obj(item.toolkit);
    const toolSlug = str(item.slug) ?? str(item.name);
    if (!toolSlug) continue;
    tools.push({
      slug: toolSlug,
      name: str(item.name) ?? toolSlug,
      description: str(item.description),
      toolkitSlug: str(toolkit.slug) ?? slug,
      inputParameters: item.inputParameters ?? item.input_parameters ?? item.parameters,
    });
  }
  return tools;
}

export async function executeComposioTool(
  toolSlug: string,
  args: Record<string, unknown>,
  connectedAccountId?: string,
): Promise<unknown> {
  const backend = getComposioExecutionBackend();
  // Resolve the actual Composio user_id ONCE up front. The setup wizard
  // writes `COMPOSIO_USER_ID=default` into .env, but Composio's real
  // user ids look like `pg-test-04a26016-…` — connections live under
  // the real id, not under literal "default". getPreferredUserId()
  // probes connected_accounts and picks the user with the most ACTIVE
  // connections, so both the CLI and SDK paths route to where the
  // user's data actually is. Without this, the CLI path emits
  // `ToolRouterV2_NoActiveConnection` for every toolkit a user has set
  // up via the dashboard.
  const userId = await getPreferredUserId();

  if (backend !== 'sdk' && !connectedAccountId) {
    const cliOptions = { ...composioCliOptions(), userId };
    const cliStatus = await getComposioCliStatus(cliOptions);
    if (cliStatus.installed && (backend === 'cli' || cliStatus.authenticated)) {
      try {
        return await executeComposioCliTool(toolSlug, args, cliOptions);
      } catch (error) {
        if (backend === 'cli') throw error;
        // In auto mode, a CLI auth/version mismatch should not break
        // existing users. Fall through to the SDK path.
      }
    } else if (backend === 'cli') {
      throw new Error(cliStatus.installed
        ? 'Composio CLI is installed, but no CLI login was detected. Run composio login or switch the backend to AUTO/SDK.'
        : 'Composio CLI is not installed. Install it or switch the backend to AUTO/SDK.');
    }
  }

  const composio = getComposio();
  if (!composio) throw new Error('COMPOSIO_API_KEY is not configured.');
  const body: Record<string, unknown> = {
    userId,
    arguments: args,
    dangerouslySkipVersionCheck: true,
  };
  if (connectedAccountId) body.connectedAccountId = connectedAccountId;
  return (composio as any).tools.execute(toolSlug, body);
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

  const connectionsBySlug = new Map<string, ConnectedToolkit[]>();
  for (const connection of connected) {
    const list = connectionsBySlug.get(connection.slug) ?? [];
    list.push(connection);
    connectionsBySlug.set(connection.slug, list);
  }

  const catalogBySlug = new Map(catalog.map((toolkit) => [toolkit.slug, toolkit]));
  const orphanSlugs = [...connectionsBySlug.keys()].filter((slug) => !catalogBySlug.has(slug));
  const toConnectionView = (connection: ConnectedToolkit) => ({
    id: connection.connectionId,
    status: connection.status,
    alias: connection.alias ?? null,
    accountLabel: connection.accountLabel ?? null,
    accountEmail: connection.accountEmail ?? null,
    accountName: connection.accountName ?? null,
    accountAvatarUrl: connection.accountAvatarUrl ?? null,
    createdAt: connection.createdAt ?? null,
  });

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
      connections: (connectionsBySlug.get(toolkit.slug) ?? []).map(toConnectionView),
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
      connections: (connectionsBySlug.get(slug) ?? []).map(toConnectionView),
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
    connected,
    toolkits,
    featured,
    totalCount: toolkits.length,
    catalogError,
  };
}
