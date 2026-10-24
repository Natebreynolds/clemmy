import { useLayoutEffect, useState } from 'preact/hooks';
import { visibleViewportBounds, type VisibleViewport } from './visible-viewport';
import { observeViewport } from './observe-viewport';

function readViewport(): VisibleViewport {
  return visibleViewportBounds(window.innerHeight, window.visualViewport);
}

let snapshot: VisibleViewport | null = null;
const listeners = new Set<(viewport: VisibleViewport) => void>();
let disconnect: (() => void) | null = null;
const getViewport = () => snapshot ?? (snapshot = readViewport());

function subscribe(listener: (viewport: VisibleViewport) => void): () => void {
  listeners.add(listener);
  if (!disconnect) {
    disconnect = observeViewport(window, (next) => {
      snapshot = next;
      listeners.forEach((notify) => notify(next));
    });
  }
  listener(getViewport());
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { disconnect?.(); disconnect = null; snapshot = null; }
  };
}

/** Shared visible bounds for the app shell and floating surfaces. */
export function useVisibleViewport(enabled = true): VisibleViewport {
  const [viewport, setViewport] = useState(getViewport);
  useLayoutEffect(() => enabled ? subscribe(setViewport) : undefined, [enabled]);
  return viewport;
}

/** Older floating surfaces consume the same measurement through CSS. */
export function useMobileViewportVariables(): void {
  useLayoutEffect(() => {
    const style = document.documentElement.style;
    // Geometry belongs to CSS. Do not rerender App (and the open transcript)
    // on every keyboard animation frame just to publish these measurements.
    const unsubscribe = subscribe(({ top, height, bottomInset }) => {
      // WKWebView can shrink innerHeight too, making bottomInset zero even
      // while the keyboard covers the full-height document. Its resting home
      // indicator gap is unnecessary above that keyboard.
      const covered = bottomInset > 80 || document.documentElement.getBoundingClientRect().height - height > 80;
      style.setProperty('--mobile-viewport-top', `${top}px`);
      style.setProperty('--mobile-viewport-height', `${height}px`);
      style.setProperty('--kb-inset', `${bottomInset}px`);
      style.setProperty('--mobile-dock-gap', covered ? '10px' : 'max(22px, calc(env(safe-area-inset-bottom) + 10px))');
      // The tab bar steps aside for the keyboard, the way a native one does.
      document.documentElement.toggleAttribute('data-keyboard-up', covered);
    });
    return () => {
      unsubscribe();
      document.documentElement.removeAttribute('data-keyboard-up');
      style.removeProperty('--mobile-viewport-top');
      style.removeProperty('--mobile-viewport-height');
      style.removeProperty('--kb-inset');
      style.removeProperty('--mobile-dock-gap');
    };
  }, []);
}

/**
 * How many layout-viewport pixels the software keyboard currently covers.
 * iOS Safari keeps `position: fixed` chrome behind the keyboard; the visual
 * viewport is the honest remaining strip.
 */
export function useKeyboardInset(): number {
  return useVisibleViewport().bottomInset;
}
