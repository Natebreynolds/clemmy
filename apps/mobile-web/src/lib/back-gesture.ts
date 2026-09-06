/**
 * Edge-swipe "back" for deep views.
 *
 * The iOS shell already sets `allowsBackForwardNavigationGestures = true`
 * (PinnedWebView.swift), but the gesture had nothing to navigate: every deep
 * view in this app is component state (`selected`, `editing`, an open chat),
 * so the web view's history never grew an entry. The only way back was the
 * arrow at the top of a scrolling screen — which meant scrolling to the top of
 * a long chat just to leave it.
 *
 * A deep view registers itself here. Entering pushes one same-document history
 * entry; the swipe (or an Android back button, or a desktop back click) pops
 * it and the view closes itself. Closing by tapping the arrow unwinds the same
 * entry, so the two paths cannot drift apart.
 *
 * Deliberately NOT a router. Tabs are peers, not depth — swiping back out of a
 * tab into a previous tab is disorienting, and would also make the very first
 * back gesture leave the app. Only genuine depth registers.
 */
import { useEffect, useRef } from 'preact/hooks';

interface Entry {
  id: number;
  close: () => void;
}

/** The subset of document this needs; absent wherever view transitions are not. */
interface TransitionDocument {
  startViewTransition?: (update: () => void) => unknown;
}

/**
 * Animate a DEPTH change — and only a depth change.
 *
 * This module already models the distinction the animation needs: a deep view
 * pushes exactly one same-document history entry, and tabs are peers that push
 * nothing. So the cross-fade rides on the same two calls, which means a tab
 * switch (high-frequency, feels faster without motion) can never accidentally
 * animate.
 *
 * Degrades silently: an unsupported browser and a reduced-motion setting both
 * just run the update.
 */
export function withDepthTransition(
  update: () => void,
  doc: TransitionDocument | undefined = typeof document === 'undefined' ? undefined : document,
  reduceMotion: boolean = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
): void {
  if (!doc?.startViewTransition || reduceMotion) {
    update();
    return;
  }
  try {
    doc.startViewTransition(update);
  } catch {
    // A transition that cannot start must never swallow the navigation itself.
    update();
  }
}

const stack: Entry[] = [];
let sequence = 0;
let installed = false;

/**
 * True while a popstate is being serviced. A view closing because the USER
 * swiped must not also call history.back() — that would consume a second
 * entry and skip a level.
 */
let servicingPop = false;

function install(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('popstate', () => {
    const top = stack.pop();
    if (!top) return;
    servicingPop = true;
    try {
      // The swipe-back close animates exactly like the in-page arrow's close,
      // because both are the same depth pop.
      withDepthTransition(() => top.close());
    } finally {
      // Cleared on a later task, not synchronously: the close() above sets
      // component state, and the effect that observes it runs after this
      // frame. Clearing too early makes that effect think the user tapped.
      setTimeout(() => { servicingPop = false; }, 0);
    }
  });
}

/** Test seam: drop all registrations without touching real history. */
export function _resetBackGestureForTest(): void {
  stack.length = 0;
  sequence = 0;
  servicingPop = false;
}

/** Test seam: how many deep views are currently registered. */
export function _backGestureDepthForTest(): number {
  return stack.length;
}

/**
 * Open a deep view: push one history entry and register how to close it.
 * Returns the entry id the caller must pass back to closeBackEntry.
 *
 * Exported so the contract is testable without a renderer — the hook below is
 * a thin wrapper around exactly these two functions.
 */
export function openBackEntry(close: () => void): number {
  install();
  const id = ++sequence;
  stack.push({ id, close });
  try {
    window.history.pushState({ clemBackId: id }, '');
  } catch {
    // A blocked history API must never stop the view from opening; the
    // in-page arrow still works.
  }
  return id;
}

/**
 * Close a deep view.
 *
 * If the entry is still registered the user tapped the arrow, so the pushed
 * entry is unwound to keep history and UI in step. If it is already gone the
 * user swiped — history has moved itself, and calling back() again would skip
 * a level and eventually walk them out of the app.
 */
export function closeBackEntry(id: number): void {
  const index = stack.findIndex((entry) => entry.id === id);
  if (index < 0) return;
  stack.splice(index, 1);
  if (servicingPop) return;
  try {
    window.history.back();
  } catch { /* see openBackEntry */ }
}

/** Drop a registration without navigating — for unmount while still open. */
export function abandonBackEntry(id: number): void {
  const index = stack.findIndex((entry) => entry.id === id);
  if (index >= 0) stack.splice(index, 1);
}

/**
 * Register a deep view.
 *
 * @param active whether the view is open right now
 * @param close  how to close it — called when the user navigates back
 */
export function useBackGesture(active: boolean, close: () => void): void {
  const idRef = useRef<number | null>(null);
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (active) {
      if (idRef.current !== null) return;
      idRef.current = openBackEntry(() => closeRef.current());
      return;
    }
    const id = idRef.current;
    if (id === null) return;
    idRef.current = null;
    closeBackEntry(id);
  }, [active]);

  // Unmounting while open (a tab switch out from under a deep view) must not
  // leave a dangling entry that would swallow the next back gesture.
  useEffect(() => () => {
    const id = idRef.current;
    if (id === null) return;
    idRef.current = null;
    abandonBackEntry(id);
  }, []);
}
