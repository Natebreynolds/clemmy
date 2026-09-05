/**
 * Customize your home — the user shapes the window.
 *
 * Everything here writes ONE record (HomePreferences) through the daemon, so
 * a change made on the phone is the desktop's too. Each control changes the
 * thing it names, immediately; the footer says whether it landed.
 */
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Sheet } from './Sheet';
import { haptic } from '../lib/native-bridge';
import { listWorkflows, type MobileWorkflow } from '../lib/api';
import { whenLabel } from '../lib/schedule-label';
import {
  panesFromPhoneRows,
  phonePaneRows,
  phoneSwitcherIds,
  SWITCHER_MORE,
  useHomePreferences,
  type HomeLanding,
  type HomePaneId,
  type QuickAction,
} from '../lib/home-prefs';

export interface SectionOption {
  id: string;
  label: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Every section this build knows, for the switcher chips. */
  sections: SectionOption[];
  /** The current project's name when the host knows one (the landing hint). */
  currentProject?: string | null;
}

function reorder<T>(list: readonly T[], from: number, to: number): T[] {
  const bounded = Math.max(0, Math.min(list.length - 1, to));
  if (from === bounded || from < 0 || from >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(bounded, 0, item);
  return next;
}

/**
 * Drag to reorder without a library. The handle (a grip, or the chip itself)
 * captures the pointer; on release the item lands where the pointer crossed
 * its neighbours' midpoints. Arrow keys move the same item one step, so the
 * order is reachable without touch.
 */
function useReorder(axis: 'x' | 'y', move: (from: number, to: number) => void) {
  const listRef = useRef<HTMLElement | null>(null);
  const drag = useRef<{ from: number; start: number; rects: DOMRect[]; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [lift, setLift] = useState<{ index: number; delta: number } | null>(null);

  const position = (event: PointerEvent) => (axis === 'y' ? event.clientY : event.clientX);
  const mid = (rect: DOMRect) => (axis === 'y' ? rect.top + rect.height / 2 : rect.left + rect.width / 2);

  const handleProps = (index: number) => ({
    onPointerDown: (event: JSX.TargetedPointerEvent<HTMLElement>) => {
      const list = listRef.current;
      if (!list || event.button !== 0) return;
      const items = [...list.querySelectorAll<HTMLElement>('[data-reorder]')];
      drag.current = { from: index, start: position(event), rects: items.map((el) => el.getBoundingClientRect()), moved: false };
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* capture is a nicety */ }
      setLift({ index, delta: 0 });
    },
    onPointerMove: (event: JSX.TargetedPointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d) return;
      const delta = position(event) - d.start;
      if (!d.moved && Math.abs(delta) > 6) d.moved = true;
      if (d.moved) setLift({ index: d.from, delta });
    },
    onPointerUp: (event: JSX.TargetedPointerEvent<HTMLElement>) => {
      const d = drag.current;
      drag.current = null;
      setLift(null);
      if (!d) return;
      if (d.moved) suppressClick.current = true;
      const pos = position(event);
      let to = d.from;
      for (let i = 0; i < d.from; i += 1) {
        if (pos < mid(d.rects[i])) { to = i; break; }
      }
      if (to === d.from) {
        for (let i = d.rects.length - 1; i > d.from; i -= 1) {
          if (pos > mid(d.rects[i])) { to = i; break; }
        }
      }
      if (d.moved && to !== d.from) {
        haptic('light');
        move(d.from, to);
      }
    },
    onPointerCancel: () => {
      drag.current = null;
      setLift(null);
    },
    onKeyDown: (event: JSX.TargetedKeyboardEvent<HTMLElement>) => {
      const back = axis === 'y' ? 'ArrowUp' : 'ArrowLeft';
      const forward = axis === 'y' ? 'ArrowDown' : 'ArrowRight';
      if (event.key === back) {
        event.preventDefault();
        move(index, index - 1);
      } else if (event.key === forward) {
        event.preventDefault();
        move(index, index + 1);
      }
    },
  });

  /** True once, right after a drag, so the release does not also count as a tap. */
  const consumeClick = (): boolean => {
    const suppressed = suppressClick.current;
    suppressClick.current = false;
    return suppressed;
  };

  const liftStyle = (index: number) => (lift && lift.index === index
    ? { transform: axis === 'y' ? `translateY(${lift.delta}px)` : `translateX(${lift.delta}px)` }
    : undefined);
  const lifting = (index: number) => Boolean(lift && lift.index === index && lift.delta !== 0);

  return { listRef, handleProps, consumeClick, liftStyle, lifting };
}

function Grip(props: { label: string } & ReturnType<ReturnType<typeof useReorder>['handleProps']>) {
  const { label, ...handlers } = props;
  return (
    <button type="button" class="cz-grip" aria-label={`Move ${label}`} {...handlers}>
      <svg viewBox="0 0 12 16" fill="currentColor" aria-hidden="true">
        <circle cx="3" cy="3" r="1.5" /><circle cx="9" cy="3" r="1.5" />
        <circle cx="3" cy="8" r="1.5" /><circle cx="9" cy="8" r="1.5" />
        <circle cx="3" cy="13" r="1.5" /><circle cx="9" cy="13" r="1.5" />
      </svg>
    </button>
  );
}

const LANDINGS: Array<{ id: HomeLanding; label: string }> = [
  { id: 'home', label: 'Home' },
  { id: 'last_conversation', label: 'Last conversation' },
  { id: 'current_project', label: 'Current project' },
];

export function CustomizeSheet({ open, onClose, sections, currentProject }: Props) {
  const { prefs, loaded, saving, error, save, reload } = useHomePreferences({ enabled: open });

  // ── panes ──
  const paneRows = phonePaneRows(prefs);
  const savePanes = (rows: Array<{ id: HomePaneId; on: boolean }>) => {
    void save({ panes: panesFromPhoneRows(prefs, rows) }).catch(() => undefined);
  };
  const panes = useReorder('y', (from, to) => savePanes(reorder(paneRows, from, to)));

  // ── switcher ──
  const switcherOn = phoneSwitcherIds(prefs, sections.map((s) => s.id)).filter((id) => id !== SWITCHER_MORE);
  const switcherOff = sections.filter((s) => !switcherOn.includes(s.id)).map((s) => s.id);
  const chipIds = [...switcherOn, ...switcherOff];
  const saveSwitcher = (on: string[]) => {
    void save({ phoneSwitcher: [...on, SWITCHER_MORE] }).catch(() => undefined);
  };
  const chips = useReorder('x', (from, to) => {
    // Only the "on" chips have an order; dragging into the off group parks at the end.
    if (from >= switcherOn.length) return;
    saveSwitcher(reorder(switcherOn, from, Math.min(to, switcherOn.length - 1)));
  });

  // ── quick actions ──
  const actions = prefs.quickActions;
  const saveActions = (next: QuickAction[]) => {
    void save({ quickActions: next }).catch(() => undefined);
  };
  const quick = useReorder('y', (from, to) => saveActions(reorder(actions, from, to)));
  const [adding, setAdding] = useState(false);

  const sectionLabel = (id: string) => sections.find((s) => s.id === id)?.label ?? id;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Customize your home"
      aside="Same as your desktop"
      backGesture
      class="sheet-tall"
      footer={(
        <>
          <span class="cz-status" role="status" aria-live="polite">
            {saving ? (
              <>Saving…</>
            ) : error ? (
              <>
                <span class="cz-status-fail">Couldn’t save.</span>
                <button type="button" class="cz-retry" onClick={() => void reload()}>Retry</button>
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                {loaded ? 'Saved to your account' : 'Loading your settings…'}
              </>
            )}
          </span>
          <button type="button" class="cz-done" onClick={onClose}>Done</button>
        </>
      )}
    >
      {!loaded && !error ? <div class="skeleton-stack" aria-hidden="true"><i /><i /></div> : null}

      <section class="cz-section" aria-labelledby="cz-panes">
        <h3 id="cz-panes" class="pane-head">Panes</h3>
        <ul class="cz-list" ref={(el) => { panes.listRef.current = el; }}>
          {paneRows.map((row, i) => (
            <li
              key={row.id}
              class={`cz-row${panes.lifting(i) ? ' lifting' : ''}${row.on ? '' : ' off'}`}
              data-reorder
              style={panes.liftStyle(i)}
            >
              <Grip label={row.label} {...panes.handleProps(i)} />
              <span class="cz-row-label">{row.label}</span>
              <button
                type="button"
                class="cz-switch-hit"
                role="switch"
                aria-checked={row.on}
                aria-label={row.label}
                onClick={() => {
                  haptic('light');
                  savePanes(paneRows.map((r) => (r.id === row.id ? { ...r, on: !r.on } : r)));
                }}
              >
                <span class={`settings-switch${row.on ? ' on' : ''}`} aria-hidden="true"><i /></span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section class="cz-section" aria-labelledby="cz-switcher">
        <div class="cz-head-row">
          <h3 id="cz-switcher" class="pane-head">Switcher order</h3>
          <span class="cz-hint">Tap to add or remove · drag to reorder</span>
        </div>
        <div class="cz-chips" ref={(el) => { chips.listRef.current = el; }}>
          {chipIds.map((id, i) => {
            const on = i < switcherOn.length;
            return (
              <button
                key={id}
                type="button"
                class={`cz-chip${on ? ' on' : ''}${chips.lifting(i) ? ' lifting' : ''}`}
                aria-pressed={on}
                data-reorder
                style={chips.liftStyle(i)}
                {...chips.handleProps(i)}
                onClick={() => {
                  if (chips.consumeClick()) return;
                  haptic('light');
                  saveSwitcher(on ? switcherOn.filter((s) => s !== id) : [...switcherOn, id]);
                }}
              >
                {sectionLabel(id)}
              </button>
            );
          })}
          <span class="cz-chip cz-chip-fixed" aria-hidden="true">More</span>
        </div>
      </section>

      <section class="cz-section" aria-labelledby="cz-landing">
        <h3 id="cz-landing" class="pane-head">Open on launch</h3>
        <div class="cz-list" role="radiogroup" aria-labelledby="cz-landing">
          {LANDINGS.map((option) => {
            const checked = prefs.landing === option.id;
            return (
              <button
                key={option.id}
                type="button"
                class="cz-row cz-radio-row"
                role="radio"
                aria-checked={checked}
                onClick={() => {
                  if (checked) return;
                  haptic('light');
                  void save({ landing: option.id }).catch(() => undefined);
                }}
              >
                <span class={`cz-radio${checked ? ' on' : ''}`} aria-hidden="true" />
                <span class="cz-row-label">{option.label}</span>
                {option.id === 'current_project' ? (
                  <span class="cz-pill">{currentProject ?? 'most recent'}</span>
                ) : option.id === 'last_conversation' ? (
                  <span class="cz-pill">the one you were in</span>
                ) : null}
              </button>
            );
          })}
        </div>
      </section>

      <section class="cz-section" aria-labelledby="cz-quick">
        <h3 id="cz-quick" class="pane-head">Quick actions</h3>
        <ul class="cz-list" ref={(el) => { quick.listRef.current = el; }}>
          {actions.map((action, i) => (
            <li
              key={action.id}
              class={`cz-row${quick.lifting(i) ? ' lifting' : ''}`}
              data-reorder
              style={quick.liftStyle(i)}
            >
              <Grip label={action.label} {...quick.handleProps(i)} />
              <span class="cz-row-label truncate">{action.label}</span>
              <span class="cz-pill">{action.kind === 'workflow' ? 'Workflow' : 'Prompt'}</span>
              <button
                type="button"
                class="cz-remove"
                aria-label={`Remove ${action.label}`}
                onClick={() => {
                  haptic('light');
                  saveActions(actions.filter((a) => a.id !== action.id));
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </li>
          ))}
          {adding ? (
            <li class="cz-row cz-form-row">
              <QuickActionForm
                existing={actions}
                onCancel={() => setAdding(false)}
                onAdd={(action) => {
                  saveActions([...actions, action]);
                  setAdding(false);
                }}
              />
            </li>
          ) : (
            <li class="cz-row">
              <button type="button" class="cz-add" onClick={() => { haptic('light'); setAdding(true); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                Add a prompt or workflow
              </button>
            </li>
          )}
        </ul>
      </section>
    </Sheet>
  );
}

function QuickActionForm({ existing, onAdd, onCancel }: {
  existing: QuickAction[];
  onAdd: (action: QuickAction) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<QuickAction['kind']>('prompt');
  const [label, setLabel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [workflow, setWorkflow] = useState('');
  const [workflows, setWorkflows] = useState<MobileWorkflow[] | null>(null);
  const [workflowsError, setWorkflowsError] = useState<string | null>(null);
  const labelRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { labelRef.current?.focus(); }, []);

  // The workflow roster comes from the daemon the moment it is needed; the
  // phone never guesses a workflow name.
  useEffect(() => {
    if (kind !== 'workflow' || workflows !== null) return;
    let cancelled = false;
    listWorkflows()
      .then((body) => { if (!cancelled) setWorkflows(body.workflows); })
      .catch((err: unknown) => { if (!cancelled) setWorkflowsError(err instanceof Error ? err.message : 'Could not load your flows'); });
    return () => { cancelled = true; };
  }, [kind, workflows]);

  const value = kind === 'prompt' ? prompt.trim() : workflow;
  const finalLabel = (label.trim() || (kind === 'workflow' ? workflow : '')).slice(0, 80);
  const valid = Boolean(value && finalLabel);

  const submit = (event: Event) => {
    event.preventDefault();
    if (!valid) return;
    haptic('success');
    const base = `qa-${Date.now().toString(36)}`;
    let id = base;
    let n = 1;
    while (existing.some((a) => a.id === id)) id = `${base}-${n++}`;
    onAdd({ id, kind, label: finalLabel, value });
  };

  return (
    <form class="cz-form" onSubmit={submit}>
      <div class="cz-seg" role="group" aria-label="Kind">
        <button type="button" class={kind === 'prompt' ? 'on' : ''} aria-pressed={kind === 'prompt'} onClick={() => setKind('prompt')}>Prompt</button>
        <button type="button" class={kind === 'workflow' ? 'on' : ''} aria-pressed={kind === 'workflow'} onClick={() => setKind('workflow')}>Workflow</button>
      </div>
      <label class="cz-field">
        <span>Chip label</span>
        <input
          ref={labelRef}
          class="cz-input"
          value={label}
          maxLength={80}
          placeholder={kind === 'workflow' ? 'Defaults to the flow name' : 'Market leaders → sheet'}
          onInput={(event) => setLabel(event.currentTarget.value)}
        />
      </label>
      {kind === 'prompt' ? (
        <label class="cz-field">
          <span>What should Clem do?</span>
          <textarea
            class="cz-input"
            rows={3}
            maxLength={2000}
            value={prompt}
            placeholder="Pull this week’s market-leader accounts into the prospects sheet"
            onInput={(event) => setPrompt(event.currentTarget.value)}
          />
        </label>
      ) : (
        <label class="cz-field">
          <span>Flow</span>
          <select
            class="cz-input"
            value={workflow}
            disabled={workflows === null && !workflowsError}
            onChange={(event) => setWorkflow(event.currentTarget.value)}
          >
            <option value="">{workflows === null ? (workflowsError ? 'Could not load' : 'Loading…') : workflows.length === 0 ? 'No flows yet' : 'Choose a flow'}</option>
            {(workflows ?? []).map((wf) => (
              <option key={wf.name} value={wf.name} disabled={!wf.enabled}>
                {wf.name} · {wf.enabled ? whenLabel(wf.schedule) : 'disabled'}
              </option>
            ))}
          </select>
          {workflowsError ? <span class="cz-field-error" role="alert">{workflowsError}</span> : null}
        </label>
      )}
      <div class="cz-form-actions">
        <button type="submit" class="cz-done" disabled={!valid}>Add</button>
        <button type="button" class="cz-cancel" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
