import { visibleViewportBounds, type VisibleViewport } from './visible-viewport';

type ViewportWindow = Pick<Window, 'innerHeight' | 'visualViewport' | 'addEventListener' | 'removeEventListener' | 'requestAnimationFrame' | 'cancelAnimationFrame'>;

/** One measurement per painted frame, even while WebKit pans and resizes together. */
export function observeViewport(host: ViewportWindow, notify: (bounds: VisibleViewport) => void): () => void {
  let frame: number | null = null;
  let previous: VisibleViewport | null = null;
  let disposed = false;
  const visual = host.visualViewport;
  const measure = () => {
    frame = null;
    if (disposed) return;
    const next = visibleViewportBounds(host.innerHeight, host.visualViewport);
    if (previous?.top === next.top && previous.height === next.height && previous.bottomInset === next.bottomInset) return;
    previous = next;
    notify(next);
  };
  const schedule = () => { if (frame === null) frame = host.requestAnimationFrame(measure); };
  host.addEventListener('resize', schedule);
  host.addEventListener('pageshow', schedule);
  visual?.addEventListener('resize', schedule);
  visual?.addEventListener('scroll', schedule);
  measure();
  return () => {
    disposed = true;
    if (frame !== null) host.cancelAnimationFrame(frame);
    host.removeEventListener('resize', schedule);
    host.removeEventListener('pageshow', schedule);
    visual?.removeEventListener('resize', schedule);
    visual?.removeEventListener('scroll', schedule);
  };
}
