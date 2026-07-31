/**
 * Stopping work from your pocket.
 *
 * Two deliberate choices. First, there is no Pause: nothing in the system can
 * suspend in-flight work and pick it up mid-step later, so a Pause button
 * would misrepresent what happens to the work. Stop cancels at the next safe
 * boundary — the same verb the desktop uses.
 *
 * Second, Stop asks once before it fires. On a phone the button is under a
 * thumb on a moving train, and a mis-tap that kills a twenty-minute run is
 * exactly the thing that teaches someone not to trust the app away from
 * their desk.
 */
import { useState } from 'preact/hooks';
import { cancelRun, cancelWorkflowRun, controlTask, isOfflineError } from '../lib/api';
import { haptic } from '../lib/native-bridge';

type Target =
  | { kind: 'run'; runId: string }
  | { kind: 'workflow'; workflow: string; runId: string }
  | { kind: 'task'; taskId: string };

interface Props {
  target: Target;
  /** Shown while the work can also be resumed (stopped background tasks). */
  resumable?: boolean;
  onChanged: () => void;
}

export function RunControl({ target, resumable, onChanged }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<'stop' | 'resume' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function stop() {
    setBusy('stop');
    setError(null);
    haptic('medium');
    try {
      if (target.kind === 'workflow') await cancelWorkflowRun(target.workflow, target.runId);
      else if (target.kind === 'run') await cancelRun(target.runId);
      else await controlTask(target.taskId, 'cancel');
      haptic('success');
      setConfirming(false);
      onChanged();
    } catch (err) {
      haptic('error');
      setError(isOfflineError(err) ? "Can't reach your Mac — try again when you're back on" : (err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function resume() {
    if (target.kind !== 'task') return;
    setBusy('resume');
    setError(null);
    haptic('medium');
    try {
      await controlTask(target.taskId, 'resume');
      haptic('success');
      onChanged();
    } catch (err) {
      haptic('error');
      setError(isOfflineError(err) ? "Can't reach your Mac — try again when you're back on" : (err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (confirming) {
    return (
      <div class="run-control confirming">
        <span class="run-control-ask">Stop this?</span>
        <button class="btn-stop-yes" disabled={busy !== null} onClick={stop}>
          {busy === 'stop' ? 'Stopping…' : 'Stop it'}
        </button>
        <button class="btn-quiet" disabled={busy !== null} onClick={() => { haptic('light'); setConfirming(false); }}>
          Keep going
        </button>
      </div>
    );
  }

  return (
    <div class="run-control">
      {resumable ? (
        <button class="btn-quiet btn-resume" disabled={busy !== null} onClick={resume}>
          {busy === 'resume' ? 'Resuming…' : 'Resume'}
        </button>
      ) : (
        <button class="btn-quiet" onClick={() => { haptic('light'); setConfirming(true); }}>Stop</button>
      )}
      {error ? <span class="run-control-error">{error}</span> : null}
    </div>
  );
}
