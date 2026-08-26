import { useEffect, useRef, useState } from 'preact/hooks';
import {
  listWorkingNow,
  type ActivityEntry,
} from '../lib/api';
import { useScreenData } from '../lib/use-screen-data';
import { haptic } from '../lib/native-bridge';
import {
  hasExpandableTaskFacts,
  kindLabel,
  lifecycleLabel,
  mobileRunControl,
  workerCountLabel,
} from '../lib/running-tasks';
import { presentWorkingNow } from '@clem/chat-engine';
import { RunControl } from './RunControl';

const POLL_MS = 4_000;
const MAX_VISIBLE_TASKS = 12;

/** Compact foreground affordance backed only by the daemon's shared
 * durable projection. The trigger disappears at zero; it never replaces chat
 * with a dashboard or manufactures a task from assistant text. */
export function RunningTasksSheet({
  composerRef,
}: {
  /** Optional: only the Chat screen has a composer to return focus to. The
   *  sheet is mounted in the app shell so running work is visible on EVERY
   *  tab, and on non-chat tabs focus falls back to the document body. */
  composerRef?: { current: HTMLTextAreaElement | null };
}) {
  const { data, refresh } = useScreenData(listWorkingNow, { intervalMs: POLL_MS });
  // ONE presenter for counts, label, pulse, and elapsed — the same function
  // the desktop badge and drawer render from, so the phone and the desktop
  // can never disagree about how much is running.
  const view = presentWorkingNow(data?.entries ?? [], data?.observedAt ?? '');
  const presented = view.entries.slice(0, MAX_VISIBLE_TASKS);
  const entries = presented.map((p) => p.entry);
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
      window.requestAnimationFrame(() => composerRef?.current?.focus());
    }
    if (selected && !entries.some((entry) => (
      entry.runKey === selected && hasExpandableTaskFacts(entry)
    ))) setSelected(null);
  }, [composerRef, entries, open, selected]);

  if (entries.length === 0) return null;
  // "37 current tasks" (live 2026-08-25) counted every needs-attention
  // remnant as current work. The presenter's label says what is true: how
  // many are actually RUNNING and how many are waiting on the user.
  const pillLabel = view.label;

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
        {pillLabel}
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
            <div class="running-tasks-filter">{pillLabel}</div>
            <div class="running-tasks-list">
              {presented.map((p) => {
                const entry = p.entry;
                const expandable = hasExpandableTaskFacts(entry);
                const expanded = expandable && selected === entry.runKey;
                const control = mobileRunControl(entry);
                const elapsed = p.elapsed;
                return (
                  <article key={entry.runKey} class={`running-task-card${expanded ? ' expanded' : ''}`}>
                    <div class="running-task-card-head">
                      {/* Accent only under the liveness certificate; a row a
                          person is blocking shows quiet, not "working". */}
                      <span
                        class="running-task-state"
                        style={p.pulse ? undefined : { background: 'var(--line-strong)' }}
                        aria-hidden="true"
                      />
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
              {view.total > presented.length ? (
                <p class="running-tasks-more">+{view.total - presented.length} more</p>
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
