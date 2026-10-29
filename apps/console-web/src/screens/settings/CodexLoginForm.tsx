import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, KeyRound, RotateCw, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { usePoll } from '@/lib/poll';
import { clemmy } from '@/lib/clemmy';
import { getCredentials, codexReauthLocal, codexDeviceBegin, codexDevicePoll } from '@/lib/connect';
import { createSignInAttemptOwner, deviceSignInDeadline, deviceSignInPollDelay } from '@/lib/sign-in-attempt';

/**
 * Codex (OpenAI) re-auth — the SAME proven daemon endpoints the legacy console
 * uses (/api/console/auth/codex-login + the codex-device flow). Extracted here
 * from Connect.tsx so it can ALSO render in Settings → Models & routing next to
 * the Claude login (parity): before this, the new app had Claude sign-in inline
 * but Codex sign-in only via a "Manage" link to the legacy app.
 * LOCAL: opens a browser + loopback callback on the daemon (desktop only).
 * REMOTE: device-code flow that works from any device.
 */
const isDesktop = () => clemmy() !== null;

export function CodexReauth({ signedIn, onDone, onBusyChange, allowCancel = false }: {
  signedIn: boolean; onDone: () => void; onBusyChange?: (busy: boolean) => void; allowCancel?: boolean;
}) {
  const [localState, setLocalState] = useState<'idle' | 'opening' | 'done'>('idle');
  const [localErr, setLocalErr] = useState('');
  const [device, setDevice] = useState<{ uri: string; code: string } | null>(null);
  const [deviceStatus, setDeviceStatus] = useState('');
  const [deviceBusy, setDeviceBusy] = useState(false);
  const attempts = useRef(createSignInAttemptOwner());
  useEffect(() => () => attempts.current.stop(), []);
  const pending = localState === 'opening' || deviceBusy;
  useEffect(() => { onBusyChange?.(pending); }, [pending, onBusyChange]);
  const stopWaiting = () => {
    attempts.current.stop(); setLocalState('idle'); setDeviceBusy(false); setDevice(null); setLocalErr('');
    setDeviceStatus('Stopped waiting here. If you finished in the browser, refresh your sign-in status.');
    onDone();
  };

  const runLocal = async () => {
    const attempt = attempts.current.begin();
    setDevice(null); setDeviceStatus(''); setDeviceBusy(false);
    setLocalErr(''); setLocalState('opening');
    try {
      const r = await codexReauthLocal(attempt.signal);
      if (!attempt.isCurrent()) return;
      if (r && r.ok) {
        setLocalState('done'); onDone();
        attempt.later(() => setLocalState('idle'), 2500);
      } else {
        setLocalState('idle'); setLocalErr((r && (r.message || r.error)) || 'Re-auth failed.');
      }
    } catch (e) { if (attempt.isCurrent()) { setLocalState('idle'); setLocalErr((e as Error).message || 'Re-auth failed.'); } }
  };

  const runRemote = async () => {
    const attempt = attempts.current.begin();
    setLocalState('idle');
    setLocalErr(''); setDeviceBusy(true); setDeviceStatus('Requesting a sign-in code…'); setDevice(null);
    const cancelBeginTimeout = attempt.later(() => {
      setDeviceStatus('The sign-in code request timed out. Try again.'); setDeviceBusy(false); attempt.stop();
    }, 30_000);
    try {
      const start = await codexDeviceBegin(attempt.signal);
      if (!attempt.isCurrent()) return;
      cancelBeginTimeout();
      if (!start.loginId || !start.verificationUri || !start.userCode) {
        setDeviceStatus(`Couldn't start device login: ${start.error || start.message || 'unknown error'}`); setDeviceBusy(false); return;
      }
      const expiresAt = deviceSignInDeadline(start.expiresAt, 900_000);
      if (expiresAt === null) { setDeviceStatus('Couldn’t confirm the sign-in code’s expiry. Try again.'); setDeviceBusy(false); return; }
      setDevice({ uri: start.verificationUri, code: start.userCode });
      setDeviceStatus('Waiting for sign-in…');
      const intervalMs = deviceSignInPollDelay(start.intervalSeconds);
      const loginId = start.loginId;
      const expired = () => {
        setDeviceStatus('Code expired — click “Sign in on another device” to retry.'); setDeviceBusy(false); attempt.stop();
      };
      const cancelExpiry = attempt.later(expired, Math.max(1, expiresAt - Date.now()));
      const later = () => attempt.later(() => { void poll(); }, Math.min(intervalMs, Math.max(1, expiresAt - Date.now())));
      const poll = async () => {
        if (!attempt.isCurrent()) return;
        if (Date.now() >= expiresAt) { expired(); return; }
        try {
          const res = await codexDevicePoll(loginId, attempt.signal);
          if (!attempt.isCurrent()) return;
          if (res.status === 'complete') {
            cancelExpiry();
            setDeviceStatus('Signed in'); onDone();
            attempt.later(() => { setDevice(null); setDeviceStatus(''); setDeviceBusy(false); }, 2500);
            return;
          }
          if (res.status === 'expired') { cancelExpiry(); setDeviceStatus('Code expired — try again.'); setDeviceBusy(false); return; }
          if (res.status !== 'pending') { cancelExpiry(); setDeviceStatus(res.message || res.error || 'Sign-in failed. Try again.'); setDeviceBusy(false); return; }
          setDeviceStatus('Waiting for sign-in…'); later();
        } catch { if (attempt.isCurrent()) { setDeviceStatus('Network hiccup — retrying…'); later(); } }
      };
      later();
    } catch (e) { if (attempt.isCurrent()) { cancelBeginTimeout(); setDeviceStatus(`Device login failed: ${(e as Error).message}`); setDeviceBusy(false); } }
  };

  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-2">
        {isDesktop() && (
          <Button size="sm" onClick={runLocal} disabled={localState !== 'idle'}>
            {localState === 'opening' ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Opening browser…</>
              : localState === 'done' ? <><Check className="h-4 w-4" aria-hidden /> Re-authenticated</>
              : <><KeyRound className="h-4 w-4" aria-hidden /> {signedIn ? 'Re-authenticate' : 'Sign in'}</>}
          </Button>
        )}
        <Button variant={isDesktop() ? 'ghost' : 'primary'} size="sm" onClick={runRemote} disabled={deviceBusy}>
          <RotateCw className="h-4 w-4" aria-hidden /> Sign in on another device
        </Button>
        {allowCancel && pending ? <Button variant="ghost" size="sm" onClick={stopWaiting}>Stop waiting</Button> : null}
      </div>
      {localErr && <p className="mt-2 text-caption text-danger">{localErr}</p>}
      {device && (
        <div className="mt-2 rounded-md border border-border bg-subtle p-2.5 text-small text-muted">
          Open <a href={device.uri} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{device.uri}</a> and enter code: <b className="tracking-wide text-fg">{device.code}</b>
        </div>
      )}
      {deviceStatus && <p className="mt-1 text-caption text-faint">{deviceStatus}</p>}
    </div>
  );
}

/**
 * Self-contained Codex sign-in for Settings (mirrors ClaudeLoginForm `embedded`).
 * Fetches its own signed-in status from the credentials snapshot so it can stand
 * alone in Models & routing next to the Claude login.
 */
export function CodexLoginForm({ embedded = false, onboarding = false, onBusyChange }: {
  embedded?: boolean; onboarding?: boolean; onBusyChange?: (busy: boolean) => void;
} = {}) {
  const qc = useQueryClient();
  const creds = usePoll(['credentials'], getCredentials, 0);
  const signedIn = Boolean(creds.data?.auth?.codexOauthPresent);
  const refetch = () => { void qc.invalidateQueries({ queryKey: ['credentials'] }); void qc.invalidateQueries({ queryKey: ['settings'] }); };

  const body = (
    <>
      <div className="mb-1 flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-muted" aria-hidden />
        <h4 className="text-label text-fg">Codex (OpenAI) sign-in</h4>
      </div>
      <div className="rounded-lg border border-border bg-canvas p-3 text-small">
        {creds.isLoading ? <span role="status" className="text-muted">Checking your Codex sign-in…</span>
          : creds.isError || typeof creds.data?.auth?.codexOauthPresent !== 'boolean' ? <span role="status" className="text-muted">Could not confirm your Codex sign-in. <Button variant="link" size="sm" onClick={() => void creds.refetch()}>Try again</Button></span>
          : signedIn
          ? <span className="inline-flex items-center gap-1 text-success"><Check className="h-4 w-4" aria-hidden /> Signed in · subscription billing</span>
          : <span className="text-muted">Not signed in. Connect your Codex/OpenAI subscription below.</span>}
      </div>
      <CodexReauth signedIn={signedIn} onDone={refetch} onBusyChange={onBusyChange} allowCancel={onboarding} />
    </>
  );

  if (embedded) return <div>{body}</div>;
  return <div className="rounded-lg border border-border bg-canvas p-4">{body}</div>;
}
