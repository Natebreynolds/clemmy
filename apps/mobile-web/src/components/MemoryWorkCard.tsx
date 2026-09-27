/**
 * "Memory at work" — the card at the top of the phone's Memory screen.
 *
 * It answers the owner's question at a glance: is Clem working on my memory
 * right now, with which model, and what has it done today. The headline and
 * the pulse move only while a job is running in the daemon; the model row
 * opens the same picker Settings › Models uses; the latest runs can be undone
 * in place. Everything else is one tap away in the full view.
 */
import type { MemoryWorkUndoResult } from '../lib/api';
import {
  MEMORY_WORK_CARD_EVENTS,
  hourStrip,
  memoryEventView,
  memoryModelView,
  memoryWorkStatus,
  pipelineView,
  recentEmptyText,
  serverNow,
  type MemoryWorkRead,
  type ModelNamer,
} from '../lib/memory-work';
import { EventRow, HourStripView, ModelRow, Pipeline, StatusLine } from './MemoryWorkParts';

export function MemoryWorkCard({ read, loading, modelName, onChangeModel, onOpen, onUndo, onRetry }: {
  read: MemoryWorkRead;
  /** The first read is still on its way. */
  loading: boolean;
  modelName: ModelNamer;
  /** Present only when this Mac's Clem offers the memory role in Settings. */
  onChangeModel?: () => void;
  onOpen: () => void;
  onUndo: (eventId: string) => Promise<MemoryWorkUndoResult>;
  onRetry: () => void;
}) {
  const snapshot = read.snapshot;
  const status = memoryWorkStatus(read, modelName);
  if (!status) {
    // Loading shows the shape of what is coming; a Mac that does not report
    // memory work at all shows nothing rather than a failure.
    return loading ? <div class="skeleton-stack mw-skeleton" aria-hidden="true"><i /></div> : null;
  }

  const now = serverNow(snapshot?.generatedAt, read.receivedAt, read.now);
  const model = memoryModelView(snapshot, modelName, now);
  const latest = snapshot
    ? snapshot.recent.slice(0, MEMORY_WORK_CARD_EVENTS).map((event) => memoryEventView(event, modelName, now))
    : [];
  const empty = recentEmptyText(snapshot);

  return (
    <section class={`card mw-card${status.pulse ? ' is-working' : ''}`} aria-labelledby="mw-card-title">
      <div class="mw-card-head">
        <h2 id="mw-card-title" class="section-head mw-eyebrow">Memory at work</h2>
        {snapshot ? (
          <button type="button" class="mw-see-all" onClick={onOpen}>
            See all
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
          </button>
        ) : null}
      </div>

      <StatusLine status={status} onRetry={snapshot ? undefined : onRetry} />

      {snapshot ? (
        <>
          {model ? <ModelRow view={model} onChange={onChangeModel} /> : null}
          <div class="mw-block">
            <p class="mw-label">Today</p>
            <Pipeline stages={pipelineView(snapshot, status.pulse)} />
          </div>
          <HourStripView strip={hourStrip(snapshot, now)} />
          {latest.length > 0 ? (
            <ul class="mw-events mw-events-compact" aria-label="Latest">
              {latest.map((view) => <EventRow key={view.id} view={view} compact onUndo={onUndo} />)}
            </ul>
          ) : null}
          {empty ? <p class="mw-empty">{empty}</p> : null}
        </>
      ) : null}
    </section>
  );
}
