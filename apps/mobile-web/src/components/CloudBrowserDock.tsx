import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { flushSync } from 'preact/compat';
import { browserClosesText, browserElapsed, browserFocusPage, browserBoundInputAllowed, browserViewTarget, browserCloseResultMessage, startBrowserViewLifecycle, browserResourceKey, browserStopMessage, browsersChipLabel, canApplyBrowserResponse, canApplyBrowserControlResponse, createBrowserViewerLeases, canStartBrowserInTask, isBrowserDisconnected, type CloudBrowserOpenBrowser, type CloudBrowserOverview, type CloudBrowserResource, type CloudBrowserStatus, type CloudBrowserUnlinkedSession, type BrowserViewLifecycle, type CloudBrowserView } from '@clem/chat-engine';
import { cloudBrowser } from '../lib/cloud-browser';
const Globe = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z" /></svg>;
export function CloudBrowserDock({ conversationId }: { conversationId?: string }) {
  if (!conversationId) return null;
  return <TaskBrowser key={conversationId} conversationId={conversationId} />;
}
function TaskBrowser({ conversationId }: { conversationId: string }) {
  const [status, setStatus] = useState<CloudBrowserStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  const [resources, setResources] = useState<CloudBrowserResource[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState(''); const [recording, setRecording] = useState(false);
  const [recoveryId, setRecoveryId] = useState('');
  const [view, setView] = useState<(CloudBrowserView & { key: string }) | null>(null);
  const [viewIssueKey, setViewIssueKey] = useState<string | null>(null);
  const [overview, setOverview] = useState<CloudBrowserOverview | null>(null);
  const [viewTick, setViewTick] = useState(0); const [targetId, setTargetId] = useState(''); const [text, setText] = useState(''); const [key, setKey] = useState('Enter');
  const frame = useRef<HTMLIFrameElement>(null); const returnButton = useRef<HTMLButtonElement>(null); const trigger = useRef<HTMLButtonElement>(null);
  const leases = useRef(createBrowserViewerLeases(cloudBrowser));
  const lifecycle = useRef<BrowserViewLifecycle | null>(null);
  const requestId = useRef<string | null>(null); const mounted = useRef(true); const generation = useRef(0);
  const resource = resources.find((item) => item.id === selectedId) ?? resources[0] ?? null;
  const current = useRef(resource); current.current = resource;
  const refresh = useCallback(async () => {
    const version = ++generation.current;
    try { const [nextStatus, list] = await Promise.all([cloudBrowser.status(), cloudBrowser.list(conversationId)]); const selected = list.resources.find((item) => item.id === current.current?.id) ?? list.resources[0]; const fresh = selected && selected.state !== 'stopped' && selected.state !== 'expired' ? (await cloudBrowser.read(selected)).resource : null; if (mounted.current && version === generation.current) { setStatus(nextStatus); setStatusFailed(false); setResources(list.resources.map((item) => fresh?.id === item.id ? fresh : item)); } }
    catch { if (mounted.current && version === generation.current) { setStatusFailed(true); setNotice('Browser status is unavailable. Refresh to reconnect.'); } }
  }, [conversationId]);
  // Every open browser on this Mac, for the trigger count and the other-browsers list.
  const loadOverview = useCallback(async () => {
    try { const next = await cloudBrowser.overview(); if (mounted.current) setOverview(next); } catch { /* keep the last list */ }
  }, []);
  useEffect(() => { void loadOverview(); const timer = window.setInterval(() => { if (!document.hidden) void loadOverview(); }, 15_000); return () => window.clearInterval(timer); }, [loadOverview]);
  useEffect(() => { mounted.current = true; void refresh(); const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 5000); return () => { mounted.current = false; generation.current++; window.clearInterval(timer); }; }, [refresh]);
  const resourceKey = resource ? browserResourceKey(resource) : '';
  // Without a chosen page, the view follows the page Clem is on.
  const viewTarget = resource ? browserViewTarget(resource, targetId || undefined) : undefined;
  const viewKey = JSON.stringify([resourceKey, viewTarget ?? null, viewTick]);
  const viewContext = useRef({ key: viewKey, open, visible, busy });
  viewContext.current = { key: viewKey, open, visible, busy };
  useEffect(() => {
    if (!visible || !open || !resource || resource.state !== 'active' || resource.returnPending) return;
    const requested = resource;
    const touch = () => {
      if (document.hidden || !mounted.current || !current.current || browserResourceKey(current.current) !== resourceKey) return;
      void cloudBrowser.touch(requested).catch(() => { if (mounted.current) void refresh(); });
    };
    touch(); const timer = window.setInterval(touch, 20_000);
    return () => window.clearInterval(timer);
  }, [visible, open, resourceKey, refresh]);
  useEffect(() => { setTargetId(''); setText(''); }, [resource?.id, resource?.controlVersion]);
  useEffect(() => { if (open) returnButton.current?.focus(); }, [open]);
  useEffect(() => {
    if (!visible || !open || !resource || resource.state !== 'active' || resource.returnPending) return;
    setViewIssueKey(null);
    const viewer = startBrowserViewLifecycle({
      resource, targetId: viewTarget, key: viewKey, client: cloudBrowser, leases: leases.current,
      uuid: () => crypto.randomUUID(),
      isCurrent: () => mounted.current && !document.hidden && viewContext.current.key === viewKey
        && viewContext.current.open && viewContext.current.visible,
      isBusy: () => viewContext.current.busy !== null,
      show: (next) => { setView(next); setViewIssueKey(null); },
      remove: async (id) => {
        // Leave the effect stack before flushing. The old iframe must be gone
        // before its lease acknowledgment can permit an agent handoff.
        await Promise.resolve();
        if (mounted.current) flushSync(() => setView((shown) => shown?.viewerLeaseId === id ? null : shown));
      },
      issue: (kind) => {
        setViewIssueKey(viewKey);
        setNotice(kind === 'cleanup' ? 'Closing the previous view was not confirmed. Choose Watch to retry.'
          : kind === 'binding' ? 'The browser view changed. Choose Watch after its status refreshes.'
          : 'The live view could not reconnect. Choose Watch to retry.');
        void refresh();
      },
    });
    lifecycle.current = viewer;
    return () => { if (lifecycle.current === viewer) lifecycle.current = null; void viewer.stop(); };
  }, [visible, open, resourceKey, viewKey]);
  useEffect(() => { if (busy === null) lifecycle.current?.resume(); }, [busy]);
  useEffect(() => {
    if (!view) return;
    const disconnected = (event: MessageEvent) => {
      if (isBrowserDisconnected(event, frame.current?.contentWindow ?? null, view.url)) lifecycle.current?.disconnected(view.viewerLeaseId);
    };
    window.addEventListener('message', disconnected);
    return () => window.removeEventListener('message', disconnected);
  }, [view]);
  useEffect(() => {
    const closeViews = () => { const selected = current.current; void lifecycle.current?.stop(); flushSync(() => { setVisible(false); setView(null); }); if (selected) void leases.current.detachAll(selected).catch(() => {}); };
    const visibility = () => { if (document.hidden) closeViews(); else { setVisible(true); setViewTick((tick) => tick + 1); void refresh(); } };
    const pageShow = () => { if (!document.hidden) { setVisible(true); setViewTick((tick) => tick + 1); void refresh(); } };
    window.addEventListener('pagehide', closeViews); document.addEventListener('visibilitychange', visibility); window.addEventListener('pageshow', pageShow);
    return () => { window.removeEventListener('pagehide', closeViews); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pageshow', pageShow); };
  }, [refresh]);
  const change = async (kind: 'human' | 'agent' | 'stop') => {
    if (!resource || busy) return; const requested = resource;
    setBusy(kind); setNotice(''); void lifecycle.current?.stop(); flushSync(() => setView(null)); generation.current++;
    try {
      let baseline = requested;
      if (kind !== 'stop') { await new Promise<void>((resolve) => { const timer = window.setTimeout(resolve, 50); window.requestAnimationFrame(() => { window.clearTimeout(timer); resolve(); }); }); baseline = await leases.current.detachAll(requested); }
      const alreadyReturned = kind === 'agent' && baseline.controller === 'agent' && !baseline.returnPending;
      const next = alreadyReturned ? baseline : (kind === 'stop' ? await cloudBrowser.stop(baseline) : await cloudBrowser.control(baseline, kind)).resource;
      if (!mounted.current) return;
      if (kind === 'stop' || alreadyReturned ? canApplyBrowserResponse(current.current, requested, next) : canApplyBrowserControlResponse(current.current, requested, next, kind)) { generation.current++; setResources((items) => items.map((item) => item.id === next.id ? next : item)); setNotice(next.returnPending ? 'Waiting for other open views to close. Clem cannot browse until they acknowledge closure.' : kind === 'agent' ? 'Control returned to Clem. This does not resume a paused task.' : kind === 'stop' ? browserStopMessage(next) : 'You have control. Clem waits for you to return it.'); }
      else { setNotice('Browser control changed. Refreshed its current state.'); await refresh(); }
    } catch (error) { if (mounted.current) { setNotice((error as { status?: number }).status === 409 ? 'Control changed on another device. Refreshed the browser; choose again.' : 'The change was not confirmed. Refresh before trying again.'); await refresh(); } }
    finally { if (mounted.current) { setBusy(null); setViewTick((tick) => tick + 1); void loadOverview(); } }
  };
  // Hand a browser from another chat, or one Clem lost track of, to this
  // chat; Clem gets control so it can work on the page the browser is on.
  const handToThisChat = async (take: () => Promise<CloudBrowserResource>) => {
    if (busy) return;
    setBusy('move'); setNotice(''); generation.current++;
    try {
      let next = await take();
      if (next.state === 'active' && next.controller === 'human') next = (await cloudBrowser.control(next, 'agent')).resource;
      if (!mounted.current) return;
      generation.current++; setResources((items) => [next, ...items.filter((item) => item.id !== next.id)]); setSelectedId(next.id);
      setNotice('This browser is in this chat now. Clem can use the page it is on.');
    } catch { if (mounted.current) setNotice('Moving the browser was not confirmed. Refresh the list and try again.'); }
    finally { if (mounted.current) { setBusy(null); void refresh(); void loadOverview(); } }
  };
  const useHere = (browser: CloudBrowserOpenBrowser) => handToThisChat(async () => (await cloudBrowser.move(browser, conversationId)).resource);
  const adoptHere = (session: CloudBrowserUnlinkedSession) => handToThisChat(async () => (await cloudBrowser.adoptUnlinked(session.providerSessionId, conversationId)).resource);
  const closeElsewhere = async (closeIt: () => Promise<Parameters<typeof browserCloseResultMessage>[0]>) => {
    if (busy) return;
    setBusy('close-other'); setNotice('');
    try { const result = await closeIt(); if (mounted.current) setNotice(browserCloseResultMessage(result)); }
    catch { if (mounted.current) setNotice('Closing was not confirmed. Refresh the list to check it.'); }
    finally { if (mounted.current) { setBusy(null); void loadOverview(); } }
  };
  const closePendingViews = async () => {
    if (!resource || busy) return;
    const requested = resource;
    setBusy('detach'); setNotice(''); void lifecycle.current?.stop(); flushSync(() => setView(null)); generation.current++;
    try {
      const next = await leases.current.detachAll(requested);
      if (!mounted.current || !canApplyBrowserResponse(current.current, requested, next)) return;
      generation.current++; setResources((items) => items.map((item) => item.id === next.id ? next : item));
      setNotice(next.returnPending ? 'This device’s views are closed. Waiting for other open views to acknowledge closure.' : next.controller === 'agent' ? 'Control returned to Clem. This does not resume a paused task.' : 'This device’s views are closed. Refresh to check control.');
    } catch { if (mounted.current) setNotice('This device’s view closure was not confirmed. Retry closing views, or stop the browser.'); }
    finally { if (mounted.current) setBusy(null); }
  };
  const start = async () => {
    if (busy || !status?.configured || !canStartBrowserInTask(resources)) return; requestId.current ??= crypto.randomUUID(); setBusy('start'); setNotice(''); generation.current++;
    try { const { resource: next } = await cloudBrowser.start(conversationId, requestId.current, recording); if (mounted.current && next.conversationId === conversationId) { generation.current++; setResources((items) => [next, ...items.filter((item) => item.id !== next.id)]); setSelectedId(next.id); requestId.current = null; } }
    catch { if (mounted.current) { setNotice('Starting the browser was not confirmed. Refresh, or retry the same start request.'); await refresh(); } }
    finally { if (mounted.current) { setBusy(null); void loadOverview(); } }
  };
  const input = async (kind: 'text' | 'key') => {
    if (!resource || busy || view?.key !== viewKey || !browserBoundInputAllowed(resource, targetId, view) || (kind === 'text' && !text)) return;
    const requested = resource; const requestedTarget = targetId;
    setBusy(kind); setNotice(''); generation.current++;
    try {
      const response = await cloudBrowser.input(requested, requestedTarget, view.viewerLeaseId, kind === 'text' ? { text } : { key });
      if (!mounted.current) return;
      if (canApplyBrowserResponse(current.current, requested, response.resource) && response.result.ok === true) { generation.current++; setResources((items) => items.map((item) => item.id === response.resource.id ? response.resource : item)); if (kind === 'text') setText(''); setNotice(kind === 'text' ? 'Text sent to the selected page. Check the focused field.' : `${key} reached the selected page.`); }
      else { setNotice('Input was not confirmed for the current browser state. Refresh before trying again.'); await refresh(); }
    } catch (error) { if (mounted.current) { setNotice((error as { status?: number }).status === 409 ? 'Control changed. Refreshed the browser; select the page again.' : 'Input was not confirmed. Check the page before sending it again.'); await refresh(); } }
    finally { if (mounted.current) setBusy(null); }
  };
  const active = resource?.state === 'active'; const liveView = !resource?.returnPending && view?.key === viewKey ? view : null;
  const inputAllowed = resource !== null && browserBoundInputAllowed(resource, targetId, liveView);
  const recover = async () => {
    if (!resource || busy || !recoveryId.trim()) return; const requested = resource; setBusy('recover'); setNotice(''); generation.current++;
    try { const { resource: next } = await cloudBrowser.recover(requested, recoveryId.trim()); if (!mounted.current) return; if (canApplyBrowserResponse(current.current, requested, next)) { generation.current++; setResources((items) => items.map((item) => item.id === next.id ? next : item)); setRecoveryId(''); setNotice(next.state === 'active' ? 'Browser recovered. You can watch or take control.' : 'Browser identity recovered. Refresh to check its state.'); } else { setNotice('Browser recovery changed. Refreshed its state.'); await refresh(); } }
    catch { if (mounted.current) { setNotice('Recovery was not confirmed. Check the session ID in your Browserbase project, then refresh.'); await refresh(); } }
    finally { if (mounted.current) setBusy(null); }
  };
  const close = () => { void lifecycle.current?.stop(); setOpen(false); trigger.current?.focus(); };
  const others = (overview?.browsers ?? []).filter((item) => item.conversationId !== conversationId);
  const lost = overview?.unlinked ?? [];
  const openCount = (overview?.browsers.length ?? 0) + lost.length;
  const thisEntry = resource ? overview?.browsers.find((item) => item.id === resource.id) : undefined;
  const now = Date.now();
  return <div class="m-browser-dock">
    <button ref={trigger} type="button" class="m-browser-trigger" aria-expanded={open} onClick={() => setOpen(true)}><Globe /><span>{browsersChipLabel(openCount)}</span><span>{resource ? `${resource.returnPending ? 'Waiting for open views' : active ? resource.controller === 'human' ? 'Your control' : 'Clem is browsing' : resource.state} · ${browserElapsed(resource.elapsedSeconds)}` : 'For this conversation'}</span></button>
    {open ? <section class="m-browser-layer" aria-label="Conversation browser" onKeyDown={(event) => { if (event.key === 'Escape') close(); }}>
      <header><button ref={returnButton} type="button" onClick={close}>Return to chat</button><span>{resource ? browserElapsed(resource.elapsedSeconds) : 'Browser'}{resource?.recording ? ' · Recording on' : ''}{thisEntry ? ` · ${browserClosesText(thisEntry, now)}` : ''}</span></header>
      {resources.length > 1 ? <label class="m-browser-select">Browser session<select value={resource?.id ?? ''} onChange={(event) => setSelectedId(event.currentTarget.value)}>{resources.map((item) => <option key={item.id} value={item.id}>{browserFocusPage(item)?.title || 'Browser'} · {item.state}</option>)}</select></label> : null}
      {!resource ? <div class="m-browser-empty"><Globe /><h2>A browser for the work</h2><p>Watch Clem browse, then take over when a page needs you. Your conversation stays open.</p>{status === null ? <><p>{statusFailed ? 'Connection status unavailable.' : 'Checking connection…'}</p>{statusFailed ? <button type="button" onClick={() => void refresh()}>Retry status</button> : null}</> : !status.configured ? <p>Connect Browserbase in Settings → Connections, then return here.</p> : <><label><input type="checkbox" checked={recording} onChange={(event) => setRecording(event.currentTarget.checked)} />Record this browser session</label><button class="m-browser-primary" type="button" disabled={busy !== null} onClick={() => void start()}>{busy === 'start' ? 'Starting…' : requestId.current ? 'Retry start' : 'Start browser'}</button><p>Cloud usage is billed by your Browserbase account. Recording is off by default.</p></>}</div> : <>
        <div class="m-browser-controls"><button type="button" disabled={!active || resource.returnPending || busy !== null} onClick={() => void change(resource.controller === 'human' ? 'agent' : 'human')}>{busy === 'human' || busy === 'agent' ? 'Changing control…' : resource.controller === 'human' ? 'Return to Clem' : 'Take control'}</button><button type="button" disabled={busy !== null || resource.returnPending} onClick={() => { void lifecycle.current?.stop(); flushSync(() => setView(null)); setNotice(''); void refresh(); setViewTick((tick) => tick + 1); }}>Watch</button><button type="button" disabled={busy !== null || resource.state === 'stopped' || resource.state === 'expired' || resource.state === 'stopping'} onClick={() => void change('stop')}>{busy === 'stop' || resource.state === 'stopping' ? 'Stopping…' : 'Stop'}</button></div>
        {status?.configured && canStartBrowserInTask(resources) ? <div class="m-browser-new"><label><input type="checkbox" checked={recording} onChange={(event) => setRecording(event.currentTarget.checked)} />Record the new session</label><button type="button" disabled={busy !== null} onClick={() => void start()}>{busy === 'start' ? 'Starting…' : 'Start new browser'}</button></div> : null}
        {resource.returnPending ? <button type="button" class="m-browser-close-views" disabled={busy !== null} onClick={() => void closePendingViews()}>{busy === 'detach' ? 'Closing views…' : 'Retry closing this device’s views'}</button> : null}
        <p class="m-browser-page">{browserFocusPage(resource)?.title || 'Browser session'}<span>{browserFocusPage(resource)?.url || resource.state}</span></p>
        <div class="m-browser-view">{liveView ? <div class="m-browser-frame" ref={(element) => { if (element) element.inert = resource.controller !== 'human'; }}><iframe ref={frame} src={liveView.url} title="Conversation browser live view" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" referrerPolicy="no-referrer" tabIndex={resource.controller === 'human' ? 0 : -1} style={{ pointerEvents: resource.controller === 'human' ? 'auto' : 'none' }} /></div> : <p>{resource.returnPending ? 'Waiting for other open views to close. Return to Clem is pending; Stop remains available.' : active ? viewIssueKey === viewKey ? 'The live view is unavailable. Choose Watch to retry.' : 'Connecting the live view…' : resource.state === 'uncertain' ? 'Browser state needs a fresh check. Refresh before continuing.' : `Browser ${resource.state}.`}</p>}</div>
        {resource.controller === 'human' && active && !resource.returnPending ? <div class="m-browser-input"><p>Choose a page to load its verified live view. Tap the field there, then enter text or send a key below.</p><label>Page<select value={targetId} disabled={busy !== null} onChange={(event) => setTargetId(event.currentTarget.value)}><option value="">Choose a page</option>{resource.pages.map((page) => <option key={page.targetId} value={page.targetId}>{page.title || page.url || 'Untitled page'}</option>)}</select></label>{targetId && !inputAllowed ? <p role="status">Waiting for a verified view of this page. Input stays off until it is ready.</p> : null}<label>Text for the focused field<input value={text} disabled={busy !== null || !inputAllowed} onInput={(event) => setText(event.currentTarget.value)} autoComplete="off" maxLength={4096} /></label><button type="button" disabled={busy !== null || !text || !inputAllowed} onClick={() => void input('text')}>{busy === 'text' ? 'Entering…' : 'Enter text'}</button><div><label>Key<select value={key} disabled={busy !== null || !inputAllowed} onChange={(event) => setKey(event.currentTarget.value)}>{['Enter', 'Tab', 'Escape', 'Backspace'].map((value) => <option key={value}>{value}</option>)}</select></label><button type="button" disabled={busy !== null || !inputAllowed} onClick={() => void input('key')}>{busy === 'key' ? 'Sending…' : 'Send key'}</button></div></div> : active && !resource.returnPending ? <p class="m-browser-note">Watching only. Take control to interact. Return to chat for steering and approvals.</p> : null}
        {resource.state === 'uncertain' && resource.providerSessionId === null ? <details class="m-browser-recovery"><summary>Recover a browser that may have started</summary><p>Find the session ID in your Browserbase project. Clem verifies its project before adopting it.</p><label>Browserbase session ID<input value={recoveryId} onInput={(event) => setRecoveryId(event.currentTarget.value)} autoComplete="off" /></label><button type="button" disabled={busy !== null || !recoveryId.trim()} onClick={() => void recover()}>{busy === 'recover' ? 'Checking session…' : 'Recover browser'}</button></details> : null}
      </>}
      {others.length || lost.length ? <section class="m-browser-others" aria-label="Other open browsers">
        <h3>Other open browsers</h3>
        <ul>
          {others.map((item) => <li key={item.id}>
            <div><strong>{item.conversationTitle || 'Untitled chat'}</strong><span>{browserFocusPage(item)?.title || browserFocusPage(item)?.url || (item.state === 'active' ? 'Blank page' : item.state)} · {browserClosesText(item, now)}{item.usesProfile ? ' · Saved profile' : ''}</span></div>
            <div class="m-browser-row-actions">
              <button type="button" disabled={busy !== null || item.state !== 'active'} onClick={() => void useHere(item)}>{busy === 'move' ? 'Moving…' : 'Use in this chat'}</button>
              <button type="button" disabled={busy !== null || item.state === 'stopping'} onClick={() => void closeElsewhere(() => cloudBrowser.stop(item))}>Close</button>
            </div>
          </li>)}
          {lost.map((item) => <li key={item.providerSessionId}>
            <div><strong>A browser Clem lost track of</strong><span>Still running on Browserbase{item.expiresAt ? ` · ${browserClosesText({ idleClosesAt: null, endsAt: item.expiresAt }, now)}` : ''}</span></div>
            <div class="m-browser-row-actions">
              <button type="button" disabled={busy !== null} onClick={() => void adoptHere(item)}>Use in this chat</button>
              <button type="button" disabled={busy !== null} onClick={() => void closeElsewhere(() => cloudBrowser.closeUnlinked(item.providerSessionId))}>Close</button>
            </div>
          </li>)}
        </ul>
      </section> : null}
      {notice ? <p class="m-browser-notice" role="status">{notice}</p> : null}
    </section> : null}
  </div>;
}
