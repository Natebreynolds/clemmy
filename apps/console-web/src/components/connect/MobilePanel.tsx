import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Smartphone, Loader2, Check } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { StatusPill } from '@/components/ui/StatusPill';
import { usePoll } from '@/lib/poll';
import { getMobileStatus, startQuickTunnel, setMobilePin, revokeAllMobileSessions, qrSrc } from '@/lib/connect';

interface MobileStatusShape {
  state?: { status?: string };
  sessions?: unknown[];
  pin?: { configured?: boolean };
}
const PIN_OK = (p: string) => p.length >= 8 && p.length <= 64 && /[a-zA-Z]/.test(p) && /\d/.test(p) && /[^a-zA-Z0-9]/.test(p);

export function MobilePanel() {
  const qc = useQueryClient();
  const mobile = usePoll(['mobile-status'], getMobileStatus, 20000);
  const data = mobile.data as MobileStatusShape | undefined;
  // Running state + session count live in the real payload shape.
  const running = data?.state?.status === 'running';
  const sessions = Array.isArray(data?.sessions) ? data!.sessions!.length : 0;
  const pinConfigured = Boolean(data?.pin?.configured);

  const [localPairing, setLocalPairing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [pin, setPin] = useState('');
  const [pinSaved, setPinSaved] = useState(false);
  const [error, setError] = useState('');
  // Show the QR whenever a tunnel is up (survives reload), or right after Pair.
  const pairing = localPairing || running;

  const pair = async () => {
    setStarting(true); setError('');
    try {
      const r = await startQuickTunnel();
      if (r.ok) setLocalPairing(true);
      else setError(r.error || 'Could not start pairing.');
      void qc.invalidateQueries({ queryKey: ['mobile-status'] });
    } catch (e) { setError((e as Error).message); }
    finally { setStarting(false); }
  };

  const savePin = async () => {
    if (!PIN_OK(pin)) { setError('PIN must be 8–64 characters with a mix of letters, numbers, and symbols.'); return; }
    setError('');
    try { await setMobilePin(pin); setPin(''); setPinSaved(true); void qc.invalidateQueries({ queryKey: ['mobile-status'] }); }
    catch (e) { setError((e as Error).message); }
  };

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center gap-2.5">
        <Smartphone className="h-5 w-5 text-primary" aria-hidden />
        <div className="flex-1">
          <h3 className="text-h3 text-fg">Your phone</h3>
          <p className="text-small text-muted">Chat with Clementine from your phone.</p>
        </div>
        <StatusPill tone={running ? 'success' : 'neutral'}>{running ? 'On' : 'Off'}</StatusPill>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <h4 className="mb-1 text-body font-semibold text-fg">1. Pair your phone</h4>
          <p className="mb-2 text-small text-muted">Start a quick, temporary link and scan the code.</p>
          {!pairing ? (
            <Button size="sm" onClick={pair} disabled={starting}>
              {starting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Smartphone className="h-4 w-4" aria-hidden />} Pair your phone
            </Button>
          ) : (
            <div className="inline-block rounded-lg border border-border bg-white p-2">
              {/* QR endpoint returns an SVG image; auth via cookie (prod) or ?token (dev). */}
              <img src={qrSrc()} alt="Pairing QR code" width={160} height={160} />
            </div>
          )}
        </div>

        <div>
          <h4 className="mb-1 text-body font-semibold text-fg">2. {pinConfigured ? 'Change your PIN' : 'Set a PIN'}</h4>
          <p className="mb-2 text-small text-muted">8–64 characters, mixing letters, numbers, and symbols.</p>
          <div className="flex gap-2">
            <Input type="password" value={pin} onChange={(e) => { setPin(e.target.value); setPinSaved(false); }} placeholder={pinConfigured ? 'Enter a new PIN' : 'Choose a PIN'} aria-label="Mobile PIN" className="flex-1" />
            <Button size="sm" onClick={savePin} disabled={!PIN_OK(pin)}>Save</Button>
          </div>
          {pinSaved
            ? <span className="mt-1 inline-flex items-center gap-1 text-small text-success"><Check className="h-4 w-4" aria-hidden /> PIN set</span>
            : pinConfigured && <span className="mt-1 inline-flex items-center gap-1 text-small text-muted"><Check className="h-4 w-4" aria-hidden /> A PIN is set</span>}
        </div>
      </div>

      {error && <p className="mt-3 text-small text-danger">{error}</p>}

      <div className="mt-4 flex items-center gap-3 border-t border-border pt-3">
        <span className="flex-1 text-small text-muted">{sessions > 0 ? `${sessions} device${sessions === 1 ? '' : 's'} connected` : 'No devices connected'}</span>
        {sessions > 0 && (
          <Button variant="ghost" size="sm" onClick={async () => { await revokeAllMobileSessions(); void qc.invalidateQueries({ queryKey: ['mobile-status'] }); }}>
            Disconnect all
          </Button>
        )}
        <a href="/console-legacy" target="_self" className="text-small text-primary hover:underline">Custom domain →</a>
      </div>
    </Card>
  );
}
