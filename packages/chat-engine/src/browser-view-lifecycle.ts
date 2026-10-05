import { browserLiveUrl, browserResourceKey, type CloudBrowserClient, type CloudBrowserResource, type CloudBrowserView, createBrowserViewerLeases } from './cloud-browser.js';

export type BrowserBoundView = CloudBrowserView & { key: string };
export type BrowserViewIssue = 'connection' | 'binding' | 'cleanup';
export type BrowserViewTrigger = 'initial' | 'expiry' | 'expired_disconnect' | 'disconnect' | 'mint_failure' | 'stop';
export interface BrowserViewDiagnostic {
  at: number;
  event: 'mint_requested' | 'mint_accepted' | 'mint_failed' | 'frame_removed' | 'detach_acknowledged'
    | 'cleanup_complete' | 'cleanup_failed' | 'expired' | 'disconnected' | 'reconnect_scheduled' | 'blocked' | 'stopped';
  trigger: BrowserViewTrigger;
  resourceId: string | null;
  viewerLeaseId: string | null;
  controlVersion: number;
  targetId: string | null;
  expiresAt: number | null;
  reconnectCount: number;
  status: number | null;
  errorCode: string | null;
  effect: 'none' | 'uncertain' | null;
  detachAcknowledged: boolean | null;
  issue: BrowserViewIssue | null;
}
// Never serialize an error, resource, response, URL, or message into a trace.
// Unknown service codes remain unknown rather than carrying arbitrary text.
const diagnosticErrorCodes = new Set([
  'invalid_request', 'not_configured', 'timeout', 'transport_failed', 'redirect_refused', 'provider_refused',
  'invalid_response', 'identity_mismatch', 'credential_rejected', 'provider_limit', 'project_not_found',
  'configuration_missing', 'credential_missing', 'credential_changed', 'credential_unavailable',
  'browser_service_unavailable', 'connection_unavailable', 'control_return_pending', 'control_version_changed',
  'invalid_viewer_lease', 'invalid_viewer_target', 'operation_in_flight', 'provider_identity_changed',
  'release_pending', 'resource_effect_uncertain', 'resource_not_found', 'resource_not_ready',
  'resource_store_conflict', 'resource_store_invalid', 'resource_store_unavailable', 'resource_unavailable',
  'target_identity_changed', 'viewer_binding_required', 'viewer_lease_detached', 'viewer_request_conflict',
  'viewer_target_unavailable', 'viewer_request_timeout',
]);
const diagnosticIdentity = (value: unknown): string | null => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value) ? value : null;
function diagnosticError(error: unknown) {
  const record = error && typeof error === 'object' ? error as { status?: unknown; body?: unknown; code?: unknown } : {};
  const body = record.body && typeof record.body === 'object' ? record.body as { code?: unknown; effect?: unknown } : {};
  const code = body.code ?? record.code;
  return {
    status: typeof record.status === 'number' && Number.isInteger(record.status)
      && (record.status === 0 || (record.status >= 100 && record.status <= 599)) ? record.status : null,
    errorCode: typeof code === 'string' && diagnosticErrorCodes.has(code) ? code : null,
    effect: body.effect === 'none' || body.effect === 'uncertain' ? body.effect : null,
  } as const;
}
export interface BrowserViewClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(timer: unknown): void;
}
const realClock: BrowserViewClock = {
  now: Date.now,
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** A view follows one exact task, control epoch and page. The caller's retry
 * counter may be included in key, but ordinary status polling must not be. */
export function browserViewTarget(resource: CloudBrowserResource, chosen?: string): string | undefined {
  return chosen || resource.focusTargetId || resource.pages[0]?.targetId;
}

/** One mounted viewer's lifecycle, shared by React and Preact. It never starts
 * a browser, changes control or repeats a browser action. Each capability is
 * reserved before minting and its iframe is removed before detach is sent.
 * Cleanup failures stay in the caller's existing owed-lease tracker. */
export function startBrowserViewLifecycle(options: {
  resource: CloudBrowserResource;
  targetId?: string;
  key: string;
  client: Pick<CloudBrowserClient, 'view'>;
  leases: ReturnType<typeof createBrowserViewerLeases>;
  uuid(): string;
  /** Must read current render state, not a closure captured at mount. */
  isCurrent(): boolean;
  isBusy(): boolean;
  show(view: BrowserBoundView): void;
  /** Resolves only once this lease's iframe is no longer in the DOM. */
  remove(viewerLeaseId: string): Promise<void>;
  issue(issue: BrowserViewIssue): void;
  /** Safe fixed-field trace. Defaults to the renderer console; never includes capabilities. */
  diagnostic?(entry: BrowserViewDiagnostic): void;
  clock?: BrowserViewClock;
}) {
  const clock = options.clock ?? realClock;
  const resource = options.resource;
  const targetId = browserViewTarget(resource, options.targetId);
  const resourceKey = browserResourceKey(resource);
  let alive = true;
  let connecting = false;
  let waiting = false;
  let blocked = false;
  let reconnects = 0;
  let trigger: BrowserViewTrigger = 'initial';
  let timer: unknown;
  let view: BrowserBoundView | null = null;
  const owned = new Set<string>();
  const expiries = new Map<string, number>();
  const removals = new Map<string, Promise<boolean>>();
  const current = () => alive && options.isCurrent() && resource.state === 'active' && !resource.returnPending;
  const clearTimer = () => { if (timer !== undefined) clock.clearTimeout(timer); timer = undefined; };
  const diagnostic = (event: BrowserViewDiagnostic['event'], cause: BrowserViewTrigger, id?: string,
    error?: unknown, issue: BrowserViewIssue | null = null) => {
    const entry: BrowserViewDiagnostic = {
      at: clock.now(), event, trigger: cause, resourceId: diagnosticIdentity(resource.id), viewerLeaseId: diagnosticIdentity(id),
      controlVersion: resource.controlVersion, targetId: diagnosticIdentity(targetId), expiresAt: id ? expiries.get(id) ?? null : null,
      reconnectCount: reconnects, ...diagnosticError(error), issue,
      detachAcknowledged: event === 'detach_acknowledged' ? true : event === 'cleanup_failed' ? false : null,
    };
    try {
      if (options.diagnostic) options.diagnostic(entry);
      else console.info('[cloud-browser-view]', JSON.stringify(entry));
    } catch { /* Observability cannot change lease/control authority. */ }
  };
  const report = (issue: BrowserViewIssue, cause: BrowserViewTrigger, id?: string, error?: unknown) => {
    blocked = true; waiting = false; diagnostic('blocked', cause, id, error, issue); if (current()) options.issue(issue);
  };
  const bounded = async <T>(promise: Promise<T>): Promise<T> => {
    let timeout: unknown;
    try {
      return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
        timeout = clock.setTimeout(() => reject(Object.assign(new Error('viewer_request_timeout'), { code: 'viewer_request_timeout' })), 60_000);
      })]);
    } finally { if (timeout !== undefined) clock.clearTimeout(timeout); }
  };
  const retire = (id: string, cause: BrowserViewTrigger, removed = false): Promise<boolean> => {
    const existing = removals.get(id);
    if (existing) return existing;
    const removal = (async () => {
      try {
        if (!removed) { await options.remove(id); diagnostic('frame_removed', cause, id); }
        await bounded(options.leases.detach(id));
        diagnostic('detach_acknowledged', cause, id);
        owned.delete(id);
        return true;
      } catch (error) { diagnostic('cleanup_failed', cause, id, error); report('cleanup', cause, id, error); return false; }
      finally { removals.delete(id); }
    })();
    removals.set(id, removal);
    return removal;
  };
  const scheduleReconnect = (cause: BrowserViewTrigger, id?: string, error?: unknown) => {
    if (!current()) return;
    const status = (error as { status?: number } | undefined)?.status;
    // Auth, identity/control conflicts and rate limits need fresh state or an
    // explicit retry, not another request against the same binding.
    if (reconnects >= 1 || (status !== undefined && status >= 400 && status < 500)) { report('connection', cause, id, error); return; }
    reconnects++;
    trigger = cause;
    diagnostic('reconnect_scheduled', cause, id, error);
    timer = clock.setTimeout(() => { timer = undefined; waiting = true; void connect(); }, 1000);
  };
  const retireView = async (cause: BrowserViewTrigger): Promise<boolean> => {
    clearTimer();
    const previous = view; view = null;
    return previous ? retire(previous.viewerLeaseId, cause) : true;
  };
  const expireView = (cause: 'expiry' | 'expired_disconnect') => {
    clearTimer();
    const expired = view; view = null;
    if (!expired) return;
    trigger = cause;
    diagnostic('expired', cause, expired.viewerLeaseId);
    // Remove immediately, but retain an input-bound lease until its in-flight
    // request settles. connect() acknowledges all owed leases before minting.
    void options.remove(expired.viewerLeaseId).then(async () => {
      diagnostic('frame_removed', cause, expired.viewerLeaseId);
      if (!current()) return;
      waiting = true;
      if (!options.isBusy() && await retire(expired.viewerLeaseId, cause, true)) void connect();
    }).catch((error) => { diagnostic('cleanup_failed', cause, expired.viewerLeaseId, error); report('cleanup', cause, expired.viewerLeaseId, error); });
  };
  async function connect(): Promise<void> {
    if (!current() || blocked || connecting || view) return;
    if (options.isBusy()) { waiting = true; return; }
    waiting = false; connecting = true;
    const cause = trigger;
    let id: string | undefined;
    try {
      // A previous render may still owe cleanup. Never accumulate new human
      // leases after a failed detach, or mint against an epoch detach advanced.
      let fresh: CloudBrowserResource;
      try {
        fresh = await bounded(options.leases.detachAll(resource));
        for (const previous of owned) { diagnostic('detach_acknowledged', cause, previous); }
        owned.clear();
        expiries.clear();
        diagnostic('cleanup_complete', cause);
      } catch (error) { diagnostic('cleanup_failed', cause, undefined, error); report('cleanup', cause, undefined, error); return; }
      if (!current()) return;
      if (browserResourceKey(fresh) !== resourceKey) { report('binding', cause); return; }
      if (options.isBusy()) { waiting = true; return; }
      id = options.uuid(); owned.add(id);
      options.leases.remember(resource, { viewerLeaseId: id });
      diagnostic('mint_requested', cause, id);
      const result = await bounded(options.client.view(resource, targetId, id));
      if (!current() || options.isBusy()) {
        waiting = current();
        await retire(id, cause);
        return;
      }
      const url = browserLiveUrl(result.url);
      const expiresAt = Date.parse(result.expiresAt);
      if (!url || result.viewerLeaseId !== id || result.controlVersion !== resource.controlVersion
        || !Number.isFinite(expiresAt) || expiresAt - clock.now() < 1000
        || (targetId !== undefined && result.targetId !== targetId)) {
        await retire(id, cause); report('binding', cause, id); return;
      }
      expiries.set(id, expiresAt);
      diagnostic('mint_accepted', cause, id);
      view = { ...result, key: options.key, url };
      options.show(view);
      timer = clock.setTimeout(() => expireView('expiry'), expiresAt - clock.now());
    } catch (error) {
      diagnostic('mint_failed', cause, id, error);
      if (id && !await retire(id, 'mint_failure')) return;
      scheduleReconnect('mint_failure', id, error);
    } finally {
      connecting = false;
      if (waiting && current() && !options.isBusy() && !blocked && timer === undefined) void connect();
    }
  }
  void connect();
  return {
    /** Busy input keeps its bound lease; only renewing/minting is paused. */
    resume() { if (waiting && timer === undefined) void connect(); },
    disconnected(viewerLeaseId: string) {
      if (!current() || view?.viewerLeaseId !== viewerLeaseId) return;
      diagnostic('disconnected', 'disconnect', viewerLeaseId);
      // Message events and overdue timers may run in either order. A known
      // expired capability follows renewal even when its disconnect wins.
      if (clock.now() >= Date.parse(view.expiresAt)) { expireView('expired_disconnect'); return; }
      void retireView('disconnect').then((removed) => { if (removed) scheduleReconnect('disconnect', viewerLeaseId); });
    },
    /** Invalidates in-flight replies synchronously, before any control call. */
    stop() {
      alive = false; waiting = false; clearTimer(); view = null;
      diagnostic('stopped', 'stop');
      return Promise.all([...owned].map((id) => retire(id, 'stop'))).then(() => undefined);
    },
  };
}

export type BrowserViewLifecycle = ReturnType<typeof startBrowserViewLifecycle>;
