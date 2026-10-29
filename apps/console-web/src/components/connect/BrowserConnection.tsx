import { useCallback, useEffect, useRef, useState } from 'react';
import { Globe } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { cloudBrowser } from '@/lib/cloud-browser';
import type { CloudBrowserChoice, CloudBrowserProvider, CloudBrowserStatus } from '@clem/chat-engine';

const PROVIDERS: Array<{ provider: CloudBrowserProvider; label: string; keyHint: string; projectHint: string; projectRequired: boolean }> = [
  { provider: 'browserbase', label: 'Browserbase', keyHint: 'Browserbase → Settings → API Keys', projectHint: 'Project ID (required)', projectRequired: true },
  { provider: 'kernel', label: 'Kernel', keyHint: 'Kernel dashboard → API keys', projectHint: 'Project (optional; the key\'s default project otherwise)', projectRequired: false },
];

/** Saved browser preferences stay available when computer control is selected. */
export function BrowserConnection() {
  const [status, setStatus] = useState<CloudBrowserStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const mounted = useRef(true);
  const [editing, setEditing] = useState<CloudBrowserProvider | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const refreshStatus = useCallback(async () => {
    setStatusFailed(false); setNotice('');
    try { const next = await cloudBrowser.status(); if (mounted.current) setStatus(next); }
    catch { if (mounted.current) { setStatusFailed(true); setNotice('Connection status is unavailable. Retry to reconnect.'); } }
  }, []);
  useEffect(() => { mounted.current = true; void refreshStatus(); return () => { mounted.current = false; }; }, [refreshStatus]);
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy || !editing) return; setBusy(true); setNotice('');
    try {
      const next = await cloudBrowser.configure(editing, apiKey.trim(), projectId.trim() || undefined);
      setStatus(next); setApiKey(''); setProjectId(''); setEditing(null);
      setNotice(next.providers?.[editing]?.configured
        ? next.effectiveBackend === 'computer' ? `${label(editing)} connected as a fallback. Clem is still set to use your computer.`
          : `${label(editing)} connected. Choose it below to use it for browsing. You can watch from the chat when a browser session opens.`
        : 'The connection was not saved. Check the project and key.');
    } catch { setApiKey(''); setNotice('The connection was not confirmed. Check the project and key, then try again.'); }
    finally { setBusy(false); }
  };
  const choose = async (choice: CloudBrowserChoice) => {
    if (busy) return; setBusy(true); setNotice('');
    try {
      const next = await cloudBrowser.select(choice); setStatus(next);
      const name = choice === 'local' ? "This computer’s Chrome" : label(choice);
      setNotice(next.effectiveBackend === 'computer' ? `${name} saved as the fallback. Clem is still set to use your computer.` : `${name} selected for browsing.`);
    }
    catch { setNotice('The choice was not saved. Retry.'); }
    finally { setBusy(false); }
  };
  const label = (provider: CloudBrowserProvider) => PROVIDERS.find((entry) => entry.provider === provider)?.label ?? provider;
  const providerLine = (provider: CloudBrowserProvider) => {
    const entry = status?.providers?.[provider];
    if (!entry) return 'Checking…';
    if (entry.configured) return 'Connected';
    if (entry.credentialStatus === 'unavailable') return "Saved, but the API key can't be read back from this computer's credential store. On Windows, check that the Clementine data folder is private to your account, then save the key again.";
    return 'Not connected';
  };
  const choice = status?.choice ?? 'local';
  const computerSelected = status?.effectiveBackend === 'computer';
  return <section className="mb-8" aria-labelledby="browser-connection-title">
    <div className="mb-3 flex items-center gap-2.5"><Globe className="h-5 w-5 text-primary" aria-hidden /><div><h3 id="browser-connection-title" className="text-h3 text-fg">{computerSelected ? 'Browser fallbacks' : 'Browser'}</h3><p className="text-small text-muted">{computerSelected ? 'Clem is set to use your computer. These are saved browser fallbacks; check the computer connection and permissions above.' : 'Choose a browser for Clem. Open sessions can be watched and managed from the chat.'}</p></div></div>
    <div className="rounded-xl border border-border bg-surface p-4 space-y-4">
      <fieldset className="space-y-2" aria-label={computerSelected ? 'Saved browser fallback' : 'Browser to use'}>
        <label className="flex items-start gap-3 text-small text-fg">
          <input type="radio" name="browser-choice" className="mt-1" checked={choice === 'local'} disabled={busy} onChange={() => void choose('local')} />
          <span><span className="font-medium">This computer's Chrome</span><span className="block text-muted">{computerSelected ? 'Use local Chrome as the saved fallback. No account needed.' : 'Clem drives the Chrome on this machine. No account needed.'}</span></span>
        </label>
        {PROVIDERS.map((entry) => {
          const configured = Boolean(status?.providers?.[entry.provider]?.configured);
          return <label key={entry.provider} className="flex items-start gap-3 text-small text-fg">
            <input type="radio" name="browser-choice" className="mt-1" checked={choice === entry.provider} disabled={busy || !configured} onChange={() => void choose(entry.provider)} />
            <span className="flex-1">
              <span className="font-medium">{entry.label}</span>
              <span className="block text-muted">{providerLine(entry.provider)}{configured && status?.providers?.[entry.provider]?.projectId ? ` · project ${status.providers[entry.provider]!.projectId}` : ''}</span>
            </span>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => { setApiKey(''); setProjectId(status?.providers?.[entry.provider]?.projectId ?? ''); setEditing(editing === entry.provider ? null : entry.provider); }}>
              {editing === entry.provider ? 'Cancel' : configured ? 'Change' : 'Connect'}
            </Button>
          </label>;
        })}
      </fieldset>
      {statusFailed ? <Button size="sm" variant="secondary" onClick={() => void refreshStatus()}>Retry status</Button> : null}
      {editing ? <form onSubmit={save} className="space-y-3 border-t border-border pt-4">
        <p className="text-small text-fg font-medium">{label(editing)}</p>
        <label className="block text-small text-fg">{PROVIDERS.find((entry) => entry.provider === editing)?.projectHint}<Input value={projectId} onChange={(event) => setProjectId(event.target.value)} autoComplete="off" required={PROVIDERS.find((entry) => entry.provider === editing)?.projectRequired} className="mt-1" /></label>
        <label className="block text-small text-fg">API key<Input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="new-password" required className="mt-1" /></label>
        <p className="text-small text-muted">From {PROVIDERS.find((entry) => entry.provider === editing)?.keyHint}. The key is saved securely on your computer, not in this browser. Browser sessions use your account; recording starts off.</p>
        <Button type="submit" size="sm" disabled={busy || !apiKey.trim() || (PROVIDERS.find((entry) => entry.provider === editing)?.projectRequired && !projectId.trim())}>{busy ? 'Saving…' : 'Save connection'}</Button>
      </form> : null}
      {status?.provider && status.idleSeconds && status.sessionTimeoutSeconds ? <p className="text-small text-muted">Idle release after {Math.ceil(status.idleSeconds / 60)} minutes · maximum session {Math.ceil(status.sessionTimeoutSeconds / 3600)} h</p> : null}
      {notice ? <p className="text-small text-muted" role="status">{notice}</p> : null}
    </div>
  </section>;
}
