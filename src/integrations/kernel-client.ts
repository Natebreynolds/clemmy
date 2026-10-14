/**
 * Kernel cloud browser API client, speaking the same session contract the
 * cloud browser service already drives for Browserbase: create, retrieve,
 * release, live view, running list, a saved profile. The service owns
 * reservations, control and settlement; this client verifies identities and
 * never retries. API: docs.onkernel.com/api-reference/browsers (POST /browsers,
 * GET and DELETE /browsers/{id}, GET /browsers?status=active) and
 * /profiles. The owner's API key is read per request, never retained.
 */
import {
  BrowserbaseClientError,
  CLEM_SESSION_METADATA,
  type BrowserbaseRunningSession,
  type BrowserbaseSession,
} from './browserbase-client.js';

const API_ORIGIN = 'https://api.onkernel.com';
const MAX_RESPONSE_BYTES = 512 * 1024;
/** Kernel scopes a key to an organization; a project is optional. The
 *  service keeps a project label on every session so the ledger reads the
 *  same for both providers; this is what an unscoped key carries. */
export const KERNEL_DEFAULT_PROJECT = 'default';
const LIVE_VIEW_HOSTS = /^([a-z0-9-]+\.)*(onkernel\.com|kernel\.sh)$/i;

function identity(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value); }
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function date(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) throw new BrowserbaseClientError('invalid_response', true);
  return value;
}
function requireIdentity(value: unknown): asserts value is string {
  if (!identity(value)) throw new BrowserbaseClientError('invalid_request', false);
}
function providerRefusal(status: number): BrowserbaseClientError {
  const refusedBeforeEffect = status >= 400 && status < 500 && status !== 408;
  const code = status === 401 || status === 403 ? 'credential_rejected'
    : status === 402 || status === 429 ? 'provider_limit'
      : 'provider_refused';
  return new BrowserbaseClientError(code, !refusedBeforeEffect, status);
}

/** The CDP endpoint Kernel minted for this session: a secure websocket on
 *  Kernel's own hosts, nothing else. */
export function kernelConnectUrlFor(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'wss:' || !LIVE_VIEW_HOSTS.test(url.hostname) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

/** The live view page Kernel minted for this session, on Kernel's own hosts. */
export function kernelLiveViewUrlFor(value: unknown, mode: 'watch' | 'human' = 'human'): string | null {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !LIVE_VIEW_HOSTS.test(url.hostname) || url.username || url.password || url.hash) return null;
    if (mode === 'watch') url.searchParams.set('readOnly', 'true');
    return url.href;
  } catch { return null; }
}

async function boundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw new BrowserbaseClientError('invalid_response', true);
  if (response.status === 204 || !response.body) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let length = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new BrowserbaseClientError('invalid_response', true);
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text.trim() ? JSON.parse(text) : undefined;
  } catch (error) {
    if (error instanceof BrowserbaseClientError) throw error;
    throw new BrowserbaseClientError('invalid_response', true);
  }
}

interface KernelBrowserRow {
  session_id: string;
  cdp_ws_url?: string;
  browser_live_view_url?: string;
  created_at?: string;
  deleted_at?: string;
  timeout_seconds?: number;
  tags?: Record<string, unknown>;
}

function parseBrowser(value: unknown, projectId: string, sessionId?: string, requireConnect = false): BrowserbaseSession & { liveViewUrl?: string; startedByClem: boolean } {
  const row = object(value) as KernelBrowserRow | undefined;
  if (!row || !identity(row.session_id)) throw new BrowserbaseClientError('invalid_response', true);
  if (sessionId !== undefined && row.session_id !== sessionId) throw new BrowserbaseClientError('identity_mismatch', true);
  const connection = row.cdp_ws_url === undefined || row.cdp_ws_url === null ? undefined : kernelConnectUrlFor(row.cdp_ws_url);
  if (row.cdp_ws_url !== undefined && row.cdp_ws_url !== null && !connection) throw new BrowserbaseClientError('invalid_response', true);
  if (requireConnect && !connection) throw new BrowserbaseClientError('invalid_response', true);
  const liveView = row.browser_live_view_url === undefined || row.browser_live_view_url === null ? undefined : kernelLiveViewUrlFor(row.browser_live_view_url);
  const createdAt = date(row.created_at);
  const deleted = typeof row.deleted_at === 'string' && row.deleted_at.length > 0;
  return {
    sessionId: row.session_id,
    projectId,
    status: deleted ? 'COMPLETED' : 'RUNNING',
    ...(connection ? { connectUrl: connection } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(liveView ? { liveViewUrl: liveView } : {}),
    startedByClem: object(row.tags)?.createdBy === CLEM_SESSION_METADATA.createdBy,
  };
}

export class KernelApiClient {
  private readonly getApiKey: () => Promise<string | undefined>;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  /** Live view URLs seen per session, for the view the service asks for later. */
  private readonly liveViews = new Map<string, string>();

  constructor(dependencies: { getApiKey: () => Promise<string | undefined>; fetcher?: typeof fetch; timeoutMs?: number; now?: () => number }) {
    this.getApiKey = dependencies.getApiKey;
    this.fetcher = dependencies.fetcher ?? fetch;
    this.timeoutMs = dependencies.timeoutMs ?? 20_000;
    this.now = dependencies.now ?? Date.now;
  }

  private async request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: Record<string, unknown>): Promise<unknown> {
    const key = (await this.getApiKey())?.trim();
    if (!key) throw new BrowserbaseClientError('not_configured', false);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const deadline = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(new BrowserbaseClientError('timeout', true)), { once: true });
    });
    const url = `${API_ORIGIN}${path}`;
    let dispatched = false;
    try {
      dispatched = true;
      const response = await Promise.race([this.fetcher(url, {
        method, signal: controller.signal, redirect: 'manual',
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) }), deadline]);
      if (response.redirected || (response.status >= 300 && response.status < 400) || (response.url && response.url !== url)) throw new BrowserbaseClientError('redirect_refused', true);
      if (!response.ok) throw providerRefusal(response.status);
      return await Promise.race([boundedJson(response), deadline]);
    } catch (error) {
      if (error instanceof BrowserbaseClientError) throw error;
      // Never retain a raw fetch/provider/credential error or its cause.
      throw new BrowserbaseClientError(controller.signal.aborted ? 'timeout' : dispatched ? 'transport_failed' : 'not_configured', dispatched);
    } finally { clearTimeout(timer); controller.abort(); }
  }

  /** A headful browser (the live view needs one), tagged as Clem's, with the
   *  saved profile when one exists, saving its sign-ins back on close. */
  async create(input: { projectId: string; recording?: boolean; timeoutSeconds?: number; contextId?: string }): Promise<BrowserbaseSession & { connectUrl: string }> {
    requireIdentity(input.projectId);
    if (input.contextId !== undefined) requireIdentity(input.contextId);
    const timeout = input.timeoutSeconds ?? 900;
    if (!Number.isInteger(timeout) || timeout < 10 || timeout > 259_200 || (input.recording !== undefined && typeof input.recording !== 'boolean')) throw new BrowserbaseClientError('invalid_request', false);
    const result = await this.request('POST', '/browsers', {
      headless: false, stealth: false, timeout_seconds: timeout,
      ...(input.contextId ? { profile: { id: input.contextId, save_changes: true } } : {}),
      tags: { ...CLEM_SESSION_METADATA, ...(input.projectId !== KERNEL_DEFAULT_PROJECT ? { project: input.projectId } : {}) },
    });
    const session = parseBrowser(result, input.projectId, undefined, true);
    if (session.liveViewUrl) this.liveViews.set(session.sessionId, session.liveViewUrl);
    const { liveViewUrl: _liveViewUrl, startedByClem: _startedByClem, ...rest } = session;
    return rest as BrowserbaseSession & { connectUrl: string };
  }

  async retrieve(sessionId: string, projectId: string): Promise<BrowserbaseSession> {
    requireIdentity(sessionId); requireIdentity(projectId);
    let result: unknown;
    try { result = await this.request('GET', `/browsers/${encodeURIComponent(sessionId)}`); }
    catch (error) {
      // A deleted browser is gone, not an error: the session ended.
      if (error instanceof BrowserbaseClientError && error.httpStatus === 404) return { sessionId, projectId, status: 'COMPLETED' };
      throw error;
    }
    const session = parseBrowser(result, projectId, sessionId);
    if (session.liveViewUrl) this.liveViews.set(sessionId, session.liveViewUrl);
    const { liveViewUrl: _liveViewUrl, startedByClem: _startedByClem, ...rest } = session;
    return rest;
  }

  async release(sessionId: string, projectId: string): Promise<void> {
    requireIdentity(sessionId); requireIdentity(projectId);
    try { await this.request('DELETE', `/browsers/${encodeURIComponent(sessionId)}`); }
    catch (error) {
      if (error instanceof BrowserbaseClientError && error.httpStatus === 404) return;
      if (error instanceof BrowserbaseClientError) throw new BrowserbaseClientError(error.code, false, error.httpStatus);
      throw new BrowserbaseClientError('transport_failed', false);
    }
    this.liveViews.delete(sessionId);
  }

  /** Kernel's live view is one page for the whole browser: the owner sees
   *  and, unless the view is read-only, drives every tab. A page target is
   *  echoed so the service's binding holds; it does not narrow the view. */
  async liveView(sessionId: string, options: { expiresIn?: number; targetId?: string; mode?: 'watch' | 'human' } = {}): Promise<{ url: string; expiresAt: string; targetId?: string }> {
    requireIdentity(sessionId);
    if (options.targetId !== undefined) requireIdentity(options.targetId);
    const expiresIn = options.expiresIn ?? 60;
    if (!Number.isInteger(expiresIn) || expiresIn < 60 || expiresIn > 21600) throw new BrowserbaseClientError('invalid_request', false);
    const requestedAt = this.now();
    let known = this.liveViews.get(sessionId);
    if (!known) {
      const row = parseBrowser(await this.request('GET', `/browsers/${encodeURIComponent(sessionId)}`), KERNEL_DEFAULT_PROJECT, sessionId);
      if (row.liveViewUrl) { known = row.liveViewUrl; this.liveViews.set(sessionId, known); }
    }
    const url = known ? kernelLiveViewUrlFor(known, options.mode ?? 'human') : null;
    if (!url) throw new BrowserbaseClientError('invalid_response', true);
    return { url, expiresAt: new Date(requestedAt + expiresIn * 1000).toISOString(),
      ...(options.targetId !== undefined ? { targetId: options.targetId } : {}) };
  }

  /** Every active browser the key can see, each marked by whether Clem started it. */
  async listRunning(projectId: string): Promise<BrowserbaseRunningSession[]> {
    requireIdentity(projectId);
    const result = await this.request('GET', '/browsers?status=active&limit=100');
    const rows = Array.isArray(result) ? result : (object(result)?.items as unknown);
    if (!Array.isArray(rows) || rows.length > 500) throw new BrowserbaseClientError('invalid_response', false);
    return rows.flatMap((row) => {
      const record = object(row);
      if (!record) return [];
      const session = parseBrowser({ ...record, cdp_ws_url: undefined }, projectId);
      const { liveViewUrl: _liveViewUrl, ...rest } = session;
      return [rest];
    });
  }

  /** The saved sign-in profile Clem's browsers share, created once. */
  async createContext(projectId: string): Promise<string> {
    requireIdentity(projectId);
    const name = `clem-${this.now().toString(36)}`;
    const id = object(await this.request('POST', '/profiles', { name }))?.id;
    if (!identity(id)) throw new BrowserbaseClientError('invalid_response', true);
    return id;
  }

  /** The key is checked by the cheapest read the organization allows. */
  async verifyProject(projectId: string): Promise<void> {
    requireIdentity(projectId);
    await this.request('GET', '/browsers?status=active&limit=1');
  }
}
