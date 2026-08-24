import { useEffect, useRef, useState } from 'preact/hooks';
import {
  listWorkingNow,
  type ActivityEntry,
} from '../lib/api';
import { useScreenData } from '../lib/use-screen-data';
import { haptic } from '../lib/native-bridge';
import {
  elapsedLabel,
  hasExpandableTaskFacts,
  kindLabel,
  lifecycleLabel,
  mobileRunControl,
  workerCountLabel,
} from '../lib/running-tasks';
import { RunControl } from './RunControl';

const POLL_MS = 4_000;
const MAX_VISIBLE_TASKS = 12;

/** Compact foreground affordance backed only by the daemon's shared
 * durable projection. The trigger disappears at zero; it never replaces chat
 * with a dashboard or manufactures a task from assistant text. */
export function RunningTasksSheet({
  composerRef,
}: {
  composerRef: { current: HTMLTextAreaElement | null };
}) {
  const { data, refresh } = useScreenData(listWorkingNow, { intervalMs: POLL_MS });
  const entries = (data?.entries ?? []).slice(0, MAX_VISIBLE_TASKS);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const sheetRef = useRef<HTMLElement | null>(null);

  const close = () => {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { close(); return; }
      if (event.key !== 'Tab' || !sheetRef.current) return;
      const focusable = [...sheetRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      )];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // A settled row disappears because the next server snapshot says so. Close
  // an empty sheet and move focus to the still-mounted adjacent composer — the
  // trigger vanishes with the final row, so returning focus to it would strand
  // keyboard/switch users on the document body.
  useEffect(() => {
    if (entries.length === 0 && open) {
      setOpen(false);
      window.requestAnimationFrame(() => composerRef.current?.focus());
    }
    if (selected && !entries.some((entry) => (
      entry.runKey === selected && hasExpandableTaskFacts(entry)
    ))) setSelected(null);
  }, [composerRef, entries, open, selected]);

  if (entries.length === 0) return null;
  const total = data?.entries.length ?? entries.length;

  return (
    <div class="running-tasks-affordance">
      <button
        ref={triggerRef}
        type="button"
        class="running-tasks-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { haptic('light'); setOpen(true); }}
      >
        <span class="running-tasks-spark" aria-hidden="true">✳</span>
        {total} current {total === 1 ? 'task' : 'tasks'}
      </button>

      {open ? (
        <div class="running-tasks-layer" role="dialog" aria-modal="true" aria-labelledby="running-tasks-title">
          <button class="running-tasks-scrim" type="button" aria-label="Close running tasks" onClick={close} />
          <section ref={sheetRef} class="running-tasks-sheet">
            <header class="running-tasks-sheet-head">
              <button ref={closeRef} type="button" class="running-tasks-close" aria-label="Close" onClick={close}>×</button>
              <h2 id="running-tasks-title">Background tasks</h2>
              <span aria-hidden="true" />
            </header>
            <div class="running-tasks-filter">Current · {total}</div>
            <div class="running-tasks-list">
              {entries.map((entry) => {
                const expandable = hasExpandableTaskFacts(entry);
                const expanded = expandable && selected === entry.runKey;
                const control = mobileRunControl(entry);
                const elapsed = elapsedLabel(entry.startedAt, data?.observedAt ?? entry.lastEvidenceAt);
                return (
                  <article key={entry.runKey} class={`running-task-card${expanded ? ' expanded' : ''}`}>
                    <div class="running-task-card-head">
                      <span class="running-task-state" aria-hidden="true" />
                      <div class="running-task-identity">
                        <h3>{entry.headline}</h3>
                        <div class="running-task-meta">
                          <span>{kindLabel(entry.kind)}</span>
                          <span>{lifecycleLabel(entry.lifecycle)}</span>
                          {elapsed ? <span>{elapsed}</span> : null}
                        </div>
                      </div>
                    </div>

                    {expanded ? <RunningTaskFacts entry={entry} /> : null}

                    <div class="running-task-actions">
                      {expandable ? (
                        <button
                          type="button"
                          class="running-task-open"
                          aria-expanded={expanded}
                          onClick={() => {
                            haptic('light');
                            setSelected(expanded ? null : entry.runKey);
                          }}
                        >
                          {expanded ? 'Close' : entry.needsAttention ? 'Review' : 'Open'}
                        </button>
                      ) : null}
                      {control ? (
                        <RunControl
                          target={control.target}
                          resumable={control.resumable}
                          onChanged={() => void refresh()}
                        />
                      ) : null}
                    </div>
                  </article>
                );
              })}
              {total > entries.length ? (
                <p class="running-tasks-more">+{total - entries.length} more</p>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function RunningTaskFacts({ entry }: { entry: ActivityEntry }) {
  const workers = workerCountLabel(entry);
  const progress = entry.progress && entry.progress.total > 0
    ? `${entry.progress.completed}/${entry.progress.total}`
    : '';
  return (
    <div class="running-task-facts">
      {entry.activity ? (
        <div class="running-task-fact">
          <span>Phase</span>
          <strong>{entry.activity.text}</strong>
        </div>
      ) : null}
      {progress ? (
        <div class="running-task-fact">
          <span>Progress</span>
          <strong>{progress}</strong>
        </div>
      ) : null}
      {workers ? (
        <div class="running-task-fact">
          <span>Workers</span>
          <strong>{workers}</strong>
        </div>
      ) : null}
    </div>
  );
}
