import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren, JSX } from 'preact';
import { MobileVoiceController, type MobileVoicePhase, type VoiceChatMessage } from '../lib/mobile-voice';
import { VoiceLaunchGate } from '../lib/voice-launch';

interface VoiceModeControlProps {
  /** Stable chat engine identity, including the transition from new to saved chat. */
  scope: string;
  messages: readonly VoiceChatMessage[];
  busy: boolean;
  onSend: (text: string, stillCurrent: () => boolean) => Promise<void>;
  /** Prevents starting; never removes the Stop control from an active loop. */
  disabled?: boolean;
  disabledHint?: string;
  onActiveChange?: (active: boolean) => void;
  clearErrorRequest?: number;
  /** A one-shot native action already consumed for this exact navigation. */
  liveLaunchId?: string | null;
  /** History/setup still loading, distinct from an owner draft or active work. */
  launchPreparing?: boolean;
  /** Keep the controller mounted while the composer places its toggle and feedback separately. */
  render?: (parts: { control: ComponentChildren; feedback: ComponentChildren }) => JSX.Element;
}

const phaseLabels: Record<MobileVoicePhase, string> = {
  off: '', starting: 'Starting microphone…', listening: 'Listening · pause to send',
  transcribing: 'Transcribing…', thinking: 'Clem is working…', speaking: 'Clem is speaking…',
};

/** An explicit, foreground-only conversation. No microphone work on mount. */
export function VoiceModeControl(props: VoiceModeControlProps) {
  const [controller] = useState(() => new MobileVoiceController());
  const [state, setState] = useState(controller.getSnapshot);
  const [launchNotice, setLaunchNotice] = useState('');
  const launchGate = useRef(new VoiceLaunchGate());
  const activeChange = useRef(props.onActiveChange);
  activeChange.current = props.onActiveChange;
  useLayoutEffect(() => { controller.clearError(); }, [controller, props.clearErrorRequest]);
  useLayoutEffect(() => {
    let previous = controller.getSnapshot().enabled;
    const unsubscribe = controller.subscribe(() => {
      const next = controller.getSnapshot();
      setState(next);
      if (next.enabled !== previous) { previous = next.enabled; activeChange.current?.(next.enabled); }
    });
    const stop = () => controller.stop();
    const visibility = () => { if (document.visibilityState === 'hidden') stop(); };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', stop);
    return () => {
      controller.stop(); unsubscribe();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', stop);
    };
  }, [controller]);
  useLayoutEffect(() => {
    controller.observe({ scope: props.scope, messages: props.messages, busy: props.busy, onSend: props.onSend });
  }, [controller, props.scope, props.messages, props.busy, props.onSend]);
  useEffect(() => {
    const retire = () => {
      if (props.liveLaunchId) launchGate.current.evaluate(props.liveLaunchId, props.scope, 'hidden');
    };
    const visibility = () => { if (document.visibilityState === 'hidden') retire(); };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', retire);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', retire);
    };
  }, [props.liveLaunchId, props.scope]);
  useEffect(() => {
    const id = props.liveLaunchId;
    if (!id) return;
    const availability = document.visibilityState === 'hidden' ? 'hidden'
      : props.busy || (props.disabled && !props.launchPreparing) ? 'blocked'
        : props.launchPreparing ? 'preparing' : 'ready';
    const decision = launchGate.current.evaluate(id, props.scope, availability);
    if (decision === 'wait' || decision === 'used') return;
    if (decision === 'refuse') {
      setLaunchNotice(props.disabledHint || 'Open this conversation and tap Talk to Clem when you are ready.');
      return;
    }
    setLaunchNotice('');
    void controller.start({ preferLive: true });
  }, [controller, props.scope, props.liveLaunchId, props.launchPreparing, props.disabled, props.busy, props.disabledHint]);
  const blocked = !state.enabled && (props.disabled || props.busy);
  const label = state.enabled ? 'End voice' : 'Talk to Clem';
  const control = <button type="button" class={`voice-mode-toggle${props.render ? ' voice-mode-toggle-compact' : ''}`} aria-pressed={state.enabled} disabled={blocked}
        aria-label={label} title={blocked ? props.disabledHint || 'Available when this turn finishes' : label}
        onClick={() => { if (state.enabled) controller.stop(); else void controller.start(); }}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          {state.enabled ? <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
            : <path d="M4 10v4m4-8v12m4-15v18m4-15v12m4-8v4" />}
        </svg>
        {!props.render ? label : null}
      </button>;
  const status = state.enabled ? state.engine === 'live' && state.phase === 'listening' ? 'Listening · just talk' : phaseLabels[state.phase]
    : !props.render && blocked ? props.disabledHint || 'Available when this turn finishes' : '';
  const feedback = status || state.error || launchNotice ? <div class="voice-mode-feedback" data-active={state.enabled || undefined}>
    {status ? <span class="voice-mode-status" role="status" aria-live="polite">{status}</span> : null}
    {state.error ? <div class="voice-mode-error" role="alert">{state.error}</div> : null}
    {state.error && state.heard ? <p class="voice-mode-heard">You said: {state.heard}</p> : null}
    {!state.enabled && launchNotice ? <p class="voice-mode-status" role="status">{launchNotice}</p> : null}
  </div> : null;
  return props.render ? props.render({ control, feedback }) : <div class="voice-mode-control" data-active={state.enabled || undefined}>
    <div class="voice-mode-row">{control}{feedback}</div>
  </div>;
}
