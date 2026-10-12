import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { MobileVoiceController, type MobileVoicePhase, type VoiceChatMessage } from '../lib/mobile-voice';

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
}

const phaseLabels: Record<MobileVoicePhase, string> = {
  off: '', starting: 'Starting microphone…', listening: 'Listening · pause to send',
  transcribing: 'Transcribing…', thinking: 'Clem is working…', speaking: 'Clem is speaking…',
};

/** An explicit, foreground-only conversation. No microphone work on mount. */
export function VoiceModeControl(props: VoiceModeControlProps) {
  const [controller] = useState(() => new MobileVoiceController());
  const [state, setState] = useState(controller.getSnapshot);
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
  const blocked = !state.enabled && (props.disabled || props.busy);
  return <div class="voice-mode-control" data-active={state.enabled || undefined}>
    <div class="voice-mode-row">
      <button type="button" class="voice-mode-toggle" aria-pressed={state.enabled} disabled={blocked}
        onClick={() => { if (state.enabled) controller.stop(); else void controller.start(); }}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          {state.enabled ? <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
            : <path d="M4 10v4m4-8v12m4-15v18m4-15v12m4-8v4" />}
        </svg>
        {state.enabled ? 'End voice' : 'Talk to Clem'}
      </button>
      <span class="voice-mode-status" role="status" aria-live="polite">
        {state.enabled ? state.engine === 'live' && state.phase === 'listening' ? 'Listening · just talk' : phaseLabels[state.phase] : blocked ? props.disabledHint || 'Available when this turn finishes' : ''}
      </span>
    </div>
    {state.error && <div class="voice-mode-error" role="alert">{state.error}</div>}
    {state.error && state.heard && <p class="voice-mode-heard">You said: {state.heard}</p>}
  </div>;
}
