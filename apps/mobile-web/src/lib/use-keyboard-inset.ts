import { useLayoutEffect, useState } from 'preact/hooks';
import { visibleViewportBounds, type VisibleViewport } from './visible-viewport';

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
    const vv = window.visualViewport;
    const measure = () => {
      const next = readViewport();
      const old = snapshot;
      if (old?.top === next.top && old.height === next.height && old.bottomInset === next.bottomInset) return;
      snapshot = next;
      listeners.forEach((notify) => notify(next));
    };
    window.addEventListener('resize', measure);
    vv?.addEventListener('resize', measure);
    vv?.addEventListener('scroll', measure);
    disconnect = () => {
      window.removeEventListener('resize', measure);
      vv?.removeEventListener('resize', measure);
      vv?.removeEventListener('scroll', measure);
    };
    measure();
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
  const { top, height } = useVisibleViewport();
  useLayoutEffect(() => {
    const style = document.documentElement.style;
    style.setProperty('--mobile-viewport-top', `${top}px`);
    style.setProperty('--mobile-viewport-height', `${height}px`);
    return () => {
      style.removeProperty('--mobile-viewport-top');
      style.removeProperty('--mobile-viewport-height');
    };
  }, [top, height]);
}

/**
 * How many layout-viewport pixels the software keyboard currently covers.
 * iOS Safari keeps `position: fixed` chrome behind the keyboard; the visual
 * viewport is the honest remaining strip.
 */
export function useKeyboardInset(): number {
  return useVisibleViewport().bottomInset;
}
