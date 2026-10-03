import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { Link } from 'react-router-dom';
import { Globe, PanelRightClose, RefreshCw, Square, Hand, ArrowRight } from 'lucide-react';
import { browserClosesText, browserElapsed, browserFocusPage, browserLiveUrl, browserResourceKey, browserStopMessage, browsersChipLabel, canApplyBrowserResponse, canApplyBrowserControlResponse, createBrowserViewerLeases, canStartBrowserInTask, isBrowserDisconnected, type CloudBrowserOpenBrowser, type CloudBrowserOverview, type CloudBrowserResource, type CloudBrowserStatus, type CloudBrowserUnlinkedSession, type CloudBrowserView } from '@clem/chat-engine';
import { cloudBrowser } from '@/lib/cloud-browser';
import './cloud-browser.css';

/** A task room beside the conversation: watching never covers steering or approvals. */
export function CloudBrowserWorkspace({ conversationId, children }: { conversationId?: string; children: ReactNode }) {
  return <BrowserWorkspace conversationId={conversationId}>{children}</BrowserWorkspace>;
}
function BrowserWorkspace({ conversationId, children }: { conversationId?: string; children: ReactNode }) {
  const [status, setStatus] = useState<CloudBrowserStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  const [resources, setResources] = useState<CloudBrowserResource[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [recording, setRecording] = useState(false);
  const [recoveryId, setRecoveryId] = useState('');
  const [view, setView] = useState<(CloudBrowserView & { key: string }) | null>(null);
  const [overview, setOverview] = useState<CloudBrowserOverview | null>(null);
  const [viewTick, setViewTick] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const leases = useRef(createBrowserViewerLeases(cloudBrowser));
  const viewGeneration = useRef(0);
  const requestId = useRef<string | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const context = useRef(conversationId); context.current = conversationId;
  const scopedResources = resources.filter((item) => item.conversationId === conversationId);
  const resource = scopedResources.find((item) => item.id === selectedId) ?? scopedResources[0] ?? null;
  const current = useRef(resource); current.current = resource;
  const refresh = useCallback(async () => {
    if (!conversationId) return;
    const version = ++generation.current;
    try {
      const [nextStatus, list] = await Promise.all([cloudBrowser.status(), cloudBrowser.list(conversationId)]);
      const selected = list.resources.find((item) => item.id === current.current?.id) ?? list.resources[0];
      // List is the local index. Only the visible session asks the provider for fresh state.
      const fresh = selected && selected.state !== 'stopped' && selected.state !== 'expired' ? (await cloudBrowser.read(selected)).resource : null;
      if (mounted.current && context.current === conversationId && version === generation.current) { setStatus(nextStatus); setStatusFailed(false); setResources(list.resources.map((item) => fresh?.id === item.id ? fresh : item)); }
    } catch { if (mounted.current && version === generation.current) { setStatusFailed(true); setNotice('Browser status is unavailable. Refresh to reconnect.'); } }
  }, [conversationId]);
  // Every open browser on this Mac, for the chip count and the other-browsers list.
  const loadOverview = useCallback(async () => {
    try { const next = await cloudBrowser.overview(); if (mounted.current) setOverview(next); } catch { /* keep the last list */ }
  }, []);
  useEffect(() => {
    void loadOverview();
    const timer = window.setInterval(() => { if (!document.hidden) void loadOverview(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [loadOverview, conversationId]);
  useEffect(() => {
    mounted.current = true; setResources([]); setSelectedId(null); setView(null); setOpen(false); setBusy(null); setNotice(''); requestId.current = null; void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    return () => { mounted.current = false; generation.current++; window.clearInterval(timer); };
  }, [refresh]);
  const resourceKey = resource ? browserResourceKey(resource) : '';
  // The view follows the page Clem is on, so a new page swaps the live view.
  const viewKey = JSON.stringify([resourceKey, resource?.focusTargetId ?? null, viewTick]);
  useEffect(() => {
    if (!visible || !open || !resource || resource.state !== 'active' || resource.returnPending) return;
    const requested = resource;
    const touch = () => {
      if (document.hidden || !mounted.current || !current.current || browserResourceKey(current.current) !== resourceKey) return;
      void cloudBrowser.touch(requested).catch(() => { if (mounted.current && context.current === requested.conversationId) void refresh(); });
    };
    touch(); const timer = window.setInterval(touch, 20_000);
    return () => window.clearInterval(timer);
  }, [visible, open, resourceKey, refresh]);
  useEffect(() => {
    setView(null);
    const attempt = ++viewGeneration.current;
    if (!visible || !open || !resource || resource.state !== 'active' || resource.returnPending) return;
    let cancelled = false;
    const requested = resource;
    const viewerLeaseId = crypto.randomUUID();
    leases.current.remember(requested, { viewerLeaseId });
    cloudBrowser.view(resource, undefined, viewerLeaseId).then((result) => {
      const url = browserLiveUrl(result.url);
      if (cancelled || attempt !== viewGeneration.current || !mounted.current || !current.current || browserResourceKey(current.current) !== resourceKey) { void leases.current.detach(viewerLeaseId).catch(() => {}); return; }
      if (!url || result.viewerLeaseId !== viewerLeaseId || result.controlVersion !== requested.controlVersion || Date.parse(result.expiresAt) <= Date.now() || !Number.isFinite(Date.parse(result.expiresAt))) { setNotice('The browser view could not be verified. Refresh the view.'); void leases.current.detach(viewerLeaseId).catch(() => {}); return; }
      setView({ ...result, key: viewKey, url });
    }).catch(() => { void leases.current.detach(viewerLeaseId).catch(() => {}); if (!cancelled && mounted.current) setNotice('The live view could not connect. Refresh the view.'); });
    // The render key removes the old frame before this passive cleanup acknowledges it.
    return () => { cancelled = true; void leases.current.detach(viewerLeaseId).catch(() => {}); };
  }, [visible, open, resourceKey, viewKey]);
  useEffect(() => {
    if (!view) return;
    const timer = window.setTimeout(() => { setView(null); setNotice('This view expired. Refresh to keep watching.'); }, Math.max(0, Date.parse(view.expiresAt) - Date.now()));
    const disconnected = (event: MessageEvent) => { if (isBrowserDisconnected(event, frame.current?.contentWindow ?? null, view.url)) { setView(null); setNotice('The browser disconnected. Refresh its status before continuing.'); void refresh(); } };
    window.addEventListener('message', disconnected);
    return () => { window.clearTimeout(timer); window.removeEventListener('message', disconnected); void leases.current.detach(view.viewerLeaseId).catch(() => {}); };
  }, [view, refresh]);
  useEffect(() => {
    const closeViews = () => { const selected = current.current; viewGeneration.current++; flushSync(() => { setVisible(false); setView(null); }); if (selected) void leases.current.detachAll(selected).catch(() => {}); };
    const visibility = () => { if (document.hidden) closeViews(); else { setVisible(true); setViewTick((tick) => tick + 1); void refresh(); } };
    const pageShow = () => { if (!document.hidden) { setVisible(true); setViewTick((tick) => tick + 1); void refresh(); } };
    window.addEventListener('pagehide', closeViews); document.addEventListener('visibilitychange', visibility); window.addEventListener('pageshow', pageShow);
    return () => { window.removeEventListener('pagehide', closeViews); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pageshow', pageShow); };
  }, [refresh]);
  const change = async (kind: 'human' | 'agent' | 'stop') => {
    if (!resource || busy) return;
    const requested = resource;
    setBusy(kind); setNotice(''); viewGeneration.current++; flushSync(() => setView(null));
    generation.current++; // invalidate a read that started before this control request
    try {
      // The local iframe is gone before the server can grant the agent its next epoch.
      let baseline = requested;
      if (kind !== 'stop') { await new Promise<void>((resolve) => { const timer = window.setTimeout(resolve, 50); window.requestAnimationFrame(() => { window.clearTimeout(timer); resolve(); }); }); baseline = await leases.current.detachAll(requested); }
      const alreadyReturned = kind === 'agent' && baseline.controller === 'agent' && !baseline.returnPending;
      const next = alreadyReturned ? baseline : (kind === 'stop' ? await cloudBrowser.stop(baseline) : await cloudBrowser.control(baseline, kind)).resource;
      if (!mounted.current || context.current !== requested.conversationId) return;
      if (kind === 'stop' || alreadyReturned ? canApplyBrowserResponse(current.current, requested, next) : canApplyBrowserControlResponse(current.current, requested, next, kind)) {
        generation.current++; setResources((items) => items.map((item) => item.id === next.id ? next : item));
        setNotice(next.returnPending ? 'Waiting for other open views to close. Clem cannot browse until they acknowledge closure.' : kind === 'agent' ? 'Control returned to Clem. This does not resume a paused task.' : kind === 'stop' ? browserStopMessage(next) : 'You have control. Clem waits for you to return it.');
      } else { setNotice('Browser control changed while this request was in flight. Refreshed its current state.'); await refresh(); }
    } catch (error) {
      if (!mounted.current || context.current !== requested.conversationId) return;
      setNotice((error as { status?: number }).status === 409 ? 'Control changed on another device. Refreshed the browser; choose again.' : 'The change was not confirmed. Refresh before trying again.');
      await refresh();
    } finally { if (mounted.current && context.current === requested.conversationId) { setBusy(null); setViewTick((tick) => tick + 1); void loadOverview(); } }
  };
  // Hand a browser from another chat, or one Clem lost track of, to this
  // chat; Clem gets control so it can work on the page the browser is on.
  const handToThisChat = async (take: () => Promise<CloudBrowserResource>) => {
    if (busy || !conversationId) return;
    setBusy('move'); setNotice(''); generation.current++;
    try {
      let next = await take();
      if (next.state === 'active' && next.controller === 'human') next = (await cloudBrowser.control(next, 'agent')).resource;
      if (!mounted.current || context.current !== conversationId) return;
      generation.current++; setResources((items) => [next, ...items.filter((item) => item.id !== next.id)]); setSelectedId(next.id); setOpen(true);
      setNotice('This browser is in this chat now. Clem can use the page it is on.');
    } catch { if (mounted.current) setNotice('Moving the browser was not confirmed. Refresh the list and try again.'); }
    finally { if (mounted.current) { setBusy(null); void refresh(); void loadOverview(); } }
  };
  const useHere = (browser: CloudBrowserOpenBrowser) => handToThisChat(async () => (await cloudBrowser.move(browser, conversationId!)).resource);
  const adoptHere = (session: CloudBrowserUnlinkedSession) => handToThisChat(async () => (await cloudBrowser.adoptUnlinked(session.providerSessionId, conversationId!)).resource);
  const closeElsewhere = async (close: () => Promise<unknown>) => {
    if (busy) return;
    setBusy('close-other'); setNotice('');
    try { await close(); if (mounted.current) setNotice('Closed that browser.'); }
    catch { if (mounted.current) setNotice('Closing was not confirmed. Refresh the list to check it.'); }
    finally { if (mounted.current) { setBusy(null); void loadOverview(); } }
  };
  const closePendingViews = async () => {
    if (!resource || busy) return;
    const requested = resource;
    setBusy('detach'); setNotice(''); viewGeneration.current++; flushSync(() => setView(null)); generation.current++;
    try {
      const next = await leases.current.detachAll(requested);
      if (!mounted.current || !canApplyBrowserResponse(current.current, requested, next)) return;
      generation.current++; setResources((items) => items.map((item) => item.id === next.id ? next : item));
      setNotice(next.returnPending ? 'This device’s views are closed. Waiting for other open views to acknowledge closure.' : next.controller === 'agent' ? 'Control returned to Clem. This does not resume a paused task.' : 'This device’s views are closed. Refresh to check control.');
    } catch { if (mounted.current) setNotice('This device’s view closure was not confirmed. Retry closing views, or stop the browser.'); }
    finally { if (mounted.current) setBusy(null); }
  };
  const start = async () => {
    if (busy || !status?.configured || !conversationId || !canStartBrowserInTask(scopedResources)) return;
    requestId.current ??= crypto.randomUUID(); // reuse after an uncertain outcome; never auto-retry
    setBusy('start'); setNotice('');
    generation.current++;
    try {
      const { resource: next } = await cloudBrowser.start(conversationId, requestId.current, recording);
      if (!mounted.current || context.current !== conversationId || next.conversationId !== conversationId) return;
      generation.current++; setResources((items) => [next, ...items.filter((item) => item.id !== next.id)]); setSelectedId(next.id); setOpen(true); requestId.current = null;
    } catch { if (mounted.current && context.current === conversationId) { setNotice('Starting the browser was not confirmed. Refresh, or retry the same start request.'); await refresh(); } }
    finally { if (mounted.current && context.current === conversationId) { setBusy(null); void loadOverview(); } }
  };
  const active = resource?.state === 'active';
  const others = (overview?.browsers ?? []).filter((item) => item.conversationId !== conversationId);
  const lost = overview?.unlinked ?? [];
  const openCount = (overview?.browsers.length ?? 0) + lost.length;
  const thisEntry = resource ? overview?.browsers.find((item) => item.id === resource.id) : undefined;
  const now = Date.now();
  const liveView = !resource?.returnPending && view?.key === viewKey ? view : null;
  const recover = async () => {
    if (!resource || busy || !recoveryId.trim()) return; const requested = resource;
    setBusy('recover'); setNotice(''); generation.current++;
    try { const { resource: next } = await cloudBrowser.recover(requested, recoveryId.trim()); if (!mounted.current || context.current !== requested.conversationId) return; if (canApplyBrowserResponse(current.current, requested, next)) { generation.current++; setResources((items) => items.map((item) => item.id === next.id ? next : item)); setRecoveryId(''); setNotice(next.state === 'active' ? 'Browser recovered. You can watch or take control.' : 'Browser identity recovered. Refresh to check its state.'); } else { setNotice('Browser recovery changed while this request was in flight. Refreshed its state.'); await refresh(); } }
    catch { if (mounted.current && context.current === requested.conversationId) { setNotice('Recovery was not confirmed. Check the session ID in your Browserbase project, then refresh.'); await refresh(); } }
    finally { if (mounted.current && context.current === requested.conversationId) setBusy(null); }
  };
  return <div className={`cloud-browser-workspace${open ? ' is-open' : ''}`}>
    <div className="cloud-browser-conversation">
      {conversationId ? <div className="cloud-browser-strip">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}><Globe size={16} aria-hidden />{browsersChipLabel(openCount)}{resource ? <span>{resource.returnPending ? 'Waiting for open views' : active ? resource.controller === 'human' ? 'Your control' : 'Clem has control' : resource.state}</span> : null}</button>
        <span className="cloud-browser-strip-note">{open ? 'Chat and approvals stay here' : resource ? browserElapsed(resource.elapsedSeconds) : 'A browser for this conversation'}</span>
      </div> : null}
      <div className="cloud-browser-thread">{children}</div>
    </div>
    {open ? <aside className="cloud-browser-panel" aria-label="Conversation browser">
      <header><div><h2>Browser</h2><p>{resource ? `${resource.returnPending ? 'Waiting for open views' : active ? resource.controller === 'human' ? 'You have control' : 'Clem has control' : resource.state} · ${browserElapsed(resource.elapsedSeconds)}${resource.recording ? ' · Recording on' : ''}${thisEntry ? ` · ${browserClosesText(thisEntry, now)}` : ''}` : 'Linked to this conversation'}</p></div><button type="button" aria-label="Hide browser, keep it running" onClick={() => setOpen(false)}><PanelRightClose size={18} aria-hidden /></button></header>
      {scopedResources.length > 1 ? <label className="cloud-browser-select">Browser session<select value={resource?.id ?? ''} onChange={(event) => { setSelectedId(event.target.value); setNotice(''); }}>{scopedResources.map((item) => <option key={item.id} value={item.id}>{browserFocusPage(item)?.title || 'Browser'} · {item.state} · {browserElapsed(item.elapsedSeconds)}</option>)}</select></label> : null}
      {!resource ? <div className="cloud-browser-empty"><Globe size={28} aria-hidden /><h3>Make room for the work</h3><p>Clem can browse while you stay in the conversation. Take over when a page needs your attention.</p>{status === null ? <><p>{statusFailed ? 'Connection status unavailable.' : 'Checking connection…'}</p>{statusFailed ? <button type="button" onClick={() => void refresh()}>Retry status</button> : null}</> : !status.configured ? <Link to="/connect">Connect Browserbase</Link> : <><label><input type="checkbox" checked={recording} onChange={(event) => setRecording(event.target.checked)} />Record this browser session</label><button className="cloud-browser-primary" type="button" disabled={busy !== null} onClick={() => void start()}>{busy === 'start' ? 'Starting…' : requestId.current ? 'Retry start' : 'Start browser'}</button><p className="cloud-browser-fine">Cloud usage is billed by your Browserbase account. Recording is off by default.</p></>}</div> : <>
        <div className="cloud-browser-controls"><button type="button" disabled={!active || resource.returnPending || busy !== null} onClick={() => void change(resource.controller === 'human' ? 'agent' : 'human')}>{resource.controller === 'human' ? <ArrowRight size={16} aria-hidden /> : <Hand size={16} aria-hidden />}{busy === 'human' || busy === 'agent' ? 'Changing control…' : resource.controller === 'human' ? 'Return to Clem' : 'Take control'}</button><button type="button" disabled={busy !== null || resource.returnPending} onClick={() => { viewGeneration.current++; flushSync(() => setView(null)); setNotice(''); void refresh(); setViewTick((tick) => tick + 1); }}><RefreshCw size={16} aria-hidden />Watch</button><button type="button" disabled={busy !== null || resource.state === 'stopped' || resource.state === 'expired' || resource.state === 'stopping'} onClick={() => void change('stop')}><Square size={14} aria-hidden />{busy === 'stop' || resource.state === 'stopping' ? 'Stopping…' : 'Stop'}</button></div>
        {status?.configured && canStartBrowserInTask(scopedResources) ? <div className="cloud-browser-new"><label><input type="checkbox" checked={recording} onChange={(event) => setRecording(event.target.checked)} />Record the new session</label><button type="button" disabled={busy !== null} onClick={() => void start()}>{busy === 'start' ? 'Starting…' : 'Start new browser'}</button></div> : null}
        {resource.returnPending ? <button type="button" className="cloud-browser-close-views" disabled={busy !== null} onClick={() => void closePendingViews()}>{busy === 'detach' ? 'Closing views…' : 'Retry closing this device’s views'}</button> : null}
        <div className="cloud-browser-page">{browserFocusPage(resource)?.title || 'Browser session'}<span>{browserFocusPage(resource)?.url || (resource.state === 'starting' ? 'Starting the browser…' : '')}</span></div>
        <div className="cloud-browser-view">{liveView ? <div className="cloud-browser-frame" ref={(element) => { if (element) element.inert = resource.controller !== 'human'; }}><iframe ref={frame} title="Conversation browser live view" src={liveView.url} referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" tabIndex={resource.controller === 'human' ? 0 : -1} style={{ pointerEvents: resource.controller === 'human' ? 'auto' : 'none' }} /></div> : <p>{resource.returnPending ? 'Waiting for other open views to close. Return to Clem is pending; Stop remains available.' : active ? 'Connecting the live view…' : resource.state === 'uncertain' ? 'The browser state needs a fresh check. Refresh before continuing.' : `Browser ${resource.state}.`}</p>}</div>
        {resource.controller === 'agent' && active && !resource.returnPending ? <p className="cloud-browser-fine">Watching only. Take control to interact with the page.</p> : null}
        {resource.state === 'uncertain' && resource.providerSessionId === null ? <details className="cloud-browser-recovery"><summary>Recover a browser that may have started</summary><p>Find the session in your Browserbase project, then enter its session ID. Clem will verify it belongs to this conversation’s project before adopting it.</p><label>Browserbase session ID<input value={recoveryId} onChange={(event) => setRecoveryId(event.target.value)} autoComplete="off" /></label><button type="button" disabled={busy !== null || !recoveryId.trim()} onClick={() => void recover()}>{busy === 'recover' ? 'Checking session…' : 'Recover browser'}</button></details> : null}
      </>}
      {others.length || lost.length ? <section className="cloud-browser-others" aria-label="Other open browsers">
        <h3>Other open browsers</h3>
        <ul>
          {others.map((item) => <li key={item.id}>
            <div><strong>{item.conversationTitle || 'Untitled chat'}</strong><span>{browserFocusPage(item)?.title || browserFocusPage(item)?.url || (item.state === 'active' ? 'Blank page' : item.state)} · {browserClosesText(item, now)}{item.usesProfile ? ' · Signed in' : ''}</span></div>
            <div className="cloud-browser-row-actions">
              <button type="button" disabled={busy !== null || !conversationId || item.state !== 'active'} onClick={() => void useHere(item)}>{busy === 'move' ? 'Moving…' : 'Use in this chat'}</button>
              <Link to={`/chat/${encodeURIComponent(`harness:${item.conversationId}`)}`}>Open chat</Link>
              <button type="button" disabled={busy !== null || item.state === 'stopping'} onClick={() => void closeElsewhere(() => cloudBrowser.stop(item))}>Close</button>
            </div>
          </li>)}
          {lost.map((item) => <li key={item.providerSessionId}>
            <div><strong>A browser Clem lost track of</strong><span>Still running on Browserbase{item.expiresAt ? ` · ${browserClosesText({ idleClosesAt: null, endsAt: item.expiresAt }, now)}` : ''}</span></div>
            <div className="cloud-browser-row-actions">
              <button type="button" disabled={busy !== null || !conversationId} onClick={() => void adoptHere(item)}>Use in this chat</button>
              <button type="button" disabled={busy !== null} onClick={() => void closeElsewhere(() => cloudBrowser.closeUnlinked(item.providerSessionId))}>Close</button>
            </div>
          </li>)}
        </ul>
      </section> : null}
      {notice ? <p className="cloud-browser-notice" role="status">{notice}</p> : null}
    </aside> : null}
  </div>;
}
