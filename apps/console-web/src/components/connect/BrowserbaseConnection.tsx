import { useCallback, useEffect, useRef, useState } from 'react';
import { Globe } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { cloudBrowser } from '@/lib/cloud-browser';
import type { CloudBrowserStatus } from '@clem/chat-engine';

export function BrowserbaseConnection() {
  const [status, setStatus] = useState<CloudBrowserStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const mounted = useRef(true);
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const refreshStatus = useCallback(async () => {
    setStatusFailed(false); setNotice('');
    try { const next = await cloudBrowser.status(); if (mounted.current) { setStatus(next); setProjectId(next.projectId ?? ''); } }
    catch { if (mounted.current) { setStatusFailed(true); setNotice('Connection status is unavailable. Retry to reconnect.'); } }
  }, []);
  useEffect(() => { mounted.current = true; void refreshStatus(); return () => { mounted.current = false; }; }, [refreshStatus]);
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy) return; setBusy(true); setNotice('');
    try { const next = await cloudBrowser.configure(apiKey.trim(), projectId.trim()); setStatus(next); setApiKey(''); setEditing(false); setNotice(next.configured ? 'Connection saved. Open Browser in a conversation to verify it.' : 'The connection was not saved. Check the project and key.'); }
    catch { setApiKey(''); setNotice('The connection was not confirmed. Check the project and key, then try again.'); }
    finally { setBusy(false); }
  };
  return <section className="mb-8" aria-labelledby="browserbase-connection-title">
    <div className="mb-3 flex items-center gap-2.5"><Globe className="h-5 w-5 text-primary" aria-hidden /><div><h3 id="browserbase-connection-title" className="text-h3 text-fg">Cloud browser</h3><p className="text-small text-muted">Watch Clem browse, take over, and return control from desktop or phone.</p></div></div>
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-4"><div><p className="font-medium text-fg">Browserbase</p><p className="text-small text-muted">{status ? status.configured ? 'Connection saved · verify it by starting a browser' : 'Not configured' : statusFailed ? 'Connection status unavailable' : 'Checking connection…'}</p></div>{status?.configured ? <Button size="sm" variant="secondary" onClick={() => { setApiKey(''); setEditing(!editing); }}>{editing ? 'Cancel' : 'Change connection'}</Button> : null}</div>
      {statusFailed ? <Button size="sm" variant="secondary" className="mt-3" onClick={() => void refreshStatus()}>Retry status</Button> : null}
      {status && (!status.configured || editing) ? <form onSubmit={save} className="mt-4 space-y-3">
        <label className="block text-small text-fg">Project ID<Input value={projectId} onChange={(event) => setProjectId(event.target.value)} autoComplete="off" required className="mt-1" /></label>
        <label className="block text-small text-fg">API key<Input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="new-password" required className="mt-1" /></label>
        <p className="text-small text-muted">The key is saved securely on your Mac, not saved in this browser. Browser sessions use your Browserbase account; recording starts off.</p>
        <Button type="submit" size="sm" disabled={busy || !apiKey.trim() || !projectId.trim()}>{busy ? 'Saving…' : 'Save connection'}</Button>
      </form> : null}
      {status?.idleSeconds && status?.sessionTimeoutSeconds ? <p className="mt-3 text-small text-muted">Idle release after {Math.ceil(status.idleSeconds / 60)} minutes · maximum session {Math.ceil(status.sessionTimeoutSeconds / 60)} minutes.</p> : null}
      {notice ? <p className="mt-3 text-small text-muted" role="status">{notice}</p> : null}
    </div>
  </section>;
}
