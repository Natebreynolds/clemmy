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
import type { ChatMessage } from '@clem/chat-engine';
import {
  cancelChatTurn,
  cancelRun,
  cancelWorkflowRun,
  cancelWorkflowRunsById,
  controlTask,
  isOfflineError,
} from '../lib/api';
import { haptic } from '../lib/native-bridge';

export type RunControlTarget =
  | { kind: 'run'; runId: string }
  | { kind: 'chat'; sessionId: string; attemptId: string }
  | { kind: 'workflow'; workflow: string; runId: string }
  | { kind: 'workflow-runs'; runIds: string[] }
  | { kind: 'task'; taskId: string };

export interface DelegatedRunControlProjection {
  sourceUserSeq: number;
  state: 'running' | 'cancelling' | 'stopped';
  target: Extract<RunControlTarget, { kind: 'workflow-runs' }> | null;
}

/** A Stop control exists only for the exact running assistant card produced by
 * async_work_dispatched. Ordinary thinking bubbles and terminal cards fail
 * closed even if a caller accidentally retains unrelated data. */
export function delegatedRunControlForMessage(
  message: ChatMessage,
): DelegatedRunControlProjection | null {
  const work = message.delegatedWork;
  if (message.role !== 'assistant' || !work) return null;
  if (!Number.isSafeInteger(work.sourceUserSeq) || work.sourceUserSeq <= 0) return null;
  const runIds = [...new Set(work.runIds.filter((runId) => (
    typeof runId === 'string'
    && /^[A-Za-z0-9_.:-]+$/.test(runId) && runId.length > 0 && runId.length <= 200
  )))];
  if (runIds.length === 0) return null;
  if (work.state === 'stopped' && message.status === 'stopped') {
    return { sourceUserSeq: work.sourceUserSeq, state: work.state, target: null };
  }
  if (message.status !== 'thinking' || (work.state !== 'running' && work.state !== 'cancelling')) {
    return null;
  }
  return {
    sourceUserSeq: work.sourceUserSeq,
    state: work.state,
    target: { kind: 'workflow-runs', runIds },
  };
}

/** The conversation keeps destructive workflow control behind the work
 * disclosure. Keeping this gate beside the source-bound projection makes a
 * collapsed card incapable of rendering a Stop target by accident. */
export function delegatedRunControlForExpandedWork(
  message: ChatMessage,
  workDetailExpanded: boolean,
): DelegatedRunControlProjection | null {
  return workDetailExpanded ? delegatedRunControlForMessage(message) : null;
}

interface Props {
  target: RunControlTarget;
  /** Shown while the work can also be resumed (stopped background tasks). */
  resumable?: boolean;
  /** Conversation work detail uses a compact circular trigger in its header. */
  compact?: boolean;
  state?: 'running' | 'cancelling' | 'stopped';
  onChanged: () => void;
  onStateChange?: (state: 'running' | 'cancelling' | 'stopped') => void;
}

export function RunControl({ target, resumable, compact = false, state, onChanged, onStateChange }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<'stop' | 'resume' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function stop() {
    setBusy('stop');
    setError(null);
    onStateChange?.('cancelling');
    haptic('medium');
    try {
      if (target.kind === 'workflow') await cancelWorkflowRun(target.workflow, target.runId);
      else if (target.kind === 'workflow-runs') {
        await cancelWorkflowRunsById(target.runIds);
      }
      else if (target.kind === 'run') await cancelRun(target.runId);
      else if (target.kind === 'chat') await cancelChatTurn(target.sessionId, target.attemptId);
      else await controlTask(target.taskId, 'cancel');
      haptic('success');
      setConfirming(false);
      onStateChange?.('stopped');
      onChanged();
    } catch (err) {
      haptic('error');
      onStateChange?.('running');
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
      <div class={`run-control confirming${compact ? ' run-control-compact' : ''}`} role="group" aria-label="Confirm stop">
        <span class="run-control-ask">Stop this?</span>
        <button type="button" class="btn-stop-yes" disabled={busy !== null} onClick={stop}>
          {busy === 'stop' ? 'Stopping…' : 'Stop it'}
        </button>
        <button type="button" class="btn-quiet" disabled={busy !== null} onClick={() => { haptic('light'); setConfirming(false); }}>
          Keep going
        </button>
      </div>
    );
  }

  if (compact && !resumable) {
    const stopping = busy === 'stop' || state === 'cancelling';
    return (
      <div class="run-control run-control-compact">
        <button
          type="button"
          class="run-stop-trigger"
          disabled={stopping}
          aria-label={stopping ? 'Stopping delegated work' : 'Stop delegated work'}
          aria-busy={stopping}
          title={stopping ? 'Stopping…' : 'Stop'}
          onClick={() => { haptic('light'); setConfirming(true); }}
        >
          <span aria-hidden="true">{stopping ? '…' : '■'}</span>
        </button>
        {error ? <span class="run-control-error" role="alert">{error}</span> : null}
      </div>
    );
  }

  return (
    <div class="run-control">
      {resumable ? (
        <button type="button" class="btn-quiet btn-resume" disabled={busy !== null} onClick={resume}>
          {busy === 'resume' ? 'Resuming…' : 'Resume'}
        </button>
      ) : (
        <button type="button" class="btn-quiet" onClick={() => { haptic('light'); setConfirming(true); }}>Stop</button>
      )}
      {error ? <span class="run-control-error">{error}</span> : null}
    </div>
  );
}
