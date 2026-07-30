/**
 * Mobile setup panel.
 *
 * The phone connects through the pinned-TLS direct-app door: the daemon opens
 * its own door at boot and the Clem app connects straight to this Mac —
 * nothing in between. Setup is: scan the code from the app. There is no
 * tunnel, no helper install, no third-party account.
 *
 * The panel deliberately renders `data.setup`, a view derived once on the
 * server, rather than recomputing "what state are we in?" from raw status.
 * Surfaces used to do that independently and disagreed with each other.
 */
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  Loader2,
  Smartphone,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { StatusPill } from '@/components/ui/StatusPill';
import { usePoll } from '@/lib/poll';
import {
  getMobileStatus,
  qrSrc,
  revokeAllMobileSessions,
  setMobilePin,
  setupMobileAccess,
  type MobileSetupView,
} from '@/lib/connect';

interface MobileStatusShape {
  setup?: MobileSetupView;
  pin?: { configured?: boolean; updatedAt?: string };
  target?: { url?: string; qrReady?: boolean };
}

const PIN_OK = (p: string) => p.length >= 8 && p.length <= 64 && /[a-zA-Z]/.test(p) && /\d/.test(p) && /[^a-zA-Z0-9]/.test(p);

function ActionNote({ tone = 'neutral', children }: { tone?: 'neutral' | 'warning' | 'success' | 'error'; children: ReactNode }) {
  const cls = tone === 'success'
    ? 'border-success/30 bg-success/10 text-success'
    : tone === 'warning'
      ? 'border-warning/40 bg-warning/10 text-warning'
      : tone === 'error'
        ? 'border-danger/40 bg-danger-tint text-danger'
        : 'border-border bg-subtle text-muted';
  return <p className={`rounded-md border px-3 py-2 text-small ${cls}`}>{children}</p>;
}

export function MobilePanel() {
  const qc = useQueryClient();
  const mobile = usePoll(['mobile-status'], getMobileStatus, 10000);
  const data = mobile.data as MobileStatusShape | undefined;
  const setup = data?.setup;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pin, setPin] = useState('');
  const [pinSaved, setPinSaved] = useState(false);

  const refresh = () => qc.invalidateQueries({ queryKey: ['mobile-status'] });

  async function runSetup() {
    setBusy(true);
    setError('');
    try {
      // Idempotent server-side, so this doubles as the retry action.
      await setupMobileAccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      refresh();
    }
  }

  async function withBusy(fn: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      refresh();
    }
  }

  if (!setup) {
    return (
      <Card className="p-5">
        <div className="flex items-center gap-2 text-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          <span className="text-small">Checking mobile access…</span>
        </div>
      </Card>
    );
  }

  const phase = setup.phase;

  return (
    <Card className="space-y-5 p-5">
      <header className="flex items-start gap-3">
        <Smartphone className="mt-0.5 h-5 w-5 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 className="text-body font-semibold text-fg">{setup.headline}</h3>
          {setup.detail ? <p className="mt-1 text-small text-muted">{setup.detail}</p> : null}
        </div>
        {phase === 'live' ? <StatusPill tone="success">Live</StatusPill> : null}
      </header>

      {/* The single primary action. Same call in every non-live state, because
          ensureMobileAccess resumes from wherever setup actually is. */}
      {phase !== 'live' ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={runSetup} disabled={busy}>
            {phase === 'error' ? (setup.failure?.remedy.label ?? 'Try again') : 'Check again'}
          </Button>
          {setup.failure?.remedy.url ? (
            <a
              className="inline-flex items-center rounded-md px-3 py-1.5 text-small text-muted hover:text-fg"
              href={setup.failure.remedy.url}
              target="_blank"
              rel="noreferrer"
            >
              Open guide <ExternalLink className="ml-1.5 h-3.5 w-3.5" aria-hidden />
            </a>
          ) : null}
          {setup.failure?.remedy.command ? (
            <Button
              variant="ghost"
              onClick={() => void navigator.clipboard?.writeText(setup.failure!.remedy.command!)}
            >
              <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden /> Copy command
            </Button>
          ) : null}
        </div>
      ) : null}

      {setup.failure ? (
        <ActionNote tone="error">
          <AlertTriangle className="mr-1.5 inline h-3.5 w-3.5" aria-hidden />
          {setup.failure.message}
        </ActionNote>
      ) : null}
      {error ? <ActionNote tone="error">{error}</ActionNote> : null}

      {phase === 'live' && setup.qrReady ? (
        <div className="flex flex-col items-center gap-3 rounded-md border border-border bg-canvas p-4">
          <img src={qrSrc()} alt="Pairing QR code" className="h-[280px] w-[280px] rounded bg-white p-2" />
          <p className="text-small text-muted">Scan from the Clem app — not the camera app.</p>
          {setup.url ? <code className="max-w-full truncate text-caption text-muted">{setup.url}</code> : null}
        </div>
      ) : null}

      <section>
        <div className="mb-2 flex items-center gap-2">
          <h4 className="text-small font-semibold text-fg">Paired devices</h4>
          <StatusPill tone={setup.devices.length > 0 ? 'success' : 'neutral'}>{setup.devices.length}</StatusPill>
        </div>
        {setup.devices.length === 0 ? (
          <p className="text-small text-muted">No phones paired yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {setup.devices.map((device) => (
              <li key={device.deviceId} className="flex items-center gap-2 text-small text-muted">
                <Check className="h-3.5 w-3.5 text-success" aria-hidden />
                <span className="text-fg">{device.deviceLabel || device.deviceId}</span>
                <span>· last seen {new Date(device.lastSeenAt).toLocaleString()}</span>
                {device.pushSubscribed ? <StatusPill tone="success">Push on</StatusPill> : null}
              </li>
            ))}
          </ul>
        )}
        {setup.devices.length > 0 ? (
          <Button variant="ghost" className="mt-2" onClick={() => withBusy(revokeAllMobileSessions)} disabled={busy}>
            Sign out all devices
          </Button>
        ) : null}
      </section>

      {/* Optional hardening, not setup. */}
      <details className="rounded-md border border-border bg-canvas p-4">
        <summary className="cursor-pointer text-small font-semibold text-fg">Advanced</summary>
        <div className="mt-4 space-y-5">
          <div>
            <h5 className="text-small font-semibold text-fg">PIN fallback</h5>
            <p className="mt-1 text-small text-muted">
              Optional. Lets you sign in from a new phone when you are away from this Mac and cannot
              scan the code. At least 8 characters with a letter, a number, and a symbol.
            </p>
            <form
              className="mt-3 flex flex-wrap items-end gap-2"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                void withBusy(async () => {
                  await setMobilePin(pin);
                  setPin('');
                  setPinSaved(true);
                });
              }}
            >
              <Input type="password" value={pin} onChange={(e) => setPin(e.currentTarget.value)} placeholder="New PIN" />
              <Button type="submit" disabled={busy || !PIN_OK(pin)}>
                {data?.pin?.configured ? 'Change PIN' : 'Set PIN'}
              </Button>
            </form>
            {pinSaved ? <ActionNote tone="success">PIN saved. Existing sessions were signed out.</ActionNote> : null}
          </div>
        </div>
      </details>
    </Card>
  );
}
