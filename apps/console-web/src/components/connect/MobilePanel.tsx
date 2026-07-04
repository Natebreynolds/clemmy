import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  ExternalLink,
  Globe2,
  KeyRound,
  Loader2,
  Play,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Square,
  Wifi,
  type LucideIcon,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { StatusPill } from '@/components/ui/StatusPill';
import { usePoll } from '@/lib/poll';
import {
  cancelMobileCloudflareLogin,
  configureMobileTunnel,
  confirmMobileCloudflareAccess,
  getMobileStatus,
  installMobileCloudflared,
  qrSrc,
  revokeAllMobileSessions,
  setMobilePin,
  startMobileCloudflareLogin,
  startMobileTunnel,
  startQuickTunnel,
  stopMobileTunnel,
} from '@/lib/connect';

interface MobileTarget {
  url?: string;
  mode?: 'local-preview' | 'quick' | 'custom-domain';
  qrReady?: boolean;
  qrBlockedReason?: string;
}

interface MobileAccessTunnel {
  id?: string;
  name?: string;
  hostname?: string;
  mode?: 'named' | 'quick';
}

interface MobileAccessAck {
  hostname?: string;
  acknowledged?: boolean;
  enabled?: boolean;
}

interface MobileStatusShape {
  detect?: { binary?: string | null; version?: string | null; source?: string | null };
  state?: {
    status?: string;
    tunnel?: MobileAccessTunnel | null;
    autoStart?: boolean;
    lastError?: string;
    cloudflareAccess?: MobileAccessAck;
  };
  sessions?: Array<{ deviceId?: string; deviceLabel?: string; lastSeenAt?: string; pushSubscribed?: boolean }>;
  pin?: { configured?: boolean; updatedAt?: string };
  login?: { active?: boolean; url?: string; certPresent?: boolean; certUpdatedAt?: string; outcome?: { ok?: boolean; error?: string } };
  tunnel?: { running?: boolean; connected?: boolean; startedAt?: string };
  target?: MobileTarget;
}

const PIN_OK = (p: string) => p.length >= 8 && p.length <= 64 && /[a-zA-Z]/.test(p) && /\d/.test(p) && /[^a-zA-Z0-9]/.test(p);

function Step({ icon: Icon, title, meta, children }: {
  icon: LucideIcon;
  title: string;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-md border border-border bg-canvas p-4">
      <div className="mb-3 flex items-center gap-2.5">
        <Icon className="h-4 w-4 text-primary" aria-hidden />
        <h4 className="min-w-0 flex-1 text-body font-semibold text-fg">{title}</h4>
        {meta}
      </div>
      {children}
    </section>
  );
}

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
  const state = data?.state;
  const target = data?.target;
  const tunnel = state?.tunnel ?? null;
  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  const pinConfigured = Boolean(data?.pin?.configured);
  const binaryInstalled = Boolean(data?.detect?.binary);
  const loggedIn = Boolean(data?.login?.certPresent);
  const isQuick = tunnel?.mode === 'quick';
  const customHost = !isQuick ? tunnel?.hostname : undefined;
  const accessAck = state?.cloudflareAccess;
  const accessConfirmed = Boolean(
    customHost
    && accessAck?.enabled
    && accessAck?.acknowledged
    && accessAck.hostname?.toLowerCase() === customHost.toLowerCase(),
  );
  const running = Boolean(data?.tunnel?.running);
  const connected = Boolean(data?.tunnel?.connected);
  const ready = Boolean(target?.qrReady);

  const [pin, setPin] = useState('');
  const [pinSaved, setPinSaved] = useState(false);
  const [tunnelName, setTunnelName] = useState(tunnel?.name && !isQuick ? tunnel.name : 'clem-laptop');
  const [hostname, setHostname] = useState(customHost ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const refresh = () => qc.invalidateQueries({ queryKey: ['mobile-status'] });

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const savePin = async () => {
    if (!PIN_OK(pin)) {
      setError('PIN must be 8-64 characters with a mix of letters, numbers, and symbols.');
      return;
    }
    await run('pin', async () => {
      await setMobilePin(pin);
      setPin('');
      setPinSaved(true);
    });
  };

  const configure = async (event: FormEvent) => {
    event.preventDefault();
    await run('configure', () => configureMobileTunnel({ tunnelName: tunnelName.trim(), hostname: hostname.trim() }));
  };

  const statusTone = ready ? 'success' : running ? 'warning' : 'neutral';
  const statusText = ready ? 'Ready' : running ? 'Starting' : customHost ? 'Configured' : 'Setup needed';

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center gap-2.5">
        <Smartphone className="h-5 w-5 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 className="text-h3 text-fg">Mobile access</h3>
          <p className="text-small text-muted">Use a permanent Cloudflare hostname for phone access that survives restarts.</p>
        </div>
        <StatusPill tone={statusTone}>{statusText}</StatusPill>
      </div>

      {error && <ActionNote tone="error">{error}</ActionNote>}
      {state?.lastError && !error && <div className="mb-3"><ActionNote tone="error">{state.lastError}</ActionNote></div>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Step icon={Wifi} title="1. Install cloudflared" meta={<StatusPill tone={binaryInstalled ? 'success' : 'neutral'}>{binaryInstalled ? 'Installed' : 'Missing'}</StatusPill>}>
          <p className="mb-3 text-small text-muted">
            Clementine uses Cloudflare Tunnel to publish the local mobile app without opening a public port on this Mac.
          </p>
          <ActionNote tone={binaryInstalled ? 'success' : 'neutral'}>
            {binaryInstalled
              ? `${data?.detect?.binary} (${data?.detect?.version ?? 'unknown'})`
              : 'Install the Cloudflare tunnel helper, then re-detect it.'}
          </ActionNote>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => run('install', installMobileCloudflared)} disabled={Boolean(busy)}>
              {busy === 'install' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Wifi className="h-4 w-4" aria-hidden />}
              Install
            </Button>
            <Button size="sm" variant="secondary" onClick={refresh} disabled={Boolean(busy)}>
              <RefreshCw className="h-4 w-4" aria-hidden /> Re-detect
            </Button>
          </div>
        </Step>

        <Step icon={Globe2} title="2. Connect a hostname" meta={<StatusPill tone={customHost ? 'success' : loggedIn ? 'warning' : 'neutral'}>{customHost ? 'Routed' : loggedIn ? 'Signed in' : 'Not signed in'}</StatusPill>}>
          <p className="mb-3 text-small text-muted">
            Sign in to Cloudflare, then route a hostname like clem.yourdomain.com to this Mac.
          </p>
          {!customHost && (
            <div className="mb-3 rounded-md border border-border bg-subtle p-3">
              <div className="mb-1 text-small font-semibold text-fg">No domain yet?</div>
              <p className="mb-3 text-small text-muted">
                Permanent mobile access needs a domain you control. The simplest path is buying one through Cloudflare, then using a subdomain like clem.yourdomain.com here.
              </p>
              <div className="flex flex-wrap gap-2">
                <a
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border bg-surface px-3 text-small font-semibold text-fg hover:bg-hover"
                  href="https://dash.cloudflare.com/sign-up/registrar"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="h-4 w-4" aria-hidden /> Buy a domain
                </a>
                <Button size="sm" variant="secondary" onClick={() => run('quick', startQuickTunnel)} disabled={Boolean(busy) || !binaryInstalled}>
                  {busy === 'quick' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Smartphone className="h-4 w-4" aria-hidden />}
                  Use temporary link
                </Button>
              </div>
            </div>
          )}
          {data?.login?.active ? (
            <ActionNote tone="warning">
              Open the Cloudflare login URL: {' '}
              {data.login.url ? <a className="underline" href={data.login.url} target="_blank" rel="noopener noreferrer">Authorize cloudflared</a> : 'waiting for URL...'}
            </ActionNote>
          ) : loggedIn ? (
            <ActionNote tone="success">Cloudflare login certificate is present.</ActionNote>
          ) : (
            <ActionNote>Cloudflare sign-in is required before Clementine can create or route a permanent tunnel.</ActionNote>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => run('login', startMobileCloudflareLogin)} disabled={Boolean(busy) || !binaryInstalled}>
              {busy === 'login' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ExternalLink className="h-4 w-4" aria-hidden />}
              Sign in
            </Button>
            {data?.login?.active && (
              <Button size="sm" variant="secondary" onClick={() => run('cancel-login', cancelMobileCloudflareLogin)} disabled={Boolean(busy)}>
                Cancel
              </Button>
            )}
          </div>

          <form onSubmit={configure} className="mt-4 grid gap-2">
            <Input value={tunnelName} onChange={(e) => setTunnelName(e.target.value)} placeholder="clem-laptop" aria-label="Tunnel name" />
            <Input value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="clem.yourdomain.com" aria-label="Mobile hostname" />
            <Button size="sm" type="submit" disabled={Boolean(busy) || !binaryInstalled || !loggedIn || !tunnelName.trim() || !hostname.trim()}>
              {busy === 'configure' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Globe2 className="h-4 w-4" aria-hidden />}
              Create tunnel + route DNS
            </Button>
          </form>
        </Step>

        <Step icon={ShieldCheck} title="3. Require Cloudflare Access" meta={<StatusPill tone={accessConfirmed ? 'success' : 'neutral'}>{accessConfirmed ? 'Confirmed' : 'Required'}</StatusPill>}>
          <p className="mb-3 text-small text-muted">
            Add a self-hosted Cloudflare Access app for your hostname and allow only your email before Clementine shows the permanent QR.
          </p>
          <ol className="mb-3 list-decimal space-y-1 pl-5 text-small text-muted">
            <li>Open Cloudflare Zero Trust.</li>
            <li>Create a self-hosted application for {customHost || 'your mobile hostname'}.</li>
            <li>Add an Allow policy for your email address.</li>
          </ol>
          <div className="flex flex-wrap gap-2">
            <a
              className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border bg-surface px-3 text-small font-semibold text-fg hover:bg-hover"
              href="https://one.dash.cloudflare.com/"
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink className="h-4 w-4" aria-hidden /> Open Zero Trust
            </a>
            <Button size="sm" onClick={() => run('access', confirmMobileCloudflareAccess)} disabled={Boolean(busy) || !customHost}>
              {busy === 'access' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ShieldCheck className="h-4 w-4" aria-hidden />}
              I enabled Access
            </Button>
          </div>
        </Step>

        <Step icon={QrCode} title="4. Start and pair" meta={<StatusPill tone={ready ? 'success' : connected ? 'warning' : 'neutral'}>{ready ? 'QR ready' : connected ? 'Connected' : 'Not ready'}</StatusPill>}>
          <p className="mb-3 text-small text-muted">
            The QR appears only after the public HTTPS target is reachable and protected.
          </p>
          <div className="mb-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => run('start', startMobileTunnel)} disabled={Boolean(busy) || !customHost || !accessConfirmed}>
              {busy === 'start' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
              Start remote URL
            </Button>
            <Button size="sm" variant="secondary" onClick={() => run('stop', stopMobileTunnel)} disabled={Boolean(busy) || !running}>
              <Square className="h-4 w-4" aria-hidden /> Stop
            </Button>
          </div>
          {ready ? (
            <div className="inline-block rounded-md border border-border bg-white p-2">
              <img src={qrSrc()} alt="Pairing QR code" width={180} height={180} />
            </div>
          ) : (
            <ActionNote tone={target?.mode === 'local-preview' ? 'warning' : 'neutral'}>
              {target?.qrBlockedReason ?? 'Complete the setup steps before scanning a phone QR.'}
            </ActionNote>
          )}
          {target?.url && <p className="mt-2 break-all text-caption text-muted">{target.url}</p>}
        </Step>
      </div>

      <div className="mt-4 rounded-md border border-warning/30 bg-warning/10 p-4">
        <div className="mb-2 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-warning" aria-hidden />
          <h4 className="text-body font-semibold text-fg">Temporary preview</h4>
        </div>
        <p className="mb-3 text-small text-muted">
          Quick links use a random trycloudflare.com URL. They are useful before permanent setup, but the URL changes after restarts.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => run('quick', startQuickTunnel)} disabled={Boolean(busy) || !binaryInstalled || Boolean(customHost)}>
            {busy === 'quick' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Smartphone className="h-4 w-4" aria-hidden />}
            Start temporary link
          </Button>
          {isQuick && running && (
            <Button size="sm" variant="secondary" onClick={() => run('stop', stopMobileTunnel)} disabled={Boolean(busy)}>
              Stop temporary link
            </Button>
          )}
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Step icon={KeyRound} title={pinConfigured ? 'PIN fallback' : 'Set PIN fallback'} meta={<StatusPill tone={pinConfigured ? 'success' : 'neutral'}>{pinConfigured ? 'Set' : 'Missing'}</StatusPill>}>
          <p className="mb-3 text-small text-muted">Use this if QR pairing is unavailable. Rotating it disconnects existing mobile sessions.</p>
          <div className="flex gap-2">
            <Input type="password" value={pin} onChange={(e) => { setPin(e.target.value); setPinSaved(false); }} placeholder={pinConfigured ? 'Enter a new PIN' : 'Choose a PIN'} aria-label="Mobile PIN" className="flex-1" />
            <Button size="sm" onClick={savePin} disabled={!PIN_OK(pin) || Boolean(busy)}>Save</Button>
          </div>
          {pinSaved
            ? <span className="mt-2 inline-flex items-center gap-1 text-small text-success"><Check className="h-4 w-4" aria-hidden /> PIN set</span>
            : pinConfigured && <span className="mt-2 inline-flex items-center gap-1 text-small text-muted"><Check className="h-4 w-4" aria-hidden /> A PIN is set</span>}
        </Step>

        <Step icon={Smartphone} title="Connected devices" meta={<StatusPill tone={sessions.length > 0 ? 'success' : 'neutral'}>{sessions.length}</StatusPill>}>
          {sessions.length === 0 ? (
            <p className="text-small text-muted">No devices connected.</p>
          ) : (
            <div className="space-y-2">
              {sessions.map((session) => (
                <div key={session.deviceId} className="rounded-md border border-border bg-surface px-3 py-2">
                  <div className="truncate text-small font-semibold text-fg">{session.deviceLabel || session.deviceId || 'device'}</div>
                  <div className="text-caption text-muted">last seen {session.lastSeenAt || 'unknown'} · push {session.pushSubscribed ? 'on' : 'off'}</div>
                </div>
              ))}
            </div>
          )}
          {sessions.length > 0 && (
            <Button className="mt-3" variant="ghost" size="sm" onClick={() => run('revoke', revokeAllMobileSessions)} disabled={Boolean(busy)}>
              Disconnect all
            </Button>
          )}
        </Step>
      </div>
    </Card>
  );
}
