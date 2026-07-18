import { useEffect, useState, type ReactNode } from 'react';
import { Check, MonitorUp, Sparkles, Video } from 'lucide-react';
import { Link } from 'react-router-dom';
import { DogMark } from '@/components/DogMark';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/Field';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatusPill } from '@/components/ui/StatusPill';
import { Switch } from '@/components/ui/Switch';
import { cn } from '@/lib/cn';
import { isDesktop } from '@/lib/clemmy';
import {
  getNotchSettings,
  notchRecallCapability,
  notchRecallCapabilityCopy,
  openNotchPreview,
  updateNotchSettings,
  type NotchPreferences,
  type NotchSettingsSnapshot,
} from '@/lib/notch-settings';
import { isMac } from '@/lib/platform';

const SHORTCUTS = [
  { value: 'CommandOrControl+Shift+Space', label: '⌘ ⇧ Space' },
  { value: 'CommandOrControl+Option+Space', label: '⌘ ⌥ Space' },
  { value: 'CommandOrControl+Shift+K', label: '⌘ ⇧ K' },
];

function SettingRow({
  title,
  description,
  children,
  disabled = false,
}: {
  title: string;
  description: string;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <div className={cn('flex items-center gap-4 py-4 first:pt-0 last:pb-0', disabled && 'opacity-55')}>
      <div className="min-w-0 flex-1">
        <div className="text-body font-semibold text-fg">{title}</div>
        <p className="mt-0.5 text-small text-muted">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function NotchSettingsCard() {
  const nativeHost = isMac() && isDesktop();
  const [snapshot, setSnapshot] = useState<NotchSettingsSnapshot | null>(null);
  const [loading, setLoading] = useState(nativeHost);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!nativeHost) return;
    let active = true;
    void getNotchSettings().then((next) => {
      if (active) setSnapshot(next);
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : 'Could not load notch settings.');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [nativeHost]);

  const apply = async (key: string, patch: Partial<NotchPreferences>) => {
    if (!snapshot || busy) return;
    const previous = snapshot;
    setBusy(key);
    setError('');
    setNotice('');
    setSnapshot({ ...snapshot, preferences: { ...snapshot.preferences, ...patch } });
    try {
      const result = await updateNotchSettings(patch);
      setSnapshot(result.snapshot);
      if (!result.ok) setError(result.error ?? 'Could not save that notch setting.');
      else setNotice('Saved');
    } catch (reason) {
      setSnapshot(previous);
      setError(reason instanceof Error ? reason.message : 'Could not save that notch setting.');
    } finally {
      setBusy(null);
    }
  };

  const openPreview = async () => {
    if (!snapshot || busy) return;
    setBusy('open');
    setError('');
    try {
      const result = await openNotchPreview();
      setSnapshot(result.snapshot);
      if (!result.ok) setError(result.error ?? 'The notch preview could not open.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The notch preview could not open.');
    } finally {
      setBusy(null);
    }
  };

  const enabled = snapshot?.preferences.enabled ?? false;
  const capturePhase = snapshot?.meetingCapture?.capturePhase;
  const captureActive = capturePhase === 'starting' || capturePhase === 'recording' || capturePhase === 'stopping';
  const configuredShortcut = snapshot?.preferences.shortcut;
  const customShortcut = configuredShortcut && !SHORTCUTS.some((shortcut) => shortcut.value === configuredShortcut)
    ? configuredShortcut
    : null;
  const needsAttention = Boolean(snapshot?.runtime.shortcutError || error);
  const meetingCapture = snapshot?.meetingCapture;
  const recallCapability = notchRecallCapability(meetingCapture);
  const recallReady = recallCapability === 'ready';
  const recallNeedsAttention = recallCapability === 'needs-attention';
  const status = !nativeHost
    ? <StatusPill tone="neutral">Mac app required</StatusPill>
    : needsAttention
      ? <StatusPill tone="danger">Needs attention</StatusPill>
      : !enabled
        ? <StatusPill tone="neutral">Off</StatusPill>
        : recallCapability === 'unsupported'
          ? <StatusPill tone="warning">Recall unavailable</StatusPill>
          : recallNeedsAttention
            ? <StatusPill tone="danger">Recall needs attention</StatusPill>
          : recallReady
            ? <StatusPill tone="info">Meetings live · tasks preview</StatusPill>
            : <StatusPill tone="neutral">Task preview</StatusPill>;

  const capabilityCopy = notchRecallCapabilityCopy(meetingCapture, enabled);

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-primary-tint"><DogMark size={30} /></span>
        <div className="min-w-0 flex-1">
          <h3 className="text-h3 text-fg">Clementine in the notch</h3>
          <p className="mt-0.5 text-small text-muted">Open Clementine from anywhere and control detected Recall meetings without leaving your call.</p>
        </div>
        {status}
      </div>

      {!nativeHost ? (
        <div className="rounded-md border border-border bg-subtle px-4 py-3 text-small text-muted">
          Open Settings inside the Clementine macOS app to turn on and configure the notch.
        </div>
      ) : loading ? <Skeleton className="h-64 w-full" /> : !snapshot ? (
        <div className="rounded-md border border-danger/25 bg-danger-tint px-4 py-3 text-small text-danger" role="alert">
          {error || 'Notch settings are unavailable. Restart Clementine and try again.'}
        </div>
      ) : (
        <>
          <div className={cn(
            'mb-4 flex items-start gap-2 rounded-md border px-3 py-2.5 text-small',
            recallReady || !meetingCapture?.enabled
              ? 'border-info/20 bg-info-tint text-info'
              : 'border-warning/25 bg-warning/10 text-warning',
          )}>
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{capabilityCopy}</span>
          </div>

          <div className="divide-y divide-border">
            <SettingRow
              title="Enable Clementine in the notch"
              description={captureActive ? 'Stop the active meeting recording before turning off the notch.' : 'Keep the surface ready while the Clementine app is running.'}
            >
              <Switch checked={enabled} disabled={Boolean(busy) || captureActive} label="Enable Clementine in the notch" onChange={(value) => void apply('enabled', { enabled: value })} />
            </SettingRow>

            <SettingRow title="Show the notch" description="Manual opens with the shortcut and enabled meeting alerts. At launch also opens it collapsed." disabled={!enabled}>
              <Select
                className="w-44"
                aria-label="When to show Clementine in the notch"
                value={snapshot.preferences.behavior}
                disabled={!enabled || Boolean(busy)}
                onChange={(event) => void apply('behavior', { behavior: event.target.value as NotchPreferences['behavior'] })}
              >
                <option value="manual">Manually</option>
                <option value="always">At launch</option>
                <option value="working" disabled>While working · soon</option>
              </Select>
            </SettingRow>

            <SettingRow
              title="Keyboard shortcut"
              description={snapshot.shortcutManagedByEnvironment ? 'Managed by CLEMMY_LIVE_SHORTCUT for this app launch.' : 'Open Clementine from anywhere. During recording it always reveals the Stop control.'}
            >
              <Select
                className="w-44"
                aria-label="Keyboard shortcut for Clementine in the notch"
                value={snapshot.preferences.shortcut}
                disabled={Boolean(busy) || snapshot.shortcutManagedByEnvironment}
                onChange={(event) => void apply('shortcut', { shortcut: event.target.value })}
              >
                {customShortcut && <option value={customShortcut}>{customShortcut}</option>}
                {SHORTCUTS.map((shortcut) => <option key={shortcut.value} value={shortcut.value}>{shortcut.label}</option>)}
              </Select>
            </SettingRow>

            <SettingRow title="Preferred display" description="Choose where Clementine appears when more than one display is connected." disabled={!enabled}>
              <Select
                className="w-44"
                aria-label="Preferred display for Clementine in the notch"
                value={snapshot.preferences.preferredDisplay}
                disabled={!enabled || Boolean(busy)}
                onChange={(event) => void apply('display', { preferredDisplay: event.target.value as NotchPreferences['preferredDisplay'] })}
              >
                <option value="pointer">Display with pointer</option>
                <option value="primary">Primary display</option>
              </Select>
            </SettingRow>

            <SettingRow
              title="Ask before recording detected meetings"
              description="When Recall sees Zoom, Google Meet, or Teams, open the notch with Record and Not this time controls. Active recordings always retain a Stop control."
              disabled={!enabled}
            >
              <Switch
                checked={snapshot.preferences.promptForDetectedMeetings}
                disabled={!enabled || Boolean(busy)}
                label="Ask before recording detected meetings"
                onChange={(value) => void apply('meetings', { promptForDetectedMeetings: value })}
              />
            </SettingRow>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-4">
            <Button size="sm" onClick={() => void openPreview()} disabled={!enabled || Boolean(busy)}>
              <MonitorUp className="h-4 w-4" aria-hidden /> {busy === 'open' ? 'Opening…' : captureActive ? 'Open recording controls' : snapshot.runtime.availability === 'loading' ? 'Notch starting…' : snapshot.runtime.availability === 'unavailable' ? 'Retry notch' : 'Open notch'}
            </Button>
            <Link to="/meetings" className="inline-flex items-center gap-1.5 text-small font-semibold text-primary hover:underline">
              <Video className="h-4 w-4" aria-hidden /> Manage meeting capture
            </Link>
            <span className="ml-auto text-caption text-faint">Motion follows macOS Reduce Motion.</span>
          </div>

          <div aria-live="polite" className="mt-3 min-h-5 text-small">
            {error ? <span className="text-danger" role="alert">{error}</span> : notice ? <span className="inline-flex items-center gap-1 text-success"><Check className="h-4 w-4" aria-hidden /> {notice}</span> : snapshot.runtime.shortcutError ? <span className="text-danger" role="alert">{snapshot.runtime.shortcutError}</span> : !meetingCapture?.enabled ? <span className="text-muted">Recall detection is off. Turn it on from Meetings to receive meeting prompts.</span> : recallNeedsAttention ? <span className="text-warning">Recall is not ready. Review meeting capture before relying on prompts or recording controls.</span> : null}
          </div>
        </>
      )}
    </Card>
  );
}
