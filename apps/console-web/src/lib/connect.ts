import { api, apiGet, apiPost } from './api';
import { getAuthToken } from './bootstrap';

/** Shapes here are intentionally loose — several daemon payloads are
 *  internal snapshots; we read fields defensively and degrade gracefully. */

export interface ComposioStatus { connected?: boolean; configured?: boolean; enabled?: boolean; apiKeyPresent?: boolean; userId?: string; [k: string]: unknown }

export interface ComposioConnection { id?: string; status?: string; accountEmail?: string | null; createdAt?: string }
export interface ComposioToolkit {
  slug: string;
  displayName?: string;
  logoUrl?: string;
  description?: string;
  toolCount?: number;
  connections?: ComposioConnection[];
}
export interface ComposioSnapshot {
  enabled?: boolean;
  apiKeyPresent?: boolean;
  connected?: Array<{ slug: string; status?: string }>;
  toolkits?: ComposioToolkit[];
  featured?: string[];
  catalogError?: string | null;
}

/** One toolkit's connection state, collapsing its connection history. */
export type ToolkitStatus = 'active' | 'expired' | 'none';
export function toolkitStatus(t: ComposioToolkit): ToolkitStatus {
  const statuses = (t.connections ?? []).map((c) => (c.status ?? '').toUpperCase());
  if (statuses.includes('ACTIVE')) return 'active';
  if (statuses.some((s) => s === 'EXPIRED' || s === 'INACTIVE' || s === 'INITIATED')) return 'expired';
  return 'none';
}

/** Apps the user has actually connected via Composio (active or needs-reconnect). */
export function connectedToolkits(snap?: ComposioSnapshot): ComposioToolkit[] {
  const list = (snap?.toolkits ?? []).filter((t) => toolkitStatus(t) !== 'none');
  return list.sort((a, b) => {
    const order = (t: ComposioToolkit) => (toolkitStatus(t) === 'active' ? 0 : 1);
    return order(a) - order(b) || (a.displayName || a.slug).localeCompare(b.displayName || b.slug);
  });
}

/** Catalog search (over the full toolkit list) for connecting something new. */
export function searchToolkits(snap: ComposioSnapshot | undefined, q: string, limit = 24): ComposioToolkit[] {
  const query = q.trim().toLowerCase();
  if (!query) return [];
  return (snap?.toolkits ?? [])
    .filter((t) => `${t.slug} ${t.displayName ?? ''}`.toLowerCase().includes(query))
    .slice(0, limit);
}
// SecretHealthRow shape (src/runtime/secrets/types.ts): the per-secret status is
// `status` ('connected'|'env_only'|'missing'|'unreadable') + `hasValue`; the
// `required`/`description` metadata lives in the separate `descriptors` map.
export interface CredentialRow { name?: string; status?: string; hasValue?: boolean; source?: string; [k: string]: unknown }
export interface CredentialDescriptor { required?: boolean; description?: string; setupHint?: string; label?: string; [k: string]: unknown }
export interface McpServer { slug?: string; name?: string; status?: string; enabled?: boolean; [k: string]: unknown }
export interface CliRow { command?: string; path?: string; isLikelyCli?: boolean; version?: string; helpHead?: string; [k: string]: unknown }

export const getComposioStatus = () => apiGet<ComposioStatus>('/api/composio/status');
export const getComposioToolkits = () => apiGet<ComposioSnapshot>('/api/composio/toolkits');
export const authorizeComposio = (slug: string) =>
  apiPost<{ url?: string; redirectUrl?: string }>(`/api/composio/toolkits/${encodeURIComponent(slug)}/authorize`);

export const getCredentials = () =>
  apiGet<{ rows?: unknown; descriptors?: Record<string, CredentialDescriptor>; discordAllowedUsers?: string }>('/api/console/credentials');
export const setDiscordOwner = (ownerId: string) =>
  apiPost<{ ok: boolean; discordAllowedUsers?: string; appliesOnRestart?: boolean }>('/api/console/credentials/discord-owner', { ownerId });
export const getMcpServers = () => apiGet<{ servers?: McpServer[] }>('/api/console/mcp-servers');

export interface McpServerInput {
  name: string;
  type: 'stdio' | 'http' | 'sse';
  description?: string;
  command?: string;
  args?: string[];
  url?: string;
}
export const addMcpServer = (body: McpServerInput) => apiPost('/api/console/mcp-servers', body);
export const deleteMcpServer = (name: string) =>
  api(`/api/console/mcp-servers/${encodeURIComponent(name)}`, { method: 'DELETE' });
export const getClis = () => apiGet<{ clis?: CliRow[]; cliCount?: number }>('/api/console/clis');

export interface ProjectInfo { name: string; path: string; type?: string; description?: string; hasClaude?: boolean }
export const getProjects = () => apiGet<{ workspaceDirs?: string[]; projects?: ProjectInfo[] }>('/api/console/projects');

export interface BrowseEntry { name: string; path: string }
export interface BrowseResult { path: string; parent: string | null; home: string; entries: BrowseEntry[] }
export const browseFolders = (dir?: string) =>
  apiGet<BrowseResult>(`/api/console/projects/browse${dir ? `?path=${encodeURIComponent(dir)}` : ''}`);
export const addWorkspace = (path: string) => apiPost('/api/console/projects/workspace', { path });
// The DELETE handler reads ?path= from the query string, not the body.
export const removeWorkspace = (path: string) =>
  api(`/api/console/projects/workspace?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
export const getMobileStatus = () => apiGet<Record<string, unknown>>('/api/console/mobile-access/status');

/** Pull a friendly toolkit list out of whatever shape the snapshot uses. */
export function extractToolkits(snapshot: Record<string, unknown> | undefined): ComposioToolkit[] {
  if (!snapshot) return [];
  for (const key of ['toolkits', 'apps', 'items', 'connections', 'connected']) {
    const v = snapshot[key];
    if (Array.isArray(v)) return v as ComposioToolkit[];
  }
  return [];
}

/** Credential rows can be an array or a name-keyed object. Normalize. */
export function normalizeCredentialRows(rows: unknown): CredentialRow[] {
  if (Array.isArray(rows)) return rows as CredentialRow[];
  if (rows && typeof rows === 'object') {
    return Object.entries(rows as Record<string, unknown>).map(([name, v]) => ({
      name,
      ...(v && typeof v === 'object' ? (v as Record<string, unknown>) : {}),
    }));
  }
  return [];
}

// ─── credentials + mobile actions ───────────────────────────────────
export const setCredential = (name: string, value: string) =>
  apiPost('/api/console/credentials/set', { name, value });

export const startQuickTunnel = () =>
  apiPost<{ ok: boolean; url?: string; error?: string }>('/api/console/mobile-access/quick/start');
export const setMobilePin = (pin: string) =>
  apiPost<{ ok: boolean }>('/api/console/mobile-access/pin', { pin });
export const revokeAllMobileSessions = () =>
  api<{ ok: boolean; removed: number }>('/api/console/mobile-access/sessions', { method: 'DELETE' });

/** Same-origin src for the QR endpoint (adds ?token= in dev). */
export function qrSrc(): string {
  const t = getAuthToken();
  const base = '/api/console/mobile-access/qr';
  return t ? `${base}?token=${encodeURIComponent(t)}` : base;
}

export function isConnected(row: { connected?: boolean; configured?: boolean; status?: string; hasValue?: boolean }): boolean {
  if (row.hasValue === true) return true;                       // secret present (vault or .env)
  if (typeof row.connected === 'boolean') return row.connected;
  if (typeof row.configured === 'boolean') return row.configured;
  const s = (row.status ?? '').toLowerCase();
  if (s === 'connected' || s === 'env_only') return true;      // SecretHealthRow statuses
  return /connect|ready|ok|configured|enabled|active|set/.test(s) && !/missing|needs|not|error|down/.test(s);
}
