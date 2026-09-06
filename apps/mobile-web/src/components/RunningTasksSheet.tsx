import { useEffect, useRef, useState } from 'preact/hooks';
import type { ActivityEntry } from '../lib/api';
import { useWorkingNow } from '../lib/working-now';
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

const MAX_VISIBLE_TASKS = 12;

/** Compact foreground affordance backed only by the daemon's shared
 * durable projection. The trigger is a header chip (the dock is gone, so
 * nothing may float at the bottom); it disappears at zero and never replaces
 * chat with a dashboard or manufactures a task from assistant text. */
export function RunningTasksSheet({
  composerRef,
  onOpenRun,
}: {
  /** Optional: only the Chat screen has a composer to return focus to. The
   *  sheet is mounted in the app shell so running work is visible on EVERY
   *  tab, and on non-chat tabs focus falls back to the document body. */
  composerRef?: { current: HTMLTextAreaElement | null };
  /** Open the run's own screen. Expanding a row in place shows the three facts
   *  this DTO carries; the run itself is where what it CHANGED lives. */
  onOpenRun?: (sessionId: string) => void;
}) {
  // ONE snapshot for the whole app: the shell keeps the poll alive and Home
  // renders from this same store, so the chip and the page cannot disagree.
  const { data, refresh } = useWorkingNow();
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

  // Presenter contract: the chip exists only while there is current work —
  // at zero the entire affordance is absent from the header.
  if (view.total === 0) return null;
  // "37 current tasks" (live 2026-08-25) counted every needs-attention
  // remnant as current work. The presenter's label says what is true: how
  // many are actually RUNNING and how many are waiting on the user.
  const pillLabel = view.label;
  // The header has ~38vw for this chip: digits, not words. The full label is
  // the accessible name and lives inside the sheet; right-aligned overflow
  // in the header escapes LEFT, straight over the screen title — a compact
  // chip makes that geometry impossible.
  const compact = [view.running, view.needsYou].filter((n) => n > 0).join('·');

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
        {/* An inline glyph, never a text emoji. `✳` (U+2733) has emoji
            presentation on iOS, so it rendered as a bright green tile that
            ignored `color:` entirely and fought the warm palette beside it.
            An SVG inherits currentColor and stays on-brand. */}
        <span class="running-tasks-spark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="12" cy="12" r="8.5" opacity="0.28" />
            <path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5" />
          </svg>
        </span>
        <span aria-hidden="true">{compact}</span>
        <span class="sr-only">{pillLabel}</span>
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
                          {expanded ? 'Close' : entry.needsAttention ? 'Review' : 'Details'}
                        </button>
                      ) : null}
                      {/* The sheet is a glance; the run is the work. Only a
                          harness session has a run screen, so a row without
                          one shows no dead affordance. */}
                      {onOpenRun && entry.sessionId ? (
                        <button
                          type="button"
                          class="running-task-open"
                          onClick={() => {
                            close();
                            onOpenRun(entry.sessionId as string);
                          }}
                        >
                          Open run
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
