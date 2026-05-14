import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Composio } from '@composio/core';
import { BASE_DIR } from '../../config.js';
import { readEnvFile, writeEnvFile } from '../../setup/env-file.js';

const ENV_FILE = path.join(BASE_DIR, '.env');
const CACHE_DIR = path.join(BASE_DIR, 'state');
const CATALOG_CACHE_FILE = path.join(CACHE_DIR, 'composio-catalog-cache.json');
const DEFAULT_USER_ID = 'default';
const CONNECTIONS_TTL_MS = 60_000;
const CATALOG_TTL_MS = 60 * 60_000;
const USER_ID_TTL_MS = 60_000;

export type ToolkitAuthMode = 'managed' | 'byo' | 'none';

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

function readComposioEnv(key: 'COMPOSIO_API_KEY' | 'COMPOSIO_USER_ID'): string {
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
} {
  const apiKey = readComposioEnv('COMPOSIO_API_KEY');
  return {
    enabled: Boolean(apiKey),
    apiKeyPresent: Boolean(apiKey),
    maskedApiKey: apiKey ? maskApiKey(apiKey) : undefined,
    userId: readComposioEnv('COMPOSIO_USER_ID') || DEFAULT_USER_ID,
  };
}

export function saveComposioCredentials(apiKey: string, userId?: string): void {
  const trimmedKey = apiKey.trim();
  if (!trimmedKey) throw new Error('COMPOSIO_API_KEY is required.');

  const env = readEnvFile(ENV_FILE);
  env.COMPOSIO_API_KEY = trimmedKey;
  if (userId !== undefined) {
    const trimmedUserId = userId.trim();
    if (trimmedUserId) {
      env.COMPOSIO_USER_ID = trimmedUserId;
    } else {
      delete env.COMPOSIO_USER_ID;
    }
  }
  writeEnvFile(ENV_FILE, env);
  process.env.COMPOSIO_API_KEY = trimmedKey;
  if (userId !== undefined) {
    if (userId.trim()) process.env.COMPOSIO_USER_ID = userId.trim();
    else delete process.env.COMPOSIO_USER_ID;
  }
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

export async function disconnectToolkit(connectionId: string): Promise<void> {
  const composio = getComposio();
  if (!composio) throw new Error('COMPOSIO_API_KEY is not configured.');
  await (composio as any).connectedAccounts.delete(connectionId);
  connectionsCache = null;
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
  const composio = getComposio();
  if (!composio) throw new Error('COMPOSIO_API_KEY is not configured.');
  const body: Record<string, unknown> = {
    userId: await getPreferredUserId(),
    arguments: args,
    dangerouslySkipVersionCheck: true,
  };
  if (connectedAccountId) body.connectedAccountId = connectedAccountId;
  return (composio as any).tools.execute(toolSlug, body);
}

export async function buildComposioDashboardSnapshot(): Promise<ComposioDashboardSnapshot> {
  const credentials = getComposioCredentialStatus();
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
    connected,
    toolkits,
    featured,
    totalCount: toolkits.length,
    catalogError,
  };
}
