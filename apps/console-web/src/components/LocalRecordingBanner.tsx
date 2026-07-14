import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Mic, Square } from 'lucide-react';
import {
  sharedLocalMeetingCapture,
  sharedLocalMeetingCaptureState,
  subscribeSharedLocalMeetingCapture,
  type LocalMeetingCaptureState,
} from '@/lib/local-meeting-recorder';

function formatElapsed(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = Math.floor(seconds % 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`;
}

/**
 * App-level "recording is live" banner (2026-07-14 review). The in-person
 * capture is a module-level singleton that SURVIVES SPA navigation — which is
 * the fix for navigation silently killing a recording — so the visibility
 * invariant ("never an invisible microphone") moves here: whenever the shared
 * capture is active, every screen shows this banner with the elapsed time and
 * a Stop control, complementing the Electron tray dot and window-close guard.
 */
export function LocalRecordingBanner() {
  const [state, setState] = useState<LocalMeetingCaptureState>(() => sharedLocalMeetingCaptureState());
  const [stopping, setStopping] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => subscribeSharedLocalMeetingCapture(setState), []);

  const active = Boolean(state.sessionId) && ['recording', 'stopping', 'error'].includes(state.phase);
  if (!active) return null;

  const onMeetingsScreen = location.pathname === '/meetings' || location.pathname.startsWith('/meetings/');
  const stop = async () => {
    setStopping(true);
    try {
      await sharedLocalMeetingCapture().stop();
    } catch {
      // The recorder + crash-recovery sidecar retain the captured prefix; the
      // Meetings screen surfaces stop errors with full context.
    } finally {
      setStopping(false);
    }
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 border-b border-danger/40 bg-danger-tint/40 px-4 py-2 text-small text-fg"
    >
      <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden>
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-60" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-danger" />
      </span>
      <Mic className="h-4 w-4 shrink-0 text-danger" aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        {state.phase === 'error'
          ? 'Meeting capture hit an error — stop to save what was recorded.'
          : `Recording in-person meeting — ${formatElapsed(state.elapsedSeconds)}`}
      </span>
      {!onMeetingsScreen && (
        <button
          type="button"
          onClick={() => navigate('/meetings')}
          className="shrink-0 rounded-md px-2 py-1 text-muted transition-colors hover:bg-subtle hover:text-fg"
        >
          Open Meetings
        </button>
      )}
      <button
        type="button"
        onClick={() => { void stop(); }}
        disabled={stopping || state.phase === 'stopping'}
        className="flex shrink-0 items-center gap-1 rounded-md bg-danger px-2 py-1 text-white transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        <Square className="h-3 w-3" aria-hidden /> {stopping || state.phase === 'stopping' ? 'Stopping…' : 'Stop & transcribe'}
      </button>
    </div>
  );
}
