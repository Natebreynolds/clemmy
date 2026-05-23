import { EventEmitter } from 'node:events';

/**
 * Small in-process pubsub for workflow lifecycle events.
 *
 * Why this exists: console-routes.ts needs to push refresh signals to
 * the desktop UI the moment a workflow file changes on disk, regardless
 * of who wrote it (architect via workflow_create, dashboard via REST,
 * external edit, etc.). workflow-store.ts is the choke point for
 * writes, so it emits here; the SSE endpoint subscribes and forwards.
 */

export type WorkflowChangeOp = 'created' | 'updated' | 'deleted';

export interface WorkflowChangeEvent {
  name: string;
  op: WorkflowChangeOp;
}

const emitter = new EventEmitter();
// Many SSE clients may subscribe concurrently; keep the default cap
// out of the warning territory without going unbounded.
emitter.setMaxListeners(50);

export function emitWorkflowChange(event: WorkflowChangeEvent): void {
  emitter.emit('changed', event);
}

export function subscribeWorkflowChanges(
  handler: (event: WorkflowChangeEvent) => void,
): () => void {
  emitter.on('changed', handler);
  return () => { emitter.off('changed', handler); };
}
