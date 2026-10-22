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

/** Shared visible bounds for floating surfaces, without resizing the app root. */
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
      style.setProperty('--mobile-viewport-top', `${top}px`);
      style.setProperty('--mobile-viewport-height', `${height}px`);
      style.setProperty('--kb-inset', `${bottomInset}px`);
      style.setProperty('--mobile-dock-gap', bottomInset > 80 ? '10px' : 'max(22px, calc(env(safe-area-inset-bottom) + 10px))');
    });
    return () => {
      unsubscribe();
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
