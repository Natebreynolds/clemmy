import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, KeyRound, RotateCw, Loader2, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { usePoll } from '@/lib/poll';
import { xaiDeviceBegin, xaiDevicePoll, xaiAuthStatus, xaiDisconnect } from '@/lib/connect';
import { addModelProvider, listProviderModels } from '@/lib/settings';

/**
 * xAI (Grok) subscription sign-in — peer to CodexLoginForm and ClaudeLoginForm,
 * rendered beside them in Settings → Models & routing.
 *
 * ONE button, not two. Codex offers a local browser flow plus a device flow
 * because its loopback path is desktop-only; xAI's device grant needs no
 * redirect URI or listener, so the same path already works on desktop, over the
 * tunnel, and from a phone. A second button would be a distinction without a
 * difference.
 */
export function XaiSignIn({ connected, onDone }: { connected: boolean; onDone: () => void }) {
  const [device, setDevice] = useState<{ uri: string; code: string } | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true); setStatus('Requesting a sign-in code…'); setDevice(null);
    try {
      const start = await xaiDeviceBegin();
      if (!start.loginId || !start.verificationUri || !start.userCode) {
        setStatus(`Couldn't start sign-in: ${start.error || 'unknown error'}`);
        setBusy(false);
        return;
      }
      // Prefer the prefilled URL so the code is already entered when it opens.
      setDevice({ uri: start.verificationUriComplete || start.verificationUri, code: start.userCode });
      setStatus('Waiting for approval…');

      let intervalMs = Math.max(3, start.intervalSeconds || 5) * 1000;
      // Trust the SERVER's deadline. Polling past it only yields confusing
      // errors, and a user who walked away should see "expired", not a spinner.
      const expiresAt = start.expiresAt ? Date.parse(start.expiresAt) : Date.now() + 1_800_000;
      const loginId = start.loginId;

      const poll = async () => {
        if (Date.now() > expiresAt) {
          setStatus('Code expired — click “Connect xAI (Grok)” to try again.');
          setBusy(false);
          return;
        }
        try {
          const res = await xaiDevicePoll(loginId);
          if (res.status === 'complete') {
            setStatus('Connected'); onDone();
            setTimeout(() => { setDevice(null); setStatus(''); setBusy(false); }, 2500);
            return;
          }
          if (res.status === 'denied') { setStatus('Sign-in was denied in the browser.'); setBusy(false); return; }
          if (res.status === 'expired') { setStatus('Code expired — try again.'); setBusy(false); return; }
          if (res.status === 'error') { setStatus(res.message || 'Sign-in failed.'); setBusy(false); return; }
          // The server can ask us to back off; honour it rather than hammering.
          if (res.status === 'slow_down' && res.intervalSeconds) intervalMs = res.intervalSeconds * 1000;
          setStatus('Waiting for approval…');
          setTimeout(poll, intervalMs);
        } catch {
          // A dropped request is not a failed sign-in — the grant is still
          // pending upstream, so keep polling instead of discarding it.
          setStatus('Network hiccup — retrying…');
          setTimeout(poll, intervalMs);
        }
      };
      setTimeout(poll, intervalMs);
    } catch (e) {
      setStatus(`Sign-in failed: ${(e as Error).message}`);
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true); setStatus('Disconnecting…');
    try { await xaiDisconnect(); onDone(); setStatus(''); } catch (e) { setStatus((e as Error).message); }
    setBusy(false);
  };

  const refreshModels = async () => {
    setBusy(true); setStatus('Refreshing Grok models…');
    try {
      const { models } = await listProviderModels({ providerId: 'xai' });
      const modelIds = models.map((m) => m.id).filter(Boolean);
      if (modelIds.length === 0) {
        setStatus('xAI returned no models — try again in a moment.');
        setBusy(false);
        return;
      }
      await addModelProvider({
        id: 'xai',
        label: 'xAI (Grok)',
        baseURL: 'https://api.x.ai/v1',
        modelIds,
      });
      setStatus(`Loaded ${modelIds.length} Grok models.`);
      onDone();
    } catch (e) {
      setStatus((e as Error).message || 'Could not refresh the model list.');
    }
    setBusy(false);
  };

  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={run} disabled={busy}>
          {busy && !device ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Starting…</>
            : <><RotateCw className="h-4 w-4" aria-hidden /> {connected ? 'Reconnect' : 'Connect xAI (Grok)'}</>}
        </Button>
        {connected && (
          <>
            <Button variant="secondary" size="sm" onClick={refreshModels} disabled={busy}>
              Refresh models
            </Button>
            <Button variant="ghost" size="sm" onClick={disconnect} disabled={busy}>
              <LogOut className="h-4 w-4" aria-hidden /> Disconnect
            </Button>
          </>
        )}
      </div>
      {device && (
        <div className="mt-2 rounded-md border border-border bg-subtle p-2.5 text-small text-muted">
          Open <a href={device.uri} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{device.uri}</a> and enter code: <b className="tracking-wide text-fg">{device.code}</b>
        </div>
      )}
      {status && <p className="mt-1 text-caption text-faint">{status}</p>}
    </div>
  );
}

/** Self-contained xAI sign-in for Settings, mirroring the Codex/Claude cards. */
export function XaiLoginForm({ embedded = false }: { embedded?: boolean } = {}) {
  const qc = useQueryClient();
  const auth = usePoll(['xai-auth'], xaiAuthStatus, 0);
  const connected = Boolean(auth.data?.connected);
  const refetch = () => {
    void qc.invalidateQueries({ queryKey: ['xai-auth'] });
    void qc.invalidateQueries({ queryKey: ['credentials'] });
    void qc.invalidateQueries({ queryKey: ['settings'] });
  };

  const body = (
    <>
      <div className="mb-1 flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-muted" aria-hidden />
        <h4 className="text-label text-fg">xAI (Grok) sign-in</h4>
      </div>
      <div className="rounded-lg border border-border bg-canvas p-3 text-small">
        {connected
          ? <span className="inline-flex items-center gap-1 text-success"><Check className="h-4 w-4" aria-hidden /> Connected · subscription billing</span>
          : <span className="text-muted">Not connected. Sign in with your xAI account to use Grok as a brain, worker, or judge.</span>}
      </div>
      <XaiSignIn connected={connected} onDone={refetch} />
    </>
  );

  if (embedded) return <div>{body}</div>;
  return <div className="rounded-lg border border-border bg-canvas p-4">{body}</div>;
}
