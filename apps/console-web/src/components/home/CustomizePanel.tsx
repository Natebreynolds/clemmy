import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragOverEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { AlertTriangle, Check, ChevronDown, Home, Loader2, Plus, Sliders, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { QueryUnavailable } from '@/components/ui/QueryUnavailable';
import { Skeleton } from '@/components/ui/Skeleton';
import { Switch } from '@/components/ui/Switch';
import { ALL_NAV, PRIMARY_NAV, type NavDest } from '@/lib/nav';
import {
  DEFAULT_HOME_PANE_ORDER,
  DEFAULT_HOME_PREFERENCES,
  useHomePreferences,
  type HomeLanding,
  type HomePaneId,
  type HomePreferences,
  type QuickAction,
} from '@/lib/home-prefs';
import { cn } from '@/lib/cn';
import { CustomizeSection } from './CustomizeSection';
import { CustomizeSortableRow } from './CustomizeSortableRow';
import { CustomizeQuickActionForm } from './CustomizeQuickActionForm';
import { useCustomizeSaver, type CustomizeSaveStatus } from './CustomizeSave';
import { useCustomizeFocusTrap } from './CustomizeFocusTrap';

/** Window event that opens the sheet from anywhere (Home header, Settings). */
export const CUSTOMIZE_HOME_EVENT = 'clem:customize-home';

export function openCustomizeHome() {
  window.dispatchEvent(new Event(CUSTOMIZE_HOME_EVENT));
}

// ── Panes ──────────────────────────────────────────────────────────────────

const PANE_LABELS: Record<HomePaneId, string> = {
  quick_actions: 'Quick actions',
  needs_you: 'Needs you',
  running: 'Running',
  while_away: 'While you were away',
  projects: 'Spaces',
  workstate: 'Working together card',
};

const ALL_PANE_IDS: HomePaneId[] = [...DEFAULT_HOME_PANE_ORDER, 'workstate'];
const PANE_ID_SET = new Set<string>(ALL_PANE_IDS);
const isPaneId = (id: string): id is HomePaneId => PANE_ID_SET.has(id);

// ── Landing ────────────────────────────────────────────────────────────────

const LANDING_OPTIONS: { value: HomeLanding; label: string; hint?: string }[] = [
  { value: 'home', label: 'Home', hint: 'Command center' },
  { value: 'last_conversation', label: 'Last conversation', hint: 'Pick up where you left off' },
  { value: 'current_project', label: 'Current project', hint: 'The workspace you were in' },
];

// ── Sidebar ────────────────────────────────────────────────────────────────

type Nav = HomePreferences['nav'];
type NavGroup = keyof Nav;

const NAV_GROUPS: { key: NavGroup; label: string }[] = [
  { key: 'pinned', label: 'Pinned' },
  { key: 'shown', label: 'Shown' },
  { key: 'more', label: 'In More' },
];
const NAV_GROUP_KEYS = new Set<string>(NAV_GROUPS.map((g) => g.key));
const isNavGroup = (key: string): key is NavGroup => NAV_GROUP_KEYS.has(key);

const HOME_PATH = '/home';
const CHAT_PATH = '/chat';
const HOME_DEST: NavDest = { path: HOME_PATH, label: 'Home', icon: Home, hint: 'Your command center' };

/** Destination for a nav id; the sidebar's own catalog first, Home as the one built-in. */
function navDest(path: string): NavDest | null {
  return ALL_NAV.find((d) => d.path === path) ?? (path === HOME_PATH ? HOME_DEST : null);
}

/** Every destination the sidebar can place. Anything known but unplaced lands in More. */
const MANAGED_NAV_PATHS = [HOME_PATH, ...PRIMARY_NAV.map((d) => d.path)];

function groupOf(nav: Nav, path: string): NavGroup | null {
  for (const g of NAV_GROUPS) if (nav[g.key].includes(path)) return g.key;
  return null;
}

const GROUP_PREFIX = 'group:';
function containerOf(nav: Nav, id: UniqueIdentifier): NavGroup | null {
  const s = String(id);
  if (s.startsWith(GROUP_PREFIX)) {
    const key = s.slice(GROUP_PREFIX.length);
    return isNavGroup(key) ? key : null;
  }
  return groupOf(nav, s);
}

function setGroup(nav: Nav, key: NavGroup, items: string[]): Nav {
  return { ...nav, [key]: items };
}

function sameNav(a: Nav, b: Nav): boolean {
  return NAV_GROUPS.every((g) => a[g.key].length === b[g.key].length && a[g.key].every((p, i) => p === b[g.key][i]));
}

// ── Normalization ──────────────────────────────────────────────────────────

/**
 * The sheet edits an EXPLICIT model: every pane in the order list, every
 * managed destination in a sidebar group, Chat first and Home pinned, no duplicates.
 * Ids the app doesn't know (from a newer build) ride along untouched.
 */
function normalizeNav(nav: Nav): Nav {
  const seen = new Set<string>();
  const take = (paths: string[]) =>
    paths.filter((p) => {
      if (seen.has(p)) return false;
      seen.add(p);
      return true;
    });
  const pinned = take([CHAT_PATH, ...(nav.pinned.includes(HOME_PATH) ? nav.pinned : [HOME_PATH, ...nav.pinned])]);
  const shown = take(nav.shown);
  const more = take(nav.more);
  const extras = MANAGED_NAV_PATHS.filter((p) => !seen.has(p));
  return { pinned, shown, more: [...more, ...extras] };
}

function normalizePreferences(p: HomePreferences): HomePreferences {
  const seen = new Set<string>();
  const order = [...p.panes.order, ...ALL_PANE_IDS].filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return {
    ...p,
    panes: { order, hidden: [...new Set(p.panes.hidden)] },
    nav: normalizeNav(p.nav),
    quickActions: p.quickActions.map((q) => ({ ...q })),
  };
}

/** Screen-reader narration for a drag, in the product's words rather than raw ids. */
function announcementsFor(labelOf: (id: UniqueIdentifier) => string): Announcements {
  return {
    onDragStart: ({ active }) => `Picked up ${labelOf(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over ? `${labelOf(active.id)} is over ${labelOf(over.id)}.` : `${labelOf(active.id)} is no longer over a list.`,
    onDragEnd: ({ active, over }) =>
      over ? `${labelOf(active.id)} was placed at ${labelOf(over.id)}.` : `${labelOf(active.id)} was put back.`,
    onDragCancel: ({ active }) => `Moving ${labelOf(active.id)} was cancelled.`,
  };
}

const PANE_ANNOUNCEMENTS = announcementsFor((id) => (isPaneId(String(id)) ? PANE_LABELS[String(id) as HomePaneId] : String(id)));

const NAV_ANNOUNCEMENTS = announcementsFor((id) => {
  const s = String(id);
  if (s.startsWith(GROUP_PREFIX)) {
    const key = s.slice(GROUP_PREFIX.length);
    return `the ${NAV_GROUPS.find((g) => g.key === key)?.label ?? key} group`;
  }
  return navDest(s)?.label ?? s;
});

function newQuickActionId(): string {
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `qa_${rand}`;
}

// ── Mount ──────────────────────────────────────────────────────────────────

/**
 * "Customize your home" — the right-side sheet where the user shapes the main
 * window: panes and their order, what the sidebar pins / shows / folds into
 * More, what opens on launch, and their quick actions. Everything is ONE
 * record (HomePreferences) saved to the account, so it applies on the phone.
 * Opens on the `clem:customize-home` window event; Esc or the scrim closes.
 */
export function CustomizePanel() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(CUSTOMIZE_HOME_EVENT, onOpen);
    return () => window.removeEventListener(CUSTOMIZE_HOME_EVENT, onOpen);
  }, []);

  const close = useCallback(() => setOpen(false), []);

  return (
    <AnimatePresence>
      {open && <CustomizeSheet key="customize-home" onClose={close} />}
    </AnimatePresence>
  );
}

// ── Sheet ──────────────────────────────────────────────────────────────────

function CustomizeSheet({ onClose }: { onClose: () => void }) {
  const reduced = useReducedMotion();
  const titleId = useId();
  const sheetRef = useRef<HTMLElement>(null);
  const prefs = useHomePreferences();
  const saver = useCustomizeSaver();

  const ready = !prefs.isPlaceholderData && !!prefs.data;
  const [draft, setDraft] = useState<HomePreferences | null>(() => (ready && prefs.data ? normalizePreferences(prefs.data) : null));
  const draftRef = useRef<HomePreferences | null>(draft);
  draftRef.current = draft;

  const [adding, setAdding] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  useCustomizeFocusTrap(sheetRef, true);

  // Seed the draft once real preferences arrive (the placeholder is the
  // default record while the first fetch is in flight).
  useEffect(() => {
    if (draft || !ready || !prefs.data) return;
    setDraft(normalizePreferences(prefs.data));
  }, [draft, ready, prefs.data]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /** Apply an edit to the draft and save it. After a failed save, the whole
   * draft goes so the account catches up in one request. */
  const commit = (patch: Partial<HomePreferences>) => {
    const current = draftRef.current;
    if (!current) return;
    const next = { ...current, ...patch };
    draftRef.current = next;
    setDraft(next);
    saver.enqueue(saver.status === 'error' ? next : patch);
  };

  const setLocal = (next: HomePreferences) => {
    draftRef.current = next;
    setDraft(next);
  };

  // Panes
  const togglePane = (id: HomePaneId, on: boolean) => {
    const cur = draftRef.current;
    if (!cur) return;
    const hidden = cur.panes.hidden.filter((x) => x !== id);
    commit({ panes: { ...cur.panes, hidden: on ? hidden : [...hidden, id] } });
  };
  const onPanesDragEnd = (e: DragEndEvent) => {
    const cur = draftRef.current;
    const { active, over } = e;
    if (!cur || !over || active.id === over.id) return;
    const order = cur.panes.order;
    const oldIndex = order.findIndex((id) => id === active.id);
    const newIndex = order.findIndex((id) => id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    commit({ panes: { ...cur.panes, order: arrayMove(order, oldIndex, newIndex) } });
  };

  // Sidebar
  const navSnapshot = useRef<Nav | null>(null);
  const onNavDragStart = () => {
    navSnapshot.current = draftRef.current?.nav ?? null;
  };
  const onNavDragCancel = () => {
    const cur = draftRef.current;
    const snap = navSnapshot.current;
    navSnapshot.current = null;
    if (cur && snap) setLocal({ ...cur, nav: snap });
  };
  const onNavDragOver = (e: DragOverEvent) => {
    const cur = draftRef.current;
    const { active, over } = e;
    if (!cur || !over) return;
    const id = String(active.id);
    if (id === HOME_PATH || id === CHAT_PATH) return; // Chat and Home stay pinned.
    const from = containerOf(cur.nav, active.id);
    const to = containerOf(cur.nav, over.id);
    if (!from || !to || from === to) return;
    const toItems = cur.nav[to].filter((p) => p !== id);
    const overIndex = toItems.indexOf(String(over.id));
    toItems.splice(overIndex >= 0 ? overIndex : toItems.length, 0, id);
    const nav = setGroup(setGroup(cur.nav, from, cur.nav[from].filter((p) => p !== id)), to, toItems);
    setLocal({ ...cur, nav });
  };
  const onNavDragEnd = (e: DragEndEvent) => {
    const cur = draftRef.current;
    const snap = navSnapshot.current;
    navSnapshot.current = null;
    if (!cur) return;
    let nav = cur.nav;
    const { active, over } = e;
    if (over) {
      const from = containerOf(nav, active.id);
      const to = containerOf(nav, over.id);
      if (from && to && from === to && active.id !== over.id) {
        const items = nav[from];
        const oldIndex = items.indexOf(String(active.id));
        const newIndex = items.indexOf(String(over.id));
        if (oldIndex >= 0 && newIndex >= 0) nav = setGroup(nav, from, arrayMove(items, oldIndex, newIndex));
      }
    }
    nav = normalizeNav(nav);
    if (snap && sameNav(snap, nav)) return;
    commit({ nav });
  };
  const moveNav = (path: string, to: NavGroup) => {
    const cur = draftRef.current;
    if (!cur || path === HOME_PATH || path === CHAT_PATH) return;
    const from = groupOf(cur.nav, path);
    if (from === to) return;
    let nav: Nav = {
      pinned: cur.nav.pinned.filter((p) => p !== path),
      shown: cur.nav.shown.filter((p) => p !== path),
      more: cur.nav.more.filter((p) => p !== path),
    };
    nav = setGroup(nav, to, [...nav[to], path]);
    commit({ nav });
  };

  // Landing
  const setLanding = (landing: HomeLanding) => commit({ landing });

  // Quick actions
  const addQuickAction = (action: Omit<QuickAction, 'id'>) => {
    const cur = draftRef.current;
    if (!cur) return;
    commit({ quickActions: [...cur.quickActions, { id: newQuickActionId(), ...action }] });
    setAdding(false);
  };
  const removeQuickAction = (id: string) => {
    const cur = draftRef.current;
    if (!cur) return;
    commit({ quickActions: cur.quickActions.filter((q) => q.id !== id) });
  };
  const onQuickDragEnd = (e: DragEndEvent) => {
    const cur = draftRef.current;
    const { active, over } = e;
    if (!cur || !over || active.id === over.id) return;
    const list = cur.quickActions;
    const oldIndex = list.findIndex((q) => q.id === active.id);
    const newIndex = list.findIndex((q) => q.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    commit({ quickActions: arrayMove(list, oldIndex, newIndex) });
  };

  // Footer
  const reset = () => {
    setLocal(normalizePreferences(DEFAULT_HOME_PREFERENCES));
    setConfirmReset(false);
    setAdding(false);
    saver.enqueue({ ...DEFAULT_HOME_PREFERENCES });
  };
  const retry = () => {
    const cur = draftRef.current;
    if (cur) saver.enqueue({ ...cur });
  };

  const hidden = new Set<string>(draft?.panes.hidden ?? []);
  const paneIds = (draft?.panes.order ?? []).filter(isPaneId);
  const quickIds = (draft?.quickActions ?? []).map((q) => q.id);
  const quickAnnouncements = announcementsFor((id) => draftRef.current?.quickActions.find((q) => q.id === id)?.label ?? String(id));

  return (
    <>
      <motion.div
        className="app-no-drag fixed inset-0 z-[90]"
        style={{ backgroundColor: 'color-mix(in srgb, var(--bg-canvas) 50%, transparent)' }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: reduced ? 0 : 0.16 }}
        onMouseDown={onClose}
        aria-hidden
      />
      <motion.section
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        // tabIndex={-1} with outline-none is the ONE legitimate shape of that
        // pair: this container is focused programmatically when the sheet
        // opens and nobody can Tab to it, so a ring around the whole panel
        // would be noise. Every control inside keeps the base :focus-visible
        // outline — which is what makes this different from the sites where
        // outline-none locks a keyboard user out.
        tabIndex={-1}
        className="app-no-drag fixed bottom-3 right-3 top-3 z-[91] flex w-[min(440px,calc(100vw-24px))] flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-lg outline-none"
        initial={{ x: reduced ? 0 : 24, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: reduced ? 0 : 24, opacity: 0 }}
        transition={{ duration: reduced ? 0 : 0.18, ease: [0.2, 0, 0, 1] }}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-5 py-4">
          <Sliders className="h-5 w-5 shrink-0 text-fg" aria-hidden />
          <h2 id={titleId} className="text-h3 font-bold text-fg">Customize your home</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-faint transition-colors duration-fast hover:bg-hover hover:text-fg"
          >
            <X className="h-[18px] w-[18px]" aria-hidden />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-3.5">
          {prefs.isError ? (
            <QueryUnavailable
              title="Couldn't load your home layout"
              description={
                (prefs.error as { status?: number } | null)?.status === 404
                  ? 'Clementine is a version behind this window — update it to save home layouts. Your saved layout is untouched.'
                  : "Clementine's local service didn't answer. Your saved layout is untouched."
              }
              onRetry={() => void prefs.refetch()}
            />
          ) : !draft ? (
            <CustomizeSkeleton />
          ) : (
            <>
              <CustomizeSection label="Panes" hint="Drag to reorder · switch to show">
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  accessibility={{ announcements: PANE_ANNOUNCEMENTS }}
                  onDragEnd={onPanesDragEnd}
                >
                  <SortableContext items={paneIds} strategy={verticalListSortingStrategy}>
                    <ul className="flex flex-col [&>li:first-child]:border-t-0">
                      {paneIds.map((id) => {
                        const on = !hidden.has(id);
                        return (
                          <CustomizeSortableRow key={id} id={id} label={PANE_LABELS[id]} muted={!on}>
                            <span className="min-w-0 flex-1 truncate">{PANE_LABELS[id]}</span>
                            <Switch checked={on} onChange={(v) => togglePane(id, v)} label={`Show ${PANE_LABELS[id]}`} />
                          </CustomizeSortableRow>
                        );
                      })}
                    </ul>
                  </SortableContext>
                </DndContext>
              </CustomizeSection>

              <CustomizeSection label="Sidebar" hint="Pinned stays on top; the rest folds into More">
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCorners}
                  accessibility={{ announcements: NAV_ANNOUNCEMENTS }}
                  onDragStart={onNavDragStart}
                  onDragOver={onNavDragOver}
                  onDragEnd={onNavDragEnd}
                  onDragCancel={onNavDragCancel}
                >
                  <ul className="flex flex-col">
                    {NAV_GROUPS.map((g, i) => (
                      <NavGroupBlock key={g.key} group={g} first={i === 0} paths={draft.nav[g.key]} onMove={moveNav} />
                    ))}
                    <li className="flex min-h-9 items-center gap-2.5 border-t border-border px-3 text-small text-faint">
                      <span className="min-w-0 flex-1 truncate">Advanced panels</span>
                      <span className="shrink-0 text-caption">Under Settings › Developer</span>
                    </li>
                  </ul>
                </DndContext>
              </CustomizeSection>

              <CustomizeSection label="Open on launch">
                <div role="radiogroup" aria-label="Open on launch" className="flex flex-col [&>label:first-child]:border-t-0">
                  {LANDING_OPTIONS.map((o) => (
                    <label
                      key={o.value}
                      className="flex min-h-9 cursor-pointer items-center gap-2.5 border-t border-border px-3 text-small text-fg transition-colors duration-fast hover:bg-hover"
                    >
                      <input
                        type="radio"
                        name={`${titleId}-landing`}
                        value={o.value}
                        checked={draft.landing === o.value}
                        onChange={() => setLanding(o.value)}
                        className="peer sr-only"
                      />
                      <span
                        aria-hidden
                        className="h-4 w-4 shrink-0 rounded-full border-2 border-border-strong transition-[border-color,box-shadow] duration-fast peer-checked:border-primary peer-checked:shadow-[inset_0_0_0_3px_var(--bg-surface),inset_0_0_0_8px_var(--primary)] peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface"
                      />
                      <span className="min-w-0 flex-1 truncate">{o.label}</span>
                      {o.hint && <span className="shrink-0 text-caption text-faint">{o.hint}</span>}
                    </label>
                  ))}
                </div>
              </CustomizeSection>

              <CustomizeSection label="Quick actions" hint="Your prompts and workflows, one tap">
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  accessibility={{ announcements: quickAnnouncements }}
                  onDragEnd={onQuickDragEnd}
                >
                  <SortableContext items={quickIds} strategy={verticalListSortingStrategy}>
                    <ul className="flex flex-col [&>li:first-child]:border-t-0">
                      {draft.quickActions.length === 0 && !adding && (
                        <li className="flex min-h-9 items-center border-t border-border px-3 text-caption text-faint">
                          The things you run most, one tap from Home.
                        </li>
                      )}
                      {draft.quickActions.map((qa) => (
                        <CustomizeSortableRow key={qa.id} id={qa.id} label={qa.label}>
                          <span className="min-w-0 flex-1 truncate" title={qa.value}>{qa.label}</span>
                          <span className="shrink-0 text-caption text-faint">{qa.kind === 'workflow' ? 'Workflow' : 'Prompt'}</span>
                          <button
                            type="button"
                            onClick={() => removeQuickAction(qa.id)}
                            aria-label={`Remove ${qa.label}`}
                            className="-mr-1.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-faint transition-colors duration-fast hover:bg-danger-tint hover:text-danger"
                          >
                            <X className="h-3.5 w-3.5" aria-hidden />
                          </button>
                        </CustomizeSortableRow>
                      ))}
                      <li className="border-t border-border">
                        {adding ? (
                          <CustomizeQuickActionForm onAdd={addQuickAction} onCancel={() => setAdding(false)} />
                        ) : (
                          <button
                            type="button"
                            onClick={() => setAdding(true)}
                            className="flex min-h-9 w-full items-center gap-2.5 px-3 text-small font-semibold text-primary transition-colors duration-fast hover:bg-primary-tint"
                          >
                            <Plus className="h-4 w-4" aria-hidden />
                            Add a prompt or workflow
                          </button>
                        )}
                      </li>
                    </ul>
                  </SortableContext>
                </DndContext>
              </CustomizeSection>
            </>
          )}
        </div>

        <div className="flex items-center gap-2.5 border-t border-border bg-canvas px-5 py-3">
          {confirmReset ? (
            <>
              <span className="min-w-0 flex-1 truncate text-caption text-fg">Reset your home to the defaults? Quick actions go too.</span>
              <Button variant="ghost" size="sm" onClick={() => setConfirmReset(false)}>Keep</Button>
              <Button variant="danger" size="sm" onClick={reset}>Reset</Button>
            </>
          ) : (
            <>
              <SaveState status={saver.status} message={saver.message} onRetry={retry} loadFailed={prefs.isError} />
              <Button variant="ghost" size="sm" disabled={!draft} onClick={() => setConfirmReset(true)}>Reset</Button>
              <Button size="sm" onClick={onClose}>Done</Button>
            </>
          )}
        </div>
      </motion.section>
    </>
  );
}

// ── Pieces ─────────────────────────────────────────────────────────────────

function NavGroupBlock({
  group,
  first,
  paths,
  onMove,
}: {
  group: { key: NavGroup; label: string };
  first: boolean;
  paths: string[];
  onMove: (path: string, to: NavGroup) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${GROUP_PREFIX}${group.key}` });
  const rows = paths.flatMap((path) => {
    const dest = navDest(path);
    return dest ? [{ path, dest }] : [];
  });
  const items = rows.map((r) => r.path);
  return (
    <li className="flex flex-col">
      <div
        className={cn(
          'flex min-h-8 items-center px-3 text-caption font-semibold',
          !first && 'border-t border-border',
          group.key === 'pinned' ? 'text-primary' : 'text-faint',
        )}
      >
        {group.label}
      </div>
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        <ul ref={setNodeRef} className={cn('flex flex-col transition-colors duration-fast', isOver && 'bg-subtle')}>
          {rows.length === 0 && (
            <li className="flex min-h-9 items-center border-t border-border px-3 text-caption text-faint">Drag a destination here</li>
          )}
          {rows.map(({ path, dest }) => {
            const Icon = dest.icon;
            return (
              <CustomizeSortableRow key={path} id={path} label={dest.label}>
                <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{dest.label}</span>
                {path === HOME_PATH || path === CHAT_PATH ? (
                  <span className="shrink-0 text-caption font-semibold text-primary">Pinned</span>
                ) : (
                  <NavGroupSelect value={group.key} label={dest.label} onChange={(to) => onMove(path, to)} />
                )}
              </CustomizeSortableRow>
            );
          })}
        </ul>
      </SortableContext>
    </li>
  );
}

function NavGroupSelect({ value, label, onChange }: { value: NavGroup; label: string; onChange: (to: NavGroup) => void }) {
  return (
    <span className="relative inline-flex shrink-0">
      <select
        value={value}
        onChange={(e) => { if (isNavGroup(e.target.value)) onChange(e.target.value); }}
        aria-label={`Where ${label} appears`}
        className="h-6 cursor-pointer appearance-none rounded-full bg-subtle pl-2.5 pr-6 text-caption font-medium text-muted transition-colors duration-fast hover:bg-hover hover:text-fg"
      >
        {NAV_GROUPS.map((g) => (
          <option key={g.key} value={g.key}>{g.label}</option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" aria-hidden />
    </span>
  );
}

function SaveState({ status, message, onRetry, loadFailed = false }: { status: CustomizeSaveStatus; message: string | null; onRetry: () => void; loadFailed?: boolean }) {
  if (loadFailed && status !== 'error' && status !== 'saving') {
    return <span className="truncate text-small text-muted">Nothing saved yet — the layout couldn't be loaded.</span>;
  }
  if (status === 'error') {
    return (
      <span role="alert" className="flex min-w-0 flex-1 items-center gap-1.5 text-caption text-danger">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="truncate">Couldn't save{message ? ` — ${message}` : ''}</span>
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 font-semibold underline underline-offset-2 transition-colors hover:text-fg"
        >
          Retry
        </button>
      </span>
    );
  }
  if (status === 'saving') {
    return (
      <span aria-live="polite" className="flex min-w-0 flex-1 items-center gap-1.5 text-caption text-muted">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
        Saving…
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5 text-caption text-muted">
      <Check className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
      <span className="truncate">Saved to your account · applies on your phone too</span>
    </span>
  );
}

function CustomizeSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading your home layout">
      {[6, 9, 3, 2].map((rows, i) => (
        <div key={i} className="flex flex-col gap-1.5">
          <Skeleton className="h-3 w-20" />
          <div className="overflow-hidden rounded-md border border-border">
            {Array.from({ length: rows }, (_, r) => (
              <Skeleton key={r} className="h-9 rounded-none border-t border-border first:border-t-0" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
