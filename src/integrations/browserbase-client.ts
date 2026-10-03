/** Private Browserbase REST boundary. No credentials or live URLs belong in
 * tool results, general events, or provider error messages. Callers own the
 * exact task/account/session binding; this client verifies provider identities.
 * API contracts: docs.browserbase.com/reference/api/{create-a-session,
 * get-a-session,update-a-session,session-live-urls}. No automatic retry. */
export type BrowserbaseSessionStatus = 'PENDING' | 'RUNNING' | 'ERROR' | 'TIMED_OUT' | 'COMPLETED';
export interface BrowserbaseSession {
  sessionId: string;
  projectId: string;
  status: BrowserbaseSessionStatus;
  /** Optional on GET, including terminal sessions; required on create. */
  connectUrl?: string;
  createdAt?: string;
  expiresAt?: string;
}
export type BrowserbaseClientErrorCode = 'invalid_request' | 'not_configured' | 'timeout' | 'transport_failed'
  | 'redirect_refused' | 'provider_refused' | 'invalid_response' | 'identity_mismatch';
export class BrowserbaseClientError extends Error {
  readonly code: BrowserbaseClientErrorCode;
  readonly dispatched: boolean;
  readonly httpStatus?: number;
  constructor(code: BrowserbaseClientErrorCode, dispatched: boolean, httpStatus?: number) {
    super(`Browserbase request failed (${code}).`);
    this.name = 'BrowserbaseClientError';
    this.code = code;
    this.dispatched = dispatched;
    this.httpStatus = httpStatus;
  }
}

const API_ORIGIN = 'https://api.browserbase.com';
const MAX_RESPONSE_BYTES = 512 * 1024;
const STATUSES = new Set<BrowserbaseSessionStatus>(['PENDING', 'RUNNING', 'ERROR', 'TIMED_OUT', 'COMPLETED']);
const TERMINAL_STATUSES = new Set<BrowserbaseSessionStatus>(['ERROR', 'TIMED_OUT', 'COMPLETED']);
function identity(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function requireIdentity(value: unknown): asserts value is string {
  if (!identity(value)) throw new BrowserbaseClientError('invalid_request', false);
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function date(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) throw new BrowserbaseClientError('invalid_response', true);
  return value;
}
function connectUrl(value: unknown, sessionId: string): string {
  try {
    if (typeof value !== 'string' || value.length > 16384) throw new Error();
    const url = new URL(value);
    if (url.protocol !== 'wss:' || url.hostname !== 'connect.browserbase.com' || (url.port && url.port !== '443')
      || url.username || url.password || url.hash || url.pathname !== '/'
      || url.searchParams.getAll('sessionId').length !== 1 || url.searchParams.get('sessionId') !== sessionId) throw new Error();
    return url.href;
  } catch { throw new BrowserbaseClientError('invalid_response', true); }
}
function parseSession(value: unknown, projectId: string, sessionId?: string, requireConnect = false): BrowserbaseSession {
  const row = object(value);
  if (!row || !identity(row.id) || !identity(row.projectId)) throw new BrowserbaseClientError('invalid_response', true);
  if (row.projectId !== projectId || (sessionId !== undefined && row.id !== sessionId)) throw new BrowserbaseClientError('identity_mismatch', true);
  if (!STATUSES.has(row.status as BrowserbaseSessionStatus)) throw new BrowserbaseClientError('invalid_response', true);
  const connection = row.connectUrl === undefined || row.connectUrl === null
    ? undefined : connectUrl(row.connectUrl, row.id);
  if (requireConnect && !connection) throw new BrowserbaseClientError('invalid_response', true);
  const createdAt = date(row.createdAt);
  const expiresAt = date(row.expiresAt);
  return { sessionId: row.id, projectId: row.projectId, status: row.status as BrowserbaseSessionStatus,
    ...(connection ? { connectUrl: connection } : {}), ...(createdAt ? { createdAt } : {}), ...(expiresAt ? { expiresAt } : {}) };
}

async function boundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw new BrowserbaseClientError('invalid_response', true);
  if (!response.body) throw new BrowserbaseClientError('invalid_response', true);
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
    return JSON.parse(text);
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof BrowserbaseClientError) throw error;
    throw new BrowserbaseClientError('invalid_response', true);
  } finally { reader.releaseLock(); }
}

export class BrowserbaseApiClient {
  private readonly getApiKey: () => Promise<string | undefined>;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  constructor(options: { getApiKey: () => Promise<string | undefined>; fetch?: typeof fetch; timeoutMs?: number; now?: () => number }) {
    this.getApiKey = options.getApiKey;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60000) throw new BrowserbaseClientError('invalid_request', false);
  }

  private async request(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<unknown> {
    let dispatched = false;
    const controller = new AbortController();
    let timer!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new BrowserbaseClientError('timeout', dispatched)); }, this.timeoutMs);
    });
    try {
      const key = await Promise.race([Promise.resolve().then(this.getApiKey), deadline]);
      if (!key || typeof key !== 'string' || key.length > 8192 || /[\r\n]/.test(key)) throw new BrowserbaseClientError('not_configured', false);
      const headers = new Headers({ 'X-BB-API-Key': key, Accept: 'application/json' });
      if (body) headers.set('Content-Type', 'application/json');
      if (controller.signal.aborted) throw new BrowserbaseClientError('timeout', false);
      const url = `${API_ORIGIN}${path}`;
      dispatched = true;
      const response = await Promise.race([this.fetcher(url, { method, headers, redirect: 'manual', signal: controller.signal,
        ...(body ? { body: JSON.stringify(body) } : {}) }), deadline]);
      if (response.redirected || (response.status >= 300 && response.status < 400) || (response.url && response.url !== url)) throw new BrowserbaseClientError('redirect_refused', true);
      if (!response.ok) throw new BrowserbaseClientError('provider_refused', true, response.status);
      return await Promise.race([boundedJson(response), deadline]);
    } catch (error) {
      if (error instanceof BrowserbaseClientError) throw error;
      // Never retain a raw fetch/provider/credential error or its cause.
      throw new BrowserbaseClientError(controller.signal.aborted ? 'timeout' : dispatched ? 'transport_failed' : 'not_configured', dispatched);
    } finally { clearTimeout(timer); controller.abort(); }
  }

  async create(input: { projectId: string; recording?: boolean; timeoutSeconds?: number }): Promise<BrowserbaseSession & { connectUrl: string }> {
    requireIdentity(input.projectId);
    const timeout = input.timeoutSeconds ?? 900;
    if (!Number.isInteger(timeout) || timeout < 60 || timeout > 21600 || (input.recording !== undefined && typeof input.recording !== 'boolean')) throw new BrowserbaseClientError('invalid_request', false);
    const result = await this.request('POST', '/v1/sessions', { projectId: input.projectId, keepAlive: true, timeout,
      browserSettings: { logSession: false, recordSession: input.recording ?? false } });
    return parseSession(result, input.projectId, undefined, true) as BrowserbaseSession & { connectUrl: string };
  }

  async retrieve(sessionId: string, projectId: string): Promise<BrowserbaseSession> {
    requireIdentity(sessionId); requireIdentity(projectId);
    return parseSession(await this.request('GET', `/v1/sessions/${sessionId}`), projectId, sessionId);
  }

  /** Requests release, not independent proof that the remote browser ended. */
  async release(sessionId: string, projectId: string): Promise<void> {
    let current: BrowserbaseSession;
    try { current = await this.retrieve(sessionId, projectId); }
    catch (error) {
      // The prerequisite GET may have crossed, but this release POST has not.
      // Preserve the nominal refusal and avoid inventing an unknown write.
      if (error instanceof BrowserbaseClientError) throw new BrowserbaseClientError(error.code, false, error.httpStatus);
      throw new BrowserbaseClientError('transport_failed', false);
    }
    if (TERMINAL_STATUSES.has(current.status)) return;
    parseSession(await this.request('POST', `/v1/sessions/${sessionId}`, { status: 'REQUEST_RELEASE' }), projectId, sessionId);
  }

  /** Private viewer capability: mint only after the service authenticates the
   * session's owner. The provider response has no independent expiry field. */
  async liveView(sessionId: string, options: { expiresIn?: number; targetId?: string } = {}): Promise<{ url: string; expiresAt: string; targetId?: string }> {
    requireIdentity(sessionId);
    if (options.targetId !== undefined) requireIdentity(options.targetId);
    const expiresIn = options.expiresIn ?? 60;
    if (!Number.isInteger(expiresIn) || expiresIn < 60 || expiresIn > 21600) throw new BrowserbaseClientError('invalid_request', false);
    const requestedAt = this.now();
    const row = object(await this.request('GET', `/v1/sessions/${sessionId}/debug?expiresIn=${expiresIn}`));
    let viewer: unknown = row?.debuggerFullscreenUrl;
    if (options.targetId !== undefined) {
      // The service must independently observe this CDP target in this exact
      // session. Join only an equal provider page id, never its URL/title/order.
      const matches = Array.isArray(row?.pages)
        ? row.pages.map(object).filter(page => page?.id === options.targetId) : [];
      if (matches.length !== 1) throw new BrowserbaseClientError('identity_mismatch', true);
      viewer = matches[0]?.debuggerFullscreenUrl;
    }
    try {
      if (!row || typeof viewer !== 'string' || viewer.length > 16384) throw new Error();
      const url = new URL(viewer);
      if (url.protocol !== 'https:' || !['www.browserbase.com', 'browserbase.com'].includes(url.hostname)
        || (url.port && url.port !== '443') || url.username || url.password || url.hash) throw new Error();
      return { url: url.href, expiresAt: new Date(requestedAt + expiresIn * 1000).toISOString(),
        ...(options.targetId !== undefined ? { targetId: options.targetId } : {}) };
    } catch { throw new BrowserbaseClientError('invalid_response', true); }
  }
}
