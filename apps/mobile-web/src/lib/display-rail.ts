import { useLayoutEffect } from 'preact/hooks';

/** A side inset this deep is a system rail (the Duo's front screen keeps its
 *  clock and dock there), not the ~59pt a notched phone reserves on its side. */
const RAIL_MIN_INSET = 72;

export type RailSide = 'left' | 'right';

/** Which side of a portrait window holds a system rail, if either does. */
export function railSide(insets: { left: number; right: number }, width: number, height: number): RailSide | null {
  if (height <= width) return null;
  if (insets.right >= RAIL_MIN_INSET) return 'right';
  if (insets.left >= RAIL_MIN_INSET) return 'left';
  return null;
}

/** Publishes the rail side as `data-rail` on the root, for the tab bar to stand in. */
export function useDisplayRail(): void {
  useLayoutEffect(() => {
    const probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;'
      + 'padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right);';
    document.body.appendChild(probe);
    const root = document.documentElement;
    const measure = () => {
      const style = getComputedStyle(probe);
      const side = railSide(
        { left: parseFloat(style.paddingLeft) || 0, right: parseFloat(style.paddingRight) || 0 },
        window.innerWidth,
        window.innerHeight,
      );
      if (side) root.dataset.rail = side;
      else delete root.dataset.rail;
    };
    measure();
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('resize', measure);
      probe.remove();
      delete root.dataset.rail;
    };
  }, []);
}
