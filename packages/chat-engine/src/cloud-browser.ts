/** Portable first-party browser view contract. Secrets and live URLs are never persisted here. */
export interface CloudBrowserResource {
  id: string; conversationId: string; provider: 'browserbase'; providerSessionId: string | null; projectId: string;
  state: 'starting' | 'active' | 'stopping' | 'stopped' | 'expired' | 'uncertain'; controller: 'agent' | 'human';
  controlVersion: number; createdAt: string; updatedAt: string; recording: boolean; elapsedSeconds: number;
  pages: Array<{ targetId: string; title: string; url: string }>; errorCode?: string; returnPending?: boolean;
}
export interface CloudBrowserStatus { configured: boolean; projectId?: string; idleSeconds?: number; sessionTimeoutSeconds?: number }
export interface CloudBrowserView { url: string; expiresAt: string; targetId?: string; viewerLeaseId: string; controlVersion: number }
export interface CloudBrowserInputResponse { resource: CloudBrowserResource; result: { ok: boolean }; receipt: unknown }
type BrowserRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export function readBrowserResource(value: unknown, conversationId: string, id?: string): CloudBrowserResource {
  const row = value as Partial<CloudBrowserResource> | null;
  if (!row || typeof row.id !== 'string' || !row.id || (id !== undefined && row.id !== id)
    || row.conversationId !== conversationId || row.provider !== 'browserbase'
    || (row.providerSessionId !== null && typeof row.providerSessionId !== 'string') || typeof row.projectId !== 'string'
    || !['starting', 'active', 'stopping', 'stopped', 'expired', 'uncertain'].includes(row.state ?? '')
    || !['human', 'agent'].includes(row.controller ?? '') || !Number.isInteger(row.controlVersion) || (row.controlVersion ?? -1) < 0
    || typeof row.createdAt !== 'string' || typeof row.updatedAt !== 'string' || typeof row.recording !== 'boolean'
    || typeof row.elapsedSeconds !== 'number' || !Number.isFinite(row.elapsedSeconds) || row.elapsedSeconds < 0 || (row.returnPending !== undefined && typeof row.returnPending !== 'boolean')
    || (row.pages !== undefined && (!Array.isArray(row.pages) || row.pages.some((page) => !page || typeof page.targetId !== 'string' || !page.targetId || typeof page.title !== 'string' || typeof page.url !== 'string')))) {
    throw new Error('The browser response was not confirmed for this conversation. Refresh its status.');
  }
  return { ...row, pages: row.pages ?? [] } as CloudBrowserResource;
}

export function createCloudBrowserClient(request: BrowserRequest, base: string) {
  const post = <T>(path: string, body: unknown) => request<T>(`${base}${path}`, { method: 'POST', body: JSON.stringify(body) });
  const query = (conversationId: string) => `?conversationId=${encodeURIComponent(conversationId)}`;
  const resourceResponse = (result: { resource: unknown }, conversationId: string, id?: string) => ({ resource: readBrowserResource(result.resource, conversationId, id) });
  return {
    status: () => request<CloudBrowserStatus>(`${base}/status`),
    configure: (apiKey: string, projectId: string) => post<CloudBrowserStatus>('/configuration', { apiKey, projectId }),
    list: (conversationId: string) => request<{ resources: unknown[] }>(`${base}/resources${query(conversationId)}`).then((result) => ({ resources: result.resources.map((item) => readBrowserResource(item, conversationId)) })),
    start: (conversationId: string, requestId: string, recording: boolean) => post<{ resource: unknown }>('/resources', { conversationId, requestId, recording }).then((result) => resourceResponse(result, conversationId)),
    read: (resource: CloudBrowserResource) => request<{ resource: unknown }>(`${base}/resources/${encodeURIComponent(resource.id)}${query(resource.conversationId)}`).then((result) => resourceResponse(result, resource.conversationId, resource.id)),
    view: (resource: CloudBrowserResource, targetId: string | undefined, viewerLeaseId: string) => post<CloudBrowserView>(`/resources/${encodeURIComponent(resource.id)}/view`, { conversationId: resource.conversationId, expectedVersion: resource.controlVersion, viewerLeaseId, ...(targetId ? { targetId } : {}) }),
    control: (resource: CloudBrowserResource, controller: 'human' | 'agent') => post<{ resource: unknown }>(`/resources/${encodeURIComponent(resource.id)}/control`, { conversationId: resource.conversationId, expectedVersion: resource.controlVersion, controller }).then((result) => resourceResponse(result, resource.conversationId, resource.id)),
    input: (resource: CloudBrowserResource, targetId: string, viewerLeaseId: string, input: { text: string } | { key: string }) => post<CloudBrowserInputResponse>(`/resources/${encodeURIComponent(resource.id)}/input`, { conversationId: resource.conversationId, expectedVersion: resource.controlVersion, targetId, viewerLeaseId, ...input }).then((result) => ({ ...result, resource: readBrowserResource(result.resource, resource.conversationId, resource.id) })),
    stop: (resource: CloudBrowserResource) => post<{ resource: unknown }>(`/resources/${encodeURIComponent(resource.id)}/stop`, { conversationId: resource.conversationId, expectedVersion: resource.controlVersion }).then((result) => resourceResponse(result, resource.conversationId, resource.id)),
    touch: (resource: CloudBrowserResource) => post<{ resource: unknown }>(`/resources/${encodeURIComponent(resource.id)}/touch`, { conversationId: resource.conversationId, expectedVersion: resource.controlVersion }).then((result) => resourceResponse(result, resource.conversationId, resource.id)),
    recover: (resource: CloudBrowserResource, providerSessionId: string) => post<{ resource: unknown }>(`/resources/${encodeURIComponent(resource.id)}/recover`, { conversationId: resource.conversationId, expectedVersion: resource.controlVersion, providerSessionId }).then((result) => resourceResponse(result, resource.conversationId, resource.id)),
    detach: (resource: CloudBrowserResource, viewerLeaseId: string) => request<{ resource: unknown }>(`${base}/resources/${encodeURIComponent(resource.id)}/detach`, { method: 'POST', keepalive: true, body: JSON.stringify({ conversationId: resource.conversationId, viewerLeaseId }) }).then((result) => resourceResponse(result, resource.conversationId, resource.id)),
  };
}
export type CloudBrowserClient = ReturnType<typeof createCloudBrowserClient>;

/** Track every minted view, including a late response that was never embedded.
 * A failed detach stays owed; callers may explicitly retry closing that lease. */
export function createBrowserViewerLeases(client: Pick<CloudBrowserClient, 'detach'>) {
  const leases = new Map<string, { resource: CloudBrowserResource; pending?: Promise<CloudBrowserResource> }>();
  const detach = (viewerLeaseId: string): Promise<CloudBrowserResource | null> => {
    const lease = leases.get(viewerLeaseId);
    if (!lease) return Promise.resolve(null);
    if (lease.pending) return lease.pending;
    const pending = client.detach(lease.resource, viewerLeaseId).then(({ resource }) => { leases.delete(viewerLeaseId); return resource; }).catch((error: unknown) => { lease.pending = undefined; throw error; });
    lease.pending = pending; return pending;
  };
  return {
    remember(resource: CloudBrowserResource, view: Pick<CloudBrowserView, 'viewerLeaseId'>) {
      if (typeof view.viewerLeaseId !== 'string' || !view.viewerLeaseId) throw new Error('The browser view lease was not confirmed.');
      leases.set(view.viewerLeaseId, { resource });
    },
    detach,
    async detachAll(resource: CloudBrowserResource): Promise<CloudBrowserResource> {
      let freshest = resource;
      for (const [id, lease] of leases) {
        if (lease.resource.conversationId !== resource.conversationId || lease.resource.id !== resource.id) continue;
        const next = await detach(id);
        if (next && next.controlVersion >= freshest.controlVersion) freshest = next;
      }
      return freshest;
    },
  };
}

export function browserResourceKey(resource: CloudBrowserResource): string {
  return JSON.stringify([resource.conversationId, resource.id, resource.controlVersion, resource.controller, resource.state, resource.returnPending === true]);
}
export function canApplyBrowserResponse(current: CloudBrowserResource | null, requested: CloudBrowserResource, next: CloudBrowserResource): boolean {
  return current !== null && browserResourceKey(current) === browserResourceKey(requested)
    && next.conversationId === current.conversationId && next.id === current.id
    && Number.isInteger(next.controlVersion) && next.controlVersion >= current.controlVersion;
}
export function canApplyBrowserControlResponse(current: CloudBrowserResource | null, requested: CloudBrowserResource, next: CloudBrowserResource, controller: 'human' | 'agent'): boolean {
  return canApplyBrowserResponse(current, requested, next) && next.state === 'active'
    && (next.controller === controller || (controller === 'agent' && next.controller === 'human' && next.returnPending === true))
    && next.controlVersion > requested.controlVersion;
}
export function browserInputAllowed(resource: CloudBrowserResource, targetId: string): boolean {
  return resource.state === 'active' && resource.controller === 'human' && !resource.returnPending && resource.pages.some((page) => page.targetId === targetId);
}
export function canStartBrowserInTask(resources: CloudBrowserResource[]): boolean {
  return resources.every((resource) => resource.state === 'stopped' || resource.state === 'expired');
}
export function browserBoundInputAllowed(resource: CloudBrowserResource, targetId: string, view: CloudBrowserView | null): boolean {
  return browserInputAllowed(resource, targetId) && view?.targetId === targetId
    && view.controlVersion === resource.controlVersion && browserLiveUrl(view.url) !== null && Date.parse(view.expiresAt) > Date.now();
}
export function browserLiveUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['www.browserbase.com', 'browserbase.com'].includes(url.hostname) && !url.port
      && !url.username && !url.password && !url.hash ? url.href : null;
  } catch { return null; }
}
export function isBrowserDisconnected(event: Pick<MessageEvent, 'origin' | 'source' | 'data'>, frame: Window | null, liveUrl: string): boolean {
  const safe = browserLiveUrl(liveUrl);
  return safe !== null && frame !== null && event.source === frame && event.origin === new URL(safe).origin
    && (event.data === 'browserbase-disconnected' || event.data?.type === 'browserbase-disconnected');
}
export function browserElapsed(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
export function browserStopMessage(resource: CloudBrowserResource): string {
  return resource.state === 'stopped' ? 'Browser stopped.' : resource.state === 'expired' ? 'Browser ended.'
    : resource.state === 'uncertain' ? 'Stopping was not confirmed. Refresh before trying again.'
    : 'Stop requested. Waiting for the provider to confirm it ended.';
}
