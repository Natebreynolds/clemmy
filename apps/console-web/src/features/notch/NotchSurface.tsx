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
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleX,
  ExternalLink,
  LoaderCircle,
  MicOff,
  Pause,
  Play,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
  UsersRound,
  X,
} from 'lucide-react';
import { DogMark } from '@/components/DogMark';
import { cn } from '@/lib/cn';
import {
  DEMO_SEQUENCE,
  NOTCH_PREVIEW_FRAMES,
  createInitialNotchState,
  notchReducer,
  notchSurfaceSize,
  previewActionFromBridge,
  type NotchAction,
  type NotchActivityTone,
  type NotchAgentState,
  type NotchPreviewPhase,
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

const DEMO_STEP_MS = 2_000;

function ActivityIcon({ tone }: { tone: NotchActivityTone }) {
  const shared = 'h-3.5 w-3.5 shrink-0';
  switch (tone) {
    case 'complete':
      return <Check className={shared} aria-hidden />;
    case 'active':
      return <LoaderCircle className={cn(shared, 'clemmy-live-spin')} aria-hidden />;
    case 'waiting':
      return <Circle className={shared} aria-hidden />;
    case 'attention':
      return <ShieldCheck className={shared} aria-hidden />;
    case 'success':
      return <CheckCircle2 className={shared} aria-hidden />;
    case 'error':
      return <AlertCircle className={shared} aria-hidden />;
  }
}

function StateGlyph({ phase }: { phase: NotchPreviewPhase }) {
  const className = 'h-4 w-4';
  switch (phase) {
    case 'review':
      return <Sparkles className={className} aria-hidden />;
    case 'working':
      return <LoaderCircle className={cn(className, 'clemmy-live-spin')} aria-hidden />;
    case 'approval':
      return <ShieldCheck className={className} aria-hidden />;
    case 'completed':
      return <CheckCircle2 className={className} aria-hidden />;
    case 'cancelled':
      return <CircleX className={className} aria-hidden />;
    case 'failure':
      return <AlertCircle className={className} aria-hidden />;
  }
}

const AGENT_STATE_LABELS: Readonly<Record<NotchAgentState, string>> = {
  completed: 'Completed',
  active: 'Active',
  queued: 'Queued',
};

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
  const meetingBusyActionRef = useRef(meetingBusyAction);
  const collapsedButtonRef = useRef<HTMLButtonElement>(null);
  const transcriptRef = useRef<HTMLTextAreaElement>(null);
  const phaseHeadingRef = useRef<HTMLHeadingElement>(null);
  const focusAfterActionRef = useRef(false);
  const mountedAcknowledgedRef = useRef(false);
  const previouslyExpandedRef = useRef(state.expanded);
  const frame = NOTCH_PREVIEW_FRAMES[state.phase];
  const meetingActive = meetingState.phase !== 'idle';

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
    () => meetingActive
      ? notchMeetingSurfaceSize(meetingState, meetingExpanded)
      : notchSurfaceSize(state),
    [meetingActive, meetingExpanded, meetingState, state.expanded, state.phase],
  );

  const toggle = useCallback(() => {
    dispatch({ type: 'toggle' });
  }, []);

  const dismiss = useCallback(() => {
    dispatch({ type: 'dismiss' });
    dismissLiveSurface();
  }, []);

  const dispatchAction = useCallback((action: NotchAction) => {
    focusAfterActionRef.current = true;
    dispatch(action);
  }, []);

  useEffect(() => {
    document.documentElement.classList.add('clemmy-live-document');
    if (!mountedAcknowledgedRef.current) {
      mountedAcknowledgedRef.current = true;
      acknowledgeLiveSurfaceMounted();
    }
    return () => document.documentElement.classList.remove('clemmy-live-document');
  }, []);

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
    resizeLiveSurface(size);
  }, [size]);

  useEffect(() => {
    if (meetingActive) return;
    const wasExpanded = previouslyExpandedRef.current;
    previouslyExpandedRef.current = state.expanded;
    if (state.expanded && !wasExpanded) {
      if (state.phase === 'review') transcriptRef.current?.focus({ preventScroll: true });
      else phaseHeadingRef.current?.focus({ preventScroll: true });
    } else if (!state.expanded && wasExpanded) {
      collapsedButtonRef.current?.focus({ preventScroll: true });
    }
  }, [meetingActive, state.expanded, state.phase]);

  useEffect(() => {
    if (meetingActive) return undefined;
    const focusCollapsedSurface = () => {
      if (!state.expanded) collapsedButtonRef.current?.focus({ preventScroll: true });
    };
    window.addEventListener('focus', focusCollapsedSurface);
    if (document.hasFocus()) focusCollapsedSurface();
    return () => window.removeEventListener('focus', focusCollapsedSurface);
  }, [meetingActive, state.expanded]);

  useEffect(() => subscribeToLivePreview((payload) => {
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
    }
    const action = previewActionFromBridge(payload);
    if (action) dispatch(action);
  }), []);

  useEffect(() => {
    if (!state.playing || meetingActive) return undefined;
    const timer = window.setTimeout(() => dispatch({ type: 'autoplay-tick' }), DEMO_STEP_MS);
    return () => window.clearTimeout(timer);
  }, [meetingActive, state.phase, state.playing]);

  useEffect(() => {
    if (meetingActive) return undefined;
    if (!focusAfterActionRef.current) return undefined;
    focusAfterActionRef.current = false;
    const animationFrame = window.requestAnimationFrame(() => {
      phaseHeadingRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [meetingActive, state.phase]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
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
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && state.expanded && state.phase === 'review') {
        event.preventDefault();
        dispatchAction({ type: 'submit-preview' });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dismiss, dispatchAction, meetingActive, meetingExpanded, meetingState.phase, state.expanded, state.phase]);

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
        onOpenConsole={openClementineConsole}
        onClear={() => { dispatchMeeting({ type: 'clear' }); dismissLiveSurface(); }}
      />
    );
  }

  if (!state.expanded) {
    return (
      <main className="clemmy-live-stage" style={style} data-testid="clemmy-live-stage">
        <button
          ref={collapsedButtonRef}
          type="button"
          className="clemmy-live-collapsed"
          data-phase={state.phase}
          onClick={toggle}
          aria-expanded="false"
          aria-label={`Clementine preview, microphone off. ${frame.collapsedSummary}. Latest milestone: ${frame.latestMilestone}. Expand.`}
        >
          <span className="clemmy-live-collapsed-avatar" aria-hidden>
            <DogMark size={24} />
            <span className="clemmy-live-availability-dot" />
          </span>
          <span className="clemmy-live-collapsed-copy">
            <span className="clemmy-live-preview-label"><MicOff aria-hidden /> Preview — microphone off</span>
            <span className="clemmy-live-collapsed-progress">
              <strong>{frame.collapsedSummary}</strong>
              <em>{frame.latestMilestone}</em>
            </span>
          </span>
          <ChevronDown className="h-4 w-4" aria-hidden />
        </button>
      </main>
    );
  }

  return (
    <main className="clemmy-live-stage" style={style} data-testid="clemmy-live-stage">
      <section
        className="clemmy-live-island"
        data-phase={state.phase}
        aria-label="Clementine preview"
      >
        <header className="clemmy-live-header">
          <div className="clemmy-live-brand">
            <span aria-hidden><DogMark size={28} className="clemmy-live-dog" /></span>
            <strong>Clementine</strong>
          </div>

          <div className="clemmy-live-preview-banner" role="status">
            <MicOff aria-hidden />
            <span>Preview — microphone off</span>
          </div>

          <div className="clemmy-live-window-actions">
            <button type="button" onClick={openClementineConsole} aria-label="Open Clementine console">
              <ExternalLink aria-hidden />
            </button>
            <button type="button" onClick={toggle} aria-label="Collapse Clementine" aria-expanded="true">
              <ChevronUp aria-hidden />
            </button>
            <button type="button" onClick={dismiss} aria-label="Dismiss Clementine">
              <X aria-hidden />
            </button>
          </div>
        </header>

        <div className="clemmy-live-content">
          <nav className="clemmy-live-state-nav" aria-label="Preview a Clementine state">
            {DEMO_SEQUENCE.map((phase) => (
              <button
                key={phase}
                type="button"
                aria-pressed={state.phase === phase}
                onClick={() => dispatch({ type: 'select-phase', phase })}
              >
                <Circle aria-hidden />
                {NOTCH_PREVIEW_FRAMES[phase].navLabel}
              </button>
            ))}
          </nav>

          <div key={`${state.phase}-copy`} className="clemmy-live-state-copy" aria-live="polite" aria-atomic="true">
            <span className="clemmy-live-status-pill">
              <StateGlyph phase={state.phase} />
              {frame.statusLabel}
            </span>
            <h1 ref={phaseHeadingRef} tabIndex={-1}>{frame.title}</h1>
            <p>{frame.summary}</p>
          </div>

          <label className="clemmy-live-transcript" data-readonly={state.phase !== 'review'}>
            <span>
              <strong>{state.phase === 'review' ? 'Sample transcript' : 'Original request'}</strong>
              <em>{state.phase === 'review' ? 'Editable · ⌘↵ previews send' : 'Read only'}</em>
            </span>
            <textarea
              ref={transcriptRef}
              value={state.transcript}
              onChange={(event) => dispatch({ type: 'set-transcript', transcript: event.target.value })}
              rows={2}
              aria-label={state.phase === 'review' ? 'Editable sample transcript' : 'Original request, read only'}
              aria-readonly={state.phase !== 'review'}
              readOnly={state.phase !== 'review'}
              spellCheck
            />
          </label>

          {frame.parentTask && (
            <section key={`${state.phase}-parent`} className="clemmy-live-parent-task" aria-label="Preview parent task">
              <span className="clemmy-live-parent-icon" aria-hidden><UsersRound /></span>
              <div>
                <span>Preview parent task</span>
                <strong>{frame.parentTask.title}</strong>
                <em>{frame.parentTask.detail}</em>
              </div>
            </section>
          )}

          {frame.agents && (
            <section key={`${state.phase}-agents`} className="clemmy-live-agents" aria-labelledby="clemmy-live-agents-heading">
              <div className="clemmy-live-section-heading">
                <h2 id="clemmy-live-agents-heading">Preview agent team</h2>
                <span>{frame.agents.length} mock agents</span>
              </div>
              <ol>
                {frame.agents.map((agent) => (
                  <li key={agent.id} data-state={agent.state}>
                    <span className="clemmy-live-agent-avatar" aria-hidden>{agent.name.slice(0, 1)}</span>
                    <span className="clemmy-live-agent-copy">
                      <span><strong>{agent.name}</strong><em>{agent.role}</em></span>
                      <small>{agent.detail}</small>
                    </span>
                    <span className="clemmy-live-agent-state">
                      {agent.state === 'active' && (
                        <span className="clemmy-live-agent-dots" aria-hidden><i /><i /><i /></span>
                      )}
                      {agent.state === 'completed' && <Check aria-hidden />}
                      {agent.state === 'queued' && <Circle aria-hidden />}
                      <em>{AGENT_STATE_LABELS[agent.state]}</em>
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {frame.approval && (
            <aside key={`${state.phase}-approval`} className="clemmy-live-approval" aria-label="Approval preview">
              <span className="clemmy-live-approval-icon"><ShieldCheck aria-hidden /></span>
              <div>
                <strong>{frame.approval.title}</strong>
                <span>{frame.approval.detail}</span>
              </div>
            </aside>
          )}

          <section key={`${state.phase}-activity`} className="clemmy-live-activity" aria-labelledby="clemmy-live-activity-heading">
            <div className="clemmy-live-section-heading">
              <h2 id="clemmy-live-activity-heading">Latest activity</h2>
              <span>Friendly milestones</span>
            </div>
            <ol>
              {frame.activities.slice(-3).map((activity) => (
                <li key={activity.id} data-tone={activity.tone}>
                  <span className="clemmy-live-activity-icon"><ActivityIcon tone={activity.tone} /></span>
                  <strong>{activity.label}</strong>
                  <span>{activity.detail}</span>
                </li>
              ))}
            </ol>
          </section>

          <div key={`${state.phase}-actions`} className="clemmy-live-primary-actions">
            {state.phase === 'review' && (
              <>
                <SurfaceButton kind="primary" onClick={() => dispatchAction({ type: 'submit-preview' })}>
                  <Send aria-hidden /> Preview send
                </SurfaceButton>
                <SurfaceButton onClick={openClementineConsole}>Open full app</SurfaceButton>
              </>
            )}
            {state.phase === 'working' && (
              <>
                <SurfaceButton kind="primary" onClick={() => dispatchAction({ type: 'select-phase', phase: 'approval' })}>
                  <ShieldCheck aria-hidden /> Preview approval
                </SurfaceButton>
                <SurfaceButton onClick={dismiss}>Keep working quietly</SurfaceButton>
              </>
            )}
            {state.phase === 'approval' && (
              <>
                <SurfaceButton kind="primary" onClick={() => dispatchAction({ type: 'approve-preview' })}>
                  <Check aria-hidden /> Approve once
                </SurfaceButton>
                <SurfaceButton kind="danger" onClick={() => dispatchAction({ type: 'reject-preview' })}>Reject</SurfaceButton>
              </>
            )}
            {state.phase === 'completed' && (
              <>
                <SurfaceButton kind="primary" onClick={openClementineConsole}>
                  <ExternalLink aria-hidden /> Open result
                </SurfaceButton>
                <SurfaceButton onClick={dismiss}>Dismiss</SurfaceButton>
              </>
            )}
            {state.phase === 'cancelled' && (
              <>
                <SurfaceButton kind="primary" onClick={() => dispatchAction({ type: 'restart-preview' })}>
                  <RotateCcw aria-hidden /> Edit request
                </SurfaceButton>
                <SurfaceButton onClick={dismiss}>Dismiss</SurfaceButton>
              </>
            )}
            {state.phase === 'failure' && (
              <>
                <SurfaceButton kind="primary" onClick={openClementineConsole}>Fix in Clementine</SurfaceButton>
                <SurfaceButton onClick={() => dispatchAction({ type: 'restart-preview' })}>
                  <RotateCcw aria-hidden /> Try preview again
                </SurfaceButton>
              </>
            )}
          </div>

          <footer className="clemmy-live-demo-controls">
            <span>Stage 0 · deterministic mock data</span>
            <div>
              <button
                type="button"
                onClick={() => dispatch({ type: 'toggle-play' })}
                aria-label={state.playing ? 'Pause state preview' : 'Play state preview'}
              >
                {state.playing ? <Pause aria-hidden /> : <Play aria-hidden />}
                {state.playing ? 'Pause' : 'Play'}
              </button>
              <button type="button" onClick={() => dispatch({ type: 'advance-demo' })}>
                Next state <ChevronDown className="-rotate-90" aria-hidden />
              </button>
            </div>
          </footer>
        </div>
      </section>
    </main>
  );
}
