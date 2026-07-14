import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Video, Circle, Square, ShieldCheck, Mic, ListChecks, Users, Hash, MessageCircle, AlertTriangle, Check, HardDrive, Trash2 } from 'lucide-react';
import { Page } from '@/components/Page';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { Input, Select } from '@/components/ui/Field';
import { StatusPill } from '@/components/ui/StatusPill';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { usePoll } from '@/lib/poll';
import { statusTone, relativeTime } from '@/lib/inbox';
import { clemmy, isDesktop } from '@/lib/clemmy';
import {
  getRecallStatus,
  patchRecallSettings,
  patchLocalMeetingSettings,
  retryLocalMeetingTranscription,
  listMeetings,
  getMeeting,
  getMeetingChatPrompt,
  type LocalMeetingSettings,
  type LocalMeetingStatus,
  type MeetingSummary,
  type RecallSettings,
} from '@/lib/meetings';
import { cn } from '@/lib/cn';
import { linkify } from '@/lib/linkify';
import {
  sharedLocalMeetingCapture,
  sharedLocalMeetingCaptureState,
  subscribeSharedLocalMeetingCapture,
  type LocalMeetingCaptureState,
} from '@/lib/local-meeting-recorder';

const DEFAULT_REGIONS: Record<string, string> = { 'us-west-2': 'US West', 'us-east-1': 'US East', 'eu-central-1': 'EU Central', 'ap-northeast-1': 'Asia Pacific' };
const PERMS: { key: string; label: string }[] = [
  { key: 'screen-capture', label: 'Screen recording' },
  { key: 'microphone', label: 'Microphone' },
  { key: 'accessibility', label: 'Accessibility' },
];

// The live SDK truth (permissions, recording, detected windows) only exists
// in the Electron main process — reachable via clemmy().recallStatus(), NOT
// the daemon route. recordActiveMeeting() returns `blocked` when it can't.
interface SdkStatus {
  sdkAvailable?: boolean; initialized?: boolean; recording?: boolean;
  hasActiveMeetingWindow?: boolean; lastError?: string;
  platformSupport?: { supported?: boolean; platform?: string; arch?: string; message?: string };
  permissionStatuses?: Record<string, string>;
  blocked?: { reason?: string; message?: string };
}

function formatElapsed(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = Math.floor(seconds % 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`;
}

export function Meetings() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const desktop = isDesktop();
  const status = usePoll(['recall-status'], getRecallStatus, 15000);
  // Desktop-only: poll the Electron SDK for the real permission/recording state.
  const sdk = usePoll<SdkStatus | null>(
    ['recall-sdk'],
    () => (clemmy()?.recallStatus?.() as Promise<SdkStatus | null> | undefined) ?? Promise.resolve(null),
    8000,
    { enabled: desktop },
  );
  const localDesktopStatus = usePoll<LocalMeetingStatus | null>(
    ['local-meeting-status'],
    () => (clemmy()?.localMeetingStatus?.() as Promise<LocalMeetingStatus> | undefined) ?? Promise.resolve(null),
    5000,
    { enabled: desktop },
  );
  const meetings = usePoll(['meetings'], listMeetings, 12000);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'info' | 'warn' | 'error'; text: string } | null>(null);
  const [retentionHoursDraft, setRetentionHoursDraft] = useState('24');
  const [localTitle, setLocalTitle] = useState('');
  const [localBusy, setLocalBusy] = useState(false);
  const [retryingMeetingId, setRetryingMeetingId] = useState<string | null>(null);
  const [localNotice, setLocalNotice] = useState<{ tone: 'info' | 'warn' | 'error'; text: string } | null>(null);
  // The capture is a module-level SINGLETON shared with AppShell's recording
  // pill (2026-07-14 review): recording used to be per-mount state, so any SPA
  // navigation away from this screen silently stopped and finalized an
  // in-progress recording. Now the mic pump survives navigation; this screen
  // only SUBSCRIBES to its state. The no-invisible-capture invariant lives in
  // AppShell (persistent pill + Stop) and the Electron tray dot/close guard.
  const [localCaptureState, setLocalCaptureState] = useState<LocalMeetingCaptureState>(
    () => sharedLocalMeetingCaptureState(),
  );

  useEffect(() => {
    const unsubscribe = subscribeSharedLocalMeetingCapture(setLocalCaptureState);
    return () => {
      unsubscribe();
      // Only an ABANDONED pre-session start is cancelled on unmount — the user
      // initiated but left before the recording existed. A live recording keeps
      // going (visible via the AppShell pill), never silently stopped.
      const capture = sharedLocalMeetingCapture();
      if (capture.state().phase === 'requesting') {
        void capture.cancel().catch(() => undefined);
      }
    };
  }, []);

  const detail = useQuery({ queryKey: ['meeting', selected], queryFn: () => getMeeting(selected!), enabled: !!selected });

  const settings = status.data?.settings ?? {};
  const credConnected = (status.data?.credential?.status ?? '').toLowerCase() === 'connected';
  const regions = status.data?.regions ?? DEFAULT_REGIONS;
  const rows = meetings.data?.meetings ?? [];
  const sdkData = sdk.data ?? undefined;
  const recording = Boolean(sdkData?.recording);
  const recallUnsupported = sdkData?.platformSupport?.supported === false;
  const recallUnsupportedMessage = sdkData?.platformSupport?.message
    || 'Recall online meeting capture is not supported on this computer.';
  const perms = sdkData?.permissionStatuses ?? {};
  const localStatus = localDesktopStatus.data ?? undefined;
  const pendingLocalCancellationCount = Math.max(0, Number(
    (localStatus as (LocalMeetingStatus & { pendingCancellationCount?: number }) | undefined)?.pendingCancellationCount ?? 0,
  ) || 0);
  const localSettings = localStatus?.settings ?? {};
  const localRuntime = localStatus?.runtime;
  const desktopRecorderSessionId = localStatus?.recorder?.recording ? localStatus.recorder.sessionId : undefined;
  const localSessionId = localCaptureState.sessionId ?? desktopRecorderSessionId;
  const localRecording = Boolean(localSessionId)
    && (Boolean(desktopRecorderSessionId) || ['recording', 'stopping', 'error'].includes(localCaptureState.phase));
  const localElapsedSeconds = localCaptureState.sessionId
    ? localCaptureState.elapsedSeconds
    : Math.max(0, Math.floor(localStatus?.recorder?.durationSeconds ?? 0));

  useEffect(() => {
    if (typeof settings.retentionHours === 'number' && Number.isFinite(settings.retentionHours)) {
      setRetentionHoursDraft(String(settings.retentionHours));
    }
  }, [settings.retentionHours]);

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['recall-status'] }); void qc.invalidateQueries({ queryKey: ['recall-sdk'] }); };

  // Every settings change PATCHes the daemon AND pushes to the Electron SDK
  // (recallConfigure) so detection / auto-record / permissions come online now,
  // not on the next daemon boot.
  const applySetting = async (partial: Partial<RecallSettings>) => {
    setBusy(true); setNotice(null);
    try {
      const res = await patchRecallSettings(partial);
      if (desktop) await clemmy()?.recallConfigure?.((res.settings ?? {}) as Record<string, unknown>);
      refresh();
    } catch (e) { setNotice({ tone: 'error', text: (e as Error).message }); }
    finally { setBusy(false); }
  };

  const applyRetentionHours = async () => {
    const hours = Number(retentionHoursDraft);
    if (!Number.isFinite(hours) || hours < 1) {
      setNotice({ tone: 'error', text: 'Recall retention must be at least 1 hour.' });
      setRetentionHoursDraft(String(settings.retentionHours ?? 24));
      return;
    }
    await applySetting({ retentionHours: hours });
  };

  const grant = async () => {
    setBusy(true); setNotice(null);
    try {
      await clemmy()?.recallRequestPermissions?.();
      setNotice({ tone: 'info', text: 'Permission requests sent — approve the macOS dialogs. If you just enabled Screen Recording, quit and reopen Clementine for it to take effect.' });
    } catch (e) { setNotice({ tone: 'error', text: (e as Error).message }); }
    finally { setBusy(false); refresh(); }
  };

  const record = async () => {
    setBusy(true); setNotice(null);
    try {
      const st = (await clemmy()?.recallRecordActive?.()) as SdkStatus | null | undefined;
      if (st?.blocked?.message) setNotice({ tone: 'warn', text: st.blocked.message });
    } catch (e) { setNotice({ tone: 'error', text: (e as Error).message }); }
    finally { setBusy(false); refresh(); }
  };

  const stop = async () => {
    setBusy(true);
    try { await clemmy()?.recallStop?.(); }
    finally { setBusy(false); refresh(); void qc.invalidateQueries({ queryKey: ['meetings'] }); }
  };

  const applyLocalSetting = async (partial: Partial<LocalMeetingSettings>) => {
    setLocalBusy(true); setLocalNotice(null);
    try {
      await patchLocalMeetingSettings(partial);
      await localDesktopStatus.refetch();
    } catch (e) { setLocalNotice({ tone: 'error', text: (e as Error).message }); }
    finally { setLocalBusy(false); }
  };

  const startLocal = async () => {
    setLocalBusy(true); setLocalNotice(null);
    try {
      await sharedLocalMeetingCapture().start(localTitle);
      setLocalNotice({ tone: 'info', text: 'Recording this microphone locally. You can navigate anywhere — the recording continues until you stop it (see the banner at the top).' });
      await localDesktopStatus.refetch();
    } catch (e) { setLocalNotice({ tone: 'error', text: (e as Error).message }); }
    finally { setLocalBusy(false); }
  };

  const stopLocal = async () => {
    setLocalBusy(true); setLocalNotice(null);
    try {
      const result = localCaptureState.sessionId
        ? await sharedLocalMeetingCapture().stop()
        : await clemmy()!.localMeetingStop!(localSessionId!);
      if (result.queued === false) {
        setLocalNotice({ tone: 'warn', text: `Audio was saved locally, but transcription could not start yet${result.error ? `: ${String(result.error)}` : '.'}` });
      } else {
        setLocalNotice({ tone: 'info', text: 'Recording saved. Local transcription is now queued.' });
      }
      setLocalTitle('');
    } catch (e) { setLocalNotice({ tone: 'error', text: (e as Error).message }); }
    finally {
      setLocalBusy(false);
      await localDesktopStatus.refetch();
      void qc.invalidateQueries({ queryKey: ['meetings'] });
    }
  };

  const cancelLocal = async () => {
    setLocalBusy(true); setLocalNotice(null);
    try {
      let cancellationPending = false;
      let cancellationWarning = '';
      if (localCaptureState.sessionId) {
        await sharedLocalMeetingCapture().cancel();
        // LocalMeetingCapture intentionally returns void after releasing media.
        // Read main's durable tombstone status so a lost daemon response is not
        // misrepresented as fully cleaned up.
        const after = await clemmy()?.localMeetingStatus?.();
        cancellationPending = Number(after?.pendingCancellationCount ?? 0) > 0;
      } else {
        const result = await clemmy()!.localMeetingCancel!(localSessionId!);
        cancellationPending = result?.daemonCancellationPending === true;
        cancellationWarning = typeof result?.warning === 'string' ? result.warning : '';
      }
      setLocalNotice(cancellationPending
        ? {
          tone: 'warn',
          text: cancellationWarning || 'Local audio was discarded, but meeting-history cleanup is pending and will retry automatically.',
        }
        : { tone: 'warn', text: 'Local recording discarded.' });
    } catch (e) { setLocalNotice({ tone: 'error', text: (e as Error).message }); }
    finally { setLocalBusy(false); await localDesktopStatus.refetch(); }
  };

  const retryTranscription = async (meetingId: string) => {
    setRetryingMeetingId(meetingId);
    try {
      await retryLocalMeetingTranscription(meetingId);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['meeting', meetingId] }),
        qc.invalidateQueries({ queryKey: ['meetings'] }),
      ]);
    } catch (e) {
      setLocalNotice({ tone: 'error', text: `Could not retry transcription: ${(e as Error).message}` });
    } finally {
      setRetryingMeetingId(null);
    }
  };

  const discuss = async (id: string) => {
    try { const { prompt } = await getMeetingChatPrompt(id); navigate(`/chat?prompt=${encodeURIComponent(prompt)}`); }
    catch { navigate('/chat'); }
  };

  return (
    <Page title="Meetings" subtitle="Local recordings and online calls, with transcripts, summaries, and action items">
      {/* Local in-person capture */}
      <Card className="mb-4 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <HardDrive className="h-5 w-5 text-primary" aria-hidden />
          <div className="min-w-[16rem] flex-1">
            <h3 className="text-h3 text-fg">In-person meeting</h3>
            <p className="text-small text-muted">Record this computer's microphone and transcribe it locally with whisper.cpp.</p>
          </div>
          {!desktop ? (
            <StatusPill tone="neutral">Desktop app only</StatusPill>
          ) : localCaptureState.phase === 'error' && localCaptureState.sessionId ? (
            <StatusPill tone="danger">Capture stopped early</StatusPill>
          ) : localRecording ? (
            <StatusPill tone="live">Recording · {formatElapsed(localElapsedSeconds)}</StatusPill>
          ) : localRuntime?.available === false ? (
            <StatusPill tone="warning">Local engine unavailable</StatusPill>
          ) : localRuntime?.modelReady ? (
            <StatusPill tone="success">Ready offline</StatusPill>
          ) : (
            <StatusPill tone="info">Local model on first use</StatusPill>
          )}
        </div>

        {!desktop ? (
          <p className="mt-4 text-body text-muted">Open Clementine Desktop to record an in-person meeting. The browser cannot write the protected local audio file.</p>
        ) : localDesktopStatus.isLoading ? (
          <Skeleton className="mt-4 h-24 w-full" />
        ) : (
          <div className="mt-4 space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <label className="min-w-[16rem] flex-1 text-small text-fg">
                <span className="mb-1.5 block">Meeting title <span className="text-faint">(optional)</span></span>
                <Input
                  value={localTitle}
                  onChange={(event) => setLocalTitle(event.target.value)}
                  placeholder="Weekly planning"
                  maxLength={160}
                  disabled={localRecording || localBusy}
                />
              </label>
              {localRecording ? (
                <>
                  <Button variant="danger" onClick={stopLocal} disabled={localBusy || localCaptureState.phase === 'stopping'}>
                    <Square className="h-4 w-4" aria-hidden /> Stop & transcribe
                  </Button>
                  <Button variant="ghost" onClick={cancelLocal} disabled={localBusy} aria-label="Discard local recording">
                    <Trash2 className="h-4 w-4" aria-hidden /> Discard
                  </Button>
                </>
              ) : (
                <Button
                  onClick={startLocal}
                  disabled={localBusy || localSettings.enabled === false || localRuntime?.available === false}
                >
                  <Circle className="h-4 w-4" aria-hidden /> Start local recording
                </Button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <label className="flex items-center gap-2 text-small text-fg">
                <Switch checked={localSettings.enabled !== false} onChange={(value) => applyLocalSetting({ enabled: value })} label="Enable local transcription" disabled={localRecording || localBusy} />
                Enable local transcription
              </label>
              <label className="flex items-center gap-2 text-small text-fg">
                <Switch checked={localSettings.analyzeOnComplete !== false} onChange={(value) => applyLocalSetting({ analyzeOnComplete: value })} label="Summarize automatically" disabled={localRecording || localBusy} />
                Summarize automatically
              </label>
              <label className="flex items-center gap-2 text-small text-fg">
                <Switch checked={!!localSettings.keepAudio} onChange={(value) => applyLocalSetting({ keepAudio: value })} label="Keep raw audio" disabled={localRecording || localBusy} />
                Keep raw audio after transcription
              </label>
            </div>

            <p className="flex gap-2 text-caption text-muted">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
              Audio never leaves this device and transcription runs locally; the recording itself is deleted after transcription unless you choose to keep it. The transcript is saved to Clementine's memory so it can be recalled in future conversations — if a cloud embedding provider is configured (for example OpenAI), transcript text is sent to that provider for search indexing. If automatic summaries are enabled, the transcript is also handled by your configured Clementine model.
            </p>
            {!localRuntime?.modelReady && localRuntime?.available !== false && (
              <p className="text-caption text-muted">The English base model downloads once on the first transcription, then works without an internet connection.</p>
            )}
            {localRuntime?.available === false && (
              <p className="text-caption text-danger">{localRuntime.reason || 'The packaged local transcription engine could not be found.'}</p>
            )}
            {pendingLocalCancellationCount > 0 && (
              <p role="status" className="text-small text-warning">
                Meeting-history cleanup is pending for {pendingLocalCancellationCount} discarded local recording{pendingLocalCancellationCount === 1 ? '' : 's'}. Clementine retries automatically every five seconds.
              </p>
            )}
            {localCaptureState.error && localCaptureState.sessionId && (
              <p role="alert" className="text-small text-danger">{localCaptureState.error} Microphone capture has stopped; choose Stop &amp; transcribe to save the captured portion.</p>
            )}
            {localNotice && (
              <p aria-live="polite" className={cn('text-small', localNotice.tone === 'error' ? 'text-danger' : localNotice.tone === 'warn' ? 'text-warning' : 'text-muted')}>{localNotice.text}</p>
            )}
          </div>
        )}
      </Card>

      {/* Online-call capture */}
      <Card className="mb-6 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <Video className="h-5 w-5 text-primary" aria-hidden />
          <div className="flex-1">
            <h3 className="text-h3 text-fg">Online call capture</h3>
            <p className="text-small text-muted">Capture and transcribe Zoom, Meet, and Teams calls with the Recall Desktop SDK.</p>
          </div>
          <StatusPill tone={recallUnsupported ? 'warning' : credConnected ? 'success' : 'warning'}>
            {recallUnsupported ? 'Unsupported on this computer' : credConnected ? 'Recall.ai connected' : 'Not connected'}
          </StatusPill>
        </div>

        {status.isLoading ? (
          <Skeleton className="mt-4 h-24 w-full" />
        ) : status.isError ? (
          <p className="mt-4 text-body text-danger">Couldn't load meeting capture status.{' '}
            <button type="button" onClick={() => status.refetch()} className="cursor-pointer text-primary hover:underline">Retry</button>
          </p>
        ) : desktop && sdk.isLoading ? (
          <Skeleton className="mt-4 h-24 w-full" />
        ) : recallUnsupported ? (
          <div className="mt-4 rounded-md border border-warning/30 bg-warning-tint px-3 py-3">
            <p className="text-body text-warning">{recallUnsupportedMessage}</p>
            <p className="mt-1 text-small text-muted">Use In-person meeting above to record the microphone and transcribe locally with whisper.cpp. Local recording remains available on Intel Macs.</p>
          </div>
        ) : !credConnected ? (
          <p className="mt-4 text-body text-muted">Add your Recall.ai key in <span className="font-medium text-fg">Connect → Keys & accounts</span> to enable meeting capture.</p>
        ) : !desktop ? (
          <p className="mt-4 inline-flex items-center gap-2 text-body text-muted"><Mic className="h-4 w-4" aria-hidden /> Recording controls live in the Clementine desktop app.</p>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <label className="flex items-center gap-2 text-small text-fg"><Switch checked={!!settings.enabled} onChange={(v) => applySetting({ enabled: v })} label="Enable meeting capture" disabled={busy || recording} /> Enable meeting capture</label>
              <label className="flex items-center gap-2 text-small text-fg">
                Region
                <Select value={settings.region ?? 'us-west-2'} onChange={(e) => applySetting({ region: e.target.value })} className="w-44" disabled={!settings.enabled || busy || recording}>
                  {Object.entries(regions).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                </Select>
              </label>
            </div>

            {settings.enabled && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  {recording
                    ? <Button variant="danger" onClick={stop} disabled={busy}><Square className="h-4 w-4" aria-hidden /> Stop recording</Button>
                    : <Button onClick={record} disabled={busy}><Circle className="h-4 w-4" aria-hidden /> Record this meeting</Button>}
                  <Button variant="secondary" size="sm" onClick={grant} disabled={busy}><ShieldCheck className="h-4 w-4" aria-hidden /> Grant permissions</Button>
                  <div className="mx-2 h-6 w-px bg-border" />
                  <label className="flex items-center gap-2 text-small text-fg"><Switch checked={!!settings.autoRecord} onChange={(v) => applySetting({ autoRecord: v })} label="Auto-record" disabled={busy || recording} /> Auto-record meetings</label>
                  <label className="flex items-center gap-2 text-small text-fg">
                    <Switch
                      checked={settings.retentionMode === 'zero' || !!settings.liveTranscript}
                      onChange={(v) => applySetting({ liveTranscript: v })}
                      label="Live transcript"
                      disabled={busy || recording || settings.retentionMode === 'zero'}
                    />
                    Live transcript{settings.retentionMode === 'zero' ? ' (required for zero retention)' : ''}
                  </label>
                </div>

                <div className="rounded-md border border-border bg-canvas p-3">
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="min-w-[15rem] flex-1 text-small text-fg">
                      <span className="mb-1.5 block">Recall retention</span>
                      <Select
                        value={settings.retentionMode ?? 'timed'}
                        onChange={(event) => {
                          const retentionMode = event.target.value as 'zero' | 'timed';
                          void applySetting(retentionMode === 'zero'
                            ? { retentionMode, liveTranscript: true }
                            : { retentionMode });
                        }}
                        disabled={busy || recording}
                      >
                        <option value="zero">Do not retain on Recall</option>
                        <option value="timed">Retain temporarily</option>
                      </Select>
                    </label>
                    {(settings.retentionMode ?? 'timed') === 'timed' && (
                      <label className="w-40 text-small text-fg">
                        <span className="mb-1.5 block">Retention hours</span>
                        <Input
                          type="number"
                          min={1}
                          max={720}
                          step={1}
                          value={retentionHoursDraft}
                          onChange={(event) => setRetentionHoursDraft(event.target.value)}
                          onBlur={() => { void applyRetentionHours(); }}
                          disabled={busy || recording}
                        />
                      </label>
                    )}
                  </div>
                  {(settings.retentionMode ?? 'timed') === 'zero' ? (
                    <p className="mt-2 text-caption text-muted">Zero retention relies on Recall's realtime transcript and events while the call is active. Post-meeting media and transcript backfill are unavailable, so interrupted events can leave gaps.</p>
                  ) : (
                    <p className="mt-2 text-caption text-muted">Timed retention lets Clementine use Recall's post-meeting media and transcript backfill during this window. Recall controls retention and deletion timing.</p>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {PERMS.map((p) => {
                    const ok = perms[p.key] === 'granted';
                    return (
                      <span key={p.key} className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-caption',
                        ok ? 'border-success/40 bg-success-tint text-success' : 'border-warning/40 bg-warning-tint text-warning')}>
                        {ok ? <Check className="h-3.5 w-3.5" aria-hidden /> : <AlertTriangle className="h-3.5 w-3.5" aria-hidden />} {p.label}
                      </span>
                    );
                  })}
                  {recording
                    ? <span className="inline-flex items-center gap-1.5 text-caption text-danger"><span className="h-2 w-2 animate-pulse rounded-full bg-danger" aria-hidden /> Recording</span>
                    : sdkData?.hasActiveMeetingWindow && <span className="text-caption text-muted">Meeting detected — ready to record</span>}
                </div>
                {sdkData && sdkData.sdkAvailable === false && (
                  <p className="text-caption text-danger">The Recall desktop SDK didn't load.{sdkData.lastError ? ` ${sdkData.lastError}` : ''}</p>
                )}
              </>
            )}

            {notice && (
              <p className={cn('text-small', notice.tone === 'error' ? 'text-danger' : notice.tone === 'warn' ? 'text-warning' : 'text-muted')}>{notice.text}</p>
            )}
          </div>
        )}
      </Card>

      {/* Recent meetings + detail */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="space-y-2">
          {meetings.isLoading ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)
            : rows.length === 0 ? <EmptyState title="No meetings yet" description="Recorded meetings will show up here with summaries and action items." />
              : rows.map((m) => <MeetingRow key={m.id} m={m} selected={selected === m.id} onSelect={() => setSelected(m.id)} />)}
        </div>

        <div className="rounded-lg border border-border bg-surface p-5 shadow-sm">
          {!selected ? (
            <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
              <Video className="h-6 w-6 text-faint" aria-hidden />
              <p className="text-body text-muted">Select a meeting to see its summary and action items.</p>
            </div>
          ) : detail.isLoading ? <Skeleton className="h-64 w-full" /> : (
            <>
              <div className="mb-3 flex justify-end">
                <Button size="sm" onClick={() => discuss(selected)}><MessageCircle className="h-4 w-4" aria-hidden /> Discuss in chat</Button>
              </div>
              <MeetingDetailView
                data={detail.data}
                retrying={retryingMeetingId === selected}
                onRetry={() => { if (selected) void retryTranscription(selected); }}
              />
            </>
          )}
        </div>
      </div>
    </Page>
  );
}

function MeetingRow({ m, selected, onSelect }: { m: MeetingSummary; selected: boolean; onSelect: () => void }) {
  const tone = m.provider === 'local' ? localTranscriptionTone(m) : statusTone(m.status);
  return (
    <button type="button" onClick={onSelect}
      className={cn('flex w-full items-center gap-3 rounded-md border px-3.5 py-3 text-left transition-colors cursor-pointer',
        selected ? 'border-primary bg-primary-tint' : 'border-border bg-surface hover:bg-hover')}>
      {m.provider === 'local'
        ? <Mic className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        : <Video className="h-4 w-4 shrink-0 text-muted" aria-hidden />}
      <div className="min-w-0 flex-1">
        <div className="truncate text-body text-fg">{m.title || `${m.platform ?? 'Meeting'} call`}</div>
        <div className="text-caption text-faint">{relativeTime(m.startedAt)}{typeof m.segmentCount === 'number' ? ` · ${m.segmentCount} segment${m.segmentCount === 1 ? '' : 's'}` : ''}</div>
      </div>
      <StatusPill tone={tone.tone}>{tone.label}</StatusPill>
    </button>
  );
}

function localTranscriptionTone(meeting: MeetingSummary): ReturnType<typeof statusTone> {
  switch (meeting.transcriptionStatus) {
    case 'queued': return { tone: 'warning', label: 'Queued' };
    case 'transcribing': return { tone: 'live', label: 'Transcribing' };
    case 'ready': return { tone: 'success', label: 'Transcribed' };
    case 'failed': return { tone: 'danger', label: 'Transcription failed' };
    case 'cancelled': return { tone: 'neutral', label: 'Cancelled' };
    default:
      return meeting.status === 'recording'
        ? { tone: 'live', label: 'Recording' }
        : { tone: 'warning', label: 'Waiting' };
  }
}

// Analysis fields vary across meetings — actionItems can be an array of
// OBJECTS (e.g. {task, owner}) on some, strings on others, or null. Coerce
// everything to a readable string so a render never throws ("Objects are not
// valid as a React child"), which was blanking the whole app.
function asText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const main = o.task ?? o.action ?? o.item ?? o.text ?? o.title ?? o.description ?? o.name;
    const who = o.owner ?? o.assignee ?? o.who;
    if (typeof main === 'string') return typeof who === 'string' && who ? `${main} — ${who}` : main;
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}
function toList(v: unknown): unknown[] { return Array.isArray(v) ? v : v == null ? [] : [v]; }

function MeetingDetailView({
  data,
  retrying = false,
  onRetry,
}: {
  data?: import('@/lib/meetings').MeetingDetail;
  retrying?: boolean;
  onRetry?: () => void;
}) {
  const a = (data?.analysis ?? {}) as Record<string, unknown>;
  const r = (data?.record ?? {}) as Record<string, unknown>;
  const summary = asText(a.summary);
  const actionItems = toList(a.actionItems).map(asText).filter(Boolean);
  const decisions = toList(a.decisions).map(asText).filter(Boolean);
  const topics = toList(a.topics).map(asText).filter(Boolean);
  const participants = toList(a.participants).map(asText).filter(Boolean);
  const segments = toList(r.segments).filter((s) => asText((s as Record<string, unknown>)?.text));
  const localProvider = asText(r.provider) === 'local';
  const transcriptionStatus = asText(r.transcriptionStatus);
  const transcriptionError = asText(r.transcriptionError);
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-caption text-faint">
        <span className="uppercase tracking-wide">{asText(r.platform)}</span>
        {r.startedAt ? <span>· {relativeTime(asText(r.startedAt))}</span> : null}
      </div>
      <h3 className="mb-3 text-h2 text-fg">{asText(a.title) || 'Meeting'}</h3>
      {localProvider && (transcriptionStatus === 'queued' || transcriptionStatus === 'transcribing') && (
        <p className="mb-4 rounded-md border border-info/30 bg-info-tint px-3 py-2 text-small text-info" role="status">
          {transcriptionStatus === 'queued' ? 'Local transcription is queued.' : 'Transcribing locally on this device…'}
        </p>
      )}
      {localProvider && transcriptionStatus === 'failed' && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-danger/30 bg-danger-tint px-3 py-2" role="alert">
          <p className="min-w-0 flex-1 text-small text-danger">Local transcription failed{transcriptionError ? `: ${transcriptionError}` : '.'}</p>
          {onRetry && <Button variant="secondary" size="sm" onClick={onRetry} disabled={retrying}>{retrying ? 'Retrying…' : 'Retry transcription'}</Button>}
        </div>
      )}
      {summary && <p className="mb-4 whitespace-pre-wrap text-body text-fg">{linkify(summary)}</p>}

      {actionItems.length > 0 && (
        <Section icon={ListChecks} title="Action items">
          <ul className="space-y-1.5">{actionItems.map((it, i) => <li key={i} className="flex gap-2 text-body text-fg"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden />{it}</li>)}</ul>
        </Section>
      )}
      {decisions.length > 0 && (
        <Section icon={ListChecks} title="Decisions">
          <ul className="space-y-1.5">{decisions.map((it, i) => <li key={i} className="text-body text-fg">{it}</li>)}</ul>
        </Section>
      )}
      {topics.length > 0 && (
        <Section icon={Hash} title="Topics">
          <div className="flex flex-wrap gap-1.5">{topics.map((t, i) => <span key={i} className="rounded-full bg-subtle px-2.5 py-1 text-caption text-muted">{t}</span>)}</div>
        </Section>
      )}
      {participants.length > 0 && (
        <Section icon={Users} title="Participants">
          <div className="text-body text-muted">{participants.join(', ')}</div>
        </Section>
      )}
      {segments.length > 0 && (
        <Section icon={Mic} title="Transcript">
          <div className="max-h-72 space-y-2 overflow-auto">
            {segments.slice(0, 200).map((s, i) => {
              const seg = s as Record<string, unknown>;
              return <p key={i} className="text-small text-muted"><span className="font-semibold text-fg">{asText(seg.speaker) || 'Speaker'}:</span> {asText(seg.text)}</p>;
            })}
          </div>
        </Section>
      )}
    </div>
  );
}

function Section({ icon: Icon, title, children }: { icon: typeof ListChecks; title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h4 className="mb-1.5 flex items-center gap-1.5 text-label text-faint"><Icon className="h-4 w-4" aria-hidden /> {title}</h4>
      {children}
    </div>
  );
}
