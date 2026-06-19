import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, KeyRound, RotateCw, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { usePoll } from '@/lib/poll';
import { clemmy } from '@/lib/clemmy';
import { getCredentials, codexReauthLocal, codexDeviceBegin, codexDevicePoll } from '@/lib/connect';

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

export function CodexReauth({ signedIn, onDone }: { signedIn: boolean; onDone: () => void }) {
  const [localState, setLocalState] = useState<'idle' | 'opening' | 'done'>('idle');
  const [localErr, setLocalErr] = useState('');
  const [device, setDevice] = useState<{ uri: string; code: string } | null>(null);
  const [deviceStatus, setDeviceStatus] = useState('');
  const [deviceBusy, setDeviceBusy] = useState(false);

  const runLocal = async () => {
    setLocalErr(''); setLocalState('opening');
    try {
      const r = await codexReauthLocal();
      if (r && r.ok) {
        setLocalState('done'); onDone();
        setTimeout(() => setLocalState('idle'), 2500);
      } else {
        setLocalState('idle'); setLocalErr((r && (r.message || r.error)) || 'Re-auth failed.');
      }
    } catch (e) { setLocalState('idle'); setLocalErr((e as Error).message || 'Re-auth failed.'); }
  };

  const runRemote = async () => {
    setLocalErr(''); setDeviceBusy(true); setDeviceStatus('Requesting a sign-in code…'); setDevice(null);
    try {
      const start = await codexDeviceBegin();
      if (!start.loginId || !start.verificationUri || !start.userCode) {
        setDeviceStatus(`Couldn't start device login: ${start.error || start.message || 'unknown error'}`); setDeviceBusy(false); return;
      }
      setDevice({ uri: start.verificationUri, code: start.userCode });
      setDeviceStatus('Waiting for sign-in…');
      const intervalMs = Math.max(3, start.intervalSeconds || 5) * 1000;
      const expiresAt = start.expiresAt ? Date.parse(start.expiresAt) : Date.now() + 900_000;
      const loginId = start.loginId;
      const poll = async () => {
        if (Date.now() > expiresAt) { setDeviceStatus('Code expired — click “Sign in on another device” to retry.'); setDeviceBusy(false); return; }
        try {
          const res = await codexDevicePoll(loginId);
          if (res.status === 'complete') {
            setDeviceStatus('Signed in ✓'); onDone();
            setTimeout(() => { setDevice(null); setDeviceStatus(''); setDeviceBusy(false); }, 2500);
            return;
          }
          if (res.status === 'expired') { setDeviceStatus('Code expired — try again.'); setDeviceBusy(false); return; }
          setDeviceStatus('Waiting for sign-in…'); setTimeout(poll, intervalMs); // pending
        } catch { setDeviceStatus('Network hiccup — retrying…'); setTimeout(poll, intervalMs); }
      };
      setTimeout(poll, intervalMs);
    } catch (e) { setDeviceStatus(`Device login failed: ${(e as Error).message}`); setDeviceBusy(false); }
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
export function CodexLoginForm({ embedded = false }: { embedded?: boolean } = {}) {
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
        {signedIn
          ? <span className="inline-flex items-center gap-1 text-success"><Check className="h-4 w-4" aria-hidden /> Signed in · subscription billing ✓</span>
          : <span className="text-muted">Not signed in. Connect your Codex/OpenAI subscription below.</span>}
      </div>
      <CodexReauth signedIn={signedIn} onDone={refetch} />
    </>
  );

  if (embedded) return <div>{body}</div>;
  return <div className="rounded-lg border border-border bg-canvas p-4">{body}</div>;
}
