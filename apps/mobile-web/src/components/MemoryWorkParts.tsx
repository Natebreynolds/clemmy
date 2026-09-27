/**
 * The pieces the Memory card and the full "Memory at work" view share: the
 * status line, the memory model row, today's pipeline, the activity strips,
 * a run, and a job. Each renders a view model from lib/memory-work.ts and
 * decides nothing about the data itself.
 *
 * Motion is a certificate here, as on Activity: the pulse, a lit stage and
 * the flow between stages appear only when the latest read says a job is
 * running now. Everything else is still.
 */
import { Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { MEMORY_ROLE_WORDS } from '@clem/chat-engine';
import { isOfflineError, type MemoryWorkUndoResult } from '../lib/api';
import { haptic } from '../lib/native-bridge';
import {
  hourCaption,
  hourStripSummary,
  undoConfirmText,
  undoOutcomeText,
  type DayBar,
  type HourStrip,
  type MemoryEventView,
  type MemoryJobView,
  type MemoryModelView,
  type MemoryWorkStatus,
  type PipelineStageView,
} from '../lib/memory-work';

export function StatusLine({ status, onRetry }: { status: MemoryWorkStatus; onRetry?: () => void }) {
  return (
    <div class={`mw-status tone-${status.tone}`}>
      {status.pulse
        ? <span class="pulse-dot mw-dot" aria-hidden="true" />
        : <span class={`mw-dot mw-dot-${status.tone}`} aria-hidden="true" />}
      <div class="mw-status-main">
        {/* Only the headline is announced, and only when its words change. */}
        <p class="mw-headline" aria-live="polite">{status.text}</p>
        {status.detail ? <p class="mw-detail">{status.detail}</p> : null}
        {status.stale ? <p class="mw-detail mw-stale">{status.stale}</p> : null}
        {onRetry ? <button type="button" class="mw-link" onClick={onRetry}>Try again</button> : null}
      </div>
    </div>
  );
}

/** The model that keeps memory. Opens the same picker Settings › Models uses,
 *  in place, when this Mac's Clem offers the role. */
export function ModelRow({ view, onChange }: { view: MemoryModelView; onChange?: () => void }) {
  const body = (
    <>
      <span class="mw-model-main">
        <span class="mw-model-role">{MEMORY_ROLE_WORDS.title}</span>
        <span class={`mw-model-name${view.hasModel ? '' : ' is-none'}`}>{view.name}</span>
        <span class="mw-model-note">{view.source}</span>
        {view.served ? <span class={`mw-model-note${view.served.standIn ? ' warning' : ''}`}>{view.served.text}</span> : null}
        {view.problem ? <span class="mw-model-note warning">{view.problem}</span> : null}
      </span>
      {onChange ? <span class="settings-row-action">Change</span> : null}
    </>
  );
  return onChange ? (
    <button type="button" class="mw-model" onClick={() => { haptic('light'); onChange(); }}>{body}</button>
  ) : (
    <div class="mw-model">{body}</div>
  );
}

/** Read → noticed → kept → left out → faded, with today's numbers. */
export function Pipeline({ stages }: { stages: PipelineStageView[] }) {
  return (
    <ol class="mw-pipe" aria-label="Today’s learning">
      {stages.map((stage, i) => (
        <Fragment key={stage.id}>
          {i > 0 ? (
            <li class={`mw-flow${stage.lit ? ' is-flowing' : ''}`} aria-hidden="true"><i /></li>
          ) : null}
          <li
            class={`mw-stage${stage.lit ? ' is-lit' : ''}${stage.known ? '' : ' is-unknown'}`}
            aria-label={`${stage.label}: ${stage.value}`}
          >
            <span class="mw-stage-n" aria-hidden="true">{stage.value}</span>
            <span class="mw-stage-label" aria-hidden="true">{stage.short}</span>
          </li>
        </Fragment>
      ))}
    </ol>
  );
}

/**
 * The last 24 hours as quiet bars. A finger run along the strip (or the
 * arrow keys) reads out one hour; letting go returns to the day's summary
 * after a moment. Bars are drawn from what the daemon counted, never scaled
 * up from nothing: an empty hour is a hairline.
 */
export function HourStripView({ strip }: { strip: HourStrip | null }) {
  const [picked, setPicked] = useState<number | null>(null);
  const barsRef = useRef<HTMLDivElement | null>(null);
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (releaseTimer.current) clearTimeout(releaseTimer.current); }, []);

  const bars = strip?.bars ?? [];
  const index = picked !== null && picked < bars.length ? picked : null;
  const caption = index !== null ? hourCaption(bars[index]!) : hourStripSummary(strip);

  const holdOpen = () => { if (releaseTimer.current) { clearTimeout(releaseTimer.current); releaseTimer.current = null; } };
  const releaseSoon = () => {
    holdOpen();
    releaseTimer.current = setTimeout(() => setPicked(null), 5_000);
  };
  const slots = strip?.slots ?? bars.length;
  const pickAt = (clientX: number) => {
    const el = barsRef.current;
    if (!el || bars.length === 0) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    // The slot under the finger, then the measured hour nearest it.
    const slot = Math.min(slots - 1, Math.max(0, Math.floor(((clientX - rect.left) / rect.width) * slots)));
    let next = 0;
    bars.forEach((bar, i) => { if (Math.abs(bar.slot - slot) < Math.abs(bars[next]!.slot - slot)) next = i; });
    if (next !== index) haptic('light');
    setPicked(next);
  };

  if (!strip) {
    return (
      <div class="mw-hours">
        <p class="mw-caption">{caption}</p>
      </div>
    );
  }
  return (
    <div class="mw-hours">
      <div
        ref={barsRef}
        class="mw-hours-bars"
        role="slider"
        tabIndex={0}
        aria-label="Memory work, last 24 hours"
        aria-valuemin={0}
        aria-valuemax={bars.length - 1}
        aria-valuenow={index ?? bars.length - 1}
        aria-valuetext={caption}
        onPointerDown={(event) => {
          holdOpen();
          try { (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); } catch { /* not every engine */ }
          pickAt(event.clientX);
        }}
        onPointerMove={(event) => { if (event.buttons !== 0 || event.pointerType === 'touch') pickAt(event.clientX); }}
        onPointerUp={releaseSoon}
        onPointerCancel={releaseSoon}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          const from = index ?? bars.length - 1;
          setPicked(Math.min(bars.length - 1, Math.max(0, from + (event.key === 'ArrowLeft' ? -1 : 1))));
          releaseSoon();
        }}
      >
        {/* Each hour in its own slot; an hour before the record began is
            blank, not a bar. */}
        {Array.from({ length: slots }, (_, slot) => {
          const i = bars.findIndex((bar) => bar.slot === slot);
          const bar = i >= 0 ? bars[i] : undefined;
          if (!bar) return <span key={`blank-${slot}`} class="mw-bar" />;
          return (
            <span
              key={bar.hourStart}
              class={`mw-bar${bar.current ? ' is-now' : ''}${i === index ? ' is-picked' : ''}${bar.height > 0 ? '' : ' is-empty'}`}
              style={{ '--h': bar.height }}
            >
              <i />
              {bar.learned > 0 ? <b class="mw-bar-learned" /> : null}
            </span>
          );
        })}
      </div>
      <div class="mw-axis" aria-hidden="true"><span>24 h ago</span><span>now</span></div>
      <p class="mw-caption" aria-hidden="true">{caption}</p>
    </div>
  );
}

export function DayStripView({ strip }: { strip: { bars: DayBar[]; slots: number; summary: string } | null }) {
  if (!strip) return null;
  return (
    <div class="mw-days">
      <div class="mw-days-bars" role="img" aria-label={strip.summary}>
        {Array.from({ length: strip.slots }, (_, slot) => {
          const bar = strip.bars.find((b) => b.slot === slot);
          if (!bar) return <span key={`blank-${slot}`} class="mw-bar" />;
          return (
            <span key={bar.day} class={`mw-bar${bar.today ? ' is-now' : ''}${bar.height > 0 ? '' : ' is-empty'}`} style={{ '--h': bar.height }}>
              <i />
              {bar.learned > 0 ? <b class="mw-bar-learned" /> : null}
            </span>
          );
        })}
      </div>
      <p class="mw-caption" aria-hidden="true">{strip.summary}</p>
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg class={`mw-chevron${open ? ' open' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

/**
 * One recorded run. On the card it is a line and its age; in the full view it
 * opens to what changed and how long its detail is kept. Undo asks once
 * before forgetting; bringing a memory back needs no question.
 */
export function EventRow({ view, compact, onUndo }: {
  view: MemoryEventView;
  compact?: boolean;
  onUndo: (eventId: string) => Promise<MemoryWorkUndoResult>;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!outcome) return;
    const timer = setTimeout(() => setOutcome(null), 5_000);
    return () => clearTimeout(timer);
  }, [outcome]);

  const undo = view.undo;
  const confirmText = undo ? undoConfirmText(undo) : null;
  const run = async () => {
    if (!undo || busy) return;
    setBusy(true);
    setConfirming(false);
    try {
      const result = await onUndo(view.id);
      const said = undoOutcomeText(result, undo.kind);
      haptic(said.ok ? 'success' : 'error');
      setOutcome(said);
    } catch (err) {
      haptic('error');
      setOutcome(isOfflineError(err) ? { ok: false, text: 'Can’t reach your Mac right now.' } : undoOutcomeText(null, undo.kind));
    } finally {
      setBusy(false);
    }
  };

  const meta = [compact ? view.age : null, view.model, ...(compact ? [] : view.meta)].filter(Boolean) as string[];
  const canOpen = !compact;
  const head = (
    <>
      <span class={`mw-event-dot tone-${view.tone}`} aria-hidden="true" />
      <span class="mw-event-main">
        <span class="mw-event-text">
          {!compact ? <span class="mw-event-time">{view.time}</span> : null}
          {view.sentence}
        </span>
        {meta.length > 0 || view.standIn ? (
          <span class="mw-event-meta">
            {meta.join(' · ')}
            {view.standIn ? <span class="mw-standin">stand-in</span> : null}
          </span>
        ) : null}
      </span>
      {canOpen ? <Chevron open={open} /> : null}
    </>
  );

  return (
    <li class={`mw-event rise${view.tone === 'failed' ? ' is-failed' : ''}`}>
      {canOpen ? (
        <button type="button" class="mw-event-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{head}</button>
      ) : (
        <div class="mw-event-head">{head}</div>
      )}

      {open ? (
        <div class="mw-event-body">
          {view.facts.length > 0 ? (
            <ul class="mw-facts">
              {view.facts.map((fact) => (
                <li key={fact.id} class={`mw-fact change-${fact.change}${fact.active ? '' : ' is-inactive'}`}>
                  <span class="mw-fact-change">{fact.change}</span>
                  <span class="mw-fact-text">{fact.text}</span>
                  {fact.state ? <span class="mw-fact-state">{fact.state}</span> : null}
                </li>
              ))}
              {view.moreFacts > 0 ? <li class="mw-fact-more">and {view.moreFacts} more</li> : null}
            </ul>
          ) : null}
          {view.kept ? <p class="mw-kept">{view.kept}</p> : null}
        </div>
      ) : null}

      {undo || outcome ? (
        <div class="mw-event-actions">
          {outcome ? (
            <span class={`mw-outcome${outcome.ok ? '' : ' error'}`} role="status">{outcome.text}</span>
          ) : confirming && confirmText ? (
            <>
              <span class="mw-confirm">{confirmText}</span>
              <button type="button" class="mw-undo danger" disabled={busy} onClick={() => void run()}>Forget</button>
              <button type="button" class="mw-undo" disabled={busy} onClick={() => setConfirming(false)}>Keep</button>
            </>
          ) : undo ? (
            <button
              type="button"
              class="mw-undo"
              disabled={busy}
              onClick={() => { if (confirmText) setConfirming(true); else void run(); }}
            >
              {busy ? '…' : undo.text}
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** One background job: what it is, which model does its thinking, when it
 *  last ran and when it runs next. Opens to its one-sentence explanation. */
export function JobRow({ view }: { view: MemoryJobView }) {
  const [open, setOpen] = useState(false);
  return (
    <li class={`mw-job state-${view.state}`}>
      <button type="button" class="mw-job-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {view.pulse
          ? <span class="pulse-dot mw-dot" aria-hidden="true" />
          : <span class={`mw-dot mw-job-dot-${view.state}`} aria-hidden="true" />}
        <span class="mw-job-main">
          <span class="mw-job-title">{view.title}</span>
          {view.stateText ? <span class={`mw-job-state${view.state === 'waiting' ? ' warning' : ''}`}>{view.stateText}</span> : null}
          <span class="mw-job-line">{view.model}</span>
          <span class="mw-job-line">{view.last}</span>
          {view.next ? <span class="mw-job-line">{view.next}</span> : null}
        </span>
        <Chevron open={open} />
      </button>
      {open ? (
        <div class="mw-job-body">
          <p>{view.blurb}</p>
          {view.today ? <p class="mw-job-line">{view.today}</p> : null}
        </div>
      ) : null}
    </li>
  );
}
