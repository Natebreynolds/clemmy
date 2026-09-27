/**
 * The full "Memory at work" view, one tap from the card: what Clem did with
 * your memory, day by day, with what each run changed and a way to undo it;
 * every background job with its model, its last run and its next; and how
 * long this record is kept before it is deleted.
 *
 * A depth view like a run on Activity: the Memory screen owns the back
 * gesture, so a swipe returns to the card.
 */
import type { MemoryWorkUndoResult } from '../lib/api';
import {
  dayStrip,
  groupByDay,
  hourStrip,
  memoryEventView,
  memoryJobGroups,
  memoryModelView,
  memoryWorkStatus,
  pipelineView,
  queueLine,
  recentEmptyText,
  retentionText,
  serverNow,
  todayFigures,
  type MemoryWorkRead,
  type ModelNamer,
} from '../lib/memory-work';
import { ChatBackButton } from './ChatBackButton';
import { DayStripView, EventRow, HourStripView, JobRow, ModelRow, Pipeline, StatusLine } from './MemoryWorkParts';

export function MemoryWorkTimeline({ read, loading, modelName, onChangeModel, onBack, onUndo, onRetry }: {
  read: MemoryWorkRead;
  loading: boolean;
  modelName: ModelNamer;
  onChangeModel?: () => void;
  onBack: () => void;
  onUndo: (eventId: string) => Promise<MemoryWorkUndoResult>;
  onRetry: () => void;
}) {
  const snapshot = read.snapshot;
  const status = memoryWorkStatus(read, modelName);
  const now = serverNow(snapshot?.generatedAt, read.receivedAt, read.now);
  const live = status?.pulse ?? false;
  const model = memoryModelView(snapshot, modelName, now);
  const figures = todayFigures(snapshot);
  const days = groupByDay(snapshot?.recent ?? [], now);
  const jobs = memoryJobGroups(snapshot, modelName, now, live);
  const queue = queueLine(snapshot?.queue);
  const empty = recentEmptyText(snapshot);
  const retention = retentionText(snapshot?.retention ?? null);

  return (
    <div class="workflow-detail mw-detail">
      <div class="chat-header">
        <ChatBackButton onClick={onBack} />
        <div class="chat-title">Memory at work</div>
      </div>
      <div class="workflow-detail-body">
        {!status && loading ? <div class="skeleton-stack" aria-hidden="true"><i /><i /></div> : null}
        {status ? (
          <section class={`card mw-card${live ? ' is-working' : ''}`} aria-label="Now">
            <StatusLine status={status} onRetry={snapshot ? undefined : onRetry} />
            {model ? <ModelRow view={model} onChange={onChangeModel} /> : null}
          </section>
        ) : null}

        {snapshot ? (
          <>
            <section class="mw-section" aria-label="Today">
              <h3>Today</h3>
              <Pipeline stages={pipelineView(snapshot, live)} />
              {figures.length > 0 ? (
                <dl class="mw-figures">
                  {figures.map((figure) => (
                    <div key={figure.label} class="mw-figure">
                      <dt>{figure.label}</dt>
                      <dd>{figure.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              <HourStripView strip={hourStrip(snapshot, now)} />
              <DayStripView strip={dayStrip(snapshot, now)} />
              {queue ? <p class="mw-queue">{queue}</p> : null}
            </section>

            <section class="mw-section" aria-label="What Clem did">
              <h3>What Clem did</h3>
              {days.map((day) => (
                <div key={day.key} class="mw-day">
                  <p class="mw-label">{day.label}</p>
                  <ul class="mw-events">
                    {day.items.map((event) => (
                      <EventRow key={event.id} view={memoryEventView(event, modelName, now)} onUndo={onUndo} />
                    ))}
                  </ul>
                </div>
              ))}
              {empty ? <p class="mw-empty">{empty}</p> : null}
            </section>

            {jobs.length > 0 ? (
              <section class="mw-section" aria-label="Jobs">
                <h3>Jobs</h3>
                {jobs.map((group) => (
                  <div key={group.id} class="mw-job-group">
                    <p class="mw-label">{group.label}</p>
                    <ul class="mw-jobs">
                      {group.jobs.map((job) => <JobRow key={job.id} view={job} />)}
                    </ul>
                  </div>
                ))}
              </section>
            ) : null}

            {retention ? <p class="mw-foot">{retention}</p> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
