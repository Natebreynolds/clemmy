/** A compact, truthful status; models, run details and undo live one tap away. */
import {
  memoryModelView,
  memoryWorkStatus,
  serverNow,
  type MemoryWorkRead,
  type ModelNamer,
} from '../lib/memory-work';
import { StatusLine } from './MemoryWorkParts';

export function MemoryWorkCard({ read, loading, modelName, onOpen, onRetry }: {
  read: MemoryWorkRead;
  loading: boolean;
  modelName: ModelNamer;
  onOpen: () => void;
  onRetry: () => void;
}) {
  const snapshot = read.snapshot;
  const status = memoryWorkStatus(read, modelName);
  if (!status) {
    return loading ? <div class="skeleton-stack mw-skeleton" aria-hidden="true"><i /></div> : null;
  }
  const model = memoryModelView(snapshot, modelName, serverNow(snapshot?.generatedAt, read.receivedAt, read.now));

  return (
    <section class="memory-work-summary" aria-labelledby="mw-card-title">
      <div class="memory-work-summary-head">
        <h2 id="mw-card-title" class="section-head">Memory at work</h2>
        {snapshot ? (
          <button type="button" class="mw-see-all" onClick={onOpen}>
            View activity
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
          </button>
        ) : null}
      </div>
      <StatusLine status={status} onRetry={snapshot ? undefined : onRetry} />
      {/* Exceptional model evidence stays visible; ordinary configuration is depth. */}
      {model?.served ? <p class={`mw-model-note${model.served.standIn ? ' warning' : ''}`}>{model.served.text}</p> : null}
      {model?.problem ? <p class="mw-model-note warning">{model.problem}</p> : null}
    </section>
  );
}
