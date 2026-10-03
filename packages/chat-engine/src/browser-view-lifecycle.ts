import { browserLiveUrl, browserResourceKey, type CloudBrowserClient, type CloudBrowserResource, type CloudBrowserView, createBrowserViewerLeases } from './cloud-browser.js';

export type BrowserBoundView = CloudBrowserView & { key: string };
export type BrowserViewIssue = 'connection' | 'binding' | 'cleanup';
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
  let timer: unknown;
  let view: BrowserBoundView | null = null;
  const owned = new Set<string>();
  const removals = new Map<string, Promise<boolean>>();
  const current = () => alive && options.isCurrent() && resource.state === 'active' && !resource.returnPending;
  const clearTimer = () => { if (timer !== undefined) clock.clearTimeout(timer); timer = undefined; };
  const report = (issue: BrowserViewIssue) => { blocked = true; waiting = false; if (current()) options.issue(issue); };
  const bounded = async <T>(promise: Promise<T>): Promise<T> => {
    let timeout: unknown;
    try {
      return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
        timeout = clock.setTimeout(() => reject(new Error('viewer_request_timeout')), 60_000);
      })]);
    } finally { if (timeout !== undefined) clock.clearTimeout(timeout); }
  };
  const retire = (id: string, removed = false): Promise<boolean> => {
    const existing = removals.get(id);
    if (existing) return existing;
    const removal = (async () => {
      try {
        if (!removed) await options.remove(id);
        await bounded(options.leases.detach(id));
        owned.delete(id);
        return true;
      } catch { report('cleanup'); return false; }
      finally { removals.delete(id); }
    })();
    removals.set(id, removal);
    return removal;
  };
  const scheduleReconnect = (error?: unknown) => {
    if (!current()) return;
    const status = (error as { status?: number } | undefined)?.status;
    // Auth, identity/control conflicts and rate limits need fresh state or an
    // explicit retry, not another request against the same binding.
    if (reconnects >= 1 || (status !== undefined && status >= 400 && status < 500)) { report('connection'); return; }
    reconnects++;
    timer = clock.setTimeout(() => { timer = undefined; waiting = true; void connect(); }, 1000);
  };
  const retireView = async (): Promise<boolean> => {
    clearTimer();
    const previous = view; view = null;
    return previous ? retire(previous.viewerLeaseId) : true;
  };
  async function connect(): Promise<void> {
    if (!current() || blocked || connecting || view) return;
    if (options.isBusy()) { waiting = true; return; }
    waiting = false; connecting = true;
    let id: string | undefined;
    try {
      // A previous render may still owe cleanup. Never accumulate new human
      // leases after a failed detach, or mint against an epoch detach advanced.
      let fresh: CloudBrowserResource;
      try { fresh = await bounded(options.leases.detachAll(resource)); }
      catch { report('cleanup'); return; }
      if (!current()) return;
      if (browserResourceKey(fresh) !== resourceKey) { report('binding'); return; }
      if (options.isBusy()) { waiting = true; return; }
      id = options.uuid(); owned.add(id);
      options.leases.remember(resource, { viewerLeaseId: id });
      const result = await bounded(options.client.view(resource, targetId, id));
      if (!current() || options.isBusy()) {
        waiting = current();
        await retire(id);
        return;
      }
      const url = browserLiveUrl(result.url);
      const expiresAt = Date.parse(result.expiresAt);
      if (!url || result.viewerLeaseId !== id || result.controlVersion !== resource.controlVersion
        || !Number.isFinite(expiresAt) || expiresAt - clock.now() < 1000
        || (targetId !== undefined && result.targetId !== targetId)) {
        await retire(id); report('binding'); return;
      }
      view = { ...result, key: options.key, url };
      options.show(view);
      timer = clock.setTimeout(() => {
        timer = undefined;
        const expired = view; view = null;
        if (!expired) return;
        // Expiry removes the interactive frame immediately. A text/key request
        // may still be reaching the server: retain its lease until busy ends,
        // then connect() closes all owed leases before minting the replacement.
        void options.remove(expired.viewerLeaseId).then(async () => {
          if (!current()) return;
          waiting = true;
          if (!options.isBusy() && await retire(expired.viewerLeaseId, true)) void connect();
        }).catch(() => report('cleanup'));
      }, expiresAt - clock.now());
    } catch (error) {
      if (id && !await retire(id)) return;
      scheduleReconnect(error);
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
      void retireView().then((removed) => { if (removed) scheduleReconnect(); });
    },
    /** Invalidates in-flight replies synchronously, before any control call. */
    stop() {
      alive = false; waiting = false; clearTimer(); view = null;
      return Promise.all([...owned].map((id) => retire(id))).then(() => undefined);
    },
  };
}

export type BrowserViewLifecycle = ReturnType<typeof startBrowserViewLifecycle>;
