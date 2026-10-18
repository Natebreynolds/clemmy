import { useEffect, useState, type RefObject } from 'react';

/** The nearest ancestor that scrolls vertically, or null for the page. */
function scrollParent(node: HTMLElement | null): HTMLElement | null {
  for (let el = node?.parentElement ?? null; el; el = el.parentElement) {
    const overflowY = getComputedStyle(el).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return el;
  }
  return null;
}

/**
 * True once a sticky bar has pinned to the top of its scroller. Put the
 * sentinel element immediately before the sticky bar: when the sentinel
 * scrolls out of view, the bar is stuck. Lets a pinned composer show its edge
 * only while it floats over content, and sit flush on the page otherwise.
 */
export function useStuck(sentinel: RefObject<HTMLElement | null>): boolean {
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const node = sentinel.current;
    if (!node || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => setStuck(entry ? !entry.isIntersecting : false),
      { root: scrollParent(node), threshold: 0 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [sentinel]);
  return stuck;
}
