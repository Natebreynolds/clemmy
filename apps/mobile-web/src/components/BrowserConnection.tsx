import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { cloudBrowserProviderLabel, CLOUD_BROWSER_PROVIDERS, type CloudBrowserChoice, type CloudBrowserProvider, type CloudBrowserStatus } from '@clem/chat-engine';
import { cloudBrowser } from '../lib/cloud-browser';

const PROVIDER_FORM: Record<CloudBrowserProvider, { keyHint: string; projectLabel: string; projectRequired: boolean }> = {
  browserbase: { keyHint: 'Browserbase → Settings → API Keys', projectLabel: 'Project ID', projectRequired: true },
  kernel: { keyHint: 'Kernel dashboard → API keys', projectLabel: 'Project (optional)', projectRequired: false },
};

/** The browser Clem uses on the computer, chosen from the phone: this
 * computer's Chrome, or a connected cloud provider. A provider must be
 * connected before it can be chosen. */
export function BrowserConnection() {
  const [status, setStatus] = useState<CloudBrowserStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const mounted = useRef(true);
  const [editing, setEditing] = useState<CloudBrowserProvider | null>(null);
  const [apiKey, setApiKey] = useState(''); const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState('');
  const refreshStatus = useCallback(async () => {
    setStatusFailed(false); setNotice('');
    try { const next = await cloudBrowser.status(); if (mounted.current) setStatus(next); }
    catch { if (mounted.current) { setStatusFailed(true); setNotice('Connection status is unavailable. Retry to reconnect.'); } }
  }, []);
  useEffect(() => { mounted.current = true; void refreshStatus(); return () => { mounted.current = false; }; }, [refreshStatus]);
  const save = async (event: Event) => {
    event.preventDefault(); if (busy || !editing) return; setBusy(true); setNotice('');
    try {
      const next = await cloudBrowser.configure(editing, apiKey.trim(), projectId.trim() || undefined);
      setStatus(next); setApiKey(''); setProjectId(''); setEditing(null);
      setNotice(next.providers?.[editing]?.configured ? `${cloudBrowserProviderLabel(editing)} connected. Choose it above to make it the browser.` : 'The connection was not saved. Check the project and key.');
    } catch { setApiKey(''); setNotice('The connection was not confirmed. Check the project and key, then try again.'); }
    finally { setBusy(false); }
  };
  const choose = async (choice: CloudBrowserChoice) => {
    if (busy) return; setBusy(true); setNotice('');
    try { const next = await cloudBrowser.select(choice); setStatus(next); setNotice(choice === 'local' ? "The computer's Chrome is the browser now." : `${cloudBrowserProviderLabel(choice)} is the browser now.`); }
    catch { setNotice('The choice was not saved. Retry.'); }
    finally { setBusy(false); }
  };
  const providerLine = (provider: CloudBrowserProvider) => {
    const entry = status?.providers?.[provider];
    if (!entry) return status ? 'Not connected' : 'Checking…';
    if (entry.configured) return entry.projectId ? `Connected · project ${entry.projectId}` : 'Connected';
    if (entry.credentialStatus === 'unavailable') return "Saved, but the key can't be read back on the computer. Save it again.";
    return 'Not connected';
  };
  const choice = status?.choice ?? 'local';
  const form = editing ? PROVIDER_FORM[editing] : null;
  return <section class="card settings-card m-browser-connection" aria-labelledby="m-browser-title">
    <div class="m-browser-connection-head"><div><h2 id="m-browser-title">Browser</h2><p>{status ? 'Which browser Clem uses on your computer' : statusFailed ? 'Connection status unavailable' : 'Checking connection…'}</p></div></div>
    {statusFailed ? <button type="button" onClick={() => void refreshStatus()}>Retry status</button> : null}
    {status ? <fieldset class="m-browser-choices" aria-label="Browser to use">
      <label class="m-browser-choice"><input type="radio" name="m-browser-choice" checked={choice === 'local'} disabled={busy} onChange={() => void choose('local')} /><span><strong>The computer's Chrome</strong><small>No account needed.</small></span></label>
      {CLOUD_BROWSER_PROVIDERS.map((provider) => {
        const configured = Boolean(status.providers?.[provider]?.configured);
        return <div class="m-browser-choice" key={provider}>
          <label><input type="radio" name="m-browser-choice" checked={choice === provider} disabled={busy || !configured} onChange={() => void choose(provider)} /><span><strong>{cloudBrowserProviderLabel(provider)}</strong><small>{providerLine(provider)}</small></span></label>
          <button type="button" disabled={busy} onClick={() => { setApiKey(''); setProjectId(status.providers?.[provider]?.projectId ?? ''); setEditing(editing === provider ? null : provider); }}>{editing === provider ? 'Cancel' : configured ? 'Change' : 'Connect'}</button>
        </div>;
      })}
    </fieldset> : null}
    {editing && form ? <form onSubmit={save}>
      <label>{form.projectLabel}<input required={form.projectRequired} value={projectId} onInput={(event) => setProjectId(event.currentTarget.value)} autoComplete="off" /></label>
      <label>API key<input type="password" required value={apiKey} onInput={(event) => setApiKey(event.currentTarget.value)} autoComplete="new-password" /></label>
      <p>From {form.keyHint}. The key is saved securely on your computer, not in this browser. Sessions use your {cloudBrowserProviderLabel(editing)} account; recording starts off.</p>
      <button class="m-browser-primary" type="submit" disabled={busy || !apiKey.trim() || (form.projectRequired && !projectId.trim())}>{busy ? 'Saving…' : 'Save connection'}</button>
    </form> : null}
    {status?.provider && status.idleSeconds && status.sessionTimeoutSeconds ? <p>Idle release after {Math.ceil(status.idleSeconds / 60)} minutes · maximum session {Math.ceil(status.sessionTimeoutSeconds / 60)} minutes.</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
  </section>;
}
