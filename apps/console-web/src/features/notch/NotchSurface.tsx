import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  ArrowUp,
  ChevronUp,
  ExternalLink,
  LoaderCircle,
  Mic,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { DogMark } from '@/components/DogMark';
import { cn } from '@/lib/cn';
import { getLiveActivity, type NotchLiveActivity } from '@/lib/live-activity';
import { NotchVoice, type NotchVoiceStatus } from '@/lib/notch-voice';
import {
  createInitialNotchState,
  notchReducer,
  notchSurfaceSize,
  notchVoiceSurfaceSize,
} from './notch-model';
import {
  alwaysRecordDetectedMeeting,
  acknowledgeLiveSurfaceMounted,
  dismissDetectedMeeting,
  dismissLiveSurface,
  getLiveMeetingStatus,
  openClementineConsole,
  recordDetectedMeeting,
  requestLiveMeetingPermissions,
  resizeLiveSurface,
  stopDetectedMeeting,
  subscribeToLiveMeetingEvents,
  subscribeToLivePreview,
} from './notch-bridge';
import { NotchMeetingSurface, notchMeetingSurfaceSize } from './NotchMeetingSurface';
import {
  INITIAL_NOTCH_MEETING_STATE,
  notchMeetingCaptureInterrupted,
  notchMeetingReducer,
  type NotchMeetingBusyAction,
} from './notch-meeting-model';
import './notch.css';

/** How often the non-meeting notch refetches live activity. */
const LIVE_ACTIVITY_POLL_MS = 4_000;
let nextLiveLayoutId = Date.now() * 1_000;

function createLiveLayoutId(): number {
  nextLiveLayoutId += 1;
  return nextLiveLayoutId;
}

/** State glyph for the current live-activity state. */
function LiveStateGlyph({ state }: { state: NotchLiveActivity['state'] }) {
  const className = 'h-4 w-4';
  switch (state) {
    case 'working':
      return <LoaderCircle className={cn(className, 'clemmy-live-spin')} aria-hidden />;
    case 'approval':
      return <ShieldCheck className={className} aria-hidden />;
    case 'idle':
      return <Sparkles className={className} aria-hidden />;
  }
}

function SurfaceButton({
  children,
  className,
  kind = 'secondary',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  kind?: 'primary' | 'secondary' | 'quiet' | 'danger';
}) {
  return (
    <button
      type="button"
      className={cn('clemmy-live-button', `clemmy-live-button--${kind}`, className)}
      {...props}
    >
      {children}
    </button>
  );
}

export function NotchSurface() {
  const [state, dispatch] = useReducer(notchReducer, undefined, createInitialNotchState);
  const [meetingState, dispatchMeeting] = useReducer(notchMeetingReducer, INITIAL_NOTCH_MEETING_STATE);
  const [meetingExpanded, setMeetingExpanded] = useState(true);
  const [meetingBusyAction, setMeetingBusyActionState] = useState<NotchMeetingBusyAction>(null);
  const [nativeHover, setNativeHover] = useState(false);
  const meetingBusyActionRef = useRef(meetingBusyAction);
  const collapsedButtonRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const mountedAcknowledgedRef = useRef(false);
  const previouslyExpandedRef = useRef(state.expanded);
  const activity = state.activity;
  const meetingActive = meetingState.phase !== 'idle';
  // Voice companion: press the mic (or the global shortcut) and speak a request
  // ("hey, pull up my pipeline"). NotchVoice records the clip, transcribes it
  // (whisper-1 — plain speech-to-text, no realtime voice), and sends the text to
  // the local Clementine agent (brain + tools + gates). The notch shows what you
  // said + Clementine's reply so you can see it landed, then jump into the app.
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<NotchVoiceStatus>('idle');
  const [voiceLabel, setVoiceLabel] = useState('');
  const [voiceUser, setVoiceUser] = useState('');
  const [voiceAssistant, setVoiceAssistant] = useState('');
  const [voiceError, setVoiceError] = useState('');
  const [voiceLevel, setVoiceLevel] = useState(0);
  const voiceRef = useRef<NotchVoice | null>(null);
  // Refs so the global-shortcut handler (a stable subscription) can read live
  // voice state without re-subscribing: first press starts recording, a second
  // press while recording sends.
  const voiceActiveRef = useRef(false);
  const voiceStatusRef = useRef<NotchVoiceStatus>('idle');
  const meetingActiveRef = useRef(meetingActive);
  const meetingPhaseRef = useRef(meetingState.phase);
  useEffect(() => { voiceActiveRef.current = voiceActive; }, [voiceActive]);
  useEffect(() => { voiceStatusRef.current = voiceStatus; }, [voiceStatus]);
  useEffect(() => { meetingActiveRef.current = meetingActive; }, [meetingActive]);
  useEffect(() => { meetingPhaseRef.current = meetingState.phase; }, [meetingState.phase]);
  useEffect(() => { if (voiceStatus !== 'recording') setVoiceLevel(0); }, [voiceStatus]);

  const setMeetingBusyAction = useCallback((action: NotchMeetingBusyAction) => {
    meetingBusyActionRef.current = action;
    setMeetingBusyActionState(action);
  }, []);

  const clearMeetingBusyAction = useCallback((action: Exclude<NotchMeetingBusyAction, null>) => {
    if (meetingBusyActionRef.current !== action) return;
    meetingBusyActionRef.current = null;
    setMeetingBusyActionState(null);
  }, []);
  const size = useMemo(
    () => {
      if (meetingActive) return notchMeetingSurfaceSize(meetingState, meetingExpanded);
      if (voiceActive) {
        return notchVoiceSurfaceSize({
          hasTranscript: Boolean(voiceUser),
          hasResponse: Boolean(voiceAssistant),
          hasError: Boolean(voiceError),
        });
      }
      return notchSurfaceSize(state);
    },
    [
      meetingActive,
      voiceActive,
      voiceUser,
      voiceAssistant,
      voiceError,
      meetingExpanded,
      meetingState,
      state.expanded,
      activity.state,
    ],
  );
  const presentation = !meetingActive && !voiceActive && !state.expanded
    ? 'dormant' as const
    : 'panel' as const;
  const layoutKey = `${presentation}:${size.width}:${size.height}`;
  const [appliedLayoutKey, setAppliedLayoutKey] = useState(layoutKey);
  const layoutReady = appliedLayoutKey === layoutKey;

  const collapse = useCallback(() => {
    dispatch({ type: 'collapse' });
  }, []);

  const dismiss = useCallback(() => {
    dispatch({ type: 'dismiss' });
    dismissLiveSurface();
  }, []);

  const stopVoice = useCallback(() => {
    voiceRef.current?.cancel();
    voiceRef.current = null;
    setVoiceActive(false);
  }, []);

  const openConsole = useCallback(() => {
    stopVoice();
    dispatch({ type: 'collapse' });
    openClementineConsole();
  }, [stopVoice]);

  const startVoice = useCallback(() => {
    if (meetingActiveRef.current) return;
    setVoiceActive(true);
  }, []);

  const sendVoice = useCallback(() => {
    voiceRef.current?.stopAndSend().catch((err: Error) => {
      setVoiceStatus('error');
      setVoiceError(err?.message || 'Could not send that request.');
    });
  }, []);

  useEffect(() => {
    document.documentElement.classList.add('clemmy-live-document');
    return () => document.documentElement.classList.remove('clemmy-live-document');
  }, []);

  // Voice lifecycle: when voice mode turns on, start recording the mic. The user
  // taps Send (or the shortcut again) to transcribe + route the request into the
  // Clementine brain. Teardown cancels any in-flight capture.
  useEffect(() => {
    if (!voiceActive) return undefined;
    setVoiceError(''); setVoiceUser(''); setVoiceAssistant('');
    setVoiceStatus('recording'); setVoiceLabel('Starting…');
    const voice = new NotchVoice({
      onStatus: (s, l) => { setVoiceStatus(s); if (l) setVoiceLabel(l); },
      onUserText: setVoiceUser,
      onAssistantText: setVoiceAssistant,
      onLevel: (lvl) => setVoiceLevel((prev) => prev * 0.6 + lvl * 0.4),
    });
    voiceRef.current = voice;
    voice.startRecording().catch((err: Error) => {
      setVoiceStatus('error');
      setVoiceError(err?.message || 'Microphone is unavailable right now.');
    });
    return () => { voice.cancel(); voiceRef.current = null; };
  }, [voiceActive]);

  // Meeting controls take exclusive ownership of the notch. Stop dictation as
  // soon as that mode appears so microphone capture can never continue behind
  // a meeting prompt or recording surface.
  useEffect(() => {
    if (meetingActive && voiceActiveRef.current) stopVoice();
  }, [meetingActive, stopVoice]);

  useEffect(() => {
    let active = true;
    let eventRevision = 0;
    let hydrationRetries = 0;
    const unsubscribe = subscribeToLiveMeetingEvents((event) => {
      if (!active) return;
      eventRevision += 1;
      dispatchMeeting({ type: 'event', event });
    });
    const hydrateCurrentStatus = async (): Promise<void> => {
      const requestedAtRevision = eventRevision;
      const status = await getLiveMeetingStatus().catch(() => null);
      if (!active || !status) return;
      if (requestedAtRevision !== eventRevision) {
        // An event newer than this main-process snapshot already reached the
        // reducer. Retry instead of letting stale hydration regress Recording
        // back to Starting (or resurrect an old prompt).
        if (hydrationRetries < 3) {
          hydrationRetries += 1;
          void hydrateCurrentStatus();
        }
        return;
      }
      dispatchMeeting({ type: 'hydrate', status });
    };
    void hydrateCurrentStatus();
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (meetingState.phase === 'prompt'
        || meetingState.phase === 'starting'
        || meetingState.phase === 'recording'
        || meetingState.phase === 'error') {
      setMeetingExpanded(true);
    }
  }, [meetingState.phase]);

  useEffect(() => {
    if (meetingState.phase === 'recording' && notchMeetingCaptureInterrupted(meetingState)) {
      setMeetingExpanded(true);
    }
  }, [meetingState.audioCapturing, meetingState.networkStatus, meetingState.phase]);

  useEffect(() => {
    let active = true;
    let retryTimer: number | null = null;
    let attempt = 0;
    const layoutId = createLiveLayoutId();

    const applyLayout = async (): Promise<void> => {
      const applied = await resizeLiveSurface(size, presentation, layoutId);
      if (!active) return;
      if (applied) {
        setAppliedLayoutKey(layoutKey);
        return;
      }
      // The native frame must lead rendering. Retry a transient navigation/IPC
      // race so the panel cannot remain stranded inside the dormant 62px frame.
      attempt += 1;
      const delay = Math.min(1_000, 40 * (2 ** Math.min(attempt, 5)));
      retryTimer = window.setTimeout(() => { void applyLayout(); }, delay);
    };

    void applyLayout();
    return () => {
      active = false;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [layoutKey, presentation, size]);

  // Poll real live activity for the non-meeting surface: immediately, on an
  // interval, and on window focus. Errors are swallowed so a transient read
  // failure keeps the last good state instead of blanking the notch. Skipped
  // entirely during a meeting to avoid churn while the meeting surface owns it.
  useEffect(() => {
    if (meetingActive) return undefined;
    let active = true;
    let newestRequest = 0;
    const refresh = async (): Promise<void> => {
      newestRequest += 1;
      const request = newestRequest;
      try {
        const next = await getLiveActivity();
        if (active && request === newestRequest) dispatch({ type: 'set-activity', activity: next });
      } catch {
        // Keep the last good activity on any read failure.
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), LIVE_ACTIVITY_POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [meetingActive]);

  useEffect(() => {
    if (meetingActive) return;
    const wasExpanded = previouslyExpandedRef.current;
    previouslyExpandedRef.current = state.expanded;
    if (state.expanded && !wasExpanded) {
      headingRef.current?.focus({ preventScroll: true });
    } else if (!state.expanded && wasExpanded) {
      collapsedButtonRef.current?.focus({ preventScroll: true });
    }
  }, [meetingActive, state.expanded]);

  useEffect(() => {
    if (meetingActive) return undefined;
    const focusCollapsedSurface = () => {
      if (!state.expanded) collapsedButtonRef.current?.focus({ preventScroll: true });
    };
    window.addEventListener('focus', focusCollapsedSurface);
    if (document.hasFocus()) focusCollapsedSurface();
    return () => window.removeEventListener('focus', focusCollapsedSurface);
  }, [meetingActive, state.expanded]);

  useEffect(() => {
    // Subscribe before acknowledging the mount. The main process may replay a
    // queued shortcut/voice intent synchronously from the acknowledgement.
    const unsubscribe = subscribeToLivePreview((payload) => {
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const kind = (payload as { kind?: unknown }).kind;
        if (kind === 'meeting-expand') {
          setMeetingExpanded(true);
          return;
        }
        if (kind === 'meeting-collapse') {
          setMeetingExpanded(false);
          return;
        }
        // The desktop reports the physical notch / menu-bar inset so we can pad the
        // surface DOWN below the notch (the window itself spans the inset at y=0).
        if (kind === 'shell-state') {
          const inset = (payload as { topInset?: unknown }).topInset;
          if (typeof inset === 'number' && Number.isFinite(inset)) {
            document.documentElement.style.setProperty('--notch-inset', `${Math.max(0, Math.round(inset))}px`);
          }
          return;
        }
        // The configurable notch shortcut opens/closes the panel (same as clicking
        // the dormant logo).
        if (kind === 'toggle-expand') {
          if (meetingActiveRef.current) {
            if (meetingPhaseRef.current === 'recording') {
              setMeetingExpanded((current) => !current);
            }
            return;
          }
          if (voiceActiveRef.current) {
            voiceRef.current?.cancel();
            voiceRef.current = null;
            setVoiceActive(false);
            dispatch({ type: 'collapse' });
            return;
          }
          dispatch({ type: 'toggle' });
          return;
        }
        if (kind === 'expand') {
          if (meetingActiveRef.current || voiceActiveRef.current) return;
          dispatch({ type: 'expand' });
          return;
        }
        if (kind === 'native-hover') {
          setNativeHover((payload as { active?: unknown }).active === true);
          return;
        }
        // The global voice shortcut (main process): first press starts recording,
        // a second press while recording sends the request.
        if (kind === 'start-voice') {
          if (meetingActiveRef.current) return;
          if (!voiceActiveRef.current) {
            setVoiceActive(true);
          } else if (voiceStatusRef.current === 'recording') {
            voiceRef.current?.stopAndSend().catch((err: Error) => {
              setVoiceStatus('error');
              setVoiceError(err?.message || 'Could not send that request.');
            });
          }
        }
      }
    });
    if (!mountedAcknowledgedRef.current) {
      mountedAcknowledgedRef.current = true;
      acknowledgeLiveSurfaceMounted();
    }
    return unsubscribe;
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (voiceActive && event.key === 'Escape') {
        event.preventDefault();
        stopVoice();
        dispatch({ type: 'collapse' });
        return;
      }
      if (meetingActive && event.key === 'Escape') {
        event.preventDefault();
        if (meetingState.phase === 'recording' && meetingExpanded) setMeetingExpanded(false);
        else if (meetingState.phase === 'prompt' || meetingState.phase === 'stopped' || meetingState.phase === 'error') {
          dismissLiveSurface();
        }
        return;
      }
      if (event.key === 'Escape' && state.expanded) {
        event.preventDefault();
        dismiss();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dismiss, meetingActive, meetingExpanded, meetingState.phase, state.expanded, stopVoice, voiceActive]);

  const runMeetingStart = async (always: boolean) => {
    const meeting = meetingState.meeting;
    if (!meeting || meetingBusyActionRef.current) return;
    const startAction = always ? 'start-auto' : 'start';
    setMeetingBusyAction(startAction);
    try {
      const status = await (always
        ? alwaysRecordDetectedMeeting(meeting.windowId)
        : recordDetectedMeeting(meeting.windowId));
      dispatchMeeting({ type: 'hydrate', status });
    } catch (error) {
      // A concurrent Cancel owns presentation from this point forward. Its
      // authoritative status hydration will settle the surface without briefly
      // presenting a failed start as an active recording.
      if (meetingBusyActionRef.current !== 'stop') {
        dispatchMeeting({ type: 'failure', message: error instanceof Error ? error.message : 'Meeting recording could not start.' });
      }
    } finally {
      clearMeetingBusyAction(startAction);
    }
  };

  const dismissMeeting = async () => {
    const meeting = meetingState.meeting;
    if (!meeting || meetingBusyActionRef.current) return;
    setMeetingBusyAction('dismiss');
    try {
      const status = await dismissDetectedMeeting(meeting.windowId);
      dispatchMeeting({ type: 'hydrate', status });
      dismissLiveSurface();
    } catch (error) {
      dispatchMeeting({ type: 'failure', message: error instanceof Error ? error.message : 'Could not dismiss this meeting.' });
    } finally {
      clearMeetingBusyAction('dismiss');
    }
  };

  const stopMeeting = async () => {
    const meeting = meetingState.meeting;
    const pendingAction = meetingBusyActionRef.current;
    if (!meeting || pendingAction === 'stop'
        || (pendingAction !== null && pendingAction !== 'start' && pendingAction !== 'start-auto')) return;
    setMeetingBusyAction('stop');
    dispatchMeeting({ type: 'stop' });
    try {
      const status = await stopDetectedMeeting(meeting.windowId);
      dispatchMeeting({ type: 'hydrate', status });
    } catch (error) {
      dispatchMeeting({ type: 'failure', message: error instanceof Error ? error.message : 'Meeting recording could not stop safely.' });
    } finally {
      clearMeetingBusyAction('stop');
    }
  };

  const requestMeetingPermissions = async () => {
    if (meetingBusyActionRef.current) return;
    setMeetingBusyAction('permissions');
    try {
      const status = await requestLiveMeetingPermissions();
      dispatchMeeting({ type: 'hydrate', status });
    } catch (error) {
      dispatchMeeting({ type: 'failure', message: error instanceof Error ? error.message : 'Meeting permissions need attention.' });
    } finally {
      clearMeetingBusyAction('permissions');
    }
  };

  const style = {
    '--clemmy-live-width': `${size.width}px`,
    '--clemmy-live-height': `${size.height}px`,
    '--clemmy-live-layout-opacity': layoutReady ? 1 : 0,
  } as CSSProperties;

  if (meetingActive) {
    return (
      <NotchMeetingSurface
        state={meetingState}
        expanded={meetingExpanded}
        busyAction={meetingBusyAction}
        style={style}
        onExpand={() => setMeetingExpanded(true)}
        onCollapse={() => setMeetingExpanded(false)}
        onHide={dismissLiveSurface}
        onRecord={() => void runMeetingStart(false)}
        onAlwaysRecord={() => void runMeetingStart(true)}
        onDismissPrompt={() => void dismissMeeting()}
        onStop={() => void stopMeeting()}
        onRequestPermissions={() => void requestMeetingPermissions()}
        onOpenConsole={openConsole}
        onClear={() => { dispatchMeeting({ type: 'clear' }); dismissLiveSurface(); }}
      />
    );
  }

  // Working continuity: once the spoken turn returns, if it left a task running
  // (per the live-activity poll) keep showing "Working — <task>" instead of a flat
  // "Done", updating live until the task finishes.
  const voiceWorking = voiceStatus === 'done' && !voiceError && activity.state === 'working';
  const voiceDisplayLabel = voiceError
    ? 'Voice unavailable'
    : voiceWorking
      ? (activity.title ? `Working — ${activity.title}` : 'Working…')
      : (voiceLabel || 'Listening…');
  const voiceDotStatus: NotchVoiceStatus = voiceWorking ? 'thinking' : voiceStatus;

  if (voiceActive) {
    const voiceHasContent = Boolean(voiceUser || voiceAssistant || voiceError);
    return (
      <main className="clemmy-live-stage" style={style} data-testid="clemmy-live-stage">
        <section
          className="clemmy-live-island clemmy-live-voice"
          data-voice={voiceStatus}
          data-has-content={voiceHasContent ? 'true' : undefined}
          aria-label="Talk to Clementine"
        >
          <header className="clemmy-live-header clemmy-live-voice-header">
            <button
              type="button"
              className="clemmy-live-voice-action"
              onClick={stopVoice}
              aria-label={voiceStatus === 'recording' ? 'Cancel voice request' : 'Close voice'}
              title={voiceStatus === 'recording' ? 'Cancel' : 'Close'}
            >
              <X aria-hidden />
            </button>
            <div className="clemmy-live-brand clemmy-live-voice-brand">
              <span aria-hidden><DogMark size={24} className="clemmy-live-dog" /></span>
              <strong>Clementine</strong>
            </div>
            {voiceStatus === 'recording' && !voiceError ? (
              <button
                type="button"
                className="clemmy-live-voice-action clemmy-live-voice-send"
                onClick={sendVoice}
                aria-label="Send voice request now"
                title="Send now"
              >
                <ArrowUp aria-hidden />
              </button>
            ) : (
              <button
                type="button"
                className="clemmy-live-voice-action"
                onClick={openConsole}
                aria-label="Open Clementine console"
                title="Open Clementine"
              >
                <ExternalLink aria-hidden />
              </button>
            )}
          </header>

          <div className="clemmy-live-voice-body">
            <p className="clemmy-live-voice-status" aria-live="polite">
              {voiceStatus === 'recording' && !voiceError ? (
                <span className="clemmy-live-voice-meter" aria-hidden style={{ '--lvl': voiceLevel } as CSSProperties}>
                  <span className="clemmy-live-voice-bar" />
                  <span className="clemmy-live-voice-bar" />
                  <span className="clemmy-live-voice-bar" />
                  <span className="clemmy-live-voice-bar" />
                  <span className="clemmy-live-voice-bar" />
                </span>
              ) : (
                <span className={cn('clemmy-live-voice-dot', voiceError ? 'is-error' : `is-${voiceDotStatus}`)} aria-hidden />
              )}
              <span className="clemmy-live-voice-status-label">{voiceDisplayLabel}</span>
            </p>
            {voiceError ? (
              <p className="clemmy-live-voice-error">{voiceError}</p>
            ) : voiceUser || voiceAssistant ? (
              <div className="clemmy-live-voice-transcript" aria-live="polite">
                {voiceUser && (
                  <div className="clemmy-live-voice-message" data-speaker="you">
                    <span>You</span>
                    <p>{voiceUser}</p>
                  </div>
                )}
                {voiceAssistant && (
                  <div className="clemmy-live-voice-message" data-speaker="clementine">
                    <span>Clementine</span>
                    <p>{voiceAssistant}</p>
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </section>
      </main>
    );
  }

  // Dormant: the Clementine logo sits beside the notch with a tiny mic badge so
  // its voice-first action is discoverable. Live work replaces the badge with a
  // status dot; the expanded panel keeps a labeled Talk action available.
  const collapsedAriaLabel =
    `Talk to Clementine.${activity.title ? ` ${activity.title}${activity.detail ? ', ' + activity.detail : ''}.` : ''}`;

  if (!state.expanded) {
    return (
      <main className="clemmy-live-stage" style={style} data-testid="clemmy-live-stage">
        <button
          ref={collapsedButtonRef}
          type="button"
          className="clemmy-live-collapsed clemmy-live-dormant"
          data-native-hover={nativeHover ? 'true' : undefined}
          data-phase={activity.state}
          onClick={startVoice}
          title="Talk to Clementine"
          aria-expanded="false"
          aria-label={collapsedAriaLabel}
        >
          <span className="clemmy-live-collapsed-avatar" aria-hidden>
            <DogMark size={22} />
            {activity.state === 'idle' ? (
              <span className="clemmy-live-voice-badge"><Mic /></span>
            ) : (
              <span className="clemmy-live-availability-dot" />
            )}
          </span>
        </button>
      </main>
    );
  }

  return (
    <main className="clemmy-live-stage" style={style} data-testid="clemmy-live-stage">
      <section
        className="clemmy-live-island"
        data-phase={activity.state}
        aria-label="Clementine"
      >
        <header className="clemmy-live-header">
          <div className="clemmy-live-brand">
            <span aria-hidden><DogMark size={28} className="clemmy-live-dog" /></span>
            <strong>Clementine</strong>
          </div>

          <div className="clemmy-live-window-actions">
            <button
              type="button"
              onClick={startVoice}
              aria-label="Talk to Clementine"
              title="Talk to Clementine"
              className="clemmy-live-mic clemmy-live-talk"
            >
              <Mic aria-hidden />
              <span>Talk</span>
            </button>
            <button type="button" onClick={openConsole} aria-label="Open Clementine console">
              <ExternalLink aria-hidden />
            </button>
            <button type="button" onClick={collapse} aria-label="Collapse Clementine" aria-expanded="true">
              <ChevronUp aria-hidden />
            </button>
            <button type="button" onClick={dismiss} aria-label="Dismiss Clementine">
              <X aria-hidden />
            </button>
          </div>
        </header>

        <div className="clemmy-live-content">
          <div className="clemmy-live-state-copy" aria-live="polite" aria-atomic="true">
            <span className="clemmy-live-status-pill">
              <LiveStateGlyph state={activity.state} />
              {activity.state === 'approval' ? 'Needs you' : activity.state === 'working' ? 'Working' : 'Ready'}
            </span>
            <h1 ref={headingRef} tabIndex={-1}>{activity.title}</h1>
            <p>{activity.detail || (activity.state === 'idle' ? 'Choose Talk to dictate a request.' : '')}</p>
          </div>

          {activity.state === 'approval' && (
            <div className="clemmy-live-primary-actions">
              <SurfaceButton kind="primary" onClick={openConsole}>
                <ShieldCheck aria-hidden /> Review &amp; approve →
              </SurfaceButton>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
