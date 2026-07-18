import { api, apiGet, apiPost } from './api';
import { getAuthToken } from './bootstrap';

/** Shapes here are intentionally loose — several daemon payloads are
 *  internal snapshots; we read fields defensively and degrade gracefully. */

export interface ComposioStatus { connected?: boolean; configured?: boolean; enabled?: boolean; apiKeyPresent?: boolean; userId?: string; [k: string]: unknown }

export interface ComposioConnection {
  id?: string;
  connectionId?: string;
  status?: string;
  providerStatus?: string;
  usable?: boolean;
  needsReconnect?: boolean;
  suppressionReason?: string | null;
  accountEmail?: string | null;
  accountName?: string | null;
  /** The user's memory label for this account ("work", "personal"), from
   *  account-alias-store — what the agent uses to route the right mailbox. */
  userLabel?: string | null;
  createdAt?: string;
}
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
export type ToolkitStatus = 'active' | 'reconnect' | 'expired' | 'none';
export function toolkitStatus(t: ComposioToolkit): ToolkitStatus {
  const connections = t.connections ?? [];
  // A toolkit is healthy when at least one account is explicitly usable. Keep
  // compatibility with older snapshots that only carried status=ACTIVE.
  if (connections.some((c) => c.usable === true)) return 'active';
  if (connections.some((c) => c.needsReconnect === true)) return 'reconnect';
  const statuses = connections.map((c) => (c.status ?? '').toUpperCase());
  if (connections.some((c) => c.usable !== false && c.needsReconnect !== true && (c.status ?? '').toUpperCase() === 'ACTIVE')) return 'active';
  if (statuses.includes('NEEDS_RECONNECT')) return 'reconnect';
  if (statuses.some((s) => s === 'EXPIRED' || s === 'INACTIVE' || s === 'INITIATED')) return 'expired';
  return 'none';
}

/** Apps the user has actually connected via Composio (active or needs-reconnect). */
export function connectedToolkits(snap?: ComposioSnapshot): ComposioToolkit[] {
  const list = (snap?.toolkits ?? []).filter((t) => toolkitStatus(t) !== 'none');
  return list.sort((a, b) => {
    const order = (t: ComposioToolkit) => {
      const status = toolkitStatus(t);
      return status === 'active' ? 0 : status === 'reconnect' ? 1 : 2;
    };
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
export interface McpServer { slug?: string; name?: string; status?: string; enabled?: boolean; state?: string; failureCount?: number; lastError?: string; declaredEnvKeys?: string[]; unsetEnvKeys?: string[]; [k: string]: unknown }
export interface CliRow { command?: string; path?: string; isLikelyCli?: boolean; version?: string; helpHead?: string; [k: string]: unknown }

export const getComposioStatus = () => apiGet<ComposioStatus>('/api/composio/status');
export const getComposioToolkits = () => apiGet<ComposioSnapshot>('/api/composio/toolkits');
export const authorizeComposio = (slug: string) =>
  apiPost<{ url?: string; redirectUrl?: string }>(`/api/composio/toolkits/${encodeURIComponent(slug)}/authorize`);
// Reset the daemon's cached Composio client so the next status/toolkits read is fresh.
export const refreshComposio = () => apiPost<{ ok: boolean }>('/api/composio/refresh');
// Disconnect a connected app (deletes the connected account). Needs the connection id.
export const disconnectComposio = (slug: string, connectionId: string) =>
  apiPost<{ ok: boolean }>(`/api/composio/toolkits/${encodeURIComponent(slug)}/disconnect`, { connectionId });

// Set (or clear, with an empty label) the user's memory label for one connected
// account. Passing the account email binds the label to the stable mailbox so it
// survives re-auth; the agent then routes "send from my <label> mailbox" correctly.
export const setAccountLabel = (connectionId: string, body: { toolkit: string; label: string; email?: string | null }) =>
  apiPost<{ ok: boolean; label: string | null }>(
    `/api/composio/accounts/${encodeURIComponent(connectionId)}/label`,
    { toolkit: body.toolkit, label: body.label, email: body.email ?? undefined },
  );

// Save/validate the Composio API key in-app (the value is copied from composio.dev).
// The route validates against Composio before persisting, so a bad key is rejected.
export const setComposioApiKey = (apiKey: string, userId?: string) =>
  apiPost<{ ok?: boolean; error?: string; validation?: string; warning?: string }>(
    '/api/composio/api-key',
    { api_key: apiKey, ...(userId ? { user_id: userId } : {}) },
  );

export interface ComposioAuthorization { url?: string; redirectUrl?: string }
export interface ComposioReconnectResult extends ComposioAuthorization { staleRemoved: boolean }

/** Replace a known-bad account before opening the normal authorization flow.
 * Some legacy entity-owned records cannot be deleted; authorization still
 * proceeds because Composio can add a usable account for the current user. */
export async function reconnectComposio(
  slug: string,
  connectionId: string | undefined,
  actions: {
    disconnect: typeof disconnectComposio;
    authorize: typeof authorizeComposio;
  } = { disconnect: disconnectComposio, authorize: authorizeComposio },
): Promise<ComposioReconnectResult> {
  let staleRemoved = false;
  if (connectionId) {
    try {
      await actions.disconnect(slug, connectionId);
      staleRemoved = true;
    } catch {
      // A replacement connection is still useful even if Composio retains the
      // inaccessible legacy record in its project history.
    }
  }
  return { ...await actions.authorize(slug), staleRemoved };
}

/** The connection id to act on — the ACTIVE one if present, else the first. */
export function activeConnectionId(t: ComposioToolkit): string | undefined {
  const conns = t.connections ?? [];
  const usable = conns.find((c) => c.usable === true && (c.status ?? '').toUpperCase() === 'ACTIVE');
  const legacyActive = conns.find((c) => c.usable !== false && c.needsReconnect !== true && (c.status ?? '').toUpperCase() === 'ACTIVE');
  const selected = usable ?? legacyActive ?? conns.find((c) => c.needsReconnect !== true) ?? conns[0];
  return selected?.id ?? selected?.connectionId;
}

/** The stale account Reconnect should replace before starting a fresh OAuth flow. */
export function reconnectConnectionId(t: ComposioToolkit): string | undefined {
  const conns = t.connections ?? [];
  const selected = conns.find((c) => c.needsReconnect === true)
    ?? conns.find((c) => /NEEDS_RECONNECT|EXPIRED|INACTIVE|FAILED|REVOKED/.test((c.status ?? '').toUpperCase()));
  return selected?.id ?? selected?.connectionId;
}

/** Codex/OpenAI auth snapshot (getAuthStatus on the daemon). codexOauthPresent
 *  is true when the managed OAuth sign-in (access + refresh) is in place. */
export interface AuthStatusLite { mode?: string; configured?: boolean; codexOauthPresent?: boolean; openaiApiKeyPresent?: boolean; [k: string]: unknown }
/** Secrets that are MANAGED by the Codex sign-in flow — never user-pasted. */
export const CODEX_MANAGED_SECRETS = new Set(['codex_oauth_access_token', 'codex_oauth_refresh_token']);

export const getCredentials = () =>
  apiGet<{ rows?: unknown; descriptors?: Record<string, CredentialDescriptor>; discordAllowedUsers?: string; slackAllowedUsers?: string; auth?: AuthStatusLite }>('/api/console/credentials');

// ─── Codex re-auth — the SAME proven daemon endpoints the legacy console uses ──
// Local: opens a browser + loopback callback on the daemon (desktop only).
export const codexReauthLocal = () =>
  apiPost<{ ok?: boolean; message?: string; error?: string }>('/api/console/auth/codex-login');
// Remote: device-code flow — works from any device / over the tunnel.
export interface CodexDeviceBegin { loginId?: string; verificationUri?: string; userCode?: string; intervalSeconds?: number; expiresAt?: string; error?: string; message?: string }
export const codexDeviceBegin = () =>
  apiPost<CodexDeviceBegin>('/api/console/auth/codex-device/begin');
export const codexDevicePoll = (loginId: string) =>
  apiPost<{ status?: 'complete' | 'pending' | 'expired'; message?: string; error?: string }>('/api/console/auth/codex-device/poll', { loginId });
export const setDiscordOwner = (ownerId: string) =>
  apiPost<{ ok: boolean; discordAllowedUsers?: string; appliesOnRestart?: boolean }>('/api/console/credentials/discord-owner', { ownerId });
export const setSlackOwner = (ownerId: string) =>
  apiPost<{ ok: boolean; slackAllowedUsers?: string; appliesOnRestart?: boolean }>('/api/console/credentials/slack-owner', { ownerId });
export interface SlackStatus {
  enabled?: boolean; connected?: boolean; listening?: boolean;
  botUserId?: string; teamName?: string; startedAt?: string; manifest?: string;
}
export const getSlackStatus = () => apiGet<SlackStatus>('/api/console/slack/status');
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
// Human-only credential entry for an MCP server's declared env key. The value is
// written to the daemon env + the server reconnects. Never echoed back.
export const setMcpCredential = (name: string, key: string, value: string) =>
  apiPost(`/api/console/mcp-servers/${encodeURIComponent(name)}/credential`, { key, value });
export const getClis = () => apiGet<{ clis?: CliRow[]; cliCount?: number; detectedCount?: number }>('/api/console/clis');
// User-saved CLIs the user explicitly told Clementine they use.
export const getSavedClis = () => apiGet<{ saved: string[] }>('/api/console/clis/saved');
export const saveCli = (command: string) => apiPost<{ saved: string[] }>('/api/console/clis/saved', { command });
export const removeSavedCli = (command: string) =>
  api<{ saved: string[] }>(`/api/console/clis/saved?command=${encodeURIComponent(command)}`, { method: 'DELETE' });
// Live probe a single bare name (resolves even probe-skipped CLIs like sf).
export const probeCli = (command: string) => apiGet<CliRow>(`/api/console/clis/probe?command=${encodeURIComponent(command)}`);

// ─── Managed CLIs (auto-discovered: GitHub + Composio, with install/auth) ──
export interface ManagedCliStatus {
  installed: boolean;
  path: string | null;
  version: string | null;
  authenticated: boolean;
  authStatus: string;          // 'ok' | 'missing' | 'invalid' | 'error' | 'unknown'
  authMessage: string | null;
  username?: string | null;    // GitHub only
}
export interface ManagedClisResp {
  github: ManagedCliStatus;
  composio: { cli: ManagedCliStatus; enabled?: boolean; apiKeyPresent?: boolean; userId?: string };
}
export type ManagedCliKind = 'github' | 'composio';
export type ManagedCliAction = 'install' | 'auth' | 'repair';
export interface ManagedCliJob {
  id: string; kind: string; action: string; title: string; command: string;
  status: 'running' | 'succeeded' | 'failed'; output: string; exitCode?: number | null;
}
export const getManagedClis = () => apiGet<ManagedClisResp>('/api/console/managed-clis');
export const startManagedCliJob = (kind: ManagedCliKind, action: ManagedCliAction) =>
  apiPost<{ job: ManagedCliJob }>(`/api/console/managed-clis/${kind}/${action}`);
export const getManagedCliJob = (id: string) =>
  apiGet<{ job: ManagedCliJob }>(`/api/console/managed-cli-jobs/${encodeURIComponent(id)}`);

// ─── CLI catalog (curated installable tools w/ install + auth metadata) ──
export interface CatalogEntry {
  id: string; name: string; command: string; vendor: string; description: string; tags: string[];
  installCommand: string; installSource: string; authDocsUrl: string; authCommand?: string; homepage?: string;
  installed?: boolean; resolvedPath?: string; score?: number;
}
export interface ConnectedCli {
  id: string; command: string; vendor: string; name: string; installedAt: string; authDocsUrl: string; authCommand?: string;
}
export interface CatalogResp { query: string; results: CatalogEntry[]; connected: Record<string, ConnectedCli>; autoPromoted: string[] }
export interface InstallJob { id: string; title: string; status: 'running' | 'succeeded' | 'failed'; output: string; exitCode?: number | null }

export const getCliCatalog = (q?: string) =>
  apiGet<CatalogResp>(`/api/console/cli-catalog${q ? `?q=${encodeURIComponent(q)}` : ''}`);
export const installCatalogCli = (id: string) =>
  apiPost<{ job: InstallJob; entry: CatalogEntry }>('/api/console/cli-catalog/install', { id });
export const forgetCatalogCli = (id: string) => apiPost<{ ok: boolean }>('/api/console/cli-catalog/forget', { id });
export const reconnectCatalogCli = (id: string) => apiPost('/api/console/cli-catalog/reconnect', { id });
export const getInstallJob = (id: string) => apiGet<{ job: InstallJob }>(`/api/console/install-jobs/${encodeURIComponent(id)}`);

// ─── Browser harness (browser-use) — drive the user's real Chrome ────────
export interface BrowserHarnessPrereq { name: string; available: boolean; path?: string; version?: string }
export interface BrowserHarnessStatus {
  installed: boolean; commandPath?: string; version?: string; installDir: string;
  repoPresent: boolean; codexSkillLinked: boolean;
  prerequisites: BrowserHarnessPrereq[];
  browserUseCloudKeyPresent: boolean; chromeSetupUrl: string; docsUrl: string; installCommand: string;
}
export interface BrowserHarnessCommandResult { ok: boolean; command: string; code: number | null; output: string }
export const getBrowserHarness = () => apiGet<BrowserHarnessStatus>('/api/console/browser-harness');
export const installBrowserHarness = () => apiPost<{ job: InstallJob }>('/api/console/browser-harness/install', {});
export const getBrowserHarnessInstallJob = (id: string) =>
  apiGet<{ job: InstallJob }>(`/api/console/browser-harness/install/${encodeURIComponent(id)}`);
export const browserHarnessDoctor = () => apiPost<BrowserHarnessCommandResult>('/api/console/browser-harness/doctor', {});
export const browserHarnessTest = () => apiPost<BrowserHarnessCommandResult>('/api/console/browser-harness/test', {});
export const browserHarnessChromeSetup = () => apiPost<BrowserHarnessCommandResult>('/api/console/browser-harness/open-chrome-setup', {});

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

/**
 * One-tap setup. Idempotent and resumable server-side, which is what lets the
 * whole error UI be a single "Try again" that calls this again.
 */
export const setupMobileAccess = () =>
  apiPost<{ ok: boolean; view: MobileSetupView; failure?: MobileSetupFailure }>(
    '/api/console/mobile-access/setup',
  );

export interface MobileSetupFailure {
  code: string;
  message: string;
  remedy: { label: string; action: 'retry' | 'install-brew' | 'open-url' | 'copy-command'; url?: string; command?: string };
}

export interface MobileSetupView {
  phase: 'not-set-up' | 'installing' | 'connecting' | 'live' | 'error';
  headline: string;
  detail?: string;
  url?: string;
  qrReady: boolean;
  progressLines?: string[];
  failure?: MobileSetupFailure;
  devices: Array<{ deviceId: string; deviceLabel?: string; lastSeenAt: string; pushSubscribed: boolean }>;
  advanced: {
    mode: 'quick' | 'named' | 'none';
    hostname?: string;
    permanentAvailable: boolean;
    cloudflareAccess: 'enforcing' | 'not-enforcing' | 'unknown';
  };
}
export const installMobileCloudflared = () =>
  apiPost<{ job: { id: string; status: string } }>('/api/console/mobile-access/install');
export const startMobileCloudflareLogin = () =>
  apiPost<{ login: Record<string, unknown> }>('/api/console/mobile-access/login');
export const cancelMobileCloudflareLogin = () =>
  apiPost<{ ok: boolean }>('/api/console/mobile-access/login/cancel');
export const configureMobileTunnel = (input: { tunnelName: string; hostname: string }) =>
  apiPost<{ ok: boolean; state: Record<string, unknown> }>('/api/console/mobile-access/configure', input);
export const startMobileTunnel = () =>
  apiPost<{ ok: boolean; error?: string }>('/api/console/mobile-access/tunnel/start');
export const stopMobileTunnel = () =>
  apiPost<{ ok: boolean }>('/api/console/mobile-access/tunnel/stop');
export const confirmMobileCloudflareAccess = () =>
  apiPost<{ ok: boolean; cloudflareAccess: Record<string, unknown> | null }>('/api/console/mobile-access/access-ack', { enabled: true });
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
