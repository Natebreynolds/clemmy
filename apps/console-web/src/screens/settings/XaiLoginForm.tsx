import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, KeyRound, RotateCw, Loader2, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { usePoll } from '@/lib/poll';
import { xaiDeviceBegin, xaiDevicePoll, xaiAuthStatus, xaiDisconnect } from '@/lib/connect';
import { addModelProvider, listProviderModels } from '@/lib/settings';
import { createSignInAttemptOwner, deviceSignInDeadline, deviceSignInPollDelay } from '@/lib/sign-in-attempt';

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
export function XaiSignIn({ connected, onDone, onBusyChange, allowCancel = false }: {
  connected: boolean; onDone: () => void; onBusyChange?: (busy: boolean) => void; allowCancel?: boolean;
}) {
  const [device, setDevice] = useState<{ uri: string; code: string } | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const attempts = useRef(createSignInAttemptOwner());
  const signInActive = useRef(false);
  useEffect(() => () => attempts.current.stop(), []);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  const stopWaiting = () => {
    if (!signInActive.current) return;
    signInActive.current = false;
    attempts.current.stop(); setBusy(false); setDevice(null);
    setStatus('Stopped waiting here. If you finished in the browser, refresh your sign-in status.');
    onDone();
  };

  const run = async () => {
    signInActive.current = true;
    const attempt = attempts.current.begin();
    setBusy(true); setStatus('Requesting a sign-in code…'); setDevice(null);
    const cancelBeginTimeout = attempt.later(() => {
      setStatus('The sign-in code request timed out. Try again.'); setBusy(false); attempt.stop();
    }, 30_000);
    try {
      const start = await xaiDeviceBegin(attempt.signal);
      if (!attempt.isCurrent()) return;
      cancelBeginTimeout();
      if (!start.loginId || !start.verificationUri || !start.userCode) {
        setStatus(`Couldn't start sign-in: ${start.error || 'unknown error'}`);
        setBusy(false);
        return;
      }
      const expiresAt = deviceSignInDeadline(start.expiresAt, 1_800_000);
      if (expiresAt === null) { setStatus('Couldn’t confirm the sign-in code’s expiry. Try again.'); setBusy(false); return; }
      // Prefer the prefilled URL so the code is already entered when it opens.
      setDevice({ uri: start.verificationUriComplete || start.verificationUri, code: start.userCode });
      setStatus('Waiting for approval…');

      let intervalMs = deviceSignInPollDelay(start.intervalSeconds);
      const loginId = start.loginId;
      const expired = () => {
        setStatus('Code expired — click “Connect xAI (Grok)” to try again.'); setBusy(false); attempt.stop();
      };
      const cancelExpiry = attempt.later(expired, Math.max(1, expiresAt - Date.now()));
      const later = () => attempt.later(() => { void poll(); }, Math.min(intervalMs, Math.max(1, expiresAt - Date.now())));

      const poll = async () => {
        if (!attempt.isCurrent()) return;
        if (Date.now() >= expiresAt) { expired(); return; }
        try {
          const res = await xaiDevicePoll(loginId, attempt.signal);
          if (!attempt.isCurrent()) return;
          if (res.status === 'complete') {
            cancelExpiry();
            setStatus('Connected'); onDone();
            attempt.later(() => { setDevice(null); setStatus(''); setBusy(false); }, 2500);
            return;
          }
          if (res.status === 'denied') { cancelExpiry(); setStatus('Sign-in was denied in the browser.'); setBusy(false); return; }
          if (res.status === 'expired') { cancelExpiry(); setStatus('Code expired — try again.'); setBusy(false); return; }
          if (res.status === 'error') { cancelExpiry(); setStatus(res.message || 'Sign-in failed.'); setBusy(false); return; }
          // The server can ask us to back off; honour it rather than hammering.
          if (res.status === 'slow_down') intervalMs = Math.max(intervalMs, deviceSignInPollDelay(res.intervalSeconds, intervalMs));
          else if (res.status !== 'pending') { cancelExpiry(); setStatus('Sign-in failed. Try again.'); setBusy(false); return; }
          setStatus('Waiting for approval…');
          later();
        } catch {
          // A dropped request is not a failed sign-in — the grant is still
          // pending upstream, so keep polling instead of discarding it.
          if (attempt.isCurrent()) { setStatus('Network hiccup — retrying…'); later(); }
        }
      };
      later();
    } catch (e) {
      if (!attempt.isCurrent()) return;
      cancelBeginTimeout();
      setStatus(`Sign-in failed: ${(e as Error).message}`);
      setBusy(false);
    }
  };

  const disconnect = async () => {
    signInActive.current = false;
    setBusy(true); setStatus('Disconnecting…');
    try { await xaiDisconnect(); onDone(); setStatus(''); } catch (e) { setStatus((e as Error).message); }
    setBusy(false);
  };

  const refreshModels = async () => {
    signInActive.current = false;
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
        {allowCancel && busy && device && signInActive.current ? <Button variant="ghost" size="sm" onClick={stopWaiting}>Stop waiting</Button> : null}
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
export function XaiLoginForm({ embedded = false, onboarding = false, onBusyChange }: {
  embedded?: boolean; onboarding?: boolean; onBusyChange?: (busy: boolean) => void;
} = {}) {
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
        {auth.isLoading ? <span role="status" className="text-muted">Checking your xAI sign-in…</span>
          : auth.isError || typeof auth.data?.connected !== 'boolean' ? <span role="status" className="text-muted">Could not confirm your xAI sign-in. <Button variant="link" size="sm" onClick={() => void auth.refetch()}>Try again</Button></span>
          : connected
          ? <span className="inline-flex items-center gap-1 text-success"><Check className="h-4 w-4" aria-hidden /> Connected · subscription billing</span>
          : <span className="text-muted">Not connected. Sign in with your xAI account to use Grok as a brain, worker, or judge.</span>}
      </div>
      <XaiSignIn connected={connected} onDone={refetch} onBusyChange={onBusyChange} allowCancel={onboarding} />
    </>
  );

  if (embedded) return <div>{body}</div>;
  return <div className="rounded-lg border border-border bg-canvas p-4">{body}</div>;
}
