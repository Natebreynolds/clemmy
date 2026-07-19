import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  LoaderCircle,
  Radio,
  ShieldAlert,
  Square,
  Video,
  X,
} from 'lucide-react';
import { DogMark } from '@/components/DogMark';
import { cn } from '@/lib/cn';
import {
  AUTO_RECORD_CONSENT_LABEL,
  meetingDisplayName,
  meetingPlatformLabel,
  notchMeetingCaptureInterrupted,
  notchMeetingStopControl,
  type NotchMeetingBusyAction,
  type NotchMeetingState,
} from './notch-meeting-model';
import type { NotchSurfaceSize } from './notch-model';

export function notchMeetingSurfaceSize(state: NotchMeetingState, expanded: boolean): NotchSurfaceSize {
  if (!expanded && state.phase === 'recording') return { width: 326, height: 46 };
  if (state.phase === 'prompt') return { width: 440, height: 286 };
  if (state.phase === 'error') return { width: 440, height: 286 };
  if (state.phase === 'recording') return { width: 440, height: 254 };
  return { width: 440, height: 230 };
}

function elapsedLabel(startedAt?: string, now = Date.now()): string {
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  const seconds = Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 1000)) : 0;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`;
}

function MeetingButton({
  children,
  onClick,
  primary = false,
  danger = false,
  disabled = false,
}: {
  children: ReactNode;
  onClick: () => void;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={cn(
        'clemmy-live-button',
        primary ? 'clemmy-live-button--primary' : danger ? 'clemmy-live-button--danger' : 'clemmy-live-button--secondary',
      )}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function NotchMeetingSurface({
  state,
  expanded,
  busyAction,
  style,
  onExpand,
  onCollapse,
  onHide,
  onRecord,
  onAlwaysRecord,
  onDismissPrompt,
  onStop,
  onRequestPermissions,
  onOpenConsole,
  onClear,
}: {
  state: NotchMeetingState;
  expanded: boolean;
  busyAction: NotchMeetingBusyAction;
  style: CSSProperties;
  onExpand: () => void;
  onCollapse: () => void;
  onHide: () => void;
  onRecord: () => void;
  onAlwaysRecord: () => void;
  onDismissPrompt: () => void;
  onStop: () => void;
  onRequestPermissions: () => void;
  onOpenConsole: () => void;
  onClear: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousPhaseRef = useRef(state.phase);
  useEffect(() => {
    if (state.phase !== 'recording') return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [state.phase, state.recordingStartedAt]);

  useEffect(() => {
    const changed = previousPhaseRef.current !== state.phase;
    previousPhaseRef.current = state.phase;
    if (!changed || !document.hasFocus()) return undefined;
    const frame = window.requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [state.phase]);

  const elapsed = useMemo(
    () => elapsedLabel(state.recordingStartedAt, now),
    [now, state.recordingStartedAt],
  );
  const title = meetingDisplayName(state.meeting);
  const platform = meetingPlatformLabel(state.meeting);
  const captureInterrupted = notchMeetingCaptureInterrupted(state);
  const stopControl = notchMeetingStopControl(state.phase, busyAction);
  const audioState = state.networkStatus === 'disconnected'
    ? { label: 'Connection interrupted', tone: 'interrupted' }
    : state.audioCapturing === true
      ? { label: 'Live', tone: 'live' }
      : state.audioCapturing === false
        ? { label: 'Interrupted', tone: 'interrupted' }
        : { label: 'Checking', tone: 'checking' };

  if (!expanded && state.phase === 'recording') {
    return (
      <main className="clemmy-live-stage" style={style} data-testid="clemmy-live-stage">
        <button
          type="button"
          className="clemmy-live-collapsed clemmy-live-meeting-collapsed"
          onClick={onExpand}
          aria-expanded="false"
          aria-label={captureInterrupted
            ? `Meeting capture interrupted, ${elapsed}. ${title}. Expand meeting controls.`
            : `Recording meeting, ${elapsed}. ${title}. Expand meeting controls.`}
          data-capture-state={captureInterrupted ? 'interrupted' : 'live'}
        >
          <span className="clemmy-live-collapsed-avatar" aria-hidden><DogMark size={24} /></span>
          <span className="clemmy-live-collapsed-copy">
            <span className="clemmy-live-preview-label clemmy-live-recording-label"><Radio aria-hidden /> {captureInterrupted ? 'Capture interrupted' : 'Recording'} · {elapsed}</span>
            <span className="clemmy-live-collapsed-progress"><strong>{title}</strong><em>{platform}</em></span>
          </span>
          <ChevronDown className="h-4 w-4" aria-hidden />
        </button>
      </main>
    );
  }

  const permissionError = state.phase === 'error' && /permission|screen recording/i.test(state.error ?? '');
  const phaseCopy = (() => {
    switch (state.phase) {
      case 'prompt': return {
        label: 'Meeting detected',
        headline: title,
        summary: platform === 'Recall' ? 'Clementine detected an online call.' : `Clementine detected this ${platform} call.`,
      };
      case 'starting': return { label: 'Starting', headline: 'Starting recording…', summary: `${title} · ${platform}` };
      case 'recording': return {
        label: state.error ? 'Recording · Stop needs attention' : 'Recording',
        headline: 'Recording meeting',
        summary: state.error ?? `${title} · ${platform}`,
      };
      case 'stopping': return { label: 'Saving', headline: 'Stopping & saving…', summary: 'Clementine is safely finalizing this recording.' };
      case 'stopped': return { label: 'Stopped', headline: 'Recording stopped', summary: state.error ?? 'Clementine is finalizing the transcript and summary.' };
      case 'error': return {
        label: permissionError ? 'Permission needed' : 'Needs attention',
        headline: permissionError ? 'Meeting permission needed' : 'Recording needs attention',
        summary: state.error ?? 'Clementine could not start this meeting recording.',
      };
      case 'idle': return { label: 'Meeting', headline: title, summary: platform };
    }
  })();

  return (
    <main className="clemmy-live-stage" style={style} data-testid="clemmy-live-stage">
      <section className="clemmy-live-island clemmy-live-meeting" data-meeting-phase={state.phase} aria-label="Clementine meeting controls">
        <header className="clemmy-live-header clemmy-live-meeting-header">
          <div className="clemmy-live-brand"><span aria-hidden><DogMark size={28} className="clemmy-live-dog" /></span><strong>Clementine</strong></div>
          <div className="clemmy-live-preview-banner clemmy-live-meeting-banner" role="status"><Video aria-hidden /><span>Recall meeting</span></div>
          <div className="clemmy-live-window-actions">
            <button type="button" onClick={onOpenConsole} aria-label="Open Clementine"><ExternalLink aria-hidden /></button>
            {state.phase === 'recording' && (
              <button type="button" onClick={onCollapse} aria-label="Collapse recording controls" aria-expanded="true"><ChevronUp aria-hidden /></button>
            )}
            {state.phase !== 'starting' && state.phase !== 'recording' && state.phase !== 'stopping' && (
              <button type="button" onClick={onHide} aria-label="Hide meeting controls"><X aria-hidden /></button>
            )}
          </div>
        </header>

        <div className="clemmy-live-meeting-content">
          <div className="clemmy-live-meeting-hero" aria-live="polite" aria-atomic="true">
            <span className="clemmy-live-meeting-icon" aria-hidden>
              {state.phase === 'error' ? <ShieldAlert /> : state.phase === 'recording' ? <Radio /> : state.phase === 'starting' || state.phase === 'stopping' ? <LoaderCircle className="clemmy-live-spin" /> : <Video />}
            </span>
            <div>
              <span>{phaseCopy.label}</span>
              <h1 ref={headingRef} tabIndex={-1}>{phaseCopy.headline}</h1>
              <p>{phaseCopy.summary}</p>
            </div>
          </div>

          {state.phase === 'recording' && (
            <div className="clemmy-live-capture-fact" data-capture-state={audioState.tone}>
              <span><Radio aria-hidden /> Audio capture</span>
              <span className="clemmy-live-capture-status">
                <strong role={captureInterrupted ? 'alert' : 'status'}>{audioState.label}</strong>
                <time aria-label={`Elapsed time ${elapsed}`}>{elapsed}</time>
              </span>
            </div>
          )}

          <div className="clemmy-live-primary-actions clemmy-live-meeting-actions">
            {state.phase === 'prompt' && (
              <>
                <MeetingButton primary onClick={onRecord} disabled={busyAction !== null}><Video aria-hidden /> {busyAction === 'start' ? 'Preparing…' : 'Record meeting'}</MeetingButton>
                <MeetingButton onClick={onAlwaysRecord} disabled={busyAction !== null}>{busyAction === 'start-auto' ? 'Preparing auto-record…' : AUTO_RECORD_CONSENT_LABEL}</MeetingButton>
                <MeetingButton onClick={onDismissPrompt} disabled={busyAction !== null}>{busyAction === 'dismiss' ? 'Dismissing…' : 'Not this time'}</MeetingButton>
              </>
            )}
            {state.phase === 'recording' && (
              <MeetingButton danger onClick={onStop} disabled={stopControl?.disabled}><Square aria-hidden /> {stopControl?.label}</MeetingButton>
            )}
            {state.phase === 'starting' && (
              <MeetingButton danger onClick={onStop} disabled={stopControl?.disabled}><Square aria-hidden /> {stopControl?.label}</MeetingButton>
            )}
            {state.phase === 'stopping' && (
              <MeetingButton onClick={onOpenConsole}>Open Clementine</MeetingButton>
            )}
            {state.phase === 'stopped' && (
              <>
                <MeetingButton primary onClick={onOpenConsole}><ExternalLink aria-hidden /> Open Clementine</MeetingButton>
                <MeetingButton onClick={onClear}>Dismiss</MeetingButton>
              </>
            )}
            {state.phase === 'error' && (
              <>
                {permissionError && <MeetingButton primary onClick={onRequestPermissions} disabled={busyAction !== null}><ShieldAlert aria-hidden /> {busyAction === 'permissions' ? 'Opening…' : 'Review permissions'}</MeetingButton>}
                <MeetingButton onClick={onOpenConsole}><ExternalLink aria-hidden /> Open Clementine</MeetingButton>
                <MeetingButton onClick={onClear}>Dismiss</MeetingButton>
              </>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
