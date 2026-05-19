import { EventEmitter } from 'node:events';
import type { RunEvent, RunRecord } from './run-events.js';
import type { NotificationRecord } from './notifications.js';
import type { PendingApproval } from '../types.js';
import type { EventRow } from './harness/eventlog.js';
import type { BoundaryError } from './boundary-error.js';

// Fan-out bus for "the daemon just did a thing" events. Listeners are
// in-process only (the SSE handler in console-routes.ts subscribes
// here). Persistence remains in the existing JSON files — this is a
// signal layer, not a store.

export type ActionEvent =
  | {
      kind: 'run.event';
      runId: string;
      sessionId: string;
      runTitle: string;
      runStatus: RunRecord['status'];
      event: RunEvent;
    }
  | {
      kind: 'approval.created';
      approval: PendingApproval;
    }
  | {
      kind: 'approval.resolved';
      approval: PendingApproval;
      resolution: 'approved' | 'rejected';
    }
  | {
      kind: 'notification.created';
      notification: NotificationRecord;
    }
  | {
      kind: 'execution.transitioned';
      executionId: string;
      title: string;
      previousState: string;
      nextState: string;
      stepId?: string;
      summary?: string;
      nextReviewAt?: string;
    }
  | {
      // 0.3 harness — emitted from src/runtime/harness/eventlog.ts
      // appendEvent(). Subscribers can filter by sessionId for a
      // per-conversation stream, or by event.type for the high-signal
      // global rail.
      kind: 'harness.event';
      sessionId: string;
      event: EventRow;
    }
  | {
      // Reliability invariant (v0.4.20+): every CodexNativeRuntime.run
      // terminates with EXACTLY ONE of `runtime.completed` or
      // `runtime.failed`. Subscribers (Discord, dashboard, ops log)
      // can be sure that "no terminal event" means "the run is still
      // in flight" — never "the run died silently."
      //
      // The Recent Errors dashboard panel listens for runtime.failed
      // and renders the BoundaryError via boundary-error-renderer.
      kind: 'runtime.failed';
      sessionId: string;
      runId?: string;
      error: BoundaryError;
      /** Where the failure should surface. 'user' = chat/Discord/toast.
       *  'ops' = supervisor.log only (internal failures the user can't
       *  act on). 'both' = both surfaces. Defaults to 'both' at the
       *  emit site when omitted. */
      surface: 'user' | 'ops' | 'both';
    }
  | {
      kind: 'runtime.completed';
      sessionId: string;
      runId?: string;
    };

export interface ActionBus {
  emit(event: ActionEvent): void;
  subscribe(listener: (event: ActionEvent) => void): () => void;
}

class ActionBusImpl implements ActionBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // The SSE handler attaches one listener per connected dashboard.
    // The default cap of 10 is too low — bump it so a busy dashboard
    // with multiple tabs doesn't trigger the "MaxListenersExceeded"
    // warning. Each listener is a single closure with no retained
    // state, so this is not a leak risk.
    this.emitter.setMaxListeners(64);
  }

  emit(event: ActionEvent): void {
    // Swallow listener exceptions so an emitter call site never
    // breaks the underlying action (writing to runs.json, recording
    // an approval, etc.). The action bus is best-effort signal — if
    // a subscriber throws we log and move on.
    try {
      this.emitter.emit('action', event);
    } catch {
      // Subscribers must guard themselves; nothing useful to do here.
    }
  }

  subscribe(listener: (event: ActionEvent) => void): () => void {
    const wrapped = (event: ActionEvent): void => {
      try {
        listener(event);
      } catch {
        // One bad subscriber must not poison the rest.
      }
    };
    this.emitter.on('action', wrapped);
    return () => {
      this.emitter.off('action', wrapped);
    };
  }
}

export const actionBus: ActionBus = new ActionBusImpl();
