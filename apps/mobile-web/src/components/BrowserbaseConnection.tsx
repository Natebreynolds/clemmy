import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { CloudBrowserStatus } from '@clem/chat-engine';
import { cloudBrowser } from '../lib/cloud-browser';
export function BrowserbaseConnection() {
  const [status, setStatus] = useState<CloudBrowserStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const mounted = useRef(true);
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState(''); const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState('');
  const refreshStatus = useCallback(async () => {
    setStatusFailed(false); setNotice('');
    try { const next = await cloudBrowser.status(); if (mounted.current) { setStatus(next); setProjectId(next.projectId ?? ''); } }
    catch { if (mounted.current) { setStatusFailed(true); setNotice('Connection status is unavailable. Retry to reconnect.'); } }
  }, []);
  useEffect(() => { mounted.current = true; void refreshStatus(); return () => { mounted.current = false; }; }, [refreshStatus]);
  const save = async (event: Event) => {
    event.preventDefault(); if (busy) return; setBusy(true); setNotice('');
    try { const next = await cloudBrowser.configure(apiKey.trim(), projectId.trim()); setStatus(next); setApiKey(''); setEditing(false); setNotice(next.configured ? 'Connection saved. Open Browser in a conversation to verify it.' : 'The connection was not saved. Check the project and key.'); }
    catch { setApiKey(''); setNotice('The connection was not confirmed. Check the project and key, then try again.'); }
    finally { setBusy(false); }
  };
  return <section class="card settings-card m-browser-connection" aria-labelledby="m-browserbase-title">
    <div class="m-browser-connection-head"><div><h2 id="m-browserbase-title">Cloud browser</h2><p>{status ? status.configured ? 'Browserbase configuration saved' : 'Connect your Browserbase project' : statusFailed ? 'Connection status unavailable' : 'Checking connection…'}</p></div>{status?.configured ? <button type="button" onClick={() => { setApiKey(''); setEditing(!editing); }}>{editing ? 'Cancel' : 'Change'}</button> : null}</div>
    {statusFailed ? <button type="button" onClick={() => void refreshStatus()}>Retry status</button> : null}
    {status && (!status.configured || editing) ? <form onSubmit={save}><label>Project ID<input required value={projectId} onInput={(event) => setProjectId(event.currentTarget.value)} autoComplete="off" /></label><label>API key<input type="password" required value={apiKey} onInput={(event) => setApiKey(event.currentTarget.value)} autoComplete="new-password" /></label><p>The key is saved securely on your computer, not saved in this browser. Sessions use your Browserbase account; recording starts off.</p><button class="m-browser-primary" type="submit" disabled={busy || !apiKey.trim() || !projectId.trim()}>{busy ? 'Saving…' : 'Save connection'}</button></form> : null}
    {status?.idleSeconds && status?.sessionTimeoutSeconds ? <p>Idle release after {Math.ceil(status.idleSeconds / 60)} minutes · maximum session {Math.ceil(status.sessionTimeoutSeconds / 60)} minutes.</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
  </section>;
}
