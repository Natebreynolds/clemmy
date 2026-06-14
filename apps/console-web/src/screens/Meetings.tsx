import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Video, Circle, Square, ShieldCheck, Mic, ListChecks, Users, Hash, MessageCircle, AlertTriangle, Check } from 'lucide-react';
import { Page } from '@/components/Page';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { Select } from '@/components/ui/Field';
import { StatusPill } from '@/components/ui/StatusPill';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { usePoll } from '@/lib/poll';
import { statusTone, relativeTime } from '@/lib/inbox';
import { clemmy, isDesktop } from '@/lib/clemmy';
import { getRecallStatus, patchRecallSettings, listMeetings, getMeeting, getMeetingChatPrompt, type MeetingSummary, type RecallSettings } from '@/lib/meetings';
import { cn } from '@/lib/cn';
import { linkify } from '@/lib/linkify';

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
  permissionStatuses?: Record<string, string>;
  blocked?: { reason?: string; message?: string };
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
  const meetings = usePoll(['meetings'], listMeetings, 12000);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'info' | 'warn' | 'error'; text: string } | null>(null);

  const detail = useQuery({ queryKey: ['meeting', selected], queryFn: () => getMeeting(selected!), enabled: !!selected });

  const settings = status.data?.settings ?? {};
  const credConnected = (status.data?.credential?.status ?? '').toLowerCase() === 'connected';
  const regions = status.data?.regions ?? DEFAULT_REGIONS;
  const rows = meetings.data?.meetings ?? [];
  const sdkData = sdk.data ?? undefined;
  const recording = Boolean(sdkData?.recording);
  const perms = sdkData?.permissionStatuses ?? {};

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

  const discuss = async (id: string) => {
    try { const { prompt } = await getMeetingChatPrompt(id); navigate(`/chat?prompt=${encodeURIComponent(prompt)}`); }
    catch { navigate('/chat'); }
  };

  return (
    <Page title="Meetings" subtitle="Recorded meetings, summaries, and action items — powered by Recall.ai">
      {/* Capture controls */}
      <Card className="mb-6 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <Video className="h-5 w-5 text-primary" aria-hidden />
          <div className="flex-1">
            <h3 className="text-h3 text-fg">Meeting capture</h3>
            <p className="text-small text-muted">Clementine can join and transcribe your Zoom, Meet, and Teams calls.</p>
          </div>
          <StatusPill tone={credConnected ? 'success' : 'warning'}>{credConnected ? 'Recall.ai connected' : 'Not connected'}</StatusPill>
        </div>

        {status.isLoading ? (
          <Skeleton className="mt-4 h-24 w-full" />
        ) : status.isError ? (
          <p className="mt-4 text-body text-danger">Couldn't load meeting capture status.{' '}
            <button type="button" onClick={() => status.refetch()} className="cursor-pointer text-primary hover:underline">Retry</button>
          </p>
        ) : !credConnected ? (
          <p className="mt-4 text-body text-muted">Add your Recall.ai key in <span className="font-medium text-fg">Connect → Keys & accounts</span> to enable meeting capture.</p>
        ) : !desktop ? (
          <p className="mt-4 inline-flex items-center gap-2 text-body text-muted"><Mic className="h-4 w-4" aria-hidden /> Recording controls live in the Clementine desktop app.</p>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <label className="flex items-center gap-2 text-small text-fg"><Switch checked={!!settings.enabled} onChange={(v) => applySetting({ enabled: v })} label="Enable meeting capture" /> Enable meeting capture</label>
              <label className="flex items-center gap-2 text-small text-fg">
                Region
                <Select value={settings.region ?? 'us-west-2'} onChange={(e) => applySetting({ region: e.target.value })} className="w-44" disabled={!settings.enabled || busy}>
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
                  <label className="flex items-center gap-2 text-small text-fg"><Switch checked={!!settings.autoRecord} onChange={(v) => applySetting({ autoRecord: v })} label="Auto-record" /> Auto-record meetings</label>
                  <label className="flex items-center gap-2 text-small text-fg"><Switch checked={!!settings.liveTranscript} onChange={(v) => applySetting({ liveTranscript: v })} label="Live transcript" /> Live transcript</label>
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
            <div className="flex h-full min-h-48 items-center justify-center text-center text-body text-faint">Select a meeting to see the summary</div>
          ) : detail.isLoading ? <Skeleton className="h-64 w-full" /> : (
            <>
              <div className="mb-3 flex justify-end">
                <Button size="sm" onClick={() => discuss(selected)}><MessageCircle className="h-4 w-4" aria-hidden /> Discuss in chat</Button>
              </div>
              <MeetingDetailView data={detail.data} />
            </>
          )}
        </div>
      </div>
    </Page>
  );
}

function MeetingRow({ m, selected, onSelect }: { m: MeetingSummary; selected: boolean; onSelect: () => void }) {
  const tone = statusTone(m.status);
  return (
    <button type="button" onClick={onSelect}
      className={cn('flex w-full items-center gap-3 rounded-md border px-3.5 py-3 text-left transition-colors cursor-pointer',
        selected ? 'border-primary bg-primary-tint' : 'border-border bg-surface hover:bg-hover')}>
      <Video className="h-4 w-4 shrink-0 text-muted" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="truncate text-body text-fg">{m.title || `${m.platform ?? 'Meeting'} call`}</div>
        <div className="text-caption text-faint">{relativeTime(m.startedAt)}{typeof m.segmentCount === 'number' ? ` · ${m.segmentCount} segments` : ''}</div>
      </div>
      <StatusPill tone={tone.tone}>{tone.label}</StatusPill>
    </button>
  );
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

function MeetingDetailView({ data }: { data?: import('@/lib/meetings').MeetingDetail }) {
  const a = (data?.analysis ?? {}) as Record<string, unknown>;
  const r = (data?.record ?? {}) as Record<string, unknown>;
  const summary = asText(a.summary);
  const actionItems = toList(a.actionItems).map(asText).filter(Boolean);
  const decisions = toList(a.decisions).map(asText).filter(Boolean);
  const topics = toList(a.topics).map(asText).filter(Boolean);
  const participants = toList(a.participants).map(asText).filter(Boolean);
  const segments = toList(r.segments).filter((s) => asText((s as Record<string, unknown>)?.text));
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-caption text-faint">
        <span className="uppercase tracking-wide">{asText(r.platform)}</span>
        {r.startedAt ? <span>· {relativeTime(asText(r.startedAt))}</span> : null}
      </div>
      <h3 className="mb-3 text-h2 text-fg">{asText(a.title) || 'Meeting'}</h3>
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
